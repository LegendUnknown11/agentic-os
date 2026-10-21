import { strict as a } from 'node:assert';
import { switchRepo } from '../electron/switch-repo.js';

// A fake clock and a fake sleep so the port-free-timeout test runs in zero
// real time instead of actually waiting 15 seconds.
function fakeDeps(overrides = {}) {
  const calls = [];
  let clock = 0;
  return {
    calls,
    deps: {
      resolve: (p) => `/resolved/${p}`,
      assertRepo: async (repo) => { calls.push(['assertRepo', repo]); },
      confirm: async (repo) => { calls.push(['confirm', repo]); return true; },
      shutdown: async () => { calls.push(['shutdown']); },
      teamOnPort: async () => { calls.push(['teamOnPort']); return false; },
      startDaemon: async (repo, logPath) => { calls.push(['startDaemon', repo, logPath]); },
      reload: () => { calls.push(['reload']); },
      logPath: '/tmp/daemon.log',
      now: () => clock,
      wait: async (ms) => { clock += ms; calls.push(['wait', ms]); },
      ...overrides,
    },
  };
}

// --- empty path never touches anything, including validation -----------
{
  const { calls, deps } = fakeDeps();
  const result = await switchRepo('', deps);
  a.deepEqual(result, { ok: false, error: 'Choose a repository first.' });
  a.deepEqual(calls, [], 'an empty path must be rejected before any dependency runs, validation included');
}

// --- an invalid repo is rejected before the destructive confirmation ----
// This is the exact ordering Greptile's PR #69 review flagged: a bad path
// must never reach confirm/shutdown/startDaemon.
{
  const { calls, deps } = fakeDeps({
    assertRepo: async (repo) => { calls.push(['assertRepo', repo]); throw new Error(`${repo} is not a git repository.`); },
  });
  const result = await switchRepo('/some/path', deps);
  a.deepEqual(result, { ok: false, error: '/resolved//some/path is not a git repository.' });
  a.deepEqual(calls, [['assertRepo', '/resolved//some/path']],
    'a failed validation must stop before confirm, shutdown, or startDaemon ever run');
}

// --- a cancelled confirmation stops before anything destructive ---------
{
  const { calls, deps } = fakeDeps({ confirm: async (repo) => { calls.push(['confirm', repo]); return false; } });
  const result = await switchRepo('/repo', deps);
  a.deepEqual(result, { canceled: true });
  a.deepEqual(calls, [['assertRepo', '/resolved//repo'], ['confirm', '/resolved//repo']],
    'cancelling at the confirmation must never reach shutdown or startDaemon');
}

// --- the old team failing to free the port surfaces a clear error ------
{
  const { calls, deps } = fakeDeps({
    teamOnPort: async () => { calls.push(['teamOnPort']); return true; }, // never frees
    now: (() => { let t = 0; return () => (t += 20_000); })(), // jumps straight past the 15s deadline
  });
  const result = await switchRepo('/repo', deps);
  a.deepEqual(result, { ok: false, error: 'The previous workspace did not end in time. Try again in a moment.' });
  a.ok(calls.some((c) => c[0] === 'shutdown'), 'shutdown must still be attempted before the wait loop');
  a.ok(!calls.some((c) => c[0] === 'startDaemon'), 'a team that never frees its port must never reach startDaemon');
}

// --- a team that refuses to end stops the switch, visibly --------------
{
  const { calls, deps } = fakeDeps({
    shutdown: async () => { calls.push(['shutdown']); return { ok: false, error: 'the workspace refused to end (HTTP 415)' }; },
  });
  const result = await switchRepo('/repo', deps);
  a.deepEqual(result, { ok: false, error: 'the workspace refused to end (HTTP 415)' });
  a.ok(!calls.some((c) => c[0] === 'teamOnPort' || c[0] === 'startDaemon'),
    'a refused shutdown must stop before waiting on the port or starting a second team');
}

// --- a daemon that fails to start surfaces its own error -----------------
{
  const { calls, deps } = fakeDeps({
    startDaemon: async (repo, logPath) => { calls.push(['startDaemon', repo, logPath]); throw new Error('Node 24+ must be on PATH.'); },
  });
  const result = await switchRepo('/repo', deps);
  a.deepEqual(result, { ok: false, error: 'Node 24+ must be on PATH.' });
  a.ok(!calls.some((c) => c[0] === 'reload'), 'a daemon that fails to start must never reload the window');
}

// --- the happy path runs every step, in order, and reloads once ---------
{
  const { calls, deps } = fakeDeps();
  const result = await switchRepo('/repo', deps);
  a.deepEqual(result, { ok: true, repo: '/resolved//repo' });
  a.deepEqual(calls.map((c) => c[0]), ['assertRepo', 'confirm', 'shutdown', 'teamOnPort', 'startDaemon', 'reload'],
    'a successful switch must validate, confirm, end the old team, wait for it to free the port, start the new one, then reload — in that order');
  a.deepEqual(calls.find((c) => c[0] === 'startDaemon').slice(1), ['/resolved//repo', '/tmp/daemon.log'],
    'the fresh daemon must start against the resolved repo path and the real log path');
}

console.log('t-repo-switch.js OK — the end-team-and-switch flow validates before it confirms, confirms before it destroys, and only reloads after the new team answers');
