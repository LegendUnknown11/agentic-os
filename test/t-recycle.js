// The briefer's context-recycle path, exercised without a 120k-token session
// and without spending any quota.
//
// A stand-in agent replaces the real briefer: it answers the handover request
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
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex', prompt: 'You watch.' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

const HANDOVER = 'coder is mid-task on math.js; orchestrator awaits a verdict.';

/** Behaves like a real briefer being asked for a handover note. */
class FakeBriefer extends EventEmitter {
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
k.bus.set('session:briefer', 'old-session-id-should-be-discarded');

const fake = new FakeBriefer();
k.agents.set('briefer', fake);

let recycled = null;
k.on('recycled', (e) => (recycled = e));

await k.recycleBriefer();

// It must have ASKED for a handover before killing anything.
a.equal(fake.sent.length, 1, 'briefer must be asked for a handover note');
a.match(fake.sent[0], /handover/i, 'the request must ask for a handover');
a.equal(fake.stopped, true, 'the old briefer must be stopped');

// The successor must exist, and must not be the same object.
const successor = k.agents.get('briefer');
a.ok(successor, 'a replacement briefer must be spawned');
a.notEqual(successor, fake, 'the replacement must be a new agent');

// The whole point: the note carries over.
a.match(successor.spec.prompt, /HANDOVER FROM YOUR PREDECESSOR/,
  'the successor must be seeded with a handover section');
a.ok(successor.spec.prompt.includes(HANDOVER),
  'the predecessor\'s actual note must reach the successor');

// A note that is not bounded defeats the point of recycling at all.
//
// #captureHandover accumulates EVERY text event of the retirement turn, not
// just the note, and the result goes into the successor's system prompt — where
// it is charged on every turn that successor ever takes. A member that reasons
// out loud before writing its note therefore hands its successor the whole
// monologue, permanently, and it compounds down a recycle chain. This asserted
// only that the note arrived, which is why nothing noticed.
{
  const verbose = new FakeBriefer();
  verbose.send = function (text) {
    this.sent.push(text);
    setImmediate(() => {
      this.emit('text', 'thinking out loud. '.repeat(4000));   // ~72k chars of preamble
      this.emit('text', HANDOVER);                             // the actual note, last
      this.emit('turn_end', { usage: {}, costUsd: 0 });
    });
  };
  const k2 = new Kingdom(repo, configPath);
  k2.base = 'master';
  k2.bus.set('base', 'master');
  k2.bus.set('session:briefer', 'another-old-session');
  k2.agents.set('briefer', verbose);
  await k2.recycleBriefer();

  const prompt = k2.agents.get('briefer').spec.prompt;
  // From the handover header to the end of the prompt: the note plus whatever
  // blocks follow it, so the bound is the cap with room for those rather than
  // the cap itself. Uncapped this region is ~74,000 chars, so the margin is
  // wide enough that the assertion cannot pass by accident.
  const seeded = prompt.slice(prompt.indexOf('HANDOVER FROM YOUR PREDECESSOR'));
  a.ok(seeded.length < 10_000,
    `a handover must be capped, got ${seeded.length} chars — it rides in the successor's `
    + 'system prompt on every turn for the life of that session');
  a.ok(seeded.includes(HANDOVER),
    'and the cap must keep the TAIL: the note is what was asked for, the rambling came first');
  k2.stop?.();
}

// A failed CLI can leave `send()` unable to accept a handover request. A model
// switch must still retire it: persisting the new model while leaving the old
// member alive strands the court on the failed runtime.
{
  const failed = new FakeBriefer();
  failed.send = () => { throw new Error('dead transport'); };
  const k3 = new Kingdom(repo, configPath);
  k3.base = 'master';
  k3.bus.set('base', 'master');
  k3.agents.set('briefer', failed);

  await k3.recycleBriefer();
  a.equal(failed.stopped, true, 'a failed handover transport must not block retirement');
  a.ok(k3.agents.get('briefer'), 'the successor must still be spawned without a handover');
  await k3.stop();
}

// A stale session id would resume the DEAD context and defeat the recycle.
a.ok(!successor.sessionId || successor.sessionId !== 'old-session-id-should-be-discarded',
  'the successor must not resume the exhausted session');

a.ok(recycled, 'a recycled event must be emitted');
a.equal(recycled.name, 'briefer');
a.ok(recycled.note.includes(HANDOVER));

await k.stop();
for (const d of [repo, kingdomDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-recycle.js OK — handover written, old briefer retired, successor seeded');
