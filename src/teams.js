// The team registry: one row per live daemon, so more than one repository
// can be open at once (issue #42) without two daemons ever colliding on a
// port or a user losing track of which team is which.
//
// One daemon PROCESS per repository is unchanged — AgenticOS#attachRepo still
// refuses a second repo inside a live process (src/agenticos.js:1546), and
// that stays true. What changes is that starting a NEW process for a
// DIFFERENT repository is now supported: this module is how each daemon
// announces itself, how a launcher finds a free port, and how a stale entry
// (crashed daemon, killed -9, reused pid) gets pruned instead of haunting
// the registry forever.
//
// Convention match: `~/.agenticos/tokens.json` is the existing out-of-tree,
// global (not per-repo) file — see src/worktree.js's globalTokenStore(). This
// registry sits right beside it, same directory, same "never inside a
// tracked repo" rule.
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { LEGACY } from './legacy.js';
import { join, dirname, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';

/** Overridable for tests, the same way AGENTICOS_TOKEN_STORE overrides the
 *  token file — never read by real callers, only by test/t-teams.js. */
export function registryPath() {
  return process.env.AGENTICOS_TEAMS_REGISTRY
    ?? join(homedir(), '.agenticos', 'teams.json');
}

const LOCK_STALE_MS = 5_000; // a crashed holder's lock dir older than this is stolen, not waited on
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 3_000;

/**
 * Acquire an exclusive lock around a read-modify-write of the registry.
 * A lock is a DIRECTORY, not a file: `mkdir` either atomically succeeds or
 * atomically fails with EEXIST on every OS this app ships to (POSIX and
 * Windows both), which a "create file if absent" pattern cannot promise
 * everywhere. A lock older than LOCK_STALE_MS is assumed to belong to a
 * process that crashed while holding it and is stolen rather than honoured
 * forever.
 */
async function withLock(path, fn) {
  const lockDir = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = Infinity;
      try { age = Date.now() - statSync(lockDir).mtimeMs; } catch { age = Infinity; }
      if (age > LOCK_STALE_MS) {
        try { rmSync(lockDir, { recursive: true, force: true }); continue; } catch { /* raced; loop */ }
      }
      if (Date.now() > deadline) throw new Error('teams registry: lock held too long, giving up');
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function readRegistryRaw(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // A registry written before the rename keeps its rows under the old key.
    const rows = parsed?.teams ?? parsed?.[LEGACY.registryKey];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Atomic write: write to a sibling temp file, then rename over the target.
 *  `rename` is atomic on the same filesystem on every OS this app ships to,
 *  so a reader never observes a half-written registry. */
function writeRegistryRaw(path, teams) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.teams.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify({ teams }, null, 2));
  renameSync(tmp, path);
}

// ---- pure helpers (self-checked below, no I/O) -----------------------------

/**
 * The identity of a checkout, not of the string naming it. One checkout can
 * be reached as `C:\\Repo`, `c:\\repo`, an 8.3 short name, or through a
 * junction or symlink — and one-team-per-repo only holds if all of those
 * compare equal. realpath (native, as src/worktree.js already uses) resolves
 * links and short names for a path that exists; Windows and macOS file
 * systems are case-insensitive by default, so their keys are case-folded.
 * A path that does not exist falls back to resolve(), so a pure caller (the
 * self-check below, or a team whose repo was deleted) still compares sanely.
 */
export function repoKey(p, platform = process.platform) {
  if (p == null || p === '') return '';
  let full = resolve(String(p));
  try { full = realpathSync.native(full); } catch { /* not on disk: keep the resolved path */ }
  full = full.replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? full.toLowerCase() : full;
}

/** Two entries are the same repository when their checkout keys match. */
export function sameRepo(a, b, platform = process.platform) {
  const ka = repoKey(a, platform);
  return ka !== '' && ka === repoKey(b, platform);
}

/** First free port at or after `start`, skipping every port already
 *  occupied by a live entry. `isFree` is injected so the self-check never
 *  binds a real socket; real callers pass tryBindPort below. */
export async function pickFreePort(start, liveTeams, isFree) {
  const taken = new Set(liveTeams.map((c) => c.port));
  for (let port = start; port < start + 500; port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port found starting from ${start}`);
}

export function findTeamForRepo(teams, repo) {
  return teams.find((c) => sameRepo(c.repo, repo)) ?? null;
}

// ---- I/O (real pid liveness, real ping, real socket bind) ------------------

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only, sends nothing
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, just not ours to signal
  }
}

/** Does `port` answer /api/ping and, if `repo` is given, agree it is serving
 *  that repository? A pid can be alive while the port serves someone else
 *  entirely (pid reuse) or nothing at all (still booting, or wedged) —
 *  ping is the fact that actually matters, pid liveness is only the cheap
 *  first filter. */
// 1.5s, not the 800ms first tried here: under this repo's own 4-wide test
// pool (test/run-all.js), a stub HTTP server that answers instantly when run
// alone was seen timing out at 800ms under real CPU contention from
// neighbouring suites — the same class of flakiness test/run-all.js already
// documents for `team self-control`, not a bug in this module. Measured:
// the retry-alone run that exposed it took under 40ms once the pool drained.
export function pingTeam(port, repo, { timeoutMs = 1500 } = {}) {
  return new Promise((resolvePromise) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/ping', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolvePromise(repo ? sameRepo(j.repo, repo) : true);
        } catch { resolvePromise(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolvePromise(false); });
    req.on('error', () => resolvePromise(false));
    req.end();
  });
}

/** True if a TCP listener can bind `port` on loopback right now. Bind-and-
 *  release rather than a plain "connect and see" probe: a port refusing
 *  connections is not necessarily free (a wedged process can still hold
 *  it), and this is the same test the real daemon is about to perform. */
export function tryBindPort(port) {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.once('error', () => resolvePromise(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolvePromise(true)));
  });
}

/** Ping every row in parallel, OUTSIDE the registry lock. A lock held across
 *  network waits can outlive LOCK_STALE_MS (a few unresponsive teams at
 *  1.5s each) and be stolen mid read-modify-write; the lock now only ever
 *  covers a file read and write. Keyed by port+pid+repo so a verdict can only
 *  ever apply to the exact row it was taken for. The repository claim is part
 *  of the key: a live attach (or its rollback) rewrites a row's repo while
 *  keeping its port and pid, and a verdict pinged for the old claim must not
 *  be applied to the new one. */
export const rowKey = (c) => `${c.port}:${c.pid}:${c.repo ?? ''}`;
async function verdictsFor(teams, isOwnRow = () => false) {
  const verdicts = new Map();
  await Promise.all(teams.map(async (c) => {
    verdicts.set(rowKey(c), isOwnRow(c) ? false : isPidAlive(c.pid) && await pingTeam(c.port, c.repo));
  }));
  return verdicts;
}
/** Rows the snapshot proved dead are dropped; rows written after the
 *  snapshot (another launch registering meanwhile) have no verdict and are
 *  kept — a fresh claim is never discarded for not having been pinged yet. */
export const keepLive = (teams, verdicts) => teams.filter((c) => verdicts.get(rowKey(c)) !== false);

/** Read the registry and drop every entry that is no longer a live team:
 *  dead pid, or a port that does not answer /api/ping for that repo. The
 *  pruned list is written back so the file self-heals on every read rather
 *  than accreting corpses. */
export async function listTeams() {
  const verdicts = await verdictsFor(readRegistryRaw(registryPath()));
  return withLock(registryPath(), async () => {
    const teams = readRegistryRaw(registryPath());
    const live = keepLive(teams, verdicts);
    if (live.length !== teams.length) writeRegistryRaw(registryPath(), live);
    return live;
  });
}

export class TeamConflictError extends Error {
  constructor(existing) {
    super(`${existing.repo} already has a live workspace on port ${existing.port}.`);
    this.existing = existing;
  }
}

/**
 * Called by a daemon right after it binds its port, before it starts doing
 * real work. Refuses (TeamConflictError) if this repository already has a
 * live team elsewhere — the caller (daemon.js) must then exit rather than
 * serve a second, conflicting daemon for the same repo. Safe against two
 * launches racing: both take the same lock, so only one wins the register
 * and the loser sees the winner's entry in `existing`.
 */
export async function registerTeam({ repo, port, pid, startedAt = new Date().toISOString() }) {
  // never trust our own stale row: it is about to be replaced
  const verdicts = await verdictsFor(readRegistryRaw(registryPath()), (c) => c.pid === pid && c.port === port);
  return withLock(registryPath(), async () => {
    const live = keepLive(readRegistryRaw(registryPath()), verdicts);
    const existing = findTeamForRepo(live, repo);
    if (existing && existing.port !== port) throw new TeamConflictError(existing);
    const next = [...live.filter((c) => c.port !== port), { repo, port, pid, startedAt }];
    writeRegistryRaw(registryPath(), next);
    return { repo, port, pid, startedAt };
  });
}

/** Called on daemon shutdown so a clean exit leaves no corpse for the next
 *  listTeams() to have to detect and prune itself. Best-effort: shutdown
 *  paths (SIGTERM, uncaughtException) must not be blocked by this. */
export async function unregisterTeam({ port, pid }) {
  return withLock(registryPath(), async () => {
    const teams = readRegistryRaw(registryPath());
    const next = teams.filter((c) => !(c.port === port && c.pid === pid));
    if (next.length !== teams.length) writeRegistryRaw(registryPath(), next);
  });
}

/** First free port from `start` upward that no live team occupies AND that
 *  a real socket can actually bind — the two-step real callers need. */
export async function firstFreePort(start, liveTeams) {
  return pickFreePort(start, liveTeams, tryBindPort);
}

// ---- self-check -------------------------------------------------------------
if (basename(process.argv[1] ?? '') === 'teams.js') {
  const assert = (cond, msg) => { if (!cond) throw new Error(`teams.js self-check failed: ${msg}`); };

  assert(sameRepo('/a/b', '/a/b/'), 'trailing slash should still match');
  assert(sameRepo('/a/b', '/a/b'), 'identical paths should match');
  assert(!sameRepo('/a/b', '/a/c'), 'different paths must not match');
  assert(!sameRepo(null, '/a/b'), 'null repo must not match a real one');
  assert(sameRepo('C:\\Repo\\App', 'c:\\repo\\app', 'win32'), 'Windows paths differing only in case are one checkout');
  assert(!sameRepo('/Repo/App', '/repo/app', 'linux'), 'Linux paths differing in case are different checkouts');

  const teams = [{ repo: '/r1', port: 7777 }, { repo: '/r2', port: 7778 }, { repo: '/r3', port: 7779 }];
  const rows = teams.map((c) => ({ ...c, pid: 1 }));
  const verdicts = new Map([[rowKey(rows[0]), true], [rowKey(rows[1]), false]]);
  const kept = keepLive(rows, verdicts);
  assert(kept.length === 2 && kept.every((c) => c.port !== 7778),
    'a row proved dead is dropped; a row with no verdict (registered after the snapshot) is kept');

  assert(findTeamForRepo(teams, '/r2').port === 7778, 'findTeamForRepo should find an exact match');
  assert(findTeamForRepo(teams, '/nope') === null, 'findTeamForRepo should return null for a miss');

  const busy = new Set([7777, 7778]);
  await (async () => {
    const port = await pickFreePort(7777, teams, async (p) => !busy.has(p) && p !== 7779);
    assert(port === 7780, `expected 7780, got ${port}`);
  })();

  await (async () => {
    // every port claimed forces the search to fail rather than loop forever
    let threw = false;
    try { await pickFreePort(1, [], async () => false); } catch { threw = true; }
    assert(threw, 'an exhausted port search must throw, not hang');
  })();

  // Real I/O round trip against a throwaway registry file, exercising the
  // lock, the atomic write, and the conflict refusal end to end.
  await (async () => {
    const { mkdtempSync, rmSync: rm } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'teams-selfcheck-'));
    const prevOverride = process.env.AGENTICOS_TEAMS_REGISTRY;
    process.env.AGENTICOS_TEAMS_REGISTRY = join(dir, 'teams.json');
    // registerTeam re-verifies every existing row by actually pinging it
    // (a dead entry must not block a real conflict check), so the self-check
    // needs a real listener standing in for "the other team" to be honest
    // about what production does.
    const stub = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, repo: '/selfcheck/repo-a' }));
    });
    await new Promise((r) => stub.listen(19001, '127.0.0.1', r));
    try {
      const a = await registerTeam({ repo: '/selfcheck/repo-a', port: 19001, pid: process.pid });
      assert(a.port === 19001, 'registerTeam should echo back the port it stored');

      let conflict = null;
      try { await registerTeam({ repo: '/selfcheck/repo-a', port: 19002, pid: process.pid }); }
      catch (e) { conflict = e; }
      assert(conflict instanceof TeamConflictError, 'a second port for the same live repo must be refused');
      assert(conflict.existing.port === 19001, 'the refusal should name the existing port');

      // Same port re-registering (a restart claiming the port back) must not
      // conflict with itself.
      const again = await registerTeam({ repo: '/selfcheck/repo-a', port: 19001, pid: process.pid });
      assert(again.port === 19001, 're-registering the same repo/port should succeed');

      await unregisterTeam({ port: 19001, pid: process.pid });
      const after = JSON.parse(readFileSync(process.env.AGENTICOS_TEAMS_REGISTRY, 'utf8'));
      assert(after.teams.length === 0, 'unregisterTeam should remove the entry');
    } finally {
      await new Promise((r) => stub.close(r));
      if (prevOverride === undefined) delete process.env.AGENTICOS_TEAMS_REGISTRY;
      else process.env.AGENTICOS_TEAMS_REGISTRY = prevOverride;
      rm(dir, { recursive: true, force: true });
    }
  })();

  console.log('teams.js: self-check passed');
}
