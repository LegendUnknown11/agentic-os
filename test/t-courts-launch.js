// The launch-routing decision behind issue #42's "launching again focuses/
// opens the right court instead of starting a stray daemon" — a plain
// function with injected dependencies, the same shape as t-repo-switch.js,
// so app.requestSingleInstanceLock's 'second-instance' handler in
// electron/main.js can be a thin wrapper around something this suite
// actually runs.
import { strict as a } from 'node:assert';
import { decideLaunchAction, routeLaunch, requestShutdown, firstLaunchPlan, courtPortOf } from '../electron/courts-launch.js';

const live = [
  { repo: '/repo/a', port: 7777, startedAt: '2026-01-01T00:00:00Z' },
  { repo: '/repo/b', port: 7778, startedAt: '2026-01-02T00:00:00Z' },
];

// --- pure decisions ----------------------------------------------------
a.deepEqual(decideLaunchAction(null, []), { action: 'start', repo: null },
  'nothing running, nothing named -> start fresh with no repo pinned');
a.deepEqual(decideLaunchAction(null, live), { action: 'focus', port: 7778 },
  'a bare relaunch with courts already open focuses the most recent one, never a stray daemon');
a.deepEqual(decideLaunchAction('/repo/a', live), { action: 'focus', port: 7777 },
  'naming a repo that already has a live court focuses THAT court');
a.deepEqual(decideLaunchAction('/repo/c', live), { action: 'start', repo: '/repo/c' },
  'naming a repo with no live court starts one for it');

// --- routeLaunch: focus path never touches the daemon -------------------
{
  const calls = [];
  const result = await routeLaunch('/repo/a', {
    listCourts: async () => live,
    focusWindow: (port) => calls.push(['focus', port]),
    startDaemonFor: async () => { calls.push(['start']); throw new Error('must not be called'); },
    openWindow: () => calls.push(['open']),
    logPath: '/tmp/daemon.log',
  });
  a.deepEqual(result, { ok: true, action: 'focus', port: 7777 });
  a.deepEqual(calls, [['focus', 7777]], 'an already-live repo must only focus its window — no daemon start, no new window');
}

// --- routeLaunch: start path opens a window for the port the daemon got -
{
  const calls = [];
  const result = await routeLaunch(null, {
    listCourts: async () => [],
    focusWindow: () => calls.push(['focus']),
    startDaemonFor: async (repo, logPath) => { calls.push(['start', repo, logPath]); return { repo, port: 7780 }; },
    openWindow: (port) => calls.push(['open', port]),
    logPath: '/tmp/daemon.log',
  });
  a.deepEqual(result, { ok: true, action: 'start', port: 7780, repo: null });
  a.deepEqual(calls, [['start', null, '/tmp/daemon.log'], ['open', 7780]],
    'a fresh start must start the daemon before opening a window, and open the port it actually got');
}

// --- routeLaunch: a failed daemon start degrades visibly, never a stray window
{
  const calls = [];
  const result = await routeLaunch('/repo/c', {
    listCourts: async () => live,
    focusWindow: () => calls.push(['focus']),
    startDaemonFor: async () => { throw new Error('Node 24+ must be on PATH.'); },
    openWindow: () => calls.push(['open']),
    logPath: '/tmp/daemon.log',
  });
  a.deepEqual(result, { ok: false, error: 'Node 24+ must be on PATH.' });
  a.deepEqual(calls, [], 'a daemon that fails to start must never open a window');
}

// --- requestShutdown: JSON header, and a refusal is reported -----------------
{
  const seen = [];
  const ok = await requestShutdown('http://x', async (url, init) => { seen.push([url, init]); return { ok: true, status: 200 }; });
  a.equal(ok.ok, true);
  a.equal(seen[0][0], 'http://x/api/shutdown');
  a.equal(seen[0][1].headers['content-type'], 'application/json', 'shutdown must send the JSON content type the daemon requires');
  const refused = await requestShutdown('http://x', async () => ({ ok: false, status: 415, json: async () => ({ error: 'expected content-type: application/json' }) }));
  a.equal(refused.ok, false, 'a refused shutdown must not be reported as success');
  a.match(refused.error, /415/);
  const gone = await requestShutdown('http://x', async () => { throw new Error('ECONNREFUSED'); });
  a.equal(gone.ok, true, 'a court that no longer answers is already gone');
}

// --- the app's own first launch consults the registry before its pinned port ---
a.deepEqual(firstLaunchPlan('/repo/b', live, { repo: '/repo/a' }), { action: 'focus', port: 7778 },
  'a named repo already served on a non-default port opens THAT court, not a refused duplicate');
a.deepEqual(firstLaunchPlan('/repo/c', live, { repo: '/repo/a' }), { action: 'start-auto', repo: '/repo/c' },
  'a default port serving a different repo starts the named repo its own court instead of a dead-end dialog');
a.deepEqual(firstLaunchPlan('/repo/c', [], null), { action: 'default' }, 'nothing running: the pinned-port flow');
a.deepEqual(firstLaunchPlan('/repo/c', [], { repo: null }), { action: 'default' },
  'a repo-less court on the default port keeps the attach-to-it flow');
a.deepEqual(firstLaunchPlan(null, live, { repo: '/repo/a' }), { action: 'default' }, 'a bare launch keeps the default flow');

// --- a per-window action targets the court THAT window shows ------------------
a.equal(courtPortOf('http://127.0.0.1:7779/', 7777), 7779,
  'a window on a non-default court reports that court\'s port, so a repository switch ends and replaces it — not the default court');
a.equal(courtPortOf('http://127.0.0.1:7777/#/settings', 7777), 7777, 'the default court window keeps the default port');
a.equal(courtPortOf('', 7777), 7777, 'a window with nothing loaded yet falls back to the default port');
a.equal(courtPortOf('https://example.com:8443/', 7777), 7777, 'a non-court URL never names a court port');

console.log('t-courts-launch.js OK — a relaunch focuses a live court by repo (or the most recent one), and only starts a fresh daemon when nothing matches');
