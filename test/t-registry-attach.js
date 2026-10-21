// A LIVE attach (POST /api/attachRepo, or the saved-repo re-attach at boot)
// changes what repository a daemon serves — and must claim that repo in the
// courts registry (src/courts.js) exactly like a fresh daemon does, or two
// daemons can end up serving the SAME repository with no refusal: a repo-
// less daemon simply attaches whatever it is given, since Kingdom#attachRepo
// only refuses a repo DIFFERENT from one it already holds. This is the
// registry-side half of issue #42 that starting fresh alone does not cover.
//   node test/t-registry-attach.js
// Never let a daemon this suite spawns touch the real ~/.kingdom/courts.json
// on the machine running the tests — see test/t-registry-isolation.js.
import './isolate-registry.js';
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeRepo } from './cleanup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, '..', 'src', 'daemon.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Both daemons share one fake home, so they see the SAME
// ~/.kingdom/courts.json — the whole point of this test — the same trick
// t-multi-court.js and t-daemon-boot.js use.
const fakeHome = mkdtempSync(join(tmpdir(), 'kingdom-ra-home-'));
// Its own port range: parallel suites each have an isolated registry, so two
// suites auto-picking from 7777 would otherwise answer each other's pings.
const BASE = 17877;
const childEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, KINGDOM_BASE_PORT: String(BASE) };

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `kingdom-ra-${name}-`));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git('add', '-A');
  git('commit', '-qm', 'init');
  return repo;
}

async function pingReady(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (r.ok) { const j = await r.json(); if (j.ok) return j; }
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error(`nothing usable answered on ${port} within ${timeoutMs}ms`);
}

// Same precedence src/courts.js's own registryPath() uses: an explicit
// KINGDOM_COURTS_REGISTRY (set by test/run-all.js's per-suite isolation, or
// by test/isolate-registry.js's standalone fallback imported above) wins
// over the HOME-derived path — this must read from wherever the daemons
// spawned below actually write to, whichever that turns out to be.
const registryPath = () => process.env.KINGDOM_COURTS_REGISTRY ?? join(fakeHome, '.kingdom', 'courts.json');
async function registryRows() {
  try { return JSON.parse(readFileSync(registryPath(), 'utf8')).courts; } catch { return []; }
}

const repoA = makeRepo('a');
const repoC = makeRepo('c');

let A, B;
try {
  // A: a real court already serving repoA, on the base auto-picked port.
  A = spawn(process.execPath, [DAEMON, repoA], { env: childEnv, stdio: 'ignore' });
  const readyA = await pingReady(BASE);
  a.equal(readyA.repo, repoA, 'sanity: court A really is serving repoA');

  // B: a repo-less court, e.g. Chat/Cowork with nothing attached yet, on the
  // next auto-picked port.
  B = spawn(process.execPath, [DAEMON], { env: childEnv, stdio: 'ignore' });
  const readyB = await pingReady(BASE + 1);
  a.equal(readyB.repo, null, 'sanity: court B really did start with no repository');

  // --- attaching a repo ALREADY served elsewhere must be refused, and must
  // NOT touch B's registry row --------------------------------------------
  const before = await registryRows();
  const rowBBefore = before.find((c) => c.port === BASE + 1);
  a.equal(rowBBefore?.repo ?? null, null, 'sanity: B\'s registry row starts with repo: null');

  const conflictResult = await fetch(`http://127.0.0.1:${BASE + 1}/api/attachRepo`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoA }),
  }).then((r) => r.json());
  a.equal(conflictResult.ok, false, 'attaching a repo another live court already serves must be refused');
  a.match(conflictResult.error, new RegExp(`already has a live workspace on port ${BASE}`),
    'the refusal must name the port the OTHER court is already on');

  const stillRepoless = await fetch(`http://127.0.0.1:${BASE + 1}/api/ping`).then((r) => r.json());
  a.equal(stillRepoless.repo, null, 'a refused attach must leave the daemon itself repo-less — kingdom.attachRepo must never have been called');

  const afterConflict = await registryRows();
  const rowBAfterConflict = afterConflict.find((c) => c.port === BASE + 1);
  a.equal(rowBAfterConflict?.repo ?? null, null,
    'a refused attach must leave B\'s registry row exactly as it was — no phantom claim on repoA');
  const rowAUnaffected = afterConflict.find((c) => c.port === BASE);
  a.equal(rowAUnaffected?.repo, repoA, 'court A\'s own row must be completely unaffected by the refused attempt on B');

  // --- attaching a genuinely free repo must succeed AND update the row ---
  const okResult = await fetch(`http://127.0.0.1:${BASE + 1}/api/attachRepo`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoC }),
  }).then((r) => r.json());
  a.equal(okResult.ok, true, 'attaching a repo nobody else holds must succeed');

  const nowAttached = await fetch(`http://127.0.0.1:${BASE + 1}/api/ping`).then((r) => r.json());
  a.equal(nowAttached.repo, repoC, 'the daemon itself must now report the newly attached repo');

  const afterOk = await registryRows();
  const rowBAfterOk = afterOk.find((c) => c.port === BASE + 1);
  a.equal(rowBAfterOk?.repo, repoC, 'a successful live attach must update the registry row for that port to the new repo');

  // --- and NOW a third daemon for repoA is still refused (A's own row
  // survived all of this untouched), while one for repoC is ALSO refused
  // (B now legitimately holds it) ------------------------------------------
  const dupeA = spawn(process.execPath, [DAEMON, repoA], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let dupeAErr = '';
  dupeA.stderr.on('data', (d) => { dupeAErr += d; });
  await new Promise((resolvePromise) => dupeA.on('close', resolvePromise));
  a.match(dupeAErr, new RegExp(`already has a live workspace on port ${BASE}`), 'repoA is still exclusively A\'s after all the attach traffic on B');

  const dupeC = spawn(process.execPath, [DAEMON, repoC], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let dupeCErr = '';
  dupeC.stderr.on('data', (d) => { dupeCErr += d; });
  await new Promise((resolvePromise) => dupeC.on('close', resolvePromise));
  a.match(dupeCErr, new RegExp(`already has a live workspace on port ${BASE + 1}`), 'repoC, now live-attached on B, refuses a second daemon too');

  console.log('t-registry-attach.js OK — a live attach claims the repo in the registry, refuses when another court already holds it, and rolls back on failure');
} finally {
  for (const p of [A, B]) { try { p?.kill('SIGKILL'); } catch {} }
  await wait(300);
  removeRepo(repoA, repoC);
  try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
}
