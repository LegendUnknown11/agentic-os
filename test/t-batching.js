// Cost is driven by TURN COUNT, not message count: every delivered turn
// replays the recipient's whole context. This proves several messages collapse
// into one turn, and that pure-FYI notices don't buy a turn of their own.
//
// Uses stand-in agents — no API, no quota.
//   node test/t-batching.js
import { strict as a } from 'node:assert';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a condition instead of for a duration. Reviving a slept member runs
// `git worktree add` plus `behindBase` — three or four subprocesses — and a flat
// `await wait(5000)` around that asserts the machine's speed, not the code's
// correctness. It failed exactly that way on a loaded box (a full run that
// normally takes 74-105s took 513.7s) and passed alone seconds later. Polling
// keeps the fast path fast and only spends the long ceiling when it has to.
const until = async (fn, ms = 60_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (fn()) return true;
    await wait(100);
  }
  return fn();
};

// Reviving a slept member really does spawn its CLI. Point codex at a stub
// that exits immediately so this test stays offline and costs nothing.
process.env.KINGDOM_CODEX_BIN = process.execPath;
// Short settle window so the test stays quick; the real default is 90s.
process.env.KINGDOM_SETTLE_MS = '400';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-batch-'));
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
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

class FakeAgent extends EventEmitter {
  constructor() { super(); this.sent = []; this.busy = false; }
  send(t) { this.sent.push(t); }
  stop() {}
}

const k = new Kingdom(repo, configPath);
await k.start();

const coder = new FakeAgent();
k.agents.set('coder', coder);
k.summoned.add('coder');

// --- three messages arriving together must cost ONE turn --------------
k.bus.post('orchestrator', 'coder', 'first thing');
k.bus.post('orchestrator', 'coder', 'second thing');
k.bus.post('architect', 'coder', 'third thing');
await wait(1500);

a.equal(coder.sent.length, 1, `3 messages must batch into 1 turn, got ${coder.sent.length}`);
for (const s of ['first thing', 'second thing', 'third thing']) {
  a.ok(coder.sent[0].includes(s), `batch must contain "${s}"`);
}
a.match(coder.sent[0], /3 new messages/, 'the batch should say how many arrived');

// --- the sovereign never waits out the settle window ------------------
// The window absorbs bursts of agent-to-agent chatter. A human typing is not a
// burst, and 15s of silence is what makes them retype the same order.
//
// Widen the window for this check only, so the two cases are actually
// distinguishable: at the 400ms used elsewhere in this file, "arrived within
// 700ms" would pass whether or not the message waited. settleMs() reads the
// env on every call, so this takes effect immediately.
process.env.KINGDOM_SETTLE_MS = '4000';
{
  coder.sent.length = 0;
  k.bus.post('sovereign', 'coder', 'do this now', 'assignment');
  await wait(1200);            // a quarter of the window
  a.equal(coder.sent.length, 1, "the sovereign's message must not wait for the settle window");

  // ...and the same message from an AGENT still waits it out.
  coder.sent.length = 0;
  k.bus.post('architect', 'coder', 'no rush', 'message');
  await wait(1200);
  a.equal(coder.sent.length, 0, 'agent traffic must still coalesce in the window');
  await wait(3500);
  a.equal(coder.sent.length, 1, 'and land once the window closes');
}
process.env.KINGDOM_SETTLE_MS = '400';

// --- a repeated order is delivered ONCE -------------------------------
// A stalled court makes the sovereign retype; seven identical "Resume"
// messages were then delivered in one batch and acted on seven times.
coder.sent.length = 0;
coder.busy = true;                       // hold them so they batch together
for (let i = 0; i < 5; i++) k.bus.post('sovereign', 'coder', 'Resume', 'assignment');
k.bus.post('sovereign', 'coder', 'and then stop', 'assignment');
await wait(800);
coder.busy = false;
await wait(1500);

a.equal(coder.sent.length, 1, 'the whole pile must still cost ONE turn');
a.equal(coder.sent[0].match(/Resume/g)?.length, 1,
  `a repeated order must be delivered once, got ${coder.sent[0].match(/Resume/g)?.length}`);
a.ok(coder.sent[0].includes('and then stop'), 'but distinct messages must survive');

// --- the settle window coalesces messages that arrive APART -----------
// Without it, an idle agent takes a turn for the first message and another for
// the second. With it, a short pause collects both into one.
coder.sent.length = 0;
k.bus.post('orchestrator', 'coder', 'part one');
await wait(150); // inside the 400ms settle window
k.bus.post('orchestrator', 'coder', 'part two');
await wait(1500);
a.equal(coder.sent.length, 1, 'messages arriving within the settle window must cost ONE turn');
a.ok(coder.sent[0].includes('part one') && coder.sent[0].includes('part two'));

// --- a busy agent is not interrupted ----------------------------------
coder.busy = true;
k.bus.post('orchestrator', 'coder', 'while busy');
await wait(1500);
a.equal(coder.sent.length, 1, 'a busy agent must not be interrupted mid-turn');

coder.busy = false;
await wait(1500);
a.equal(coder.sent.length, 2, 'the held message must arrive once it goes idle');
a.ok(coder.sent[1].includes('while busy'));

// --- pure FYI must not buy its own turn -------------------------------
k.bus.post('orchestrator', 'coder', 'just so you know', 'notice');
await wait(1500);
a.equal(coder.sent.length, 2, 'a lone notice must NOT cost a turn');

// ...but it rides along with the next real message.
k.bus.post('orchestrator', 'coder', 'real work');
await wait(1500);
a.equal(coder.sent.length, 3, 'real traffic must flush the held notice with it');
a.ok(coder.sent[2].includes('just so you know'), 'the notice must ride along');
a.ok(coder.sent[2].includes('real work'));

// --- an idle-slept member is revived on demand ------------------------
k.agents.delete('coder'); // simulate an idle sleep; still summoned
k.bus.post('orchestrator', 'coder', 'wake up');
a.ok(await until(() => k.agents.has('coder')),
  'a summoned-but-slept member must be revived to receive mail');

// --- the crew survives a restart --------------------------------------
// #tick only iterates `summoned`; if that were lost, mail to a peasant woken
// before the restart would sit unread forever.
await k.stop();

const k2 = new Kingdom(repo, configPath);
await k2.start();
a.ok(k2.summoned.has('coder'), 'a summoned peasant must still be in service after a restart');
a.ok(!k2.agents.has('coder'), 'it should be asleep, not eagerly respawned');

k2.bus.post('orchestrator', 'coder', 'still there?');
a.ok(await until(() => k2.agents.has('coder')),
  'mail after a restart must revive it, not vanish');

// --- a turn that dies outright must not swallow the order -------------
// The ack happens BEFORE the turn is known to have worked. A 53k-char brief
// was lost exactly this way: spawn failed, the message was already acked, and
// the court sat silent. One retry, then it gives up rather than looping.
// The stubbed "codex" is plain node given a script that does not exist, so
// every turn dies with no output — the real failure, end to end.
{
  // Only THIS batch's redeliveries. "still there?" above went to the same
  // dying stub and has its own deliver-die-rewind-redeliver cycle in flight;
  // on a loaded machine that cycle lands after this listener is attached, and
  // counting it read as the retry guard failing when it had not.
  const all = [];
  k2.on('redelivered', (r) => all.push(r));
  const id = k2.bus.post('orchestrator', 'coder', 'do the important thing');
  const mine = () => all.filter((r) => r.through >= id);
  await until(() => mine().length > 0);        // deliver, die, rewind, redeliver
  await wait(3000);                            // then long enough to die again

  a.equal(mine().length, 1,
    `a dead turn must be redelivered exactly once, got ${JSON.stringify(all)}`);
  a.equal(k2.bus.pending('coder').length, 0,
    'and after the retry is spent the order must not sit redelivering forever');
}

// --- a declare_done must be verified ONCE, however long the batch waits ---
// The done branch sits in the delivery loop ABOVE the ripeness gate and above
// the ack, so a `done` arriving next to any other message used to be re-seen
// on every 300ms tick until the batch ripened. Measured on a real run against
// a Flutter repo: one declare_done ran commit + tests + two diffs 131 times
// and queued 131 digest turns onto the briefer.
const fakeOrchestrator = new FakeAgent();
fakeOrchestrator.busy = true;              // so the batch can never ripen
k2.agents.get('orchestrator')?.stop();
k2.agents.set('orchestrator', fakeOrchestrator);

let verified = 0;
k2.on('verified', () => verified++);
k2.bus.post('coder', 'orchestrator', 'I have finished the thing', 'done');
k2.bus.post('coder', 'orchestrator', 'and here is a note about it');
// Wait for the first verification, THEN sit through ~10 more ticks: the defect
// was a re-verify on every tick, so the duplicates arrive after the first one.
await until(() => verified > 0);
await wait(3000);

a.equal(verified, 1, `a declare_done must be verified exactly once, got ${verified}`);

// --- the backstop must never clamp the settle window ------------------
// Ripeness is `(idle && quiet for settleMs) || older than BATCH_MAX_WAIT_MS`.
// If the backstop is the smaller of the two it wins every time, the window is
// silently capped at it, and tuning the window changes nothing — a config that
// looks tuned and is not. The guard is in #deliver, so drive a real delivery.
{
  const errs = [];
  k2.on('error', (e) => errs.push(e));
  process.env.KINGDOM_SETTLE_MS = String(10 * 60_000);   // far above the backstop
  k2.bus.post('coder', 'orchestrator', 'wake the delivery loop');
  await until(() => errs.length > 0);
  process.env.KINGDOM_SETTLE_MS = '400';

  a.ok(errs.some((e) => /must exceed the settle window/.test(e.message)),
    'a settle window wider than BATCH_MAX_WAIT_MS must be reported, not silently clamped');
}

// --- awareness must never buy a turn ----------------------------------
// Nine sites post "AWARENESS ..." to a member; eight passed 'notice' and one
// did not, so a message whose own text says TAKE NO ACTION bought the orchestrator a
// full context replay to do nothing. Nothing caught it, because each site
// reads fine on its own — the defect is only visible across all of them.
{
  const src = readFileSync(join(HERE, '..', 'src', 'kingdom.js'), 'utf8');
  const posts = src.match(/this\.bus\.post\([\s\S]*?\);/g) ?? [];
  const awareness = posts.filter((p) => /AWARENESS/.test(p));
  a.ok(awareness.length >= 8, `expected the awareness posts to be found, got ${awareness.length}`);
  for (const p of awareness) {
    a.ok(/'notice'\s*\)\s*;$/.test(p.trim()) || /,\s*'notice'/.test(p),
      `an AWARENESS post must be sent as 'notice' so it rides along instead of `
      + `buying a turn:\n${p.slice(0, 180)}`);
  }
}

// --- one member's spawn must never hold up everyone else's mail --------
//
// Delivery runs inside a single `ticking` critical section, and it used to
// `await this.#spawn(name)` inline. Two consequences, both fixed by starting
// the spawn and letting a later tick deliver:
//
//   1. SLOW: waking a peasant validates its worktree (several git subprocesses,
//      ~100ms each on Windows) while every other member's mail waited.
//   2. WEDGED: a spawn that THREW took the whole pass with it, so nobody after
//      it in the loop was delivered — that tick or any tick after it, if the
//      failure was persistent. "Degrade, never wedge."
//
// A member in `summoned` with no spec in the config makes #spawn throw
// deterministically, which is the cheapest way to prove the second.
{
  const errs = [];
  k2.on('error', (e) => errs.push(e));

  // 'ghost' is summoned but does not exist, and is inserted FIRST so the
  // delivery loop reaches it before the awake member (both rank as peasants,
  // and the sort is stable, so insertion order decides).
  k2.summoned.delete('coder');
  k2.summoned.add('ghost');
  k2.summoned.add('coder');
  const live = new FakeAgent();
  k2.agents.set('coder', live);

  k2.bus.post('orchestrator', 'ghost', 'you do not exist');
  k2.bus.post('orchestrator', 'coder', 'but you do, and this must still arrive');
  // Both, not just the delivery: the spawn now fails asynchronously, so its
  // error can land after the message it must not have blocked.
  await until(() => live.sent.length > 0
    && errs.some((e) => /No such member/.test(e.message)));

  a.equal(live.sent.length, 1,
    'a member behind a FAILING spawn must still be delivered — the old inline '
    + 'await threw out of the whole pass and starved everyone after it');
  a.match(live.sent[0], /but you do/);
  a.ok(errs.some((e) => /No such member/.test(e.message)),
    'and the failure must still be reported, not swallowed');

  k2.summoned.delete('ghost');
}

// --- concurrent wakes must produce ONE agent, not a spawn cascade ------
//
// #doSpawn awaits createWorktree before it ever reaches `agents.set`, so an
// `agents.has` check at the top is not a lock: two callers both pass it and
// both run `git worktree add` on the same path. That cascade has happened here
// before. Now delivery no longer awaits and approved crews spawn in parallel,
// so there are more ways in — the dedupe lives in #spawn itself.
{
  k2.agents.delete('coder');
  const [a1, a2, a3] = await Promise.all([k2.wake('coder'), k2.wake('coder'), k2.wake('coder')]);
  a.ok(a1, 'a concurrent wake must still return the agent');
  a.equal(a1, a2, 'every concurrent caller must get the SAME agent');
  a.equal(a2, a3);
  a.equal(k2.agents.get('coder'), a1, 'and it must be the one in the roster');
  a.equal(k2.spawning.size, 0, 'the in-flight record must be cleared when the spawn settles');
}

await k2.stop();
for (const d of [repo, kingdomDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-batching.js OK — messages coalesce, busy agents spared, notices ride along, '
  + 'a failing spawn cannot starve the court');
