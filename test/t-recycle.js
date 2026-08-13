// The jester's context-recycle path, exercised without a 120k-token session
// and without spending any quota.
//
// A stand-in agent replaces the real jester: it answers the handover request
// like a real one would. The replacement is configured as a codex member,
// which spawns no process until it is first sent a turn — so nothing here
// touches an API.
//
//   node test/t-recycle.js
import { strict as a } from 'node:assert';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir } from '../src/worktree.js';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-recycle-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  king: { name: 'king', cli: 'codex' },
  jester: { name: 'jester', cli: 'codex', prompt: 'You watch.' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

const HANDOVER = 'coder is mid-task on math.js; king awaits a verdict.';

/** Behaves like a real jester being asked for a handover note. */
class FakeJester extends EventEmitter {
  constructor() { super(); this.sent = []; this.stopped = false; }
  send(text) {
    this.sent.push(text);
    setImmediate(() => {
      this.emit('text', HANDOVER);
      this.emit('turn_end', { usage: {}, costUsd: 0 });
    });
  }
  stop() { this.stopped = true; }
}

const k = new Kingdom(repo, configPath);
k.base = 'master';
k.bus.set('base', 'master');
k.bus.set('session:jester', 'old-session-id-should-be-discarded');

const fake = new FakeJester();
k.agents.set('jester', fake);

let recycled = null;
k.on('recycled', (e) => (recycled = e));

await k.recycleJester();

// It must have ASKED for a handover before killing anything.
a.equal(fake.sent.length, 1, 'jester must be asked for a handover note');
a.match(fake.sent[0], /handover/i, 'the request must ask for a handover');
a.equal(fake.stopped, true, 'the old jester must be stopped');

// The successor must exist, and must not be the same object.
const successor = k.agents.get('jester');
a.ok(successor, 'a replacement jester must be spawned');
a.notEqual(successor, fake, 'the replacement must be a new agent');

// The whole point: the note carries over.
a.match(successor.spec.prompt, /HANDOVER FROM YOUR PREDECESSOR/,
  'the successor must be seeded with a handover section');
a.ok(successor.spec.prompt.includes(HANDOVER),
  'the predecessor\'s actual note must reach the successor');

// A stale session id would resume the DEAD context and defeat the recycle.
a.ok(!successor.sessionId || successor.sessionId !== 'old-session-id-should-be-discarded',
  'the successor must not resume the exhausted session');

a.ok(recycled, 'a recycled event must be emitted');
a.equal(recycled.name, 'jester');
a.ok(recycled.note.includes(HANDOVER));

await k.stop();
for (const d of [repo, kingdomDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-recycle.js OK — handover written, old jester retired, successor seeded');
