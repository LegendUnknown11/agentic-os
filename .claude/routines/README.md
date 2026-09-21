# Routines

Three recurring loops. Each is one command; the scheduler is Windows Task
Scheduler, because this workspace is win32 and `cron` is not on it.

Logs are written to `.kingdom/routines/`, which is gitignored. Routine output is
per-machine evidence, not project state.

| Routine | When | Command |
|---|---|---|
| `handoff-sweep` | daily 09:00 | `claude -p "/handoff-audit"` |
| `branch-record` | Mondays 09:15 | `claude -p` over the PR record |
| `gate-log` | nightly 02:00 | `npm test`, tail appended to the log |

Register or re-register all three:

```powershell
powershell -ExecutionPolicy Bypass -File .claude\routines\register.ps1
```

It is idempotent — re-running replaces the existing tasks. Remove them with
`-Unregister`. Nothing is registered until you run it.

## Why these three

**`handoff-sweep`** answers this repository's most-repeated failure. `HANDOFF.md`
is the operating source of truth and has shipped stale figures more than once;
commit `018fae7` corrected four claims in one pass. A daily sweep keeps that from
accumulating between sessions. It runs with `--permission-mode acceptEdits`
because correcting a contradicted claim means editing the file.

**`branch-record`** exists because ancestry lies here. This repository
squash-merges, so a merged branch does not appear under `git branch -r --merged`.
Twenty-one branches once read as unmerged with every pull request merged. The
routine reads the PR record and reports, without deleting anything — a branch
deletion stays a human decision.

**`gate-log`** spends no model at all. It runs `npm test` and appends the printed
summary line to a log, so the suite count becomes something *read* rather than
remembered. That is the whole value: the count is the contract, and the log is
where the next session can look up what the last run actually printed.

## Running one by hand

```powershell
claude -p "/handoff-audit" --permission-mode acceptEdits --permission-prompts none
claude -p "/verify"
```

A routine that fails should fail loudly. Check its log before assuming it ran:

```powershell
Get-Content .kingdom\routines\handoff-sweep.log -Tail 40
```

## A cloud runner

There is no cloud runner for this workspace today, and these three do not need
one: `gate-log` needs this machine's Node and repository, and `handoff-sweep`
edits tracked files that would then need merging back.

If one is added, sync only the repository directory and leave `.kingdom/`
unsynced — it holds per-machine paths, the SQLite bus, and the token store. In
Syncthing terms that is one folder at the repository root with `.kingdom/`,
`node_modules/`, `dist/` and `.tmp-*` in its ignore patterns, which is the same
set `.gitignore` already names. Point the remote runner's routines at the synced
copy and keep `gate-log` local, since a shared log written from two machines
records neither honestly.
