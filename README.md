# Kingdom — an agentic OS

A court of AI agents that work a git repository together. The difference from
ordinary subagent setups: **the peasants talk to each other directly**, not
through the king.

```
        you (the sovereign)
               │
             king            ← decides, assigns, reviews. Reads almost nothing raw.
               ↑
            jester           ← drinks the firehose, briefs the king in detail
               ↑
   ┌───────┬───┴───┬───────┐
architect coder reviewer tester   ← each in its own git worktree, messaging each other
```

## Why the jester exists

The king's context is the scarcest thing in the kingdom. If every peasant
message reached it, the king would be incoherent within an hour. So a cheap
model (Haiku) watches *everything* — every message, every tool call — and
briefs the king on what actually matters. The king keeps a `read_bus` escape
hatch it should rarely need.

The jester recycles itself: as it nears its context limit it writes a handover
note, dies, and is respawned seeded with that note. A session can run all day.

## Requirements

- **Node 24+** (uses built-in `node:sqlite`; no native modules anywhere)
- `claude` and/or `codex` on PATH, both authenticated
- The target must be a **git repository**

## Run

```bash
npm install
npm run doctor                  # check node, git, and that both CLIs authenticate
npm start                       # Electron app; asks which repo
```

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

### Several tokens, so the court doesn't share one rate limit

Five agents on one token exhaust it fast. Give the kingdom a pool and each
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

In the CLI: type to speak to the king, `@coder do X` to speak to one member,
`/approve <id>`, `/reject <id>`, `/roster`, `/quit`.

## What you approve

Nothing important happens without you:

| The king proposes | You see |
|---|---|
| `summon` — which peasants to wake, and why | a card with the crew and its reasoning |
| `propose_role` — a brand-new kind of peasant | the name, prompt, CLI, and rationale; approving writes it into `kingdom.config.json` permanently |
| `request_merge` — work it has reviewed and approves of | its verdict, plus a Merge button |

## The vault

Point the kingdom at an Obsidian vault and the whole court can use it:

```json
{ "vault": "E:\\AGIOS Kingdom\\Obsidian Vault", "vaultWriteDir": "Kingdom" }
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
"design my app" — spent 34 turns, 21 of them the king's, and 18 of those were
retries against a bug. Measure with `node test/dump.js <repo> events`.

**Tokens are not the bill.** Replayed context is billed at a *tenth* of fresh
input, so the share of tokens that are replay says almost nothing about what a
session cost. Three tools, all read-only and safe to run mid-session:

| | |
|---|---|
| `node src/ctx.js <repo>` | Where the money went: tokens **and** dollars, split replay / new input / output. |
| `node src/replay.js <repo> [settle] [backstop]` | What a different delivery window would have cost, replayed through the real ripeness rule. |
| `node src/recycle.js <repo>` | What `recycleAtTokens` should be, and whether it is ever reached at all. |

The kingdom is built around that fact:

| Lever | Effect |
|---|---|
| **Batched delivery** | Messages arriving together become **one** turn, not one each. |
| **Busy agents aren't interrupted** | Delivery waits for idle (up to 45s), so no replay is spent on a half-finished thought. |
| **Notices ride along** | Pure FYI never buys its own turn; it waits for real traffic (or 3 min). |
| **4000-char message cap** | Pasting a file through the bus replays it into someone's context. Write a file, send the path — peasants can read each other's worktrees. |
| **Idle sleep** | Untouched members stop after 15 min (`KINGDOM_IDLE_SLEEP_MS`, 0 disables) and revive with memory on the next message. |
| **`effort` per role** | `"effort": "low"` for mechanical roles. |
| **Live spend** | The header shows `$0.000 · N turns` as it happens. |
| **`maxBudgetUsd`** | Per member. **Off unless you set it** — there is no default. |

**The biggest lever is the roster.** That run woke seven agents; a tester doing
42 tool calls on a design task is pure cost. The king is now told to summon the
smallest crew that can do the job — but you approve every summon, so trim the
crew there.

## Safety and limits

**Merging never damages your repo.** Conflicts are computed in memory with
`git merge-tree` *before* anything is checked out. If a peasant conflicts, or
your base branch has uncommitted changes, the merge is refused and nothing is
touched — the king is told so it can send the work back. Any surprise
mid-merge is rolled back with `merge --abort`.

**Peasants are confined, to different degrees.** Codex peasants run under a
real OS sandbox (`--sandbox workspace-write`) that physically cannot write
outside their worktree. Claude Code has no OS sandbox on Windows, so those
peasants are *mitigated*, not confined: `git push`, `remote`, `worktree`,
`reset --hard`, `rebase` and branch deletion are denied outright. Treat a
Claude peasant as trusted-but-fenced, not jailed. Add more denials per member
with `"deny": ["Bash(curl:*)"]`.

**Spend can be capped — it is not capped by default.** Set `maxBudgetUsd`
(per member, overridable per member) or `maxKingdomUsd` (whole court) in
`kingdom.config.json` and a looping member stops costing money by itself.
Leave them unset, as shipped, and nothing stops it but you.

Until recently a cap would not have worked anyway on a codex or agy court:
those CLIs report no cost at all, so the check compared $0 against the ceiling
on every turn and could never fire. Turns are now priced from a rate card
(`src/price.js`) when the CLI will not say, so caps apply to the whole court —
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
peasant → declare_done
   → orchestrator runs the project's real tests in that worktree
   → jester digests the diff + results
   → king reviews the digest (raw diff only if suspicious)
   → king: request_merge, or send_back with notes
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

`kingdom.config.json` — edit by hand any time, or let the king propose
additions. Each member picks its own CLI and model:

```json
{ "name": "coder", "cli": "codex", "model": "gpt-5", "prompt": "..." }
{ "name": "reviewer", "cli": "claude", "model": "sonnet", "prompt": "..." }
```

## One behavioural difference between the CLIs

A **claude** agent is one long-lived process fed turns over stdin, so an
incoming message interrupts it immediately. A **codex** agent exits between
turns and is resumed by thread id, so a message **queues until its current turn
ends**. Memory persists identically either way. Put your chattiest roles on
claude.

## Layout

| File | Does |
|---|---|
| `src/bus.js` | SQLite message bus + event log + kv state |
| `src/agent.js` | spawns/streams/injects either CLI, normalised to one event shape |
| `src/mcp.js` | the MCP server every agent gets; toolset varies by role |
| `src/worktree.js` | git worktrees, test discovery, merging |
| `src/kingdom.js` | the orchestrator: roster, delivery loop, approvals, jester recycling |
| `src/daemon.js` | HTTP + SSE server |
| `src/cli.js` | terminal interface |
| `ui/` | the throne room (no framework) |
| `electron/main.js` | thin shell; spawns the daemon and shows the UI |

State lives **outside** your repo, in `<repoParent>/.kingdom/<repoName>/` —
worktrees, the database, everything. Your repo stays clean.

### Why the daemon is a separate process

Electron bundles an older Node without `node:sqlite`. Running the orchestrator
as its own Node 24 process avoids that entirely, and means closing the window
doesn't kill the court.

## Build an installer

```bash
npm run dist       # -> dist/Kingdom Setup <version>.exe (NSIS, Start-menu shortcut)
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
node test/t-comms.js       # THE test: peasant messages peasant, unaided
node test/t-tokens.js      # token pool loads, assigns stably, reaches child env
node test/t-concurrent.js  # 8 processes hammering the bus, no "database is locked"
node test/dump.js <repo>   # peek at a kingdom's bus
```

`t-agent.js` and `t-comms.js` spend real quota, so `npm test` leaves them out.

`npm test` runs four suites at a time (185s → 59s here). A suite that fails is
re-run alone before it is reported, because several of them use real resources —
the live tick loop, git, ports, a Whisper model — and lose races for them under
load; a failure that passes on the retry is printed as `flaky`, not as a pass.
Set `KINGDOM_TEST_WIDTH=1` for the old one-at-a-time run.
