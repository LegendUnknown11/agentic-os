// The first evidence in this repository that is not source evidence.
//
// HANDOFF.md names this the single largest gap: PLAN.md's five sections are
// implemented and their acceptance clause is unmet, because nothing has ever
// demonstrated the interface in a real Electron session. t-pages.js and
// t-thread.js mount views against a hand-rolled fake DOM — they prove the
// render functions agree with themselves, never that the shipped app draws
// anything at all. This launches the actual Electron binary against a real
// daemon and a real repository, and reads what Chromium actually painted.
//
//   node test/t-electron.js
//
// WHY playwright-core AND NOT playwright. playwright downloads ~400MB of
// browser binaries on install. playwright-core downloads nothing: it drives a
// browser you already have, and `_electron.launch` drives the electron devDep
// that is already in this repo. One pure-JS devDep, no binaries, no native
// modules — the constraint README.md states for this whole project.
//
// WHY THE HOME DIRECTORY IS NOT SANDBOXED HERE, unlike t-daemon-boot.js.
// Overriding USERPROFILE/HOME kills Electron on Windows before the first
// window: Chromium resolves its user data directory through them and exits
// 0x80000003 when it cannot. Measured, not assumed — the launch dies right
// after `Debugger attached.` with no window. The sandbox comes from the repo
// argument instead: a daemon given a repo on argv puts its whole kingdom in
// <repoParent>/.kingdom/<repoName>/, and the repo here is a throwaway temp
// one, so nothing of the sovereign's is read or written. The one exception is
// ~/.kingdom/tokens.json, which is read; no agent is ever spawned here, so no
// token is ever used.
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Offset from t-daemon-boot.js's 7951 band so a 4-wide pool cannot collide.
const PORT = 7851 + (process.pid % 40);
const base = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------------ repo -- */

const repo = mkdtempSync(join(tmpdir(), 'kingdom-electron-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' }).toString().trim();
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# throne room acceptance\n');
git('add', '-A');
git('commit', '-qm', 'init');

/** POST an action the way the UI does — the origin header is what CSRF reads. */
const api = (path, body = {}) => fetch(`${base}/api/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify(body),
}).then((r) => r.json());

let app = null;
let failed = false;

/** One named acceptance check. Keeps going after a failure, so one run of this
 *  suite reports every gap instead of only the first. */
const check = async (what, fn) => {
  try {
    await fn();
    console.log(`  ok    ${what}`);
  } catch (e) {
    failed = true;
    console.error(`  FAIL  ${what}`);
    console.error(`        ${String(e.message).split('\n')[0]}`);
  }
};

try {
  /* ------------------------------------------------------------- launch -- */

  app = await _electron.launch({
    args: [ROOT, repo],
    // KINGDOM_SKIP_DOCTOR: no agent is ever spawned here (see the file
    // header), so the first-boot doctor redirect would be reporting on CLIs
    // this run never intends to authenticate — see src/daemon.js's
    // /api/doctor handler for why that redirect cannot be raced out safely.
    env: { ...process.env, KINGDOM_PORT: String(PORT), KINGDOM_SKIP_DOCTOR: '1' },
    // Cold Electron start plus a daemon boot plus git discovery.
    // electron/main.js allows the daemon alone 90s, so anything less here
    // measures the machine rather than the app.
    timeout: 120_000,
  });

  // The pet window (ui/pet.html) opens too and is frequently FIRST, so
  // firstWindow() is the wrong handle — it returned "HappyDog" every time
  // during development. Take the window that is not the pet.
  await app.firstWindow({ timeout: 120_000 });
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    page = app.windows().find((w) => !w.url().includes('pet.html')) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  a.ok(page, 'the throne room window must open');
  await page.waitForLoadState('domcontentloaded');

  const onScreen = (needle, timeout = 30_000) => page.waitForFunction(
    (t) => document.body.innerText.includes(t), needle, { timeout });

  /* ------------------------------------------- 1. the shell, as painted -- */

  console.log('shell');

  await check('the header names the attached repository and its branch', async () => {
    await onScreen(basename(repo));
    const head = await page.locator('body').innerText();
    a.ok(/\b(master|main)\b/.test(head), 'the base branch must be on screen');
  });

  await check('the stream is live, not merely requested', async () => {
    await onScreen('Connected');
  });

  await check('an objective-less court leads with the next step', async () => {
    await page.locator('.home-next-step').first().waitFor({ state: 'visible', timeout: 30_000 });
  });

  /* ------------------------------------------------ 2. the run lifecycle -- */
  //
  // Driven through the daemon's own HTTP actions rather than by clicking,
  // because what is unproven is that the INTERFACE follows the durable
  // record. Clicking would prove a button posts; this proves the painted
  // screen tracks the state machine HANDOFF.md draws.

  console.log('run lifecycle');

  const controls = () => page.locator('[aria-label="Run controls"]').first();
  const button = (label) => controls().locator('button', { hasText: label }).first();

  await check('a planning run reaches the screen and offers approval', async () => {
    const created = await api('run/create', {
      id: 'run-acceptance',
      objective: 'prove the interface follows the run',
      acceptanceCriteria: ['the screen tracks the state machine'],
    });
    a.equal(created.run.state, 'planning', 'the daemon must record a planning run');
    await onScreen('Planning');
    await onScreen('prove the interface follows the run');
    await button('Approve plan').waitFor({ state: 'visible', timeout: 15_000 });
  });

  await check('approving the plan repaints as Running, with pause and stop', async () => {
    await api('run/approve', { id: 'run-acceptance', baselineRevision: git('rev-parse', 'HEAD') });
    await onScreen('Running');
    await button('Pause').waitFor({ state: 'visible', timeout: 15_000 });
    await button('Stop').waitFor({ state: 'visible', timeout: 15_000 });
  });

  await check('pausing repaints as Paused and offers Resume', async () => {
    await api('run/pause', { id: 'run-acceptance', why: 'acceptance check' });
    await onScreen('Paused');
    await button('Resume').waitFor({ state: 'visible', timeout: 15_000 });
  });

  await check('resuming returns the screen to Running', async () => {
    await api('run/resume', { id: 'run-acceptance' });
    await onScreen('Running');
  });

  await check('stopping repaints as Cancelled', async () => {
    await api('run/stop', { id: 'run-acceptance', why: 'acceptance check complete' });
    await onScreen('Cancelled');
  });
} finally {
  // The daemon is DETACHED (electron/main.js says so on purpose), so closing
  // the window would leave it holding the port and the temp kingdom forever.
  try { await api('shutdown'); } catch { /* already gone */ }
  try { await app?.close(); } catch { /* already gone */ }
  try { rmSync(join(repo, '..', '.kingdom'), { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
  try { rmSync(repo, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
}

if (failed) {
  console.error('\nlive interface acceptance FAILED');
  process.exit(1);
}
console.log('\nlive interface acceptance passed');
