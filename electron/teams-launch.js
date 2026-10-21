// The pure decision logic behind "which team should this launch open?" —
// pulled out of main.js the same way switch-repo.js pulled out the
// end-and-switch flow, so the ordering runs for real under a plain Node test
// with fake windows, a fake registry and a fake daemon, instead of a real
// Electron process.
//
// Two callers share this: the app's own first launch, and a SECOND launch
// arriving while the app is already running (app.requestSingleInstanceLock's
// 'second-instance' event) — issue #42's "launching again focuses/opens the
// right team instead of starting a stray daemon".


import { sameRepo } from '../src/teams.js';

/**
 * Decide what a launch (first or second) should do, given the repo it named
 * (or null) and the teams already known to be live. Pure: no I/O, so every
 * branch is a plain assertion in the self-check below.
 *
 *   - no repo named, and at least one team is already open -> focus the
 *     most recently started one (a bare relaunch reopens *something* rather
 *     than nothing).
 *   - no repo named, and none open -> start fresh, unpinned (auto port).
 *   - a repo named that already has a live team -> focus THAT one, never a
 *     second daemon for the same repo (src/teams.js's registerTeam already
 *     refuses that at the daemon level; this is the same rule one layer up,
 *     so the UI never even tries).
 *   - a repo named with no live team -> start one for it.
 */
export function decideLaunchAction(repo, liveTeams) {
  if (repo) {
    const existing = liveTeams.find((c) => sameRepo(c.repo, repo));
    return existing ? { action: 'focus', port: existing.port } : { action: 'start', repo };
  }
  if (liveTeams.length > 0) {
    const latest = [...liveTeams].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
    return { action: 'focus', port: latest.port };
  }
  return { action: 'start', repo: null };
}

/**
 * Carry out a decision from decideLaunchAction: focus an existing window, or
 * start a fresh daemon and open a window for it once it answers. Every
 * dependency is injected, exactly like switchRepo() in switch-repo.js, so
 * this runs under a plain Node test with fakes for all of them.
 */
export async function routeLaunch(repo, { listTeams, focusWindow, startDaemonFor, openWindow, logPath }) {
  const liveTeams = await listTeams();
  const decision = decideLaunchAction(repo, liveTeams);
  if (decision.action === 'focus') {
    focusWindow(decision.port);
    return { ok: true, action: 'focus', port: decision.port };
  }
  try {
    const started = await startDaemonFor(decision.repo, logPath);
    openWindow(started.port);
    return { ok: true, action: 'start', port: started.port, repo: started.repo ?? decision.repo };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The app's OWN first launch, which also owns the pinned default port. It
 * must consult the registry before that port: a repo named on the command
 * line may already have a team on some other port (open that one — starting
 * another would be refused by the daemon and the app would quit), and a
 * default port serving a different repository is no longer a dead end now
 * that teams run side by side (start the named repo its own team). Every
 * other case keeps the pinned-port flow.
 */
export function firstLaunchPlan(repo, liveTeams, onDefaultPort) {
  if (repo) {
    const existing = liveTeams.find((c) => sameRepo(c.repo, repo));
    if (existing) return { action: 'focus', port: existing.port };
    if (onDefaultPort?.repo && !sameRepo(onDefaultPort.repo, repo)) return { action: 'start-auto', repo };
  }
  return { action: 'default' };
}

/**
 * The team port a window is showing, read off its loaded URL. With several
 * teams open side by side, a per-window action (the repository switch) must
 * act on THAT window's team, not on the app's pinned default port. Falls
 * back to `fallback` for anything that is not a loopback team URL.
 */
export function teamPortOf(url, fallback) {
  try {
    const u = new URL(url);
    const port = Number(u.port);
    if (u.hostname === '127.0.0.1' && Number.isInteger(port) && port > 0) return port;
  } catch { /* not a URL yet (blank window) */ }
  return fallback;
}

/**
 * Ask a team to end itself. The daemon refuses any POST /api/* that is not
 * `content-type: application/json` with a 415 (src/daemon.js's CSRF gate),
 * and fetch() resolves on a 415 just as it does on a 200 — so a bare POST
 * looked like success while the daemon kept running. This sends the JSON
 * header and reports the answer. A refused connection means the team is
 * already gone, which is what the caller wanted.
 */
export async function requestShutdown(origin, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(`${origin}/api/shutdown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
  } catch {
    return { ok: true, gone: true };
  }
  if (res.ok) return { ok: true };
  let error = `the workspace refused to end (HTTP ${res.status})`;
  try { const j = await res.json(); if (j?.error) error += `: ${j.error}`; } catch { /* keep the status */ }
  return { ok: false, error };
}

// ---- self-check -------------------------------------------------------------
import { basename } from 'node:path';
if (basename(process.argv[1] ?? '') === 'teams-launch.js') {
  const assert = (cond, msg) => { if (!cond) throw new Error(`teams-launch.js self-check failed: ${msg}`); };

  assert(decideLaunchAction(null, []).action === 'start', 'no repo, nothing live -> start fresh');
  assert(decideLaunchAction(null, []).repo === null, 'a repo-less start must not invent a repo');

  const twoLive = [
    { repo: '/a', port: 7777, startedAt: '2026-01-01T00:00:00Z' },
    { repo: '/b', port: 7778, startedAt: '2026-01-02T00:00:00Z' },
  ];
  assert(decideLaunchAction(null, twoLive).action === 'focus', 'no repo, something live -> focus, not a stray daemon');
  assert(decideLaunchAction(null, twoLive).port === 7778, 'a bare relaunch focuses the MOST RECENTLY started team');

  assert(decideLaunchAction('/a', twoLive).action === 'focus', 'a named repo already live -> focus that one');
  assert(decideLaunchAction('/a', twoLive).port === 7777, 'focus must land on the matching repo, not just any team');
  assert(decideLaunchAction('/a/', twoLive).port === 7777, 'a trailing slash must not defeat the match');

  assert(decideLaunchAction('/c', twoLive).action === 'start', 'a named repo with no live team -> start one');
  assert(decideLaunchAction('/c', twoLive).repo === '/c', 'starting must carry the requested repo forward');

  await (async () => {
    const focused = [];
    const opened = [];
    const result = await routeLaunch('/a', {
      listTeams: async () => twoLive,
      focusWindow: (port) => focused.push(port),
      startDaemonFor: async () => { throw new Error('must not start a daemon when one is already live'); },
      openWindow: (port) => opened.push(port),
      logPath: '/tmp/x',
    });
    assert(result.ok && result.action === 'focus' && result.port === 7777, 'routeLaunch must focus rather than start when a live team matches');
    assert(focused.length === 1 && opened.length === 0, 'exactly one focus, zero window opens, zero daemon starts');
  })();

  await (async () => {
    const opened = [];
    const result = await routeLaunch('/c', {
      listTeams: async () => twoLive,
      focusWindow: () => { throw new Error('must not focus when nothing matches'); },
      startDaemonFor: async (repo) => ({ repo, port: 7779 }),
      openWindow: (port) => opened.push(port),
      logPath: '/tmp/x',
    });
    assert(result.ok && result.action === 'start' && result.port === 7779, 'routeLaunch must start and open a window for a genuinely new repo');
    assert(opened[0] === 7779, 'the window opened must be for the port the new daemon actually got');
  })();

  await (async () => {
    // A failed start must degrade visibly, not throw uncaught into Electron's
    // own error handling.
    const result = await routeLaunch('/c', {
      listTeams: async () => [],
      focusWindow: () => {},
      startDaemonFor: async () => { throw new Error('boom'); },
      openWindow: () => { throw new Error('must not open a window when the daemon never started'); },
      logPath: '/tmp/x',
    });
    assert(result.ok === false && result.error === 'boom', 'a failed daemon start must come back as {ok:false, error}');
  })();

  console.log('teams-launch.js: self-check passed');
}
