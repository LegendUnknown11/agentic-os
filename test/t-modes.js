// Three shapes, and the promises each one makes.
//
// src/modes.js already checks its own table. What it CANNOT check is whether
// the court honours it, and every one of these is a promise made to the
// sovereign in the interface:
//
//   * Cowork never touches the base branch — including from the
//     sovereign's own Merge button, which does not go through the MCP tool
//     gate that the model sees;
//   * a flip never lands mid-turn, so nobody finishes under rules it did not
//     start with;
//   * a live flip does NOT restart anybody or rewrite a cached prompt — the
//     measurement in kingdom.js is 96% of a $101 session billed as replay;
//   * the mode survives a restart, and reaches the bus, which is the only
//     channel that gets into a member's MCP server.
//
//   node test/t-modes.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.KINGDOM_CODEX_BIN = process.execPath;
process.env.KINGDOM_SETTLE_MS = '150';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-modes-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const cfg = join(repo, 'kingdom.config.json');
writeFileSync(cfg, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [
    { name: 'coder', cli: 'codex', description: 'writes code' },
    { name: 'researcher', cli: 'codex', description: 'finds things out' },
  ],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  summarizer: { enabled: false },
}));

try {
  const k = new Kingdom(repo, cfg);
  k.on('error', () => {});
  await k.start();

  /* ---------- 1. a court with no mode set is the court we already had ------ */
  a.equal(k.mode(), 'code', 'an unconfigured court behaves exactly as it did before modes');
  a.equal(k.bus.get('mode'), 'code',
    'published on start, or every member\'s MCP server falls back and hands out a merge tool');

  /* ---------- 2. the shape reaches the prompt ------------------------------ */
  a.ok(!k.briefFor('coder').includes('NOTHING MERGES'), 'Code merges, and says nothing about it');
  k.setMode('cowork');
  a.match(k.briefFor('coder'), /COWORK MODE/);
  a.match(k.briefFor('coder'), /NOTHING MERGES/, 'a mode that cannot merge must say so');
  a.match(k.briefFor('coder'), /workflow_save/, 'Cowork carries its real workspace capabilities');

  /* ---------- 3. a live flip TELLS; it does not restart -------------------- */
  // The whole reason a flip is a bus notice: `prompt:${name}` is byte-stable on
  // purpose, and rewriting it re-bills the entire session as fresh input.
  const before = [...k.agents.keys()];
  const seen = [];
  k.on('mode', (m) => seen.push(m));

  const r = k.setMode('chat', { why: 'talking it through' });
  a.equal(r.changed, true);
  a.equal(r.previous, 'cowork', 'the previous shape comes back, or undo has nothing to restore');
  a.equal(seen.at(-1).mode, 'chat');
  a.deepEqual([...k.agents.keys()], before, 'a flip must not respawn anybody');

  const notices = k.bus.history({ limit: 50, tail: true })
    .filter((m) => m.kind === 'notice' && /CHAT MODE/i.test(m.body));
  a.ok(notices.length >= before.length,
    'every live member must be told, on the bus, rather than have its prompt rewritten');
  a.ok(notices.some((m) => m.body.includes('talking it through')), 'and told why');

  // Setting the mode it is already in changes nothing and says nothing — the
  // advisor re-classifies on every message and most of them do not move it.
  const quiet = k.bus.countMessages();
  a.equal(k.setMode('chat').changed, false);
  a.equal(k.bus.countMessages(), quiet, 'a no-op flip must not spam the bus');

  // A live flip must carry the SAME substance a fresh spawn's prompt gets —
  // not just the label — or a member mid-session is worse-informed than one
  // spawned after the flip. Measured failure without this: an orchestrator
  // live-flipped into Automate mode did not know it owned workflow_save and
  // tried to delegate the work to a nonexistent "coder" peasant instead.
  k.setMode('cowork');
  const coworkNotices = k.bus.history({ limit: 50, tail: true })
    .filter((m) => m.kind === 'notice' && /COWORK MODE/i.test(m.body));
  a.ok(coworkNotices.some((m) => m.body.includes('workflow_save')),
    'a live flip into Cowork must carry the node/trigger vocabulary, not just the label');

  /* ---------- 4. nothing merges outside Code ------------------------------- */
  // Not the MCP tool gate — this is the sovereign's own Merge button, which
  // reaches merge() directly and never sees the model's tool list.
  for (const mode of ['cowork', 'chat']) {
    k.setMode(mode);
    await a.rejects(() => k.merge('coder'), /Nothing merges/,
      `${mode} must refuse a merge even when it is asked for directly`);
  }
  // And Code still gets past the gate — a refusal that refuses everything
  // proves nothing. It fails later, on there being no worktree to merge.
  k.setMode('code');
  await a.rejects(() => k.merge('coder'), (e) => !/Nothing merges/.test(e.message),
    'Code must reach the real merge, not the mode refusal');

  /* ---------- 5. a flip is held while anyone is mid-turn ------------------- */
  const orchestrator = k.agents.get('orchestrator');
  a.ok(orchestrator, 'the orchestrator is awake');
  orchestrator.busy = true;

  const held = k.queueMode('chat', { why: 'just talking' });
  a.equal(held.pending, 'chat');
  a.equal(k.mode(), 'code', 'a mid-turn flip must not land');
  a.equal(k.bus.get('mode'), 'code', 'and must not reach the tool gate either');
  a.equal(seen.at(-1).pending, 'chat', 'the UI is told it is pending, so it can say so');

  // The newest classification wins: it read the newest message.
  k.queueMode('cowork');
  a.equal(k.pendingMode.mode, 'cowork', 'a second request replaces the first');

  orchestrator.busy = false;
  // Polled rather than slept: this rides the real 300ms tick loop, and a fixed
  // wait is exactly the shape run-all.js documents as failing under contention
  // and passing alone. Waiting FOR the condition tests the same thing and does
  // not encode this machine's load into the assertion.
  const idle = () => [...k.agents.values()].every((agent) => !agent.busy);
  for (let i = 0; i < 40 && (k.mode() !== 'cowork' || !idle()); i++) await wait(150);
  a.equal(k.mode(), 'cowork', 'and lands the moment the court goes idle');
  a.equal(k.bus.get('mode'), 'cowork');
  a.equal(k.pendingMode, null, 'and is not applied twice');

  // Idle already? Then there is nothing to wait for.
  a.equal(k.queueMode('chat').changed, true, 'an idle court flips immediately');
  a.equal(k.mode(), 'chat');

  /* ---------- 6. Chat is the orchestrator alone ---------------------------- */
  a.match(k.briefFor('orchestrator'), /nobody to propose/i);
  await k.command('what do you think of this codebase?');
  const sent = k.bus.history({ limit: 20, tail: true }).filter((m) => m.sender === 'sovereign');
  a.ok(sent.some((m) => m.body.includes('what do you think')),
    'a Chat command still reaches the orchestrator — same session, same bus, same cost line');

  // Nobody may be summoned into it, and the APPROVAL is where that is enforced
  // rather than the summon tool: the card sits in the corner until the
  // sovereign answers it, so a proposal can outlive the mode it was made in.
  const ruled = [];
  k.on('resolved', (x) => ruled.push(x));
  k.approvals.set(9001, { kind: 'summon', names: ['researcher'], by: 'orchestrator' });
  await k.approve(9001);

  a.deepEqual(ruled.at(-1), { id: 9001, approved: false }, 'a summon into Chat is refused');
  a.ok(!k.agents.has('researcher'), 'and nobody was actually woken');
  a.match(k.bus.history({ limit: 5, tail: true }).at(-1).body, /not on the Chat bench/,
    'and the orchestrator is told why, in a sentence it can act on');

  await k.stop();

  /* ---------- 7. it survives a restart ------------------------------------- */
  a.equal(JSON.parse(readFileSync(cfg, 'utf8')).mode, 'chat',
    'the shape you were working in yesterday is the shape you expect today');
  const k2 = new Kingdom(repo, cfg);
  k2.on('error', () => {});
  await k2.start();
  a.equal(k2.mode(), 'chat');
  a.equal(k2.bus.get('mode'), 'chat', 'republished on start, or the tools read a stale shape');
  await k2.stop();

  console.log('  the shape reaches the prompt, the bus, and the config');
  console.log('  a live flip tells the court instead of rewriting its prompts');
  console.log('  nothing merges outside Code, including from the Merge button');
  console.log('  a mid-turn flip waits for idle; the newest request wins');
  console.log('t-modes.js OK — three shapes, and the court honours them');
} finally {
  for (const d of [repo, kingdomDir(repo)]) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
