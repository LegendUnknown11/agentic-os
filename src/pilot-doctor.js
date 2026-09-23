// Doctor-style detection for the Habitable pilot's own tooling — HANDOFF.md
// "Habitable pilot" step 2: before a worker can capture `flutter analyze`,
// `flutter test`, coverage, or a debug APK build, something has to know
// whether flutter/dart/adb/an emulator are even present, and say so as a
// concrete, visible blocker rather than a raw spawn ENOENT.
//
// Same shape as src/doctor.js's runDoctor(): `{ checks, failures, ready }`,
// where a check is `{ level: 'ok'|'warn'|'fail', message }`. Deliberately a
// SEPARATE module rather than added to doctor.js — the two are checked at
// different times (once at app boot, the other only when a worker is about
// to touch a Flutter target) and doctor.js's checks all assume the court's
// own CLIs, not a target repository's toolchain.
//
// This module never touches the real Habitable checkout and never assumes
// Flutter is installed on the machine running its own tests — every real
// subprocess call goes through the injectable `exec`, exactly so
// test/t-pilot-doctor.js can run with fakes on a machine that has none of
// this tooling (this repository's own CI and dev sandbox, today).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

const execFileP = promisify(execFile);

async function tryExec(exec, cmd, args) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { windowsHide: true });
    return { ok: true, out: (stdout || stderr || '').trim() };
  } catch (e) {
    return { ok: false, out: (((e.stdout ?? '') + (e.stderr ?? '')) || e.message || '').trim() };
  }
}

/**
 * `exec`, `env` and `existsFn` are all injectable for the test suite; real
 * callers use the defaults (a real child_process execFile, process.env, and
 * a real fs.existsSync).
 */
export async function runPilotDoctor({
  exec = execFileP, env = process.env, existsFn = existsSync,
} = {}) {
  const checks = [];
  const ok = (message) => checks.push({ level: 'ok', message });
  const warn = (message) => checks.push({ level: 'warn', message });
  const fail = (message) => checks.push({ level: 'fail', message });

  // Hard requirements: analysis, tests, and a build all need these.
  const flutter = await tryExec(exec, 'flutter', ['--version']);
  if (flutter.ok) ok(`flutter: ${flutter.out.split('\n')[0]}`);
  else fail(`flutter not found on PATH: ${flutter.out || 'command failed'}`);

  const dart = await tryExec(exec, 'dart', ['--version']);
  if (dart.ok) ok(`dart: ${dart.out.split('\n')[0]}`);
  else fail(`dart not found on PATH: ${dart.out || 'command failed'}`);

  const adb = await tryExec(exec, 'adb', ['version']);
  if (adb.ok) ok(`adb: ${adb.out.split('\n')[0]}`);
  else fail(`adb not found on PATH (Android SDK platform-tools): ${adb.out || 'command failed'}`);

  // Soft signals: useful context, but neither blocks analyze/test/build.
  const androidHome = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (androidHome) {
    if (existsFn(androidHome)) ok(`Android SDK: ${androidHome}`);
    else warn(`ANDROID_HOME/ANDROID_SDK_ROOT is set to "${androidHome}", which does not exist`);
  } else {
    warn('ANDROID_HOME/ANDROID_SDK_ROOT is not set — the SDK path is unconfirmed even though adb answered');
  }

  // Emulator readiness is explicitly separate from tool presence (see
  // .claude/arms/pilot.md) — an AVD is needed only for the LATER emulator
  // demonstration step (HANDOFF.md step 4), never for analyze/test/build.
  const avds = await tryExec(exec, 'emulator', ['-list-avds']);
  if (avds.ok) {
    const names = avds.out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (names.length) ok(`emulator: ${names.length} AVD(s) configured (${names.join(', ')})`);
    else warn('emulator: no AVDs configured — create one before an emulator demonstration');
  } else {
    warn(`emulator binary not found or failed to list AVDs: ${avds.out || 'command failed'}`);
  }

  const failures = checks.filter((c) => c.level === 'fail').length;
  return { checks, failures, ready: failures === 0 };
}

// --- CLI entry point: `node src/pilot-doctor.js`, real tools, no fakes -----
if (basename(process.argv[1] ?? '') === 'pilot-doctor.js') {
  const paint = { ok: '\x1b[32m✔\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✘\x1b[0m' };
  const { checks, failures } = await runPilotDoctor();
  for (const { level, message } of checks) console.log(`${paint[level]} ${message}`);
  console.log(failures
    ? `\n\x1b[31m${failures} blocking problem(s).\x1b[0m analyze/test/build cannot run until these are fixed.`
    : '\n\x1b[32mReady for the pilot evidence gate.\x1b[0m');
  process.exit(failures ? 1 : 0);
}
