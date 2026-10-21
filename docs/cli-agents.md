# Coding CLI agents

Use the existing roster entries in `agenticos.config.json`: `name`, `cli`,
`model`, `prompt`, and CLI-specific options. Credentials stay in the CLI's
own authentication store or environment. Claude's `CLAUDE_CODE_OAUTH_TOKEN`
is inherited after host-session markers are removed. Never put credentials
in roster entries, command arguments, or MCP configuration.

```json
{
  "name": "coder",
  "cli": "cursor",
  "model": "your-account-model-id",
  "mode": "plan",
  "sandbox": "enabled",
  "skipPermissions": false,
  "prompt": "Inspect the assigned workspace and report your findings."
}
```

`cursor`, `cursor-agent`, and `agent` select the same adapter. Model ids come
from your account; run `cursor-agent models` and populate `models.cursor` in
your workspace config. The shipped list is empty to avoid inventing model ids.

## What is verified, and what is not

Codex, Claude Code, Antigravity and OpenCode argument shapes are the ones this
repository measured before the adapter refactor; `test/t-cli-adapters.js` pins
the Codex and Claude argv to the pre-refactor form. **Cursor's flags were read
from its installed help by the author of the `codex/cli-integrations` branch
(2026-10-10) and have not been exercised here against a real binary.** Every
adapter test runs against fakes. Flags change when a CLI updates; inspect its
help again when an invocation fails.

| CLI | Invocation and output | Resume | Permission options in the roster |
|---|---|---|---|
| Codex | `codex exec --json … -`; JSONL, prompt on stdin | Saved thread id → `exec resume ID` | `sandbox`: `read-only`, `workspace-write`, `danger-full-access` (default; confining modes deny every MCP call) |
| Claude Code | `claude --print --input-format stream-json --output-format stream-json`; persistent stdin turns | Saved session id → `--resume ID` | `permissionMode` → `--permission-mode` (default `bypassPermissions`); existing `tools`, `deny`, `maxBudgetUsd` |
| Antigravity | `agy --print PROMPT --output-format stream-json` | Saved conversation id → `--conversation ID` | `skipPermissions: false` omits the default `--dangerously-skip-permissions`; `effort` only `low`/`medium`/`high` |
| OpenCode | `opencode run PROMPT --format json --title NAME`; JSONL | Saved session id → `--session ID` | `skipPermissions: false` omits the default `--auto` |
| Cursor | `cursor-agent --print --output-format stream-json --workspace DIR … PROMPT` | Saved session id → `--resume ID` | `mode`: `plan` or `ask`; `sandbox`: `enabled` or `disabled`; `skipPermissions: false` omits default `--force`; `trust` and `approveMcps` control their flags |

There is no "continue the latest session" option: officers share a working
directory, so "latest" can be another member's session. Saved ids are the only
resume path.

All adapters pass `model` via `--model`. Codex sends `effort` through
`model_reasoning_effort`; Claude and Antigravity use `--effort`; OpenCode uses
`--variant`. Cursor model parameterisation belongs in the model string.

Claude, Antigravity and Cursor accept `outputFormat: "json"` as an alternative
to the default stream. Claude then runs one process per turn with the prompt as
text on stdin; its default stream mode keeps one process alive and can accept
injected turns. The other CLIs queue messages until the current process ends.

## Turn lifecycle

Common events are `ready(sessionId)`, `text(string)`, `tool({name,input})`,
`turn_end({usage,costUsd,costReported,ctx})`, and `error(message)`. A
turn-based process emits exactly one `turn_end`, when it finishes: OpenCode's
per-step `step_finish` events accumulate usage and cost into that one. The turn
finishes on `close`, so the last unterminated JSON line is still parsed; if
`exit` arrives and `close` does not follow within two seconds (a grandchild
holding the pipe), the turn ends anyway. A failed, incomplete or killed process
always releases the busy state and ends the turn. Unknown usage stays `null`;
it is never reported as zero tokens.

Prompts that start with `-` are passed to argument-based CLIs (OpenCode,
Cursor) with a leading newline so they cannot be parsed as an option. Codex
prompts stay off argv. Large prompts for argument-based CLIs are staged in
private (0600) temporary files and removed when the turn ends. Every
turn-based invocation has the existing watchdog (`KINGDOM_TURN_TIMEOUT_MS`).

## Workspaces and MCP

The child's working directory is always the assigned workspace. Codex receives
`-C` only on a new session; its resume accepts a narrower flag set. Cursor also
receives `--workspace`. OpenCode and Cursor officers each use their own
directory under the kingdom dir to prevent identity collisions.

Cursor reads `.cursor/mcp.json` from its workspace. The court writes one with
the member's identity, and `--trust --approve-mcps` by default so headless runs
are not stopped by prompts. `--approve-mcps` approves every server in that
file, so the court **never modifies an existing `.cursor/mcp.json` it did not
write** (a repository's own, checked out into a peasant worktree): that member
runs without kingdom tools and a warning says so. `.cursor/mcp.json` is added
to `.git/info/exclude`.

Neither Antigravity nor Cursor is given `--add-dir`: neither flag is verified,
and peasants always receive extra directories, so an unknown flag would fail
every peasant turn. A Cursor or Antigravity peasant therefore cannot be assumed
to read its siblings' worktrees.

## Binaries

Detection searches `~/.local/bin`, agy's install directory and PATH, preserving
existing Windows native and npm entry resolution. For Cursor, `cursor-agent` is
searched in every directory before the generic `agent`. Override a binary with
`KINGDOM_CODEX_BIN`, `KINGDOM_CLAUDE_BIN`, `KINGDOM_AGY_BIN`,
`KINGDOM_OPENCODE_BIN` or `KINGDOM_CURSOR_BIN` (every Cursor alias). A `.js`
override runs with Node and is used by offline tests.

On Windows only `.exe` files are found: `.cmd`/`.ps1` shims would need a shell,
which shreds JSON arguments. If Cursor installs only a shim there, point
`KINGDOM_CURSOR_BIN` at its `.js` entry or native executable. This is not
verified on Windows.

## Doctor

`npm run doctor` (and `GET /api/doctor`, which runs on every app start) checks
versions and the following bounded, non-billing status commands. It sends no
model prompt. Raw output is parsed privately and never included in the report.

| CLI | Authentication check |
|---|---|
| Codex | `codex login status` |
| Claude | `claude auth status`; env credentials reported as supplied, unverified |
| Antigravity | `agy models` (stdin detached, 25 s cap); also checks the global kingdom MCP declaration |
| OpenCode | `opencode auth list`; a positive stored-credential count confirms, zero stays unverified (env-var providers are not counted) |
| Cursor | `cursor-agent status --format json`; `CURSOR_API_KEY` reported as supplied, unverified |

`detectCli` returns `installed`, tri-state `authenticated` (`true`, `false`,
`null` for unverified), and a safe reason. Doctor reads the repository's own
config when it has one, checks configured backends as required and reports
other known CLIs only when installed. It cannot prove account balance or
successful model execution.

## Not supported

Freebuff was proposed by the `codex/cli-integrations` branch only as a refusal
stub: by that author's reading its 0.2.26 release has no non-interactive prompt
or JSON mode. A stub that can never run is not an adapter, so it is not wired
in; `cli: "freebuff"` fails its first turn with "Unsupported agent CLI".
