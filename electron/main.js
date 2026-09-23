// Thin shell. All the real work happens in the daemon (own Node 24 process,
// because Electron's bundled Node has no node:sqlite).
//
// The daemon is DETACHED on purpose: an agentic court runs for hours, and
// closing a window must not kill work in progress. This window is a viewer.
// Launching again re-attaches to the court that is already running; to end it
// for real, use "end court" in the throne room.
import { app, BrowserWindow, dialog, session, ipcMain, screen, shell } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { openSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRepo } from '../src/worktree.js';
import { switchRepo } from './switch-repo.js';
import { listCourts } from '../src/courts.js';
import { routeLaunch, requestShutdown, firstLaunchPlan, courtPortOf } from './courts-launch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.KINGDOM_PORT ?? 7777);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Who, if anyone, is already holding the port. */
async function courtOnPort(origin = ORIGIN) {
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
 * One BrowserWindow per live court, keyed by the port it is serving —
 * multiple courts at once (issue #42). The default launch still opens PORT
 * (pinned by KINGDOM_PORT or 7777) exactly as before; every OTHER court a
 * launch or the courts switcher opens gets its own entry here instead of
 * replacing anything.
 */
const courtWindows = new Map(); // port -> { win, origin }
const originFor = (port) => `http://127.0.0.1:${port}`;

/**
 * The native folder picker, on demand — Code mode asks for this through the
 * `repo:choose` IPC channel (via court-preload.cjs) instead of the app
 * blocking behind it before the window even opens. Returns a validated path,
 * or null on cancel / an error message on an invalid pick — the renderer
 * decides what to do with either, this never retries on its own.
 */
async function chooseRepoDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose the repository your kingdom will work on',
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
    out = execFileSync(node, ['--version'], { timeout: 5000 }).toString().trim();
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
 * Start the court and leave it running. Readiness is decided by asking the
 * port, not by parsing stdout — a detached child's output belongs in the log,
 * and this works whatever the daemon chooses to print.
 */
async function startDaemon(repo, logPath, port = PORT) {
  const node = process.env.KINGDOM_NODE ?? 'node';
  checkNodeVersion(node);
  const out = openSync(logPath, 'a');
  const child = spawn(node, [
    join(HERE, '..', 'src', 'daemon.js'), ...(repo ? [repo] : []), '--port', String(port),
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
      throw new Error(`The court daemon exited before it became ready `
        + `(code ${childExit.code ?? 'unknown'}, signal ${childExit.signal ?? 'none'}).\n\n`
        + logTail(logPath));
    }
    const ping = await courtOnPort(originFor(port));
    if (ping) return ping;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`The court did not answer on ${originFor(port)} within 90s.\n\n${logTail(logPath)}`);
}

/**
 * The same idea as startDaemon() above, for a court that is NOT pinned to
 * PORT — every court opened besides the app's default one (a second repo
 * from the switcher, or a bare relaunch routed by routeLaunch() below). No
 * --port is passed, so src/daemon.js picks the next free one itself (see
 * courts.firstFreePort()); readiness is read off the SAME registry that
 * choice was written to (src/courts.js), matched by this child's pid, since
 * the port is not known until the daemon has already picked it.
 */
async function startDaemonAuto(repo, logPath) {
  const node = process.env.KINGDOM_NODE ?? 'node';
  checkNodeVersion(node);
  const out = openSync(logPath, 'a');
  const child = spawn(node, [
    join(HERE, '..', 'src', 'daemon.js'), ...(repo ? [repo] : []),
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
      throw new Error(`The court daemon exited before it became ready `
        + `(code ${childExit.code ?? 'unknown'}, signal ${childExit.signal ?? 'none'}).\n\n`
        + logTail(logPath));
    }
    const found = (await listCourts()).find((c) => c.pid === child.pid);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`The court did not register itself within 90s.\n\n${logTail(logPath)}`);
}

/**
 * A court window shows the court, and nothing else.
 *
 * Without this, any link or script-driven navigation in the renderer could take
 * a full-privilege Electron window to an arbitrary origin — and a popup opened
 * from one inherits the opener's window. The renderer runs with
 * contextIsolation and no node integration, so this is not an RCE chain, but it
 * is the difference between "a page in a browser" and "a page wearing the
 * court's clothes". Outside links go to the real browser, where the address bar
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
 * Open the court on `port`, or focus it if a window for it is already open —
 * one call covers both "start a new court's viewer" and "a relaunch/switcher
 * action for a court already running" (issue #42). The pet window and every
 * other single-window assumption in this file are untouched: PORT's window
 * is still the one opened at first launch, exactly as before.
 */
function openWindow(port = PORT) {
  const existing = courtWindows.get(port);
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
    backgroundColor: '#0a0c0f',
    title: 'Agentic OS',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(HERE, 'court-preload.cjs'),
    },
  });
  win.setMenuBarVisibility(false);
  lockNavigation(win, origin);
  win.loadURL(`${origin}/`);
  courtWindows.set(port, { win, origin });
  win.on('closed', () => {
    if (courtWindows.get(port)?.win === win) courtWindows.delete(port);
  });
  return win;
}

/* ---------- the floating dog ----------
 * A second window that is not a viewer of the court so much as a readout of
 * it: frameless, transparent, always on top, and draggable anywhere on the
 * desktop. He follows the court over HTTP like any other page; the main
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

// The throne room's own request for a repository — Code mode asks for this
// when none is attached yet, rather than the app blocking on it at launch.
ipcMain.handle('repo:choose', () => chooseRepoDialog());

// Kingdom#attachRepo refuses to move a LIVE court onto a different repo on
// purpose (its DB path, live worktrees, and every agent cwd are all derived
// from the first repo attached — swapping them out from under a running
// court would corrupt in-progress worktrees rather than cleanly switch
// projects). The only real fix is a fresh court: end this one, then start
// another pointed at the new path — the same startDaemon() the app itself
// boots with. This is the one truly destructive action reachable from
// Settings (it stops every in-flight agent turn in the current court), so it
// gets a native confirmation before anything is torn down — and the target
// gets a REAL git check (assertRepo, the same one Kingdom itself boots
// with), not just an existsSync(.git) peek: a corrupt or empty .git entry
// passes that peek, and startDaemon's own boot path (src/worktree.js's
// ensureRepo) is deliberately permissive — it would silently `git init` a
// brand new repo there rather than fail, which is fine for a first boot but
// not something a destructive court-ending action should risk triggering.
// The actual step sequence lives in switch-repo.js, as a plain function
// tested without Electron, a real daemon, or a real dialog.
//
// Every step targets the court the REQUESTING window shows (issue #42): a
// window opened on a non-default port must end and replace its own court,
// not the one on the app's pinned PORT.
ipcMain.handle('court:switchRepo', async (event, rawPath) => {
  const port = courtPortOf(event.sender.getURL(), PORT);
  const origin = originFor(port);
  return switchRepo(rawPath, {
    resolve,
    assertRepo,
    confirm: async (repo) => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'End this court?',
        message: `End the current court and start a fresh one for:\n\n${repo}`,
        detail: 'Any work in progress in the current court will stop. This cannot be undone.',
        buttons: ['Cancel', 'End court and switch'],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
    shutdown: () => requestShutdown(origin),
    courtOnPort: () => courtOnPort(origin),
    startDaemon: (repo, logPath) => startDaemon(repo, logPath, port),
    // A fresh window load, not the renderer's own SSE reconnect: the new
    // daemon's event cursor starts back at zero, and resuming with the old
    // court's `since` would ask for events that no longer exist in this repo's
    // fresh store.
    reload: () => BrowserWindow.fromWebContents(event.sender)?.loadURL(`${origin}/`),
    logPath: join(app.getPath('userData'), 'daemon.log'),
  });
});

// ---- multiple courts at once (issue #42) -----------------------------------
// The switcher reachable from Settings' Repository panel (ui/views/courts.js)
// talks to these three. Unlike court:switchRepo above, none of them end the
// CURRENT court — "open that repo's court" coexists with whatever is already
// running instead of replacing it.
ipcMain.handle('courts:list', async () => {
  const courts = await listCourts();
  return courts.map((c) => ({ ...c, open: courtWindows.has(c.port) }));
});

ipcMain.handle('courts:open', async (event, rawPath) => {
  const repo = rawPath ? resolve(String(rawPath)) : null;
  return routeLaunch(repo, {
    listCourts,
    focusWindow: (port) => openWindow(port),
    startDaemonFor: (r, logPath) => startDaemonAuto(r, logPath),
    openWindow: (port) => openWindow(port),
    logPath: join(app.getPath('userData'), 'daemon.log'),
  });
});

// A court row is identified by its PORT, not its repository: repo-less courts
// are real and several can run at once, so a null repo cannot name one.
ipcMain.handle('courts:focus', async (event, port) => {
  const found = (await listCourts()).find((c) => c.port === Number(port));
  if (!found) return { ok: false, error: 'That court is no longer running.' };
  openWindow(found.port);
  return { ok: true, port: found.port };
});

ipcMain.handle('courts:end', async (event, port) => {
  const found = (await listCourts()).find((c) => c.port === Number(port));
  if (!found) return { ok: false, error: 'That court is no longer running.' };
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'End this court?',
    message: `End the court for:\n\n${found.repo ?? `the court on port ${found.port} (no repository attached)`}`,
    detail: 'Any work in progress in that court will stop. This cannot be undone.',
    buttons: ['Cancel', 'End court'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return { canceled: true };
  const down = await requestShutdown(originFor(found.port));
  if (!down.ok) return { ok: false, error: down.error };
  const win = courtWindows.get(found.port)?.win;
  if (win && !win.isDestroyed()) win.close();
  courtWindows.delete(found.port);
  return { ok: true };
});

// One daemon-launching process per machine: without this, opening the app a
// second time (double-clicking the icon again, or the OS relaunching it)
// would start a SECOND, port-colliding daemon rather than reach the court
// already running. The losing instance quits immediately and hands its argv
// to the surviving one via 'second-instance', which routes it exactly like a
// first launch would (routeLaunch, shared with courts:open above) — focusing
// the right court instead of starting a stray one.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', async (event, argv2) => {
    const repo = repoFromArgv(argv2);
    const result = await routeLaunch(repo, {
      listCourts,
      focusWindow: (port) => openWindow(port),
      startDaemonFor: (r, logPath) => startDaemonAuto(r, logPath),
      openWindow: (port) => openWindow(port),
      logPath: join(app.getPath('userData'), 'daemon.log'),
    });
    if (!result.ok) dialog.showErrorBox('The kingdom could not rise', result.error);
  });
}

app.whenReady().then(async () => {
  if (!singleInstanceLock) return; // this instance is on its way out — see above
  // No blocking dialog here anymore: Chat/Research/Build don't need a repo at
  // all, and Code mode asks for one live, from inside the throne room, via
  // the repo:choose IPC handler below. A repo named on the command line still
  // launches pre-attached, for the power-user path.
  const repo = repoFromArgv();

  const logPath = join(app.getPath('userData'), 'daemon.log');

  // The registry first: the named repo may already have a court on another
  // port, and a default port serving a different repo means the named one
  // gets a court of its own (issue #42) rather than a two-button dead end.
  let running = await courtOnPort();
  const plan = firstLaunchPlan(repo, repo ? await listCourts() : [], running);
  let targetPort = PORT;
  if (plan.action === 'focus') {
    targetPort = plan.port;
  } else if (plan.action === 'start-auto') {
    try {
      targetPort = (await startDaemonAuto(plan.repo, logPath)).port;
    } catch (e) {
      dialog.showErrorBox('The kingdom could not rise', e.message);
      return app.quit();
    }
  } else if (!running) {
    try {
      running = await startDaemon(repo, logPath);
    } catch (e) {
      dialog.showErrorBox('The kingdom could not rise', e.message);
      return app.quit();
    }
  } else if (repo && !running.repo) {
    // A court is already up but has not attached a repo yet (e.g. a bare
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

  // Dictation needs the microphone. Grant it to any court window — every
  // court is this same app's own served origin, on its own port, so "mine"
  // now means "some live court's origin", not just the one at PORT.
  const mine = (wc) => {
    const url = wc?.getURL() ?? '';
    return [...courtWindows.values()].some(({ origin }) => url.startsWith(origin));
  };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) =>
    cb(perm === 'media' && mine(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && mine(wc));

  openWindow(targetPort);
  openPet();
});

app.on('activate', () => { if (singleInstanceLock && !BrowserWindow.getAllWindows().length) openWindow(); });

// Closing the window closes the VIEWER. The court keeps working; "end court"
// in the throne room is what stops it.
//
// The dog does not count as a window worth staying alive for: he has no menu
// and no way to reopen the throne room, so an app that lived on as nothing but
// a floating dog would be unclosable except from Task Manager.
app.on('window-all-closed', () => app.quit());
app.on('browser-window-closed', (_e, closed) => {
  if (closed === petWin) return;
  if (BrowserWindow.getAllWindows().every((w) => w === petWin)) app.quit();
});
