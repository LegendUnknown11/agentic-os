// src/pilot-evidence.js: the Habitable pilot's evidence gate (flutter
// analyze, flutter test --coverage, a debug APK build). Every subprocess
// call and every fs check is faked — Flutter is not installed anywhere near
// this repository's own test run — so this proves the gate's sequencing and
// blocking behaviour, never real Flutter output.
//   node test/t-pilot-evidence.js
import { strict as a } from 'node:assert';
import { runPilotEvidenceGate, isFlutterProject } from '../src/pilot-evidence.js';

const readyDoctor = async () => ({ ready: true, failures: 0, checks: [{ level: 'ok', message: 'stub' }] });
const notReadyDoctor = async () => ({
  ready: false, failures: 1,
  checks: [{ level: 'fail', message: 'flutter not found on PATH: spawn flutter ENOENT' }],
});

function execRouter(table) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(' ')}`;
    const entry = table[key];
    if (!entry) throw new Error(`unexpected exec: ${key}`);
    if (entry.throws) throw entry.throws;
    return entry;
  };
  return { exec, calls };
}

// --- not a Flutter project at all: not a failure, just nothing to gate --
{
  const result = await runPilotEvidenceGate('/some/js/project', { existsFn: () => false });
  a.equal(result.blocked, true);
  a.match(result.reason, /has no pubspec\.yaml/);
  a.equal(result.checks, undefined, 'a non-Flutter target must not even reach the tooling doctor');
}

a.equal(isFlutterProject('/x', () => true), true);
a.equal(isFlutterProject('/x', () => false), false);

// --- a Flutter project with missing tooling: one visible blocker, zero
// steps attempted --------------------------------------------------------
{
  const { exec, calls } = execRouter({});
  const result = await runPilotEvidenceGate('/habitable-fixture', {
    exec, doctor: notReadyDoctor, existsFn: (p) => p.endsWith('pubspec.yaml'),
  });
  a.equal(result.blocked, true);
  a.match(result.reason, /tooling is missing/);
  a.ok(result.checks.some((c) => c.level === 'fail'), 'the blocker must carry the doctor\'s own checks, naming what is missing');
  a.deepEqual(calls, [], 'missing tooling must stop the gate BEFORE any of analyze/test/build is attempted');
}

// --- everything present and every step passes ---------------------------
{
  const { exec, calls } = execRouter({
    'flutter analyze': { stdout: 'No issues found!', stderr: '' },
    'flutter test --coverage': { stdout: '00:03 +12: All tests passed!', stderr: '' },
    'flutter build apk --debug': { stdout: 'Built build/app/outputs/flutter-apk/app-debug.apk', stderr: '' },
  });
  const existing = new Set(['/proj/pubspec.yaml', '/proj/coverage/lcov.info']);
  const result = await runPilotEvidenceGate('/proj', {
    exec, doctor: readyDoctor, existsFn: (p) => existing.has(p),
  });
  a.equal(result.blocked, false);
  a.equal(result.ok, true, 'analyze, test, and build all passing must report the gate as ok');
  a.equal(result.steps.analyze.ok, true);
  a.equal(result.steps.test.ok, true);
  a.equal(result.steps.buildApk.ok, true);
  a.equal(result.steps.coverage.available, true, 'a produced lcov.info must be recorded as available coverage');
  a.deepEqual(calls, [
    ['flutter', 'analyze'],
    ['flutter', 'test', '--coverage'],
    ['flutter', 'build', 'apk', '--debug'],
  ], 'the three steps must run in this order: analyze, test with coverage, then the debug build');
}

// --- analyze fails: the build must still run, and both results are visible
// independently — a bad analyze must never hide whether the build works --
{
  const { exec } = execRouter({
    'flutter analyze': { throws: Object.assign(new Error('analyze failed'), { stdout: '', stderr: 'lib/main.dart:3:1: error: unused import' }) },
    'flutter test --coverage': { stdout: 'All tests passed!', stderr: '' },
    'flutter build apk --debug': { stdout: 'Built app-debug.apk', stderr: '' },
  });
  const result = await runPilotEvidenceGate('/proj', {
    exec, doctor: readyDoctor, existsFn: (p) => p.endsWith('pubspec.yaml'),
  });
  a.equal(result.blocked, false);
  a.equal(result.ok, false, 'one failing step must make the overall gate not-ok');
  a.equal(result.steps.analyze.ok, false);
  a.match(result.steps.analyze.output, /unused import/, 'the failing step\'s own output must be preserved for the run\'s evidence');
  a.equal(result.steps.test.ok, true, 'a failing analyze must not stop the test step from running');
  a.equal(result.steps.buildApk.ok, true, 'a failing analyze must not stop the build step from running — partial work stays visible');
  a.equal(result.steps.coverage.available, false, 'no lcov.info written must be reported as coverage unavailable, not silently assumed');
}

console.log('t-pilot-evidence.js OK — missing tooling blocks before any step runs; once ready, analyze/test/build all run and report independently, in order');
