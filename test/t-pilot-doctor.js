// src/pilot-doctor.js: doctor-style detection for the Habitable pilot's
// Flutter/Android tooling. Every real subprocess call is faked — Flutter is
// not installed anywhere near this repository's own test run, and this
// suite proves the module's OWN logic (reads the right binaries, degrades
// visibly per missing tool, treats the SDK path and an emulator as soft
// signals rather than hard blockers) without needing it to be.
//   node test/t-pilot-doctor.js
import { strict as a } from 'node:assert';
import { runPilotDoctor } from '../src/pilot-doctor.js';

const okExec = (out = 'ok') => async () => ({ stdout: out, stderr: '' });
const failExec = (msg = 'command not found') => async () => { throw new Error(msg); };

function execRouter(table) {
  return async (cmd, args) => {
    const fn = table[cmd];
    if (!fn) throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
    return fn(cmd, args);
  };
}

// --- everything present -----------------------------------------------
{
  const result = await runPilotDoctor({
    exec: execRouter({
      flutter: okExec('Flutter 3.24.0'),
      dart: okExec('Dart 3.5.0'),
      adb: okExec('Android Debug Bridge version 1.0.41'),
      emulator: okExec('Pixel_7_API_34\n'),
    }),
    env: { ANDROID_HOME: '/opt/android-sdk' },
    existsFn: () => true,
  });
  a.equal(result.ready, true, 'every tool present and an SDK path that exists must report ready');
  a.equal(result.failures, 0);
  a.ok(result.checks.some((c) => c.level === 'ok' && /Pixel_7_API_34/.test(c.message)), 'a configured AVD must be named, not just counted');
}

// --- flutter missing: a hard blocker, not a thrown exception -----------
{
  const result = await runPilotDoctor({
    exec: execRouter({
      flutter: failExec('flutter: command not found'),
      dart: okExec(), adb: okExec(), emulator: okExec(),
    }),
    env: {},
    existsFn: () => false,
  });
  a.equal(result.ready, false, 'a missing flutter binary must block readiness');
  a.ok(result.checks.some((c) => c.level === 'fail' && /flutter not found/.test(c.message)),
    'the missing tool must be named in a fail-level check, not silently absorbed');
}

// --- adb missing is also a hard blocker (no test/build without it) -----
{
  const result = await runPilotDoctor({
    exec: execRouter({ flutter: okExec(), dart: okExec(), adb: failExec(), emulator: okExec() }),
    env: {}, existsFn: () => false,
  });
  a.equal(result.ready, false, 'a missing adb must block readiness — no Android build without it');
}

// --- no ANDROID_HOME and no AVDs: warnings, never blockers --------------
{
  const result = await runPilotDoctor({
    exec: execRouter({
      flutter: okExec(), dart: okExec(), adb: okExec(),
      emulator: okExec(''), // no AVDs listed
    }),
    env: {},
    existsFn: () => false,
  });
  a.equal(result.ready, true, 'an unset ANDROID_HOME and zero AVDs must not block analyze/test/build');
  a.ok(result.checks.some((c) => c.level === 'warn' && /ANDROID_HOME/.test(c.message)), 'the missing SDK path must still be visible as a warning');
  a.ok(result.checks.some((c) => c.level === 'warn' && /no AVDs configured/.test(c.message)), 'zero AVDs must still be visible as a warning');
}

// --- ANDROID_HOME set but pointing nowhere real -------------------------
{
  const result = await runPilotDoctor({
    exec: execRouter({ flutter: okExec(), dart: okExec(), adb: okExec(), emulator: okExec('') }),
    env: { ANDROID_HOME: '/does/not/exist' },
    existsFn: () => false,
  });
  a.ok(result.checks.some((c) => c.level === 'warn' && /does not exist/.test(c.message)),
    'a stale ANDROID_HOME must be flagged, not silently trusted');
}

console.log('t-pilot-doctor.js OK — flutter/dart/adb are hard blockers, the SDK path and AVDs are visible warnings, nothing throws on a missing tool');
