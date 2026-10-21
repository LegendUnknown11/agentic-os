# Agentic OS

[![test](https://github.com/legendunknown11/agentic-os/actions/workflows/test.yml/badge.svg)](https://github.com/legendunknown11/agentic-os/actions/workflows/test.yml)

A team of AI agents that work a git repository together. The difference from
ordinary subagent setups: **the agents talk to each other directly**, not
through the orchestrator.

```
              you
               │
             orchestrator            ← decides, assigns, reviews. Reads almost nothing raw.
               ↑
            briefer           ← drinks the firehose, briefs the orchestrator in detail
               ↑
   ┌───────┬───┴───┬───────┐
architect coder reviewer tester   ← each in its own git worktree, messaging each other
```

## Why the briefer exists

The orchestrator's context is the scarcest thing in the team. If every agent
message reached it, the orchestrator would be incoherent within an hour. So a cheap
model (Haiku) watches *everything* — every message, every tool call — and
briefs the orchestrator on what actually matters. The orchestrator keeps a `read_bus` escape
hatch it should rarely need.

The briefer recycles itself: as it nears its context limit it writes a handover
note, dies, and is respawned seeded with that note. A session can run all day.

## Requirements

- **Node 24+** (uses built-in `node:sqlite`; no native modules anywhere)
- An authenticated coding CLI: `claude`, `codex`, `agy`, `opencode`, or
  `cursor-agent` (also named `agent`). Detection includes `~/.local/bin`.
- The target must be a **git repository**

## Run

```bash
npm install
npm run doctor                  # non-billing installation and auth status checks
npm start                       # Electron app; asks which repo
```

Agent CLI setup and options are described in [docs/cli-agents.md](docs/cli-agents.md).
Doctor never sends a model prompt (it runs on every app start) and never
prints a token. It reads only the expiry of `~/.claude/.credentials.json`. An
environment credential is reported as supplied, with validity unverified, and
status checks do not prove quota: an out-of-quota CLI surfaces on its first
turn. A configured CLI that is missing or logged out blocks readiness; other
CLIs are reported only when installed.

### "OAuth session expired and could not be refreshed"

The single most likely cause: **the `claude` CLI is not logged in.** Being
signed into the Claude *desktop app* does not log in the CLI — they are
separate credential stores. Check with:

```bash
claude auth status      # {"loggedIn": false, "authMethod": "none"} = this is your problem
```

Fix it in a plain terminal:

```bash
claude setup-token      # long-lived token — best for a daemon spawning many agents
claude auth login       # or ordinary browser OAuth
```

Or supply a token through the environment — the daemon spawns every agent as a
child process, so they all inherit it:

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-..."   # this shell only
npm start
```

`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are
all honoured, and take precedence over the stored login (`claude auth status`
will still say `loggedIn: false` — that's expected, and `npm run doctor` knows
the difference).

**Never put a token in `kingdom.config.json`.** That file is written back to
disk whenever you change a model or approve a role, and it is not gitignored.

### Several tokens, so the team doesn't share one rate limit

Five agents on one token exhaust it fast. Give the team a pool and each
member gets assigned one, stably (the same member keeps the same token across
restarts, so resumed sessions stay valid):

```bash
npm run token -- --global sk-ant-oat01-AAA sk-ant-oat01-BBB
```

Stored once in `~/.kingdom/tokens.json` and used by **every** repo, every
launch — no env var, no re-entering. Add more later with the same command
(deduped), or wipe with `-- --global --clear`.

Scope one repo differently by naming it instead of `--global`; a per-repo store
overrides the global one. Resolution order:

```
KINGDOM_CLAUDE_TOKENS  →  <repoParent>/.kingdom/<repo>/tokens.json  →  ~/.kingdom/tokens.json
```

That writes `<repoParent>/.kingdom/<repoName>/tokens.json` — **outside your
repo**, so it can never be committed:

```json
{ "claude": ["sk-ant-oat01-...", "sk-ant-oat01-..."] }
```

Or pass them in the environment instead, which takes precedence:

```powershell
$env:KINGDOM_CLAUDE_TOKENS = "token1,token2"
```

Token values are never logged, never sent to the UI, and never written to
`kingdom.config.json` — only the pool size is ever reported.

Also run everything from a **plain terminal**, not from inside a Claude Code or
Claude Desktop session. Those set `CLAUDE_CODE_*` variables that put spawned
`claude` processes into managed-child-session mode, where they cannot refresh
their own token. `npm run doctor` detects and warns about this.

Or headless / in a browser:

```bash
node src/daemon.js /path/to/repo          # then open http://127.0.0.1:7777
node src/cli.js   /path/to/repo           # pure terminal
```

In the CLI: type to speak to the orchestrator, `@coder do X` to speak to one member,
`/approve <id>`, `/reject <id>`, `/roster`, `/quit`.

## What you approve

Nothing important happens without you:

| The orchestrator proposes | You see |
|---|---|
| `summon` — which agents to wake, and why | a card with the crew and its reasoning |
| `propose_role` — a brand-new kind of agent | the name, prompt, CLI, and rationale; approving writes it into `kingdom.config.json` permanently |
| `request_merge` — work it has reviewed and approves of | its verdict, plus a Merge button |

## The vault

Point Agentic OS at an Obsidian vault and the whole team can use it:

```json
{ "vault": "E:\\Notes\\Obsidian Vault", "vaultWriteDir": "Kingdom" }
```

- `vault_search` / `vault_read` — **the whole vault, read-only.** Members are
  told to search it *before* choosing a model, library or approach, because
  you have usually already written down what you want.
- `vault_write` — durable findings only (decisions, gotchas, conventions), and
  **confined to `vaultWriteDir`** so five agents can't scatter files through a
  personal knowledge base. Notes are attributed and dated, and links render as
  `[[wikilinks]]`.

`.obsidian/` and `.trash/` are never searched or read. Paths and note titles
cannot traverse out of the vault.

## What a session costs

**Turns, not messages.** Each delivered turn replays the recipient's entire
accumulated context, so a session's cost tracks *turn count*. A real run —
"design my app" — spent 34 turns, 21 of them the orchestrator's, and 18 of those were
retries against a bug. Measure with `node test/dump.js <repo> events`.

**Tokens are not the bill.** Replayed context is billed at a *tenth* of fresh
input, so the share of tokens that are replay says almost nothing about what a
session cost. Three tools, all read-only and safe to run mid-session:

| | |
|---|---|
| `node src/ctx.js <repo>` | Where the money went: tokens **and** dollars, split replay / new input / output. |
| `node src/replay.js <repo> [settle] [backstop]` | What a different delivery window would have cost, replayed through the real ripeness rule. |
| `node src/recycle.js <repo>` | What `recycleAtTokens` should be, and whether it is ever reached at all. |

Agentic OS is built around that fact:

| Lever | Effect |
|---|---|
| **Batched delivery** | Messages arriving together become **one** turn, not one each. |
| **Busy agents aren't interrupted** | Delivery waits for idle (up to 90s), so no replay is spent on a half-finished thought. |
| **Notices ride along** | Pure FYI never buys its own turn; it waits for real traffic (or 3 min). |
| **4000-char message cap** | Pasting a file through the bus replays it into someone's context. Write a file, send the path — agents can read each other's worktrees. |
| **Idle sleep** | Untouched members stop after 15 min (`KINGDOM_IDLE_SLEEP_MS`, 0 disables) and revive with memory on the next message. |
| **`effort` per role** | `"effort": "low"` for mechanical roles. |
| **Live spend** | The header shows `$0.000 · N turns` as it happens. |
| **`maxBudgetUsd`** | Per member. **Off unless you set it** — there is no default. |

**The biggest lever is the roster.** That run woke seven agents; a tester doing
42 tool calls on a design task is pure cost. The orchestrator is now told to summon the
smallest crew that can do the job — but you approve every summon, so trim the
crew there.

## Safety and limits

**Merging never damages your repo.** Conflicts are computed in memory with
`git merge-tree` *before* anything is checked out. If an agent's work conflicts, or
your base branch has uncommitted changes, the merge is refused and nothing is
touched — the orchestrator is told so it can send the work back. Any surprise
mid-merge is rolled back with `merge --abort`.

**Permission defaults allow automatic tool use.** Codex defaults to
`danger-full-access` because confining modes have denied its MCP calls in this
repository's measurements. Claude defaults to `bypassPermissions`, with
`git push`, `remote`, `worktree`, `reset --hard`, `rebase` and branch deletion
denied through its tool policy. Choose explicit per-member permission settings
using the [CLI options](docs/cli-agents.md); enforcement belongs to the CLI.
Claude denials can be extended with `"deny": ["Bash(curl:*)"]`.

**Spend can be capped — it is not capped by default.** Set `maxBudgetUsd`
(per member, overridable per member) or `maxKingdomUsd` (whole team) in
`kingdom.config.json` and a looping member stops costing money by itself.
Leave them unset, as shipped, and nothing stops it but you.

Until recently a cap would not have worked anyway on a codex or agy team:
those CLIs report no cost at all, so the check compared $0 against the ceiling
on every turn and could never fire. Turns are now priced from a rate card
(`src/price.js`) when the CLI will not say, so caps apply to the whole team —
except models with no published price, which spend nothing rather than be
enforced against a guess. `node src/ctx.js <repo>` shows the real bill either
way.

**Rate limits fail over.** With more than one token in the pool, a
rate-limited member is moved to a sibling token and restarted — its session
resumes, so no work is lost. It gives up once every token has been tried.

**Nothing runs unattended.** Every pane has a ⏻ button to stop or wake that
member mid-task.

## The merge path

```
agent → declare_done
   → orchestrator runs the project's real tests in that worktree
   → briefer digests the diff + results
   → orchestrator reviews the digest (raw diff only if suspicious)
   → orchestrator: request_merge, or send_back with notes
   → you click Merge
```

Tests are discovered, not configured (`npm test` → `npm run build` → `cargo
test` → `pytest` → `go test`). A project with no tests reports **"unverified"**,
never "passed".

## Choosing models

Every pane header has a **CLI + model dropdown**. Change it and that member
restarts immediately on the new model, keeping its memory — the choice is
written back to `kingdom.config.json`, so it survives restarts.

Switching a member's **CLI** (claude ⇄ codex) is the one case that costs
memory: a codex thread id means nothing to claude, so it starts a fresh
session. The UI says which happened.

`custom…` lets you type any `cli:model` pair for a model not in the list
(Electron has no `window.prompt`, so it swaps in a text box).

The dropdown's contents come from `models` in `kingdom.config.json` — add
model names there rather than editing code:

```json
"models": {
  "claude": ["opus", "sonnet", "haiku", "fable"],
  "codex":  ["gpt-5.6-luna"]
}
```

## The roster

`kingdom.config.json` — edit by hand any time, or let the orchestrator propose
additions. Each member picks its own CLI and model:

```json
{ "name": "coder", "cli": "codex", "model": "gpt-5", "prompt": "..." }
{ "name": "reviewer", "cli": "claude", "model": "sonnet", "prompt": "..." }
```

Configuring a role does not put it on the team — it makes it **available**.
The rail on the left holds the members actually serving; everyone else lives
behind **Summon** (Alt+E), which searches names, titles and descriptions, so
you can find the person who does Kubernetes without knowing they are filed
under `cloud-architect`. Summoning is `wake`, dismissing is `sleep`; both are
reversible and a dismissed member keeps its transcript.

This split is the point: the shipped roster is 105 roles, and a rail that
listed them all was 4,179px of scroll in a 580px viewport with 105 rows reading
"not summoned".

## One behavioural difference between the CLIs

A **claude** agent is one long-lived process fed turns over stdin, so an
incoming message interrupts it immediately. Codex, Antigravity, OpenCode,
Cursor, and Claude with `outputFormat: "json"` exit between turns and resume
using their saved session ids, so a message queues until the current turn ends.
Memory persists identically either way. Put your chattiest roles on claude.

## Layout

| File | Does |
|---|---|
| `src/bus.js` | SQLite message bus + event log + kv state |
| `src/agent.js` | common process lifecycle, queues, timeouts and session persistence |
| `src/cli-adapters.js` | per-CLI arguments and common ready/text/tool/turn_end/error events |
| `src/cli-detection.js` | bounded, non-billing status checks with private raw output |
| `src/mcp.js` | the MCP server every agent gets; toolset varies by role |
| `src/worktree.js` | git worktrees, test discovery, merging |
| `src/kingdom.js` | the orchestrator: roster, delivery loop, approvals, briefer recycling |
| `src/daemon.js` | HTTP + SSE server |
| `src/cli.js` | terminal interface |
| `ui/` | the app interface (no framework) |
| `ui/court.js` | who belongs in the rail vs. the summoning screen — pure, and tested |
| `ui/feel.js` | the weight: arrival/departure motion, and the horn cues on a summon or a ruling |
| `electron/main.js` | thin shell; spawns the daemon and shows the UI |

State lives **outside** your repo, in `<repoParent>/.kingdom/<repoName>/` —
worktrees, the database, everything. Your repo stays clean.

### Why the daemon is a separate process

Electron bundles an older Node without `node:sqlite`. Running the orchestrator
as its own Node 24 process avoids that entirely, and means closing the window
doesn't stop the team.

## Build an installer

```bash
npm run dist       # -> dist/Agentic OS Setup <version>.exe (NSIS, Start-menu shortcut)
```

Packaged with `asar: false` on purpose: the orchestrator runs as an external
Node process, and a script inside `app.asar` is invisible to anything but
Electron. **Node 24+ must still be on PATH** — the daemon needs `node:sqlite`,
which Electron's bundled Node does not have.

## Tests

```bash
npm test                   # everything that costs no API quota
node src/bus.js            # bus self-check
node test/t-agent.js       # codex agent: two turns, one session, memory survives
node test/t-comms.js       # THE test: agent messages agent, unaided
node test/t-tokens.js      # token pool loads, assigns stably, reaches child env
node test/t-concurrent.js  # 8 processes hammering the bus, no "database is locked"
node test/dump.js <repo>   # peek at a workspace's bus
```

`t-agent.js` and `t-comms.js` spend real quota, so `npm test` leaves them out.

`npm test` runs four suites at a time (185s → 50-74s here). A suite that fails is
re-run alone before it is reported, because several of them use real resources —
the live tick loop, git, ports, a Whisper model — and lose races for them under
load; a failure that passes on the retry is printed as `flaky`, not as a pass.
Set `KINGDOM_TEST_WIDTH=1` for the old one-at-a-time run.
