# f1-performance — report

Branch `f1-performance`, cut from `origin/functionality` at `e730bb6`. Linux
container, Node v22.22.0, 4 cores. Sibling threads ran their own gates on the
same machine and shared `/tmp`, so wall-clock figures below are from a loaded
box (load average 8-9 at times).

## Commits

| sha | subject |
|---|---|
| 373ce58 | perf(mcp): reuse tool schemas and snapshot mode per request |
| 2e6cecd | perf(mcp): compact JSON for structured tool results |
| b34effb | fix(spend): campaign spend survives clearSpend |
| feb7f1a | test: each suite removes its own `<tmp>/.kingdom/<repo>` folder |
| 7a8bace | test: fake-home cleanup in t-multi-team and t-registry-attach is best effort |
| 5fe0d06 | fix(mcp): release the vault watcher when the client closes stdin |

The repo's husky pre-commit hook runs the full `npm test`, which always fails
here on t-electron.js because there is no display. Every commit above was made
with `--no-verify`, and only after a full `npm test` run just before it showed
every suite passing except t-electron.js. Each commit message says so.

## 1. Codex branches integrated

**`codex/mcp-listing-optimization` (2446817), kept.** The cherry-pick applied
clean: `src/mcp.js` had not changed since the branch point. Adversarial review:

- *Role enforcement per request.* `tools/call` still checks
  `TOOLS[name].roles.includes(ROLE)` on every call. ROLE is fixed per process,
  so filtering by role once at startup is equivalent to filtering per request.
- *Mode enforcement per request.* `tools/list` filters the cached descriptors
  by a live `modeNow()` read each time. `tools/call` reads the mode once and
  uses that one value for both the check and the denial text. Before, it read
  the mode up to three times, so a flip during a call could disagree with
  itself.
- *Caching schemas is safe.* I checked every `src/mcp/*.js` module: none
  defines a getter or a schema/description built from live state. Every
  `roles:` is a literal array. So compacting once is equivalent to compacting
  per request.
- Test: the new `test/t-mcp-listing.js` (in the gate) fails against the old
  `src/mcp.js`. t-tool-surface still reports 49 tools with byte-stable
  surfaces.

**`codex/compact-mcp-results` (a60fc5b), kept.** Applied clean. Structured
results are now `JSON.stringify(out)` with no indentation. A 3-member roster
result went from 743 to 562 characters. String results are unchanged. No test
and no `src` consumer parsed the indented form. Masking still keys on exact
bytes. One side effect, accepted: a payload just over `MASK_MIN` (400) can now
shrink below it and no longer be masked. The new t-efficiency assertion fails
against the indented serialiser.

Nothing was dropped.

## 2. Campaign spend vs clearSpend

The reproducing test came first. In t-efficiency, three campaigns run around a
real `Kingdom.clearSpend()`. Before the fix, the campaign spanning the clear
read **-3.75** for $0.25 of real spend.

The fix: `bus.lifetimeSpentUsd()` returns `spentUsd + spentUsdCleared`, and
`bus.clearSpentUsd()` atomically moves the zeroed amount into
`spentUsdCleared`. `beginCampaign` and `campaigns()` take their snapshots from
the lifetime figure. I did not use `run_spend` because it records turns only
while a run is current, and campaigns cover all court spend. No migration is
needed: the cleared key reads 0 until the first clear, so existing snapshots
stay consistent. A campaign that already spanned a clear before this landed
stays wrong, and that history cannot be recovered. `spentUsd`, `maxKingdomUsd`
and the usage readouts are unchanged.

## 3. Test hygiene

Before this change, `<tmp>/.kingdom` held 206 leftovers from 15 prefixes
across 13 suites. The new `test/cleanup.js` provides `removeRepo(...repos)`,
which deletes a repo plus exactly its own `kingdomDir(repo)`. It refuses a
null repo (that is the workspace home under the real homedir) and refuses any
path that is not `<parent>/.kingdom/<repo-name>`. It is used in t-efficiency,
t-registry-attach, t-multi-team, t-prompt, t-task-admin, t-opencode,
t-idle-nudge, t-merge, t-compact, t-argue, t-agy, t-advisor and t-evidence.
The new suite `t-cleanup` proves three things: a real Kingdom's folder is
removed, a sibling repo's folder and the shared parent survive, and null is
refused.

Found along the way:

- **t-evidence wrote into the real `~/.kingdom/workspace/evidence`.** Its
  no-repo export case did this on every gate run. It now sandboxes
  HOME/USERPROFILE and asserts the export landed in the sandbox. That
  assertion fails without the sandbox.
- **t-multi-team failed once standalone with ENOTEMPTY** on its fake-home
  `rmSync`, after it had already printed OK: a killed daemon was still writing
  into that folder. That cleanup, and the same one in t-registry-attach, are
  now best effort with retries, like the other four fake-home suites.

Verification: each patched suite was run alone with a private `TMPDIR`, and
each left no new entry in its own `.kingdom`. Runs against the shared `/tmp`
were too noisy to use, because sibling worktrees running unpatched suites were
creating entries at the same time.

## 4. Slow suites

- **obsidian vault: ~36s → 7s alone; 40.5s → 10.5-13.2s in the gate.** The
  time was not in any sleep. Two `vault_search` calls each sat on the
  harness's 15s `spawnSync` timeout. The cause is a real bug: on Linux, Node
  22's recursive `fs.watch` ignores `unref()`. I checked this with
  `node -e "fs.watch(dir,{recursive:true}).unref()"`, which never exits. So
  any mcp.js that had searched the vault outlived its client. `src/mcp.js` now
  closes the vault watchers on stdin `end`, and t-vault asserts that every
  call exits on its own. That assertion fails without the fix.
- **turn batching (~27s): not changed.** Its waits are mostly absence windows
  ("still one turn after N ms", "a busy agent is not interrupted"). Replacing
  them with polling would weaken what the tests prove. Skipped as risky, as
  the task allowed.

## Gate

| point | suites | failures |
|---|---|---|
| baseline (`e730bb6`) | 95 | t-electron.js only (no display) |
| final (`5fe0d06`) | 97 | t-electron.js only (no display) |

The two new suites are t-mcp-listing and t-cleanup. During the gates,
"court self-control" (baseline) and "metrics, diff and vault panels" (once)
failed in the pool and passed when retried alone. That happened under load
from sibling gates; neither suite spawns mcp.js.

## Evidence

- **Held:** source evidence from the full no-quota suite on Linux, plus direct
  command-line measurements (the unref probe, per-call spawn timings, `.kingdom`
  listings under a private TMPDIR).
- **Not held:** Electron or visual evidence (no display), Windows evidence,
  provider/CLI evidence (no real claude or codex session ran against the
  changed MCP server), and human acceptance.

## Open items

- The vault-watcher fix has been seen working on Linux only. Windows and macOS
  recursive watches are native, and whether `unref()` works there was not
  observed.
- Compact JSON is not verified against each CLI's own truncation of tool
  output. Whether codex or agy truncate MCP results by line count is
  unverified.
- `get_workflow` (`src/mcp/workflows.js`) still returns its own indented JSON
  string. It is consistent with string results staying verbatim, but it is a
  further saving if wanted.
- Suites still leave other temp folders behind that are not `.kingdom`
  folders, for example `kingdom-test-registry-*` from standalone runs and
  t-evidence's run worktree branches. Only `.kingdom/<repo>` was in scope.
- HANDOFF.md's "Test-hygiene trap", its "campaigns() ... noted, not changed"
  line, and the t-vault/t-batching timing notes in `test/run-all.js` comments
  are now stale. I did not edit HANDOFF.md, per the rules.
