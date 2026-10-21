---
name: verify
description: Run this repository's test gate and report the result with its evidence typed. Use before calling any change done, before committing, when reporting a suite count or pass/fail, when a suite fails, and when asked whether something works.
---

# verify

The gate is one command. Reporting it honestly is the work.

```powershell
npm.cmd test
```

It excludes `t-agent.js` and `t-comms.js` on purpose: those spend real
subscription quota.

## Read the run, do not remember it

The run prints its own terminal summary, and that printed line is the claim:

```
N suites, 4-wide, Ns
all suites passed
```

The suite count is the contract, and it grows as suites are added. A count from
a handoff, a memory, or an earlier session is a *remembered* claim and is not
admissible. Quote the number the run printed this session.

Duration is not a signal. The same machine has printed 36.8s and 179.6s for the
same suite set under 4-wide contention. `test/run-all.js` documents and measures
that effect. A slow run is not a failing run.

## A failure inside the pool is not yet a failure

The runner re-runs a pool failure alone and prints `flaky (failed in the pool,
passed alone)` when the retry passes. `team self-control` is the one suite known
to do this.

So: read the retry result before reporting anything. A bare pool failure is
*unproven*, not failed.

For a real failure, name the suite, the assertion, and the file — then fix the
cause rather than the assertion. If the test needed changing, behaviour changed;
say that explicitly.

## Adding a suite

`test/run-all.js` holds a hardcoded array, not glob discovery. A new file in
`test/` runs green by never running at all. Add it to the array by hand and
confirm the printed suite count went up by one.

## Type the evidence

Close with what the run proves and what it does not. A passing suite is *source*
evidence. It is never device, signing, provider, or human-acceptance evidence.

This repository has the sharpest available demonstration of why that matters,
and it is worth carrying: on 2026-09-21 the interface had **73 green suites and
eight visible layout defects**, six of them a single root cause — a CSS grid
distributing leftover height across every row it created, so a conversation row
stood 165px tall with 49px left for its title. The suite was green throughout.
"Tests pass" is not "it works".

A suite that skipped is also not a suite that passed. `t-theme-geometry.js`
needs Chromium and skips itself with a note when it cannot launch one, which is
what happens in this repository's CI. Read whether it ran before counting it.

Visual and Electron evidence for the interface contract does now exist, from
that live session; `PLAN.md` records what it covered. Point at that record
rather than re-asserting the gap it closed.

Done when: the printed summary line is quoted, every failure is resolved or
named with its retry result, and the report states which kinds of evidence are
held and which are missing.
