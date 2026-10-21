# Claim classes and what settles them

Companion to [SKILL.md](SKILL.md). Run these from the repository root.

| Claim class | Settled by | Has gone stale |
|---|---|---|
| Suite count | `npm.cmd test`, read the printed `N suites` line | yes — recorded 71, run printed 73 (`018fae7`) |
| Local vs remote sync | `git status -sb` | yes — claimed two commits ahead with the push outstanding; they were in sync |
| Which branches are alive | `gh pr list --state all --json headRefName,state` | yes — 21 branches read as unmerged by ancestry with every PR merged |
| Design-system source | the header comment in `ui/app.css`, which is at the code | yes, three times — Hiveory replaced the Cold-Call kit on 2026-09-17, the kit was reinstated on 2026-09-21, and the dark T3 Code system replaced it on 2026-10-21. `PLAN.md` section 1 still holds the Hiveory spec as the record of what was agreed then, so PLAN is the wrong file to read for what ships |
| What is implemented | `PLAN.md`'s closed-by table against `git log` | yes — listed the whole interface rebuild outstanding with sections 1–4 landed |
| External toolchain presence | `command -v flutter dart adb gh claude` | yes — Flutter and Android discovery recorded unresolved; all three are on PATH as of 2026-09-22 |
| A named key file exists | `git ls-files <path>` for each row of the key-files table | not yet |
| A referenced command exists | `npm run` against the `scripts` block in `package.json` | not yet |

## Traps inside the sweep

- **Ancestry is the wrong branch test.** This repository squash-merges, so a
  merged branch does not appear under `git branch -r --merged origin/main`. The
  PR record is the record.
- **A slow test run is not a failing one.** The same suite set has printed 36.8s
  and 179.6s on this machine under 4-wide contention.
- **`team self-control` is the known flaky suite.** Read the runner's retry
  result before recording a failure.
- **Tooling presence is not readiness.** `flutter` on PATH does not mean an
  emulator is available, a device is attached, or signing is configured. Correct
  the tooling claim without inflating it into an acceptance claim.

## A suite that skipped is not a suite that passed

`t-theme-geometry.js` needs Chromium and skips itself with a note when it
cannot launch one. This repository's CI has no browser install step, so it
skips there every time. A sweep that reads "all suites passed" as "layout is
covered" has recorded the one thing this suite was written to prevent.

## Evidence classes, which also go stale

The acceptance clause of `PLAN.md` section 1 was unmet for weeks and is now
met: a live session on 2026-09-21 drove a run through its lifecycle, recovered
a blocked run, and exercised the collapsed rail, the 720px drawer with its
keyboard path, and reduced motion, first in a browser and then in Electron.

So the sweep runs in both directions. An unmet gap that has since been closed
is as stale a claim as a figure that moved, and re-asserting it is the same
error as quoting an old suite count. What has *not* been supplied is device,
signing, provider and human-acceptance evidence. Check the current text before
repeating any of it.
