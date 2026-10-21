// A member must never be given a turn nobody asked for. Issue #40, filed
// against a real session: "The orchestrator is talking to itself. I didn't
// give it a command yet."
//
// Root cause: agenticos.js#start() unconditionally posts housekeeping notices
// to the orchestrator on every daemon boot — "still in service from a
// previous session" for inherited crew, "nobody is working on this any more"
// for orphaned tasks — and the orchestrator is registered as `awake` the
// moment #spawn() runs, well before the user has said anything. If one
// of those notices (or any other) is already older than NOTICE_HOLD_MS by the
// time it is next read — exactly what a restart leaves behind, since the
// previous boot's identical notice can still be sitting unacked — ripeness.js
// let it fire as a turn on its own: a message the user never sent,
// answered by a member the user never addressed.
//
// This proves the fix end to end against the real bus and the real delivery
// loop (agenticos.js's `hadReal:` flag feeding ripeness.js's `hadRealTurn`), not
// just the pure function in isolation.
//
// Uses a stand-in agent — no API, no quota.
//   node test/t-first-turn.js
import { strict as a } from 'node:assert';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { stateDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.AGENTICOS_CODEX_BIN = process.execPath;
process.env.AGENTICOS_SETTLE_MS = '400';

const repo = mkdtempSync(join(tmpdir(), 'agenticos-firstturn-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  agents: [{ name: 'coder', cli: 'codex' }],
}));

class FakeAgent extends EventEmitter {
  constructor() { super(); this.sent = []; this.busy = false; }
  send(t) { this.sent.push(t); }
  stop() {}
}

const k = new AgenticOS(repo, configPath);
await k.start();

const coder = new FakeAgent();
k.processes.set('coder', coder);
k.added.add('coder');

// --- a stale notice, with no real turn ever behind this member, must not
// manufacture one --------------------------------------------------------
a.equal(k.bus.get('hadReal:coder'), undefined,
  'a freshly spawned member must start with no real-turn history recorded');

const noticeId = k.bus.post('orchestrator', 'coder', 'AWARENESS ONLY — TAKE NO ACTION. '
  + 'Still in service from a previous session.', 'notice');
// Simulate a notice that was already old when this member came up — exactly
// what a restart leaves behind, since start() posts the same housekeeping
// notice every boot and an earlier copy may still be sitting unacked.
k.bus.db.prepare('update messages set ts = ? where id = ?').run(Date.now() - 10 * 60_000, noticeId);

await wait(1500);
a.equal(coder.sent.length, 0,
  'a member with no real turn behind it must not be given one by a stale notice alone (#40)');
a.equal(k.bus.get('hadReal:coder'), undefined, 'and no real-turn history must be recorded for a notice');

// --- real traffic still rides it along, exactly as before ---------------
k.bus.post('user', 'coder', 'do the real thing', 'assignment');
await wait(1500);
a.equal(coder.sent.length, 1, 'real traffic must still deliver');
a.ok(coder.sent[0].includes('AWARENESS ONLY'), 'and the stale notice must ride along with it, not vanish');
a.ok(coder.sent[0].includes('do the real thing'));
a.equal(k.bus.get('hadReal:coder'), '1', 'the real turn must now be recorded');

await k.stop();
for (const d of [repo, stateDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-first-turn.js OK — a stale notice never manufactures a member\'s first turn (#40)');
