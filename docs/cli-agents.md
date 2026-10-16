# Coding CLI agents

Use the existing roster entries in `kingdom.config.json`: `name`, `cli`,
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
Freebuff's model list is empty because it cannot be spawned headlessly.

The installed help was inspected on 2026-10-10, including Codex exec/resume,
Claude auth status, OpenCode run/auth list, Cursor status/MCP, and Freebuff
login help. Flags can change when a CLI updates; inspect its help again when
an invocation fails.

| CLI | Invocation and output | Resume | Permission options in the roster |
|---|---|---|---|
| Codex | `codex exec --json -`; JSONL, prompt on stdin | Saved thread id → `exec resume ID`; `continue: true` → `--last` | `sandbox`: `read-only`, `workspace-write`, `danger-full-access`; `approvalPolicy` passed through `-c` |
| Claude Code | `claude --print --input-format stream-json --output-format stream-json`; persistent stdin turns | Saved session id → `--resume ID`; `continue: true` → `--continue` | `permissionMode` passed to `--permission-mode`; default `bypassPermissions`; existing `tools`, `deny`, `maxBudgetUsd` retained |
| Antigravity | `agy --print PROMPT --output-format stream-json` | Saved conversation id → `--conversation ID`; `continue: true` → `--continue` | `mode`: `accept-edits` or `plan`; `sandbox: true`; `skipPermissions: false` omits the default `--dangerously-skip-permissions` |
| OpenCode | `opencode run PROMPT --format json --title NAME`; JSONL | Saved session id → `--session ID`; `continue: true` → `--continue` | `skipPermissions: false` omits the default `--auto`; no invented sandbox flag |
| Cursor | `cursor-agent --print --output-format stream-json --workspace DIR` | Saved session id → `--resume ID`; `continue: true` → `--continue` | `mode`: `plan` or `ask`; `sandbox`: `enabled` or `disabled`; `skipPermissions: false` omits default `--force`; `trust` and `approveMcps` control their flags |
| Freebuff 0.2.26 | Interactive UI only; no prompt/JSON flags in installed help or argument parser | Interactive `--continue [ID]` only | Interactive `--cwd` and `--trust-agents` only; adapter refuses headless runs with a visible error |

All runnable adapters pass `model` via `--model`. Codex sends `effort` through
`model_reasoning_effort`; Claude and Antigravity use `--effort`; OpenCode uses
`--variant`. Antigravity currently publishes `low`, `medium`, `high`, `xhigh`,
and `max`. Cursor model parameterization belongs in the model string.

Antigravity, Cursor, and Claude accept `outputFormat: "json"` as an alternative
to the default stream. Claude then runs one process per turn with text stdin;
its default stream mode keeps one process alive and can accept injected turns.
The other CLIs queue messages until the current process closes. JSON parsers
handle chunk boundaries, pretty-printed objects, and a final line without a
newline. Common events are `ready(sessionId)`, `text(string)`,
`tool({name,input})`, `turn_end({usage,costUsd,costReported,ctx})`, and
`error(message)`. OpenCode's model steps accumulate usage and finish one agent
turn when the process closes. A failed or incomplete process always releases
the busy state and ends the turn.

The child's working directory is always the assigned workspace. Codex receives
`-C` only on a new session; its resume accepts a narrower flag set. Cursor also
receives `--workspace`. Existing MCP wiring remains for Claude, Codex,
Antigravity and OpenCode. Cursor receives `.cursor/mcp.json` with the member's
identity, workspace trust and MCP approval flags by default. OpenCode and Cursor
officers each use their own directory to prevent identity collisions.

Agentic OS's existing permission defaults permit tool use automatically.
Codex's default `danger-full-access` preserves its MCP tools; the repository
has observed confining Codex modes denying those calls. Explicit permission
settings are forwarded, and each CLI remains responsible for enforcement.

Codex prompts stay off argv. Large prompts for argument-based CLIs are staged
in private temporary files and removed on close. Every turn-based invocation
has the existing watchdog (`KINGDOM_TURN_TIMEOUT_MS`).

Detection searches PATH and `~/.local/bin`, preserving existing Windows native
and npm entry resolution. Override a binary with `KINGDOM_CODEX_BIN`,
`KINGDOM_CLAUDE_BIN`, `KINGDOM_AGY_BIN`, `KINGDOM_OPENCODE_BIN`,
`KINGDOM_CURSOR_BIN` or `KINGDOM_FREEBUFF_BIN`. A `.js` override runs with Node
and is used by offline tests.

`npm run doctor` checks versions and the following bounded, non-billing status
commands. Raw output is captured privately and never included in the report.

| CLI | Authentication check |
|---|---|
| Codex | `codex login status` |
| Claude | `claude auth status`; env credentials reported as supplied, unverified |
| Antigravity | `agy models`; timeout or service failure is unverified |
| OpenCode | `opencode auth list`; counts stored credentials, without claiming every model's provider is authenticated |
| Cursor | `cursor-agent status --format json`; env API key reported as supplied, unverified |
| Freebuff | Version only; no available non-billing auth-status command |

`detectCli` returns `installed`, tri-state `authenticated` (`true`, `false`,
`null` for unverified), and a safe reason. Doctor reads the requested workspace's
config, checks configured backends as required and lists others as optional.
It neither reads token files nor creates token stores nor spends model quota.
It cannot prove account balance or successful model execution.

Offline fixtures run with `npm test`; there are no live model calls in the
adapter tests. Real provider, Electron and Windows validation remain separate
from source tests.
