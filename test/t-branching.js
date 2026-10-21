// No CLI backend (claude/codex/agy/opencode) can rewind a session in place —
// every resume flag continues a thread, none roll one back. So "edit a past
// message" and "regenerate a reply" can only ever mean one thing: fork a
// fresh sibling conversation seeded with a replay of everything up to the
// fork point, then post the new/repeated text into it. This exercises
// Kingdom.branchFrom() directly: the fork stops exactly at the fork point
// (nothing after it leaks into the replay), siblings forked from the same
// point are isolated from each other, and siblingsOf() finds them all.
//
//   node test/t-branching.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/agenticos.js';
import { kingdomDir } from '../src/worktree.js';

process.env.KINGDOM_CODEX_BIN = process.execPath; // stub: never calls an API
process.env.KINGDOM_SETTLE_MS = '200';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-branch-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  models: { claude: ['haiku'], codex: ['gpt-5.6-luna'] },
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [],
  advisor: { promptEngineer: false, autoModel: false },
}));

const neuter = (agent) => {
  agent.sent = [];
  agent.stopped = false;
  agent.send = function (t) { this.sent.push(t); };
  agent.stop = function () { this.stopped = true; };
  return agent;
};

const k = new Kingdom(repo, configPath);
await k.start();
neuter(k.agents.get('orchestrator'));

// Build up 'default' history: three turns, in order.
const id1 = k.bus.post('sovereign', 'orchestrator', 'FIRST turn.', 'assignment', 'default');
const id2 = k.bus.post('sovereign', 'orchestrator', 'SECOND turn.', 'assignment', 'default');
const id3 = k.bus.post('sovereign', 'orchestrator', 'THIRD turn.', 'assignment', 'default');
a.ok(id1 < id2 && id2 < id3, 'sanity: ids increase in post order');

// --- fork right after the second turn: an edit/regenerate of the third ---
// The replay isn't baked into the successor's spawn-time system prompt (a
// brand new conversation has no messages yet, so #orientation() has nothing
// to build from) — branchFrom() delivers it as a real posted bus message
// instead, the same way any other notice reaches a live member.
const fork1 = await k.branchFrom('orchestrator', 'default', id2, 'THIRD, rewritten.');
a.equal(fork1.parent_id, 'default', 'a fork records its parent conversation');
a.equal(fork1.fork_at, id2, 'a fork records the exact message it forked from');
a.equal(k.activeConversation.get('orchestrator'), fork1.id,
  'branching moves the member\'s live session into the new conversation');
neuter(k.agents.get('orchestrator')); // the fresh successor spawned into fork1

const fork1Log = k.bus.history({ conversation: fork1.id, limit: 100 }).map((m) => m.body).join('\n');
a.match(fork1Log, /FIRST turn/, 'the replay must include everything up to the fork point');
a.match(fork1Log, /SECOND turn/, 'the replay must include everything up to the fork point');
a.doesNotMatch(fork1Log, /THIRD turn\./,
  'the replay must stop exactly at the fork point — the original third turn must not leak in');
a.match(fork1Log, /THIRD, rewritten\./, 'the edited text must land as a real message in the new branch');

// --- a second, independent fork from the SAME point (a sibling) ---
const fork2 = await k.branchFrom('orchestrator', 'default', id2, 'THIRD, a different rewrite.');
neuter(k.agents.get('orchestrator'));

const sibs = k.bus.siblingsOf(fork1.id);
a.deepEqual(sibs.map((s) => s.id).sort(), [fork1.id, fork2.id].sort(),
  'siblingsOf must return every conversation forked from the same point');

// --- isolation: neither fork's own text leaks into the other or into 'default' ---
const fork2Log = k.bus.history({ conversation: fork2.id, limit: 100 }).map((m) => m.body).join('\n');
a.doesNotMatch(fork2Log, /THIRD, rewritten\./, 'fork2 must not see fork1\'s edited text');
a.doesNotMatch(fork1Log, /a different rewrite/, 'fork1 must not see fork2\'s edited text');

const defaultHistory = k.bus.history({ conversation: 'default', limit: 100 });
a.ok(defaultHistory.some((m) => /THIRD turn\./.test(m.body)),
  'the original conversation is untouched by branching from it');
a.ok(!defaultHistory.some((m) => /rewritten|different rewrite/.test(m.body)),
  'forked text must never bleed back into the conversation it was forked from');

await k.stop();
for (const d of [repo, kingdomDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-branching.js OK — forks stop at the fork point, siblings are isolated and discoverable');
