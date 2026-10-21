// Thin shell. All the real work happens in the daemon (own Node 24 process,
// because Electron's bundled Node has no node:sqlite).
//
// The daemon is DETACHED on purpose: an agentic team runs for hours, and
// closing a window must not kill work in progress. This window is a viewer.
// Launching again re-attaches to the team that is already running; to end it
// for real, use "end team" in the dashboard.
import '../src/legacy-boot.js'; // first: legacy env fallback and home migration, before any module reads env
import { app, BrowserWindow, dialog, session, ipcMain, screen, shell } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { openSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRepo } from '../src/worktree.js';
import { migrateUserData } from '../src/legacy.js';
import { switchRepo } from './switch-repo.js';
import { listTeams } from '../src/teams.js';
import { routeLaunch, requestShutdown, firstLaunchPlan, teamPortOf } from './teams-launch.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// userData is named after package.json's name, which the rename changed, so
// pet.json and daemon.log move with it once. Top level, before anything
// (requestSingleInstanceLock, the ready event) makes Electron create the new
// folder: an existing new folder wins and the old one is left alone.
try {
  const appData = app.getPath('appData');
  const userData = app.commandLine.getSwitchValue('user-data-dir') || join(appData, app.getName());
  migrateUserData(appData, resolve(userData));
} catch (e) { console.warn(`[agenticos] app data migration skipped: ${e.message}`); }
const PORT = Number(process.env.AGENTICOS_PORT ?? 7777);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Who, if anyone, is already holding the port. */
async function teamOnPort(origin = ORIGIN) {
  try {
    const r = await fetch(`${origin}/api/ping`, { signal: AbortSignal.timeout(1200) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** A repo named on the command line (or packaged app arg), if it's a real one.
 *  Takes an explicit argv so app.on('second-instance')'s argv can be checked
 *  the same way the app's own launch argv is — see routeLaunch() below. */
function repoFromArgv(argv = process.argv) {
  const fromArgv = argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  return fromArgv && existsSync(join(fromArgv, '.git')) ? resolve(fromArgv) : null;
}

/**
 * One BrowserWindow per live team, keyed by the port it is serving —
 * multiple teams at once (issue #42). The default launch still opens PORT
 * (pinned by AGENTICOS_PORT or 7777) exactly as before; every OTHER team a
 * launch or the teams switcher opens gets its own entry here instead of
 * replacing anything.
 */
const teamWindows = new Map(); // port -> { win, origin }
const originFor = (port) => `http://127.0.0.1:${port}`;

/**
 * The native folder picker, on demand — Code mode asks for this through the
 * `repo:choose` IPC channel (via team-preload.cjs) instead of the app
 * blocking behind it before the window even opens. Returns a validated path,
 * or null on cancel / an error message on an invalid pick — the renderer
 * decides what to do with either, this never retries on its own.
 */
async function chooseRepoDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose the repository your team will work on',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return { canceled: true };
  if (!existsSync(join(filePaths[0], '.git'))) {
    return { error: `${filePaths[0]} is not a git repository.` };
  }
  return { path: resolve(filePaths[0]) };
}

/** Last words from a daemon that failed to come up — the whole point of the log. */
function logTail(path, n = 1200) {
  try {
    const size = statSync(path).size;
    return readFileSync(path, 'utf8').slice(Math.max(0, size - n)).trim();
  } catch {
    return '';
  }
}

/**
 * Fail with a clear message before spawning, not after. A too-old `node` on
 * PATH still spawns fine — it just dies inside the daemon on `import
 * 'node:sqlite'`, and the childExit path below would surface that as a raw
 * Node stack trace in the log tail instead of "install Node 24+".
 */
function checkNodeVersion(node) {
  let out;
  try {
    out = execFileSync(node, ['--version'], { timeout: 5000, windowsHide: true }).toString().trim();
  } catch (e) {
    throw new Error(`Could not run Node ("${node}"): ${e.message}. `
      + 'Node 24+ must be on PATH. Get it at https://nodejs.org.');
  }
  const major = Number(out.replace(/^v/, '').split('.')[0]);
  if (!(major >= 24)) {
    throw new Error(`Node ${out} is on PATH, but the daemon needs Node 24+ for node:sqlite. `
      + 'Get it at https://nodejs.org.');
  }
}

/**
 * Start the team and leave it running. Readiness is decided by asking the
 * port, not by parsing stdout — a detached child's output belongs in the log,
 * and this works whatever the daemon chooses to print.
 */
async function startDaemon(repo, logPath, port = PORT) {
  return spawnDaemon(repo, logPath, ['--port', String(port)],
    () => teamOnPort(originFor(port)), `answer on ${originFor(port)}`);
}

/**
 * Spawn a detached daemon and poll `ready()` until it returns something, the
 * child dies, or 90s pass. `what` names the readiness for the timeout error.
 */
async function spawnDaemon(repo, logPath, extraArgs, ready, what) {
  const node = process.env.AGENTICOS_NODE ?? 'node';
  checkNodeVersion(node);
  const out = openSync(logPath, 'a');
  const child = spawn(node, [
    join(HERE, '..', 'src', 'daemon.js'), ...(repo ? [repo] : []), ...extraArgs,
  ], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  let spawnError = null;
  let childExit = null;
  child.on('error', (e) => { spawnError = e; });
  child.on('exit', (code, signal) => { childExit = { code, signal }; });
  child.unref();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Could not start Node ("${node}"): ${spawnError.message}. `
        + 'Node 24+ must be on PATH.');
    }
    if (childExit) {
      throw new Error(`The Agentic OS daemon exited before it became ready `
        + `(code ${childExit.code ?? 'unknown'}, signal ${childExit.signal ?? 'none'}).\n\n`
        + logTail(logPath));
    }
    const found = await ready(child);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`The workspace did not ${what} within 90s.\n\n${logTail(logPath)}`);
}

/**
 * The same idea as startDaemon() above, for a team that is NOT pinned to
 * PORT — every team opened besides the app's default one (a second repo
 * from the switcher, or a bare relaunch routed by routeLaunch() below). No
 * --port is passed, so src/daemon.js picks the next free one itself (see
 * teams.firstFreePort()); readiness is read off the SAME registry that
 * choice was written to (src/teams.js), matched by this child's pid, since
 * the port is not known until the daemon has already picked it.
 */
async function startDaemonAuto(repo, logPath) {
  return spawnDaemon(repo, logPath, [],
    async (child) => (await listTeams()).find((c) => c.pid === child.pid), 'register itself');
}

/**
 * A team window shows the team, and nothing else.
 *
 * Without this, any link or script-driven navigation in the renderer could take
 * a full-privilege Electron window to an arbitrary origin — and a popup opened
 * from one inherits the opener's window. The renderer runs with
 * contextIsolation and no node integration, so this is not an RCE chain, but it
 * is the difference between "a page in a browser" and "a page wearing the
 * team's clothes". Outside links go to the real browser, where the address bar
 * is visible.
 */
function lockNavigation(win, origin = ORIGIN) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${origin}/`)) e.preventDefault();
  });
}

/**
 * Open the team on `port`, or focus it if a window for it is already open —
 * one call covers both "start a new team's viewer" and "a relaunch/switcher
 * action for a team already running" (issue #42). The pet window and every
 * other single-window assumption in this file are untouched: PORT's window
 * is still the one opened at first launch, exactly as before.
 */
function openWindow(port = PORT) {
  const existing = teamWindows.get(port);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.show();
    existing.win.focus();
    return existing.win;
  }
  const origin = originFor(port);
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    backgroundColor: '#0a0a0a',
    title: 'Agentic OS',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(HERE, 'team-preload.cjs'),
    },
  });
  win.setMenuBarVisibility(false);
  lockNavigation(win, origin);
  win.loadURL(`${origin}/`);
  teamWindows.set(port, { win, origin });
  win.on('closed', () => {
    if (teamWindows.get(port)?.win === win) teamWindows.delete(port);
    // The dog does not count as a window worth staying alive for: he has no
    // menu and no way to reopen the dashboard, so an app that lived on as
    // nothing but a floating dog would be unclosable except from Task Manager.
    if (BrowserWindow.getAllWindows().every((w) => w === petWin || w.isDestroyed())) app.quit();
  });
  return win;
}

/* ---------- the floating dog ----------
 * A second window that is not a viewer of the team so much as a readout of
 * it: frameless, transparent, always on top, and draggable anywhere on the
 * desktop. He follows the team over HTTP like any other page; the main
 * process is involved only in moving the window, which a page cannot do.
 */
// The sprite box at scale 1, plus the transparent margin the drop shadow needs
// and a strip under him for the size slider.
const PET_ART = { w: 132, h: 143 };
const PET_PAD = 12, PET_STRIP = 16;
const petBox = (s) => ({
  width: Math.round(PET_ART.w * s) + PET_PAD,
  height: Math.round(PET_ART.h * s) + PET_PAD + PET_STRIP,
});
const clampScale = (s) => Math.min(1.6, Math.max(0.45, Number(s) || 1));

let petWin = null;
let petDrag = null;
// The authoritative size. Reading it back off the window instead lets rounding
// accumulate: getBounds() returns whole DIPs, the physical box rounds up a
// little, and each drag re-freezes the larger reading — measured creeping
// 114 -> 118 -> 119 -> 120 over four drags. Computed from the scale, it is the
// same number forever.
let petScale = 1;
const petStatePath = () => join(app.getPath('userData'), 'pet.json');

const readPetState = () => {
  try {
    return JSON.parse(readFileSync(petStatePath(), 'utf8'));
  } catch {
    return {};
  }
};
const writePetState = (patch) => {
  try {
    writeFileSync(petStatePath(), JSON.stringify({ ...readPetState(), ...patch }));
  } catch { /* a forgotten corner is not worth failing a launch over */ }
};

/** Bottom-right of the work area, clear of the taskbar, on first run. */
function petSpot(box) {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const home = { x: x + width - box.width - 24, y: y + height - box.height - 24 };
  const saved = readPetState();
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return home;
  // A monitor unplugged since last launch — or a drag that ended somewhere
  // absurd — would otherwise put him at coordinates no display covers.
  const onScreen = screen.getAllDisplays().some((d) =>
    saved.x + box.width > d.workArea.x && saved.x < d.workArea.x + d.workArea.width
    && saved.y + box.height > d.workArea.y && saved.y < d.workArea.y + d.workArea.height);
  return onScreen ? { x: saved.x, y: saved.y } : home;
}

function openPet() {
  if (petWin && !petWin.isDestroyed()) return petWin.show();
  petScale = clampScale(readPetState().scale ?? 1);
  const box = petBox(petScale);
  const { x, y } = petSpot(box);
  petWin = new BrowserWindow({
    x, y, ...box,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, focusable: true,
    // Not shown until the page has painted: a transparent window that appears
    // before its first frame flashes as a white square.
    show: false,
    title: 'HappyDog',
    webPreferences: {
      preload: join(HERE, 'pet-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  // 'screen-saver' is the level that also floats above full-screen apps, which
  // is what "always on top" is actually expected to mean.
  lockNavigation(petWin);
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.loadURL(`${ORIGIN}/pet.html`);
  petWin.once('ready-to-show', () => petWin.show());
  petWin.on('closed', () => { stopPetDrag(); petWin = null; });
}

const petAlive = () => Boolean(petWin) && !petWin.isDestroyed();

ipcMain.handle('pet:state', () => ({ scale: clampScale(readPetState().scale ?? 1) }));

/* ---------- dragging ----------
 * Driven from the OS cursor in the main process, NOT from pointer coordinates
 * in the page.
 *
 * The renderer version of this drifted: Chromium derives `screenX` as
 * clientX + the window's cached screen origin, and that cache updates a beat
 * after setPosition moves the window. So every frame the delta was computed
 * against a stale origin, fed back into the next move, and the dog took off
 * across the desktop while the pointer sat still. getCursorScreenPoint has no
 * such feedback path: it is the truth, from outside the window being moved.
 */
ipcMain.on('pet:dragStart', () => {
  stopPetDrag();
  if (!petAlive()) return;
  const c = screen.getCursorScreenPoint();
  const b = petWin.getBounds();
  petDrag = {
    ox: c.x - b.x, oy: c.y - b.y, sx: c.x, sy: c.y,
    moved: false, started: Date.now(),
    timer: setInterval(followCursor, 16),
  };
});

function followCursor() {
  if (!petDrag || !petAlive()) return stopPetDrag();
  // A drag can only outlive its pointerup if the renderer lost the release
  // (window dragged out from under a failed pointer capture, an alt-tab). A
  // dog that silently follows the cursor forever is the worst failure here.
  if (Date.now() - petDrag.started > 30_000) return stopPetDrag();

  const c = screen.getCursorScreenPoint();
  // A few pixels of slop so a click that wobbles is still a click.
  if (!petDrag.moved && Math.abs(c.x - petDrag.sx) + Math.abs(c.y - petDrag.sy) < 4) return;
  petDrag.moved = true;

  // setBounds with an EXPLICIT computed size, never setPosition.
  //
  // setPosition is implemented as "keep the current size, change the origin",
  // and on a display at 125% that round trip re-applies the scale factor: the
  // window grew 144 -> 180 -> 267 -> 344 -> 432 across one drag, compounding
  // by ~1.25 every few frames. The position was always right; the box around
  // it ballooned, which is what threw the × and the slider off into space.
  // Restating the size every frame leaves nothing to compound.
  petWin.setBounds({ x: c.x - petDrag.ox, y: c.y - petDrag.oy, ...petBox(petScale) });
}

function stopPetDrag() {
  if (petDrag) clearInterval(petDrag.timer);
  petDrag = null;
}

ipcMain.handle('pet:dragEnd', () => {
  const moved = petDrag?.moved ?? false;
  stopPetDrag();
  if (moved && petAlive()) {
    const [x, y] = petWin.getPosition();
    writePetState({ x, y });
  }
  return moved;
});

ipcMain.on('pet:scale', (_e, raw) => {
  if (!petAlive()) return;
  const scale = clampScale(raw);
  const box = petBox(scale);
  // Grow and shrink from the BOTTOM edge: his feet stay put, so resizing does
  // not walk him up the screen. The OLD height comes from the scale we last
  // set, for the same reason followCursor does not read it back.
  const [x, y] = petWin.getPosition();
  const h = petBox(petScale).height;
  petScale = scale;

  // resizable:false pins the window's min and max size to what it was created
  // at, and Windows then CLAMPS setBounds back — silently. The sprite scaled
  // with CSS while the window did not, so the slider and the × drifted further
  // from the dog at every step. It has to be lifted for the one call, then put
  // straight back so the frameless window keeps no invisible drag borders.
  petWin.setResizable(true);
  petWin.setBounds({ x, y: y + h - box.height, ...box });
  petWin.setResizable(false);

  const [nx, ny] = petWin.getPosition();
  writePetState({ scale, x: nx, y: ny });
});

// For this session only. His own tooltip promises he comes back next launch,
// so persisting the dismissal would make that a lie.
ipcMain.on('pet:hide', () => petWin?.destroy());
ipcMain.on('pet:open', openPet);

// The dashboard's own request for a repository — Code mode asks for this
// when none is attached yet, rather than the app blocking on it at launch.
ipcMain.handle('repo:choose', () => chooseRepoDialog());

// AgenticOS#attachRepo refuses to move a LIVE team onto a different repo on
// purpose (its DB path, live worktrees, and every agent cwd are all derived
// from the first repo attached — swapping them out from under a running
// team would corrupt in-progress worktrees rather than cleanly switch
// projects). The only real fix is a fresh team: end this one, then start
// another pointed at the new path — the same startDaemon() the app itself
// boots with. This is the one truly destructive action reachable from
// Settings (it stops every in-flight agent turn in the current team), so it
// gets a native confirmation before anything is torn down — and the target
// gets a REAL git check (assertRepo, the same one AgenticOS itself boots
// with), not just an existsSync(.git) peek: a corrupt or empty .git entry
// passes that peek, and startDaemon's own boot path (src/worktree.js's
// ensureRepo) is deliberately permissive — it would silently `git init` a
// brand new repo there rather than fail, which is fine for a first boot but
// not something a destructive team-ending action should risk triggering.
// The actual step sequence lives in switch-repo.js, as a plain function
// tested without Electron, a real daemon, or a real dialog.
//
// Every step targets the team the REQUESTING window shows (issue #42): a
// window opened on a non-default port must end and replace its own team,
// not the one on the app's pinned PORT.
ipcMain.handle('team:switchRepo', async (event, rawPath) => {
  const port = teamPortOf(event.sender.getURL(), PORT);
  const origin = originFor(port);
  return switchRepo(rawPath, {
    resolve,
    assertRepo,
    confirm: async (repo) => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'End this workspace?',
        message: `End the current workspace and start a fresh one for:\n\n${repo}`,
        detail: 'Any work in progress in the current workspace will stop. This cannot be undone.',
        buttons: ['Cancel', 'End workspace and switch'],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
    shutdown: () => requestShutdown(origin),
    teamOnPort: () => teamOnPort(origin),
    startDaemon: (repo, logPath) => startDaemon(repo, logPath, port),
    // A fresh window load, not the renderer's own SSE reconnect: the new
    // daemon's event cursor starts back at zero, and resuming with the old
    // team's `since` would ask for events that no longer exist in this repo's
    // fresh store.
    reload: () => BrowserWindow.fromWebContents(event.sender)?.loadURL(`${origin}/`),
    logPath: join(app.getPath('userData'), 'daemon.log'),
  });
});

// ---- multiple teams at once (issue #42) -----------------------------------
// The switcher reachable from Settings' Repository panel (ui/views/teams.js)
// talks to these three. Unlike team:switchRepo above, none of them end the
// CURRENT team — "open that repo's team" coexists with whatever is already
// running instead of replacing it.
ipcMain.handle('teams:list', async () => {
  const teams = await listTeams();
  return teams.map((c) => ({ ...c, open: teamWindows.has(c.port) }));
});

// What routeLaunch needs, shared by the switcher and a second launch.
const launchDeps = () => ({
  listTeams,
  focusWindow: (port) => openWindow(port),
  startDaemonFor: (r, logPath) => startDaemonAuto(r, logPath),
  openWindow: (port) => openWindow(port),
  logPath: join(app.getPath('userData'), 'daemon.log'),
});

ipcMain.handle('teams:open', async (event, rawPath) =>
  routeLaunch(rawPath ? resolve(String(rawPath)) : null, launchDeps()));

// A team row is identified by its PORT, not its repository: repo-less teams
// are real and several can run at once, so a null repo cannot name one.
ipcMain.handle('teams:focus', async (event, port) => {
  const found = (await listTeams()).find((c) => c.port === Number(port));
  if (!found) return { ok: false, error: 'That workspace is no longer running.' };
  openWindow(found.port);
  return { ok: true, port: found.port };
});

ipcMain.handle('teams:end', async (event, port) => {
  const found = (await listTeams()).find((c) => c.port === Number(port));
  if (!found) return { ok: false, error: 'That workspace is no longer running.' };
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'End this workspace?',
    message: `End the workspace for:\n\n${found.repo ?? `the workspace on port ${found.port} (no repository attached)`}`,
    detail: 'Any work in progress in that workspace will stop. This cannot be undone.',
    buttons: ['Cancel', 'End workspace'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return { canceled: true };
  const down = await requestShutdown(originFor(found.port));
  if (!down.ok) return { ok: false, error: down.error };
  const win = teamWindows.get(found.port)?.win;
  if (win && !win.isDestroyed()) win.close();
  teamWindows.delete(found.port);
  return { ok: true };
});

// One daemon-launching process per machine: without this, opening the app a
// second time (double-clicking the icon again, or the OS relaunching it)
// would start a SECOND, port-colliding daemon rather than reach the team
// already running. The losing instance quits immediately and hands its argv
// to the surviving one via 'second-instance', which routes it exactly like a
// first launch would (routeLaunch, shared with teams:open above) — focusing
// the right team instead of starting a stray one.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', async (event, argv2) => {
    const result = await routeLaunch(repoFromArgv(argv2), launchDeps());
    if (!result.ok) dialog.showErrorBox('Agentic OS could not start', result.error);
  });
}

app.whenReady().then(async () => {
  if (!singleInstanceLock) return; // this instance is on its way out — see above
  // No blocking dialog here anymore: Chat/Research/Build don't need a repo at
  // all, and Code mode asks for one live, from inside the dashboard, via
  // the repo:choose IPC handler below. A repo named on the command line still
  // launches pre-attached, for the power-user path.
  const repo = repoFromArgv();

  const logPath = join(app.getPath('userData'), 'daemon.log');

  // The registry first: the named repo may already have a team on another
  // port, and a default port serving a different repo means the named one
  // gets a team of its own (issue #42) rather than a two-button dead end.
  let running = await teamOnPort();
  const plan = firstLaunchPlan(repo, repo ? await listTeams() : [], running);
  let targetPort = PORT;
  if (plan.action === 'focus') {
    targetPort = plan.port;
  } else if (plan.action === 'start-auto') {
    try {
      targetPort = (await startDaemonAuto(plan.repo, logPath)).port;
    } catch (e) {
      dialog.showErrorBox('Agentic OS could not start', e.message);
      return app.quit();
    }
  } else if (!running) {
    try {
      running = await startDaemon(repo, logPath);
    } catch (e) {
      dialog.showErrorBox('Agentic OS could not start', e.message);
      return app.quit();
    }
  } else if (repo && !running.repo) {
    // A team is already up but has not attached a repo yet (e.g. a bare
    // relaunch from earlier). Without this, a repo named on THIS launch's
    // command line was silently dropped — the window opened, but Code mode
    // stayed unattached and nothing told the user why.
    try {
      const r = await fetch(`${ORIGIN}/api/attachRepo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repo }),
      }).then((res) => res.json());
      if (r.ok) running = { ...running, repo };
    } catch { /* best-effort: the window still opens either way */ }
  }

  // Dictation needs the microphone. Grant it to any team window — every
  // team is this same app's own served origin, on its own port, so "mine"
  // now means "some live team's origin", not just the one at PORT.
  const mine = (wc) => {
    const url = wc?.getURL() ?? '';
    return [...teamWindows.values()].some(({ origin }) => url.startsWith(origin));
  };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) =>
    cb(perm === 'media' && mine(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && mine(wc));

  openWindow(targetPort);
  openPet();
});

app.on('activate', () => { if (singleInstanceLock && !BrowserWindow.getAllWindows().length) openWindow(); });

// Closing the window closes the VIEWER. The team keeps working; "end team"
// in the dashboard is what stops it. (A team window left alone with the
// dog quits too — see openWindow's 'closed' handler.)
app.on('window-all-closed', () => app.quit());
