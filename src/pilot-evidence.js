// The Habitable pilot's evidence gate — HANDOFF.md "Habitable pilot" steps 2
// and 4: `flutter analyze`, `flutter test` with coverage, and a debug APK
// build, each recorded independently so one failing step never hides
// whether the others even ran. Missing tooling (src/pilot-doctor.js) is a
// single visible blocker raised BEFORE any step runs — never a raw ENOENT
// half-way through, and never partial work silently discarded: this module
// only spawns read-only-to-the-repo tool invocations, it never deletes or
// reverts anything in `dir`.
//
// Source-side only, and deliberately never pointed at the real Habitable
// checkout (`E:\AI\Mobile Apps\Habitable`) from this repository — every real
// subprocess call goes through the injectable `exec`, so
// test/t-pilot-evidence.js proves the gate's OWN behaviour (blocking,
// sequencing, result shape) with fakes on a machine that has no Flutter
// installed at all, which is what this repository's own dev sandbox is.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPilotDoctor } from './pilot-doctor.js';

const execFileP = promisify(execFile);

async function runStep(exec, cmd, args, cwd, timeoutMs) {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs,
    });
    return { ran: true, ok: true, output: (String(stdout ?? '') + String(stderr ?? '')).slice(-8000) };
  } catch (e) {
    return {
      ran: true, ok: false,
      output: (String(e.stdout ?? '') + String(e.stderr ?? '') || String(e.message ?? '')).slice(-8000),
    };
  }
}

export function isFlutterProject(dir, existsFn = existsSync) {
  return existsFn(join(dir, 'pubspec.yaml'));
}

/**
 * Run the gate against `dir` (a run's worktree, or a snapshot restored per
 * src/snapshot.js — this function does not care which). Every dependency is
 * injectable: `exec` for the three tool invocations, `doctor` for the
 * tooling check, `existsFn` for both the pubspec and coverage-file checks.
 *
 * Returns one of three shapes:
 *   - `{ blocked: true, reason }` — not a Flutter project at all (nothing to
 *     gate; not a failure of the gate itself).
 *   - `{ blocked: true, reason, checks }` — a Flutter project, but required
 *     tooling is missing; `checks` names exactly what (from runPilotDoctor).
 *   - `{ blocked: false, ok, steps, checks }` — every step ran; `ok` is
 *     whether ALL of analyze/test/build passed. A step's own `ok` is
 *     reported independently, so "analyze failed but the build still ran
 *     and its own result is right here" is visible rather than short-
 *     circuited away.
 */
export async function runPilotEvidenceGate(dir, {
  exec = execFileP, doctor = runPilotDoctor, existsFn = existsSync, timeoutMs = 15 * 60 * 1000,
} = {}) {
  if (!isFlutterProject(dir, existsFn)) {
    return { blocked: true, reason: `${dir} has no pubspec.yaml — this is not a Flutter project.` };
  }

  const tooling = await doctor();
  if (!tooling.ready) {
    return {
      blocked: true,
      reason: 'Required Flutter/Android tooling is missing — see `checks` for exactly what, '
        + 'and .claude/arms/pilot.md for how this machine last verified it.',
      checks: tooling.checks,
    };
  }

  const steps = {};
  steps.analyze = await runStep(exec, 'flutter', ['analyze'], dir, timeoutMs);
  steps.test = await runStep(exec, 'flutter', ['test', '--coverage'], dir, timeoutMs);
  // Coverage is a FACT about what the test step produced, not a step of its
  // own — recorded regardless of whether the test step passed, since a
  // partial coverage file from a failing run is still evidence worth
  // preserving (operating rule 4: preserve partial work).
  steps.coverage = { available: existsFn(join(dir, 'coverage', 'lcov.info')) };
  steps.buildApk = await runStep(exec, 'flutter', ['build', 'apk', '--debug'], dir, timeoutMs);

  const ok = steps.analyze.ok && steps.test.ok && steps.buildApk.ok;
  return { blocked: false, ok, steps, checks: tooling.checks };
}
