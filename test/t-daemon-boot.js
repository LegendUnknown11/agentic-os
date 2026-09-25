// A repo attached LIVE (POST /api/attachRepo, or the UI's picker) is meant to
// stay at the workspace home forever — see worktree.js's kingdomDir doc
// comment and Kingdom#attachRepo. But daemon.js's own boot-time resolution
// used to re-derive configPath (and, through the Kingdom constructor,
// dbPath) from the rediscovered repo whenever no repo was named on the CLI —
// so a plain restart after a live attach silently forked into a SECOND,
// empty kingdom living in a repo-relative .kingdom/<repoName>/ directory,
// leaving the goal/roster/vault the sovereign actually set behind in the
// workspace home nobody was reading from anymore.
//   node test/t-daemon-boot.js
// Never let a daemon this suite spawns touch the real ~/.kingdom/courts.json
// on the machine running the tests — see test/t-registry-isolation.js.
import './isolate-registry.js';
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kingdomDir } from '../src/worktree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 7951 + (process.pid % 40);
const base = `http://127.0.0.1:${PORT}`;

// Sandbox the home directory the daemon subprocess resolves its workspace
// config/db against, same trick as t-repo-optional.js — os.homedir() reads
// these at call time, so setting them on the child's env is enough.
const fakeHome = mkdtempSync(join(tmpdir(), 'kingdom-home-'));
const childEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };

const repo = mkdtempSync(join(tmpdir(), 'kingdom-daemon-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const up = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) return true; } catch {}
    await wait(250);
  }
  return false;
};

const snapshot = async () => {
  const res = await fetch(`${base}/stream`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
};

let d1, d2;
try {
  /* ---------- 1. first boot, no CLI repo — attach one live, like the UI --- */
  d1 = spawn(process.execPath, [join(HERE, '..', 'src', 'daemon.js'), '--port', String(PORT)],
    { stdio: 'ignore', env: childEnv });
  a.ok(await up(), 'first boot must come up with no repo on the command line');

  let ping = await fetch(`${base}/api/ping`).then((r) => r.json());
  a.equal(ping.repo, null, 'nothing attached yet');

  const attached = await fetch(`${base}/api/attachRepo`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repo }),
  }).then((r) => r.json());
  a.equal(attached.ok, true, 'attachRepo must succeed against a real git repo');
  a.equal(attached.repo, resolve(repo), 'attachRepo must return the daemon-canonical repository path');
  a.ok(attached.base, 'attachRepo must return the discovered base branch');

  await fetch(`${base}/api/goal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'daemon-boot regression check' }),
  });

  const createdRun = await fetch(`${base}/api/run/create`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'run-daemon', objective: 'daemon run controls', acceptanceCriteria: ['tests'] }),
  }).then((r) => r.json());
  a.equal(createdRun.run.state, 'planning', 'run creation must persist a planning record');
  a.equal((await fetch(`${base}/api/run`).then((r) => r.json())).run.id, 'run-daemon',
    'the current run endpoint must expose the durable record');
  const forgedBaseline = 'forged-revision-that-must-never-land';
  const approvedRun = await fetch(`${base}/api/run/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'run-daemon', baselineRevision: forgedBaseline }),
  }).then((r) => r.json());
  a.equal(approvedRun.run.state, 'running');
  a.equal(approvedRun.run.baselineRevision, createdRun.run.baselineRevision,
    'run/approve must never let a client-supplied baselineRevision overwrite the one captured at creation');
  a.notEqual(approvedRun.run.baselineRevision, forgedBaseline,
    'the captured baseline is the only safeguard Final Apply has against a since-changed source tree');
  a.equal((await fetch(`${base}/api/run/pause`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'run-daemon' }),
  }).then((r) => r.json())).run.state, 'paused');
  a.equal((await fetch(`${base}/api/run/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'run-daemon' }),
  }).then((r) => r.json())).run.state, 'running');
  a.equal((await fetch(`${base}/api/run/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'run-daemon' }),
  }).then((r) => r.json())).run.state, 'cancelled');

  ping = await fetch(`${base}/api/ping`).then((r) => r.json());
  a.equal(ping.repo, resolve(repo), 'the live attach must show up immediately');

  d1.kill();
  await wait(300);
  d1 = null;

  a.equal(existsSync(join(kingdomDir(repo), 'kingdom.config.json')), false,
    'a live attach must never create a repo-relative config — state stays at the workspace home');

  /* ---------- 2. second boot, still no CLI repo — must rediscover it ------ */
  d2 = spawn(process.execPath, [join(HERE, '..', 'src', 'daemon.js'), '--port', String(PORT)],
    { stdio: 'ignore', env: childEnv });
  a.ok(await up(), 'second boot (a plain restart) must come up');

  ping = await fetch(`${base}/api/ping`).then((r) => r.json());
  a.equal(ping.repo, resolve(repo),
    'a restart must rediscover the previously-attached repo, not come up with none');
  a.ok(ping.base, 'rediscovery must run the same attach as the UI would, base branch included');

  const snap = await snapshot();
  a.equal(snap.goal?.text, 'daemon-boot regression check',
    'the goal set before the restart must still be there — proof both boots share one home');

  a.equal(existsSync(join(kingdomDir(repo), 'kingdom.config.json')), false,
    'a restart must not fork into a second, repo-relative kingdom either');

  console.log('  live attachRepo state never leaves the workspace home');
  console.log('  a plain restart rediscovers the same repo and the same goal, not a fresh empty kingdom');
  console.log('t-daemon-boot.js OK — a repo attached live survives a restart in the same home');
} finally {
  d1?.kill();
  d2?.kill();
  await wait(300);
  try { rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  try { rmSync(kingdomDir(repo), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
}
