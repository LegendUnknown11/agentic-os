// Two real daemon processes, one court registry between them (issue #42):
// a second repo gets its own daemon on an automatically-picked free port, a
// SECOND daemon for the SAME repo is refused and names the port already
// serving it, and a daemon pinned to a busy port fails cleanly instead of
// silently binding somewhere else.
//   node test/t-multi-court.js
// Never let a daemon this suite spawns touch the real ~/.kingdom/courts.json
// on the machine running the tests — see test/t-registry-isolation.js.
import './isolate-registry.js';
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestShutdown } from '../electron/courts-launch.js';
import { removeRepo } from './cleanup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, '..', 'src', 'daemon.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Both daemons share ONE fake home, so they see the SAME ~/.kingdom/courts.json
// — the whole point of this test. Each still gets its own repo-relative
// .kingdom (worktree.js's kingdomDir), since both are named on the command
// line, so there is no cross-talk between their actual court state.
const fakeHome = mkdtempSync(join(tmpdir(), 'kingdom-mc-home-'));
// Its own port range, so a parallel suite auto-picking from 7777 with its own
// isolated registry can never answer this suite's pings.
const BASE = 17777;
const childEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, KINGDOM_BASE_PORT: String(BASE) };

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `kingdom-mc-${name}-`));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git('add', '-A');
  git('commit', '-qm', 'init');
  return repo;
}

const repoA = makeRepo('a');
const repoB = makeRepo('b');

/** Spawn a daemon and capture its stderr, without a --port (auto-pick). */
function spawnAuto(repo) {
  const proc = spawn(process.execPath, [DAEMON, repo], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  return { proc, stderrOf: () => stderr };
}

async function pingUntil(port, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (r.ok) {
        const j = await r.json();
        if (predicate ? predicate(j) : true) return j;
      }
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error(`nothing usable answered on ${port} within ${timeoutMs}ms`);
}

/** 'close' rather than 'exit': exit can fire before stderr has fully
 *  drained, and the whole point of this wait is to read that stderr. */
function waitForExit(proc, timeoutMs = 10_000) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), timeoutMs);
    proc.on('close', (code) => { clearTimeout(timer); resolvePromise(code); });
  });
}

let A, B, pinnedConflict;
try {
  // ---- 1. first court, no --port: auto-picks the base port (BASE unless
  // something on this machine already holds it, which the registry itself
  // would then have caused this test to skip past correctly). ----
  A = spawnAuto(repoA);
  const readyA = await pingUntil(BASE, (j) => j.ok);
  a.equal(readyA.ok, true, 'first auto-started court comes up on the base port');

  // ---- 2. second repo, also no --port: must land on the NEXT free port,
  // not collide with the first. ----
  B = spawnAuto(repoB);
  const readyB = await pingUntil(BASE + 1, (j) => j.ok);
  a.equal(readyB.ok, true, 'second court auto-picks the next free port');
  a.notEqual(BASE + 1, BASE, 'sanity: the two ports really differ');

  // ---- 3. a THIRD daemon for repoA (already live on BASE) must be refused,
  // not started on some other port instead — one repo, one live court. ----
  const dupe = spawnAuto(repoA);
  const dupeExit = await waitForExit(dupe.proc, 15_000);
  a.notEqual(dupeExit, 0, 'a second daemon for an already-live repo must exit non-zero');
  a.match(dupe.stderrOf(), new RegExp(`already has a live workspace on port ${BASE}`),
    'the refusal must name the port the repo is already served on');

  // ---- 4. a daemon PINNED (--port) to a port already in use must fail
  // cleanly, not silently rebind elsewhere. ----
  pinnedConflict = spawn(process.execPath, [DAEMON, repoB, '--port', String(BASE + 1)],
    { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let pinnedStderr = '';
  pinnedConflict.stderr.on('data', (d) => { pinnedStderr += d; });
  const pinnedExit = await waitForExit(pinnedConflict, 15_000);
  a.notEqual(pinnedExit, 0, 'a daemon pinned to a busy port must exit non-zero');
  a.match(pinnedStderr, new RegExp(`port ${BASE + 1} is already in use`), 'a busy pinned port names itself in the error');

  // ---- 5. ending a court through the shell's own request must actually end
  // it. The daemon 415s any POST /api/* without a JSON content type, and a
  // bare fetch() resolves on that 415 — the old "End court" reported success
  // while the daemon kept serving. ----
  const bare = await fetch(`http://127.0.0.1:${BASE + 1}/api/shutdown`, { method: 'POST' });
  a.equal(bare.status, 415, 'sanity: a headerless shutdown POST is refused by the daemon');
  const down = await requestShutdown(`http://127.0.0.1:${BASE + 1}`);
  a.equal(down.ok, true, 'requestShutdown must be accepted by a real daemon');
  a.notEqual(await waitForExit(B.proc, 15_000), null, 'the court must actually exit after requestShutdown');

  console.log('t-multi-court.js OK — one live court per repo, auto ports avoid collision, a busy pinned port refuses cleanly, and ending a court really ends it');
} finally {
  for (const p of [A?.proc, B?.proc]) { try { p?.kill('SIGKILL'); } catch {} }
  await wait(300);
  removeRepo(repoA, repoB);
  rmSync(fakeHome, { recursive: true, force: true });
}
