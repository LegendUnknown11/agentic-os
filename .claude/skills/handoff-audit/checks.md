# Claim classes and what settles them

Companion to [SKILL.md](SKILL.md). Run these from the repository root.

| Claim class | Settled by | Has gone stale |
|---|---|---|
| Suite count | `npm.cmd test`, read the printed `N suites` line | yes — recorded 71, run printed 73 (`018fae7`) |
| Local vs remote sync | `git status -sb` | yes — claimed two commits ahead with the push outstanding; they were in sync |
| Which branches are alive | `gh pr list --state all --json headRefName,state` | yes — 21 branches read as unmerged by ancestry with every PR merged |
| Design-system source | `PLAN.md` section 1, then the header comment in `ui/app.css` | yes — named `E:\Prototype.zip` after Hiveory replaced it on 2026-09-17 |
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
- **`court self-control` is the known flaky suite.** Read the runner's retry
  result before recording a failure.
- **Tooling presence is not readiness.** `flutter` on PATH does not mean an
  emulator is available, a device is attached, or signing is configured. Correct
  the tooling claim without inflating it into an acceptance claim.

## The acceptance clause

`PLAN.md`'s five sections are closed and its acceptance clause is unmet: no
Electron or browser session has demonstrated a run lifecycle, a blocked run's
recovery, the collapsed rail, the 720px drawer with its keyboard path, or
reduced-motion behaviour. A sweep must not quietly resolve that gap. Source
evidence is not acceptance, and closure does not waive it.
