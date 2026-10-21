// The session surfaces the T3 inspector and Overview draw: the context-window
// meter, Compact session, the agent on a run, and spend by day. Exercised
// against stand-in agents — nothing here spawns a CLI or spends quota.
//
//   node test/t-session.js
import { strict as a } from 'node:assert';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir } from '../src/worktree.js';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-session-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex', model: 'gpt-known' },
  briefer: { name: 'briefer', cli: 'codex', prompt: 'You watch.' },
  peasants: [{ name: 'coder', cli: 'codex', model: 'gpt-mystery' }],
  contextWindows: { 'gpt-known': 400_000 },
  rolesSeeded: true,
}));

/** A member that answers a handover request the way a real one does. */
class FakeMember extends EventEmitter {
  constructor(model, ctx) {
    super();
    this.spec = { model };
    this.sent = [];
    this.stopped = false;
    this.busy = false;
    this.ctx = ctx;
    this.conversationId = 'default';
  }
  ctxTokens() { return this.ctx; }
  send(text) {
    this.sent.push(text);
    setImmediate(() => {
      this.emit('text', 'handover: the parser is half done.');
      this.emit('turn_end', { usage: {}, costUsd: 0 });
    });
  }
  stop() { this.stopped = true; }
}

const k = new Kingdom(repo, configPath);
k.base = 'master';
k.bus.set('base', 'master');

/* ---------- 1. context-window meter ---------- */
{
  // Asleep: the figure is the per-conversation `ctx:` key #record writes.
  k.bus.set('ctx:orchestrator:default', '100000');
  k.bus.set('ctx:coder:default', '30000');

  const all = k.contextAll();
  a.equal(all[0].name, 'orchestrator', 'the orchestrator comes first');
  a.deepEqual(all.map((c) => c.name), ['orchestrator', 'briefer', 'coder']);

  const orch = k.contextOf('orchestrator');
  a.equal(orch.tokens, 100_000);
  a.equal(orch.window, 400_000, 'the window comes from contextWindows in config');
  a.equal(orch.pct, 25);
  a.equal(orch.awake, false);
  a.equal(orch.recycleAt, 70_000, 'the recycle threshold rides along so the meter can mark it');

  const coder = k.contextOf('coder');
  a.equal(coder.tokens, 30_000);
  a.equal(coder.window, null, 'a model the table does not name has no window — never a guess');
  a.equal(coder.pct, null);
  a.equal(k.contextOf('briefer').window, null, 'no model at all is no window');
  a.equal(k.contextOf('nobody'), null);
  a.equal(k.contextWindowOf(null), null);

  // Awake: the live agent's own measurement wins over the stored figure.
  const live = new FakeMember('gpt-known', 200_000);
  k.agents.set('orchestrator', live);
  const awake = k.contextOf('orchestrator');
  a.equal(awake.tokens, 200_000, 'a live member reports what its agent measures now');
  a.equal(awake.pct, 50);
  a.equal(awake.awake, true);
  k.agents.delete('orchestrator');
}

/* ---------- 2. Compact session ---------- */
{
  const events = (type) => k.bus.events({ limit: 1000, type }).filter((e) => e.agent === 'coder');
  const compacted = [];
  const recycled = [];
  k.on('compacted', (e) => compacted.push(e));
  k.on('recycled', (e) => recycled.push(e));

  // Asleep: nothing live to hand over from. Refused, and recorded.
  await a.rejects(k.compactSession('coder'), (e) => e.reason === 'asleep' && e.status === 409);
  await a.rejects(k.compactSession('nobody'), /No such team member/);

  // Mid-turn: refused without touching the member.
  const member = new FakeMember('gpt-mystery', 90_000);
  member.busy = true;
  k.agents.set('coder', member);
  k.bus.set('session:coder:default', 'old-session');
  await a.rejects(k.compactSession('coder'), (e) => e.reason === 'busy' && /mid-turn/.test(e.message));
  a.equal(member.sent.length, 0, 'a busy member is never sent the handover request');
  a.equal(member.stopped, false);
  a.equal(k.agents.get('coder'), member);

  member.recycling = true;
  await a.rejects(k.compactSession('coder'), (e) => e.reason === 'recycling');
  member.recycling = false;

  const refusals = events('session_compact');
  a.deepEqual(refusals.map((e) => e.payload.reason), ['asleep', 'busy', 'recycling'], 'every refusal is a durable event');
  a.ok(refusals.every((e) => e.payload.ok === false));

  // Idle: compacted through the very recycle the threshold fires.
  member.busy = false;
  const result = await k.compactSession('coder');
  a.equal(member.sent.length, 1, 'the member is asked for a handover first');
  a.match(member.sent[0], /handover/i);
  a.equal(member.stopped, true, 'the old session is retired');
  a.equal(recycled.length, 1, 'it IS the recycle path — one recycled event, no parallel one');
  const successor = k.agents.get('coder');
  a.ok(successor && successor !== member, 'a successor holds the session now');
  a.ok(successor.spec.prompt.includes('the parser is half done'), 'seeded with the handover note');
  a.equal(k.bus.get('session:coder:default'), '', 'the old session id is not resumed');
  a.equal(k.bus.get('ctx:coder:default'), '0');
  a.equal(result.ok, true);
  a.equal(result.before, 90_000);
  a.equal(result.after, 0);
  a.equal(result.by, 'sovereign');
  a.deepEqual(compacted, [result], 'a compacted event is emitted for the stream');
  const done = events('session_compact').at(-1);
  a.equal(done.payload.ok, true);
  a.equal(done.payload.before, 90_000);
  successor.stop?.();
  k.agents.delete('coder');
}

/* ---------- 3. the agent on a run ---------- */
{
  const run = await k.createRun({ objective: 'lead is recorded' });
  a.equal(run.lead, 'orchestrator', 'a run is the orchestrator\'s thread unless told otherwise');
  a.equal(k.bus.run(run.id).lead, 'orchestrator', 'and it is durable, not computed on read');
  k.bus.updateRun(run.id, { state: 'cancelled', cancelledTs: Date.now() });

  const named = await k.createRun({ objective: 'led by the coder', lead: 'coder' });
  a.equal(named.lead, 'coder');
  k.bus.updateRun(named.id, { state: 'cancelled', cancelledTs: Date.now() });

  const stranger = await k.createRun({ objective: 'led by nobody real', lead: 'nobody' });
  a.equal(stranger.lead, 'orchestrator', 'a lead outside the court is not recorded');
  k.bus.updateRun(stranger.id, { state: 'cancelled', cancelledTs: Date.now() });
}

/* ---------- 4. spend by day ---------- */
{
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  a.equal(k.spendTimeZone(), local, 'no configured zone is the daemon\'s own local zone, by name');
  k.config.timeZone = 'Not/AZone';
  a.equal(k.spendTimeZone(), local, 'an invalid zone falls back rather than throwing');
  k.config.timeZone = 'Asia/Kolkata';
  a.equal(k.spendTimeZone(), 'Asia/Kolkata');

  // 20:00 UTC is already the next day in Kolkata (UTC+5:30).
  const now = Date.UTC(2026, 9, 21, 20, 0);
  k.bus.recordSpend('coder', 0.4, 1000, Date.UTC(2026, 9, 21, 19, 0));  // 00:30 IST on the 22nd
  k.bus.recordSpend('coder', 0.6, 2000, Date.UTC(2026, 9, 21, 10, 0));  // 15:30 IST on the 21st
  const today = k.spendToday(now);
  a.deepEqual(today, { day: '2026-10-22', usd: 0.4, turns: 1, tokens: 1000, timeZone: 'Asia/Kolkata' });
  const week = k.spendByDay({ days: 7, now });
  a.equal(week.days.length, 7);
  a.deepEqual(week.days.slice(0, 2).map((d) => [d.day, d.usd]), [['2026-10-22', 0.4], ['2026-10-21', 0.6]]);
  k.clearSpend();
  a.deepEqual(k.spendToday(now), today, 'clearSpend() leaves the ledger alone');
  delete k.config.timeZone;
}

await k.stop();
for (const d of [repo, kingdomDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-session.js OK — context meter, compact session, run lead, spend by day');
