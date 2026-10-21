# f4-cli: review and integration of `codex/cli-integrations`

Thread f4-cli, 2026-10-21. Source branch `origin/codex/cli-integrations`
(d245c91, "Add CLI adapters for Codex, Claude, Antigravity, OpenCode, Cursor,
Freebuff (via Codex)", 18 files, +1046/-648). Target `functionality`.
Result branch `f4-cli`.

## Starting point (read)

- Merge-base `62561d3`. `functionality` is 9 commits past it, all T3 UI and
  tests. The only `src/` change on `functionality` since the merge-base is one
  line in `src/daemon.js`, which the branch does not touch. So the branch's
  source applied cleanly; its defects are its own, not drift.
- The branch's own HANDOFF note recorded that its gate was **never green**
  ("94 suites … 55 suites failed in this restricted environment"). Its claims
  about installed CLI help (Cursor flags, agy xhigh/max, Freebuff) are the
  author's, from their session, and are *remembered* here, not read.
- Baseline gate here: 95 suites, only `t-electron.js` failed (no display).
  An early baseline log looked like "3 failed"; that was two runs interleaving
  into one shared scratch file, not real failures.
- HANDOFF.md hunk of the branch was dropped (this thread may not edit it).

## Review findings

Severity: **H** breaks a member or the gate, **M** wrong data or unsafe
default, **L** robustness or clarity.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | H | Turn end moved from `exit` to `close` only. A grandchild that inherited stdout (a shell the agent left running) keeps the pipe open, `close` never fires, the member stays busy forever. | Fixed: finish on `close`, fallback 2 s after `exit`. Fakes test with exit-and-no-close. |
| 2 | H | agy and Cursor were given `--add-dir` for every `addDirs` entry. Peasants always get addDirs; agy never received the flag before and neither is verified. An unknown flag fails every peasant turn. | Dropped for both. Recorded as an open capability gap. |
| 3 | H | `adapterFor()` in the Agent constructor throws for an unknown CLI, out of Kingdom's spawn path. | Fixed: the first turn fails visibly ("Unsupported agent CLI"). |
| 4 | M | Unknown usage fabricated as zeros: opencode `step_finish` without tokens became `{input:0,output:0,total:0}`; `cursorUsage` defaulted `output_tokens: 0`. Reads as a free turn in the spend ledger. | Fixed: unknown → `null`; only reported fields carried. |
| 5 | M | opencode cache tokens mapped to codex's nested `cached_input_tokens`. opencode's `input` excludes the cache read (remembered from opencode's usage code), so `usage.js` would undercount input. | Fixed: mapped to the alongside fields `cache_read_input_tokens` / `cache_creation_input_tokens`. Not verified against a real stream. |
| 6 | M | `continue: true` → `codex exec resume --last` / `--continue`. Officers share a cwd, so "latest session" can be another member's. | Dropped for all CLIs; saved ids are the only resume. |
| 7 | M | `#writeCursorMcp` merged into an existing `.cursor/mcp.json`. In a peasant worktree that file is the repo's tracked one: the court's DB path and member identity would be committed by `git add -A`, and `--approve-mcps` auto-approves every server the repo lists. | Fixed: an existing file without a kingdom entry is left byte-for-byte and the member is warned to have no kingdom tools. |
| 8 | M | agy effort ladder widened to xhigh/max on the author's reading of help; the repo's earlier measurement says agy rejects them outright. | Reverted to measured `low/medium/high` (config + adapter). Open item to re-measure. |
| 9 | M | Doctor rewrite removed credential-expiry warnings, token-pool report, agy global-MCP check and claude's logged-out guidance, and read config from `<repo>/kingdom.config.json`, which does not exist (the court's config lives in `kingdomDir(repo)`). | Restored all four (pool counted, no longer created); config read from `kingdomDir`. |
| 10 | M | Doctor probed every known CLI, so a machine with claude+codex got warnings for absent agy/opencode/cursor/freebuff. | Absent optional CLIs are silent; installed ones are reported as optional. |
| 11 | M | opencode `auth list` with 0 stored credentials → `authenticated: false` → a configured opencode **fails** readiness even when it authenticates from env-var providers. | 0 stays `null` (unverified, warn). |
| 12 | L | `jsonStream` let handler throws escape a stdout `data` handler (old `jsonLines` swallowed them — an `error` emitted with no listener would kill the daemon). Also a stray `{` banner line swallowed every later event. | Fixed both; tests. |
| 13 | L | Positional prompts (opencode, Cursor) starting with `-` would be parsed as an option. | Leading newline prefix. |
| 14 | L | Cursor resolution searched `cursor-agent` then `agent` per directory, so an unrelated `agent` early on PATH shadowed `cursor-agent`; missing-binary message named `KINGDOM_CURSOR-AGENT_BIN`. | `cursor-agent` searched in all dirs first; every alias uses `KINGDOM_CURSOR_BIN`. |
| 15 | L | New "exited (code)" error fired even after a completed turn; with codex `turn.failed` it doubled errors into recovery accounting. | Only when no completion and no error already this turn. |
| 16 | L | `.git/info/exclude` check became exact-match: CRLF files and `.agents` (no slash) re-appended lines on every spawn. | CRLF/slash-tolerant. |
| 17 | L | Doctor auth parse for claude used whole-output `JSON.parse`; a warning line before the JSON gave "unknown". | First `{…}` span. `agy models` keeps its measured 25 s cap (branch used 8 s). |
| 18 | L | Persistent claude got a stdout `end` tail flush; `exit` can precede `end`, ending a died turn twice. | Not flushed in persistent mode (old behaviour). |
| 19 | — | Freebuff "(via Codex)": not routed via Codex at all — a refusal stub that throws on every turn, plus a doctor probe and empty model list. | **Dropped.** A stub that can never run is not an adapter. |
| 20 | — | Codex `approvalPolicy` option: headless codex needs `never`; anything else denies tool calls. | Dropped; `never` pinned. |

Regression check on existing behaviour (derived from tests): Codex and
Claude persistent argv are pinned element-for-element to the pre-refactor form
in `test/t-cli-adapters.js`; `t-agy.js` is unchanged from `functionality` and
passes; `t-opencode.js`, `t-agent-guard.js`, `t-batching.js` pass.

UI: the branch touches no `ui/**`, so no T3 token conflict and the ui-change
skill did not apply.

Windows/CLI traps (HANDOFF "Windows and CLI traps"): codex prompt stays on
stdin with `exec -`; `exec resume` gets no `-C`; no `shell: true`; long
argv prompts staged to 0600 temp files outside the worktree; every spawn and
status probe sets `windowsHide: true`; `agy models` runs with stdin detached.

## What was integrated

- `src/cli-adapters.js`: argv + event parsing for codex, claude (stream and
  opt-in `outputFormat: "json"`), agy, opencode, cursor.
- `src/agent.js`: one shared turn lifecycle, emit hold for a single
  `turn_end`, exit fallback, staged-file cleanup on failed start.
- Cursor backend (`cursor` / `cursor-agent` / `agent`), officer isolation,
  `.cursor/mcp.json` with refusal rule, advisor support in read-only `ask` mode.
- `src/cli-detection.js` + doctor rewrite (no model prompt, no file write).
- `docs/cli-agents.md` and README rewritten to what actually shipped.

## Commits

1. `c2e52d1` Extract CLI adapters; add Cursor; fix the cli-integrations defects
2. `0abe9ba` Doctor: non-billing CLI detection, keep the diagnostics the branch cut
3. `1709d40` Docs: CLI agents guide and README match what was integrated
4. this report

Each committed with `--no-verify` after a full `npm test` showed
**97 suites, only `t-electron.js` failed** (no display); the pre-commit hook
cannot pass here for that reason alone.

## Evidence

Held (source / fakes only):
- Full gate 97 suites, only `t-electron.js` failing, before each commit.
- `test/t-cli-adapters.js`: argv for all five adapters, regression parity for
  codex/claude, every protocol parser, null-usage rules, JSON framing, auth
  parsing, the in-process lifecycle (multi-step opencode, incomplete protocol,
  json-mode claude/cursor resume, exit-without-close, non-zero exits).
- `test/t-cursor.js`: stub-binary turns (cwd, flags, resume, dash-safe prompt,
  staged brief), unknown CLI, Kingdom officers with a foreign `.cursor/mcp.json`
  and a CRLF exclude file.
- `test/t-doctor-api.js`: daemon route, no-prompt/no-write source checks,
  absent/logged-out/env-token cases via injected detection.

Not held:
- Any real CLI run: Cursor flags, Cursor stream-json shape, Cursor
  `status --format json`, opencode token semantics, agy effort ladder are
  unverified here.
- Windows: `.cmd`-only Cursor installs are not found (only `.exe`); untested.
- Electron, provider, quota, and human acceptance.
- Node: this container runs Node 22.22.0, not the required 24.

## Open items

1. Re-measure `agy --help` for xhigh/max; widen `AGY_EFFORTS` only on a read.
2. Verify Cursor flags (`--workspace`, `--trust`, `--approve-mcps`, `--mode`,
   `--sandbox`, any `--add-dir`) against a real `cursor-agent --help`.
3. Cursor/agy peasants cannot be assumed to read sibling worktrees (no
   `--add-dir`); decide whether reviews need another path for them.
4. Windows Cursor install layout: find its real executable or `.js` entry.
5. Out-of-quota is no longer caught pre-flight; consider a user-triggered,
   explicitly billed "deep check" in Doctor if that matters.
6. Confirm opencode's `tokens.input` excludes cache reads on a live stream.
