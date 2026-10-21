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

await k.stop();
for (const d of [repo, kingdomDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-session.js OK — context meter');
