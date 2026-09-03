# HANDOFF — Agentic OS (Kingdom)

Consolidated 2026-09-03 from `docs/HANDOFF.md`, `PLAN.md`, `docs/PLAN-court.md`,
`docs/PLAN-saas.md`, `docs/PROMPT-redesign-the-court.md`, `docs/RENAME.md`,
`AGENTS.md`, `CLAUDE.md`, `README.md`, `.agents/`, `.claude/`, `.kingdom/`, and
the live repository state. One file, everything known.

**Claim typing used throughout.** *[verified 2026-09-03]* = re-read off this
repo today, command named. *[recorded]* = carried forward from a prior
session's own record, not re-checked. *[estimated]* = judgement. Where a
number could not be obtained, it says so instead of being filled in.

---

## 1. What this is

A multi-agent orchestrator shaped as a kingdom. An orchestrator decomposes and
delegates, a cheap briefer drinks the firehose and briefs it, and peasants work
in isolated git worktrees. The differentiator: **members message each other
directly over MCP** rather than routing everything through the orchestrator.
Members run the Claude Code CLI, the Codex CLI, Antigravity (`agy`), or
opencode.

Court members working *inside* a kingdom take their live instructions and memory
index from the Obsidian vault note `Kingdom/Court Instructions.md`. That note —
not this file — governs how a running court behaves. This file is for agents
working on *the codebase itself*.

## 2. Where things stand right now

*[verified 2026-09-03]* `git log --oneline -5`, `git status --porcelain`,
`git branch -a`, `git remote -v`:

- Branch **`ui-rewrite`**; `main` also exists. **No git remote configured**, so
  nothing can be pushed by accident.
- HEAD `923d6ec` "plan: record what shipped this session", then `3306812`
  (docs moved under `docs/`), `84fbaab` (CI on windows-latest), `479587b`
  (Electron checks Node 24+ on PATH), `4237599` (doctor first-run screen).
- The working tree is **deliberately dirty and user-owned**: ~30 modified files,
  the deleted legacy UI modules (`ui/app.js`, `canvas.js`, `chat.js`,
  `chat-sidebar.js`, `identity.js`, `overview.js`, `panels.js`, `rail.js`,
  `voice.js`, `win.js`, `test/t-win.js`), and untracked `ui/main.js`,
  `ui/sidebar.js`, `ui/store.js`, `ui/thread.js`, `ui/views/`, `test/t-pages.js`,
  `test/t-store.js`, `test/t-thread.js`, plus `CLAUDE.md` and `.claude.json`.
- **Preserve all of it.** Inspect `git status --short` before editing anything.
- **Do not commit or push without a fresh explicit instruction** for that
  specific commit. A prior authorization never carries forward.

The UI rebuild in `PLAN.md` is substantially implemented in source and, as of
the 2026-08-29 evidence in that file, has live Electron/DevTools proof for the
responsive grid. What remains unproven is **stateful flows** (see §6). Passing
source-level tests are not proof that the interface looks or behaves correctly
at runtime.

## 3. Run it

```bash
npm test                        # everything that costs no API quota — 67 suites, 4-wide
KINGDOM_TEST_WIDTH=1 npm test   # serialize; use when a failure looks like a race
node test/t-pages.js            # one suite — every test/t-*.js runs standalone
npm start                       # Electron shell (spawns the daemon)
node src/daemon.js <repo> --port 7777    # daemon only, for browser-driven work
node src/cli.js <repo> "first order"     # headless terminal court
node src/doctor.js               # preflight the CLIs — from a plain terminal
npm run ctx -- <repo>            # where a court's context actually went
npm run token -- --global <tok>  # token pool, stored in ~/.kingdom/tokens.json
npm run dist                     # NSIS installer into dist/
```

*[verified 2026-09-03]* `test/run-all.js` lists **67 suites**
(`grep -c "join(HERE" test/run-all.js`). `AGENTS.md` still says 45 and
`README.md` says 55 — both are stale.

`node test/t-agent.js` and `node test/t-comms.js` spend **real API quota** and
are excluded from `npm test`. Run them deliberately.

**Many `src/` and `ui/` modules are their own suite** and self-check when
invoked directly: `src/bus.js`, `ripeness.js`, `modes.js`, `price.js`,
`usage.js`, `forecast.js`, `approval.js`, `replay.js`, `recycle.js`,
`compact.js`, `argue.js`, `memory.js`, `workflows.js`, `ctx.js`, `ui/court.js`,
`ui/names.js`, `ui/graph.js`, `ui/views/home.js`. Change pure logic in one of
those and run the file.

`npm test` re-runs a failed suite alone before reporting it — several use real
ports, git, a Whisper model or the live tick loop and lose races under load. A
suite printed as `flaky` passed on that retry. `court self-control` is a
**known pool-only flake** *[recorded]*; investigate only a repeatable failure.

CI: `.github/workflows/test.yml` runs `npm ci` + `npm test` on
**windows-latest only**, deliberately — every Windows-only path in
`src/agent.js` is untested elsewhere and cross-platform is deferred.

## 4. Rules that are not negotiable

1. **Tests ship with the change.** Every suite in `test/` exists because
   something broke. Extend the suite that owns the area rather than adding a new
   one. A test that passes before your fix is not a test of your fix — verify it
   fails without it.
2. **Never trust a measurement you did not take.** This project has twice tuned
   the wrong knob from an estimate. Measure first, put the number in the comment.
3. **Comments carry the evidence, not the intent.** `// this is faster` is
   noise; `// measured 3,635ms -> 331ms` is why the line survives a refactor.
4. **Degrade, never wedge.** Anything that can hang, fail to spawn, or return
   nothing must end the turn and say so. A silent stall is this system's worst
   failure mode.

Plus, from the current UI contract:

- **`ui/app.css` declares every selector exactly once.** Edit the owning rule.
  Never append an override block — it used to end in five appended REFIT blocks
  where the rule you found was rarely the rule that won.
- **Do not restore** the hall, avatars, canvas, draggable windows, Grid/Canvas
  control, voice UI, rail, overview, panels, or legacy `app.js`. The **status
  dot** (awake / resting / busy / failed in one element) and the **`#bg` wash**
  are not optional and stay.
- No framework, build step, new dependency, new persistence key, per-view
  poller, or geometry persistence. Lifecycle work is released on navigation.
- Keep the daemon contract and the `GET /modes.js` import intact; do not fork
  mode definitions into the renderer.

## 5. Architecture

**Three processes, on purpose.** Electron (`electron/main.js`) is a thin shell
that spawns the daemon and shows the UI; it never orchestrates, because
Electron's bundled Node has no `node:sqlite`. The daemon (`src/daemon.js`, HTTP
+ SSE) runs the court under Node 24+ and survives the window closing. The court
(`src/kingdom.js`) spawns each member as its own CLI process (`src/agent.js`),
normalising claude / codex / agy / opencode to one event shape.

| Path | Owns |
|---|---|
| `src/kingdom.js` | orchestrator: roster, spawning, delivery loop, approvals, merges, prompts, briefer recycling |
| `src/agent.js` | one member's process per CLI — where the spawn traps live |
| `src/bus.js` | SQLite message bus + event log + kv state |
| `src/mcp.js` | the tools members call; toolset filtered per role **and** per mode |
| `src/modes.js` | who may be summoned, what gets a worktree, what may merge |
| `src/worktree.js` | git isolation, test discovery, merges |
| `src/memory.js`, `src/vault.js` | vault instructions, memory index, read-only vault search |
| `src/skills.js`, `skills/` | shipped procedures, `<pack>/<name>.md`; the vault overrides |
| `src/ctx.js` / `replay.js` / `recycle.js` / `price.js` / `usage.js` | the cost model and its audits |
| `src/daemon.js`, `src/cli.js` | HTTP+SSE server; terminal interface |
| `ui/` | the renderer (vanilla ES modules, no build step) |

Kingdom state lives **outside** the target repo, at
`<repoParent>/.kingdom/<repoName>/` — worktrees, db, everything.

**Cost is the design constraint.** Turns, not messages, are the bill: each
delivered turn replays the recipient's accumulated context. The levers —
batched delivery, delivery-waits-for-idle, notice ride-along, a 4000-char
message cap, idle sleep, per-role `effort`, `maxBudgetUsd` / `maxKingdomUsd`
(both **off unless you set them**) — all exist for that. Every constant behind
them is derived from measured data, not chosen: `src/ripeness.js` (batching),
`src/recycle.js` (recycle threshold, closed-form
`T* = c0 + sqrt(2·g·c0·(1 + 12.5b))`), `src/replay.js` (delivery windows swept
over real logs; past 180s it saves at most 3 turns while the worst-case wait
climbs to 15 minutes), `src/price.js` (rate card for CLIs that report no cost).
**Re-derive before touching one** — see rule 2.

### The UI

`ui/store.js` is the single state owner (DOM modules keep no copy of the stream
and start no timers of their own). `ui/main.js` owns routing, the one
stream/poll lifecycle, the shared ten-second tasks/changes refresh, and route
cleanup. `ui/sidebar.js`, `ui/thread.js` and `ui/views/` render. One prefs key:
`kd.prefs`.

**View mounts return cleanup synchronously** and guard late responses with a
request token, so navigation can cancel a view before its first request settles.
Chat, Cowork and Code are the public modes; only Code permits repository merges.

The layout table in `README.md` still names `ui/panels.js` and `ui/app.js`,
which no longer exist. The directory is the truth.

## 6. What has actually been verified, and what has not

**Verified** *[recorded, PLAN.md 2026-08-29 and docs/HANDOFF.md 2026-08-28]*:

- `KINGDOM_TEST_WIDTH=1 npm.cmd test` → **67 suites, 1-wide, 231.6s, green**
  after the storage / asset / advisor / chronicle / stream-cursor /
  event-recovery / crew-state / roster-stream / MCP-state-recovery /
  bounded-workflow-HTTP changes. An earlier run: 67 suites, 1-wide, 116.4s.
  SpeechBird skipped cleanly (not installed).
- Live Electron/DevTools capture: the Overview has **no horizontal overflow at
  320 / 375 / 390 / 768 / 1280 px**; the mobile drawer opens at 320px; reduced
  motion is active; the Electron repo-picker bridge is present; a live pet
  window exists; the real navigation controls opened all twelve workspace views
  plus Settings with expected headings. The desk-pet control reopens the window
  after its own close, in a freshly restarted Electron session.
- Daemon smoke: all **39 UI paths + `/api/ping`** served. That proves static
  serving, not rendered layout.
- `git diff --check` clean apart from pre-existing ignore-permission and
  line-ending warnings.

**Not verified, and must not be claimed:**

- **Stateful flows that mutate a workspace** — composer submission, approval
  resolution, repository attachment, automation changes.
- **Native repository selection** — the bridge is present, the dialog was
  deliberately never invoked.
- Earlier attempts at headless capture failed for *environment* reasons, not UI
  reasons: Electron's default profile/cache was access-denied, a workspace-local
  hidden-window retry timed out before its renderer loaded, and Chrome headless
  had its GPU process killed by the host even with `--disable-gpu`. Do not read
  any of that as evidence about the interface.
- The prescribed Python handoff validator could not run — **neither `python`
  nor `py` is installed on this machine** *[recorded]*.

**Remaining gates** before the rewrite is done: the serialized `npm test` stays
green, `git diff --check` passes, the static route/action audit stays green, and
browser-grid plus Electron evidence exist for the stateful flows above.

## 7. Work completed in the rewrite

Source-level, all in the dirty tree:

- Legacy floating/canvas/layout modules and `test/t-win.js` removed.
- The store owns state, SSE reduction, one prefs key, dismissal replay
  protection, roster roles/states, and money formatting.
- The shared action dispatcher returns object results (including `attachRepo`'s
  canonical `repo`/`base`); void actions keep `{ok: true}`.
- Thread wake/sleep and rejected approval/question controls recover from both
  sync and async transport failure and show the existing toast instead of
  leaking an unhandled rejection (`test/t-thread.js` pins the rejected path).
- Stale EventSource callbacks ignored after replacement; malformed Activity rows
  render an empty timeline; narrow sidebar headers truncate instead of clipping.
- Generic JSON action dispatch rejects primitive and array bodies with a clear
  400 rather than leaking a handler TypeError.
- Mobile drawer capped at `min(320px, 85vw)` (`test/t-theme.js` pins it).
- A live court refuses a *different* repository before it can mix old worktrees
  with new repo state; same-repo attachment leaves the court intact.
- Workflow storage rejects path-traversing IDs; disabled webhook workflows
  cannot bypass their disabled state through the hook endpoint; deletion stays
  idempotent for a missing file but real filesystem failures now surface;
  listing returns empty only before the directory exists.
- Workflow HTTP nodes carry a 30s timeout and the daemon's 2 MiB body budget
  (streaming and fallback both), and `foreach` — nested included — shares one
  200-step execution budget.
- Uploaded attachments persist as sanitized asset references on the bus, reach
  command and direct-member delivery, replay from history, and render as safe
  links; the migration preserves pre-existing transcripts with an empty
  attachment list.
- Asset writes are filesystem-exclusive, so simultaneous same-name uploads
  cannot overwrite each other; malformed percent escapes 404 instead of erroring;
  listing and deleting distinguish "not there yet" from a real storage failure.
- Pending approvals persist independently of the prunable transcript, with
  one-time migration; retention is bounded (every pending decision, newest 2,000
  resolved).
- A multi-member summon resolves atomically: any failed wake stands down its new
  siblings, pre-existing members survive, and the approval is durably marked
  blocked with a visible failure.
- Thread routes reconnect the shared stream at the active orchestrator
  conversation; chronicle pagination clamps limits to 1–500; stream cursors
  accept only positive safe integers; bus readers drop only the malformed row
  rather than the whole page; corrupt persisted crew, roster and goal state warn
  and degrade instead of aborting startup or failing an MCP call.

## 8. Prior feature work (2026-08-19, committed on `main`) *[recorded]*

- **Citations on recall/vault answers** — answers cite their source note as a
  `vault:` markdown link (`0ff79f4`).
- **Document upload** — `/api/assets` extended beyond images and audio so a
  member can reference an uploaded file mid-task (`0ff79f4`).
- **Quota-aware usage accounting** (`a9dd393`) — `src/price.js` only has $/token
  rates for metered keys; a subscription CLI (codex on a ChatGPT plan) has no
  marginal dollar cost but a hard token allowance. `metrics()` in `src/daemon.js`
  attributes each turn's *deltaed* tokens to the member's `cli` inside the
  existing `turn_end` loop and returns a `quotas` array. Config:
  `kingdom.config.json` → `quotas: {"<cli>": {"label": "...", "limitTokens": N}}`;
  surfaced at `GET /api/metrics` → `quotas: [{cli, label, used, limit, pct}]`.
  **Limits stated plainly:** quota size is user-supplied, no account API is
  called, and nothing throttles a member that exceeds it. *(The renderer half
  lived in the now-deleted `ui/panels.js`; confirm where it renders in the
  rewrite before quoting this as working UI.)*

**A four-cycle cost-efficiency audit found nothing further to fix**, and that
conclusion is the deliverable, not a placeholder. Each lever already had
real-data tooling behind it: prompt-cache reuse (a resumed member is handed its
system prompt byte-for-byte; recomputing it once drove new input from 4% of a
$101 bill past 28%), recycle thresholds (the shipped 50k briefer / 70k others
landed on the model's computed floor for real production data), per-role and
per-mode tool filtering in `src/mcp.js`, and the batching windows. **Do not
re-run these four expecting a different answer** without new production data or
a code change elsewhere. Fastest check that anything has changed:
`node src/ctx.js <repo>`.

## 9. Open decisions — none of these are started

### a. The court redesign (`docs/PLAN-court.md`) — written, awaiting a go

Recommends cutting the bench to **15 standing roles** (architect, coder,
refactoring-engineer, frontend, designer, backend, dba, tester, debugger,
reviewer, auditor, devops-engineer, scout, scribe, strategist), tiered by model
and effort, with everything else moved to `roles-library.json` — **not deleted**.
Those 91 roles carry ~84KB of written prompts, and `propose_role` otherwise
makes the orchestrator author one from scratch. The case is **selection quality,
not tokens**: the bench costs about $0.001/turn in cached prefix, so the cost
argument does not survive the price card.

Migration is a hand edit of one array, committed alone — **no migration
script**. `rolesSeeded: true` means editing `roles.json` changes nothing for an
existing kingdom, and removing a role is **permanent**; git is the only undo.
Three sites hardcode role names and break silently:
`src/kingdom.js:1109-1110` (the orchestrator's own prompt names `debugger`),
`src/kingdom.js:284` (a comment now orphaned onto the wrong function), and
`src/kingdom.js:302` (`domains()`). `test/t-roles.js` owns the roster.

**The baseline in that plan has drifted.** *[verified 2026-09-03]* the live
`kingdom.config.json` holds **107 peasants** with
`peasantDefaults = {cli: "claude", model: "haiku", effort: "low"}`, and the
orchestrator and briefer are both `claude/haiku` — not the 105 ×
`codex/gpt-5.6-luna/max` the plan measured on 2026-08-16. `vault` is empty and
`quotas` is unset. **Re-measure before acting on any number in that file.**

For usage evidence, almost everything is already on the bus (`turn_end` events,
`deltaOf`, `costOf`); the one honest gap is `summons_count` — worth one
`bus.logEvent(name, 'summoned', {by, approvalId})` at `wake()`, not a new table.
Do not add an automatic pruning rule until a court has actually run for 30 days;
fed an empty log it would recommend deleting the whole roster.

### b. De-theming (`docs/RENAME.md`) — decided, not started

**2115 occurrences across 111 files.** Mechanical but large; a half-applied
rename is worse than none, so start only with room to finish. `Kingdom` →
`AgentOS`, `peasant` → **`member`** (not `agent` — `src/agent.js` has
`class Agent` for the CLI process), `court` → `team`, `sovereign`/`king` →
`user` (UI copy: "you"), `crown` → `system`, `briefer` → `planner`, `summon` →
`add`, `dismiss` → `remove`, `throne room` → `dashboard`. On disk: `.kingdom/` →
`.agentos/`, `kingdom.db` → `agentos.db`, `kingdom.config.json` →
`agentos.config.json`, branch prefix `kingdom/<name>` → `agent/<name>`, 22
`KINGDOM_*` env vars → `AGENTOS_*`, `kingdomDir()` → `stateDir()`. **Rename, no
migration** — existing projects are orphaned, accepted. Order: words in `src`,
`ui`, `test` first, then `node --check` plus the suite, then file renames, docs
last. Watch `\bking\b` word boundaries (`working`, `making`) and leave
`this.agents` untouched.

### c. Product shape (`docs/PLAN-saas.md`) — a recommendation, no decision

Recommends **product B**: host the control plane, run execution on the
customer's own machine through a thin outbound-only runner. That avoids custody
of customer source and reselling inference at a loss, and is the shortest path
from what exists. The marketable wedge is the **turn-cost discipline** —
batching, the settle window, notice ride-along, idle sleep, read cursors, and
per-turn accounting that separates fresh input from cache reads and writes.
Nine blockers, each located in the code: CLI-spawn execution, no authentication,
one db/repo/process/court, no schema migrations, a deliberately wide sandbox,
per-court rather than per-tenant cost enforcement, Obsidian as the memory
substrate, Windows assumed in 29 places, nothing observable from outside. Four
decisions gate Phase 1 — which product; whether the pet, wallpaper and music
survive; whether the vault is a customer feature or a personal workflow; solo
build or budget for help.

### d. The structured-question feature — designed, never requested

An `ask_question` MCP tool letting any member pose a multi-choice question
through the existing approval pipeline, reusing `propose_role`'s
`kind:'approval'` bus convention rather than building a parallel channel. Full
design at `C:\Users\mayur\.claude\plans\plan-out-a-complete-logical-turing.md`.
Not started, not in this repo. **Ask before building it.**

### e. `docs/PROMPT-redesign-the-court.md`

A self-contained prompt for a fresh session to redo the court design from
scratch. Its numbers were measured on 2026-08-16 and have drifted (see §9a).
Keep it as the record of how the question was framed, not as current data.

## 10. Traps that have already cost a session

- **codex takes its prompt on stdin** (`codex exec -`), never as an argument.
  Windows caps a command line at 32,767 chars and `spawn` throws *synchronously*,
  so `exit` never fires.
- **`codex exec resume` accepts a strict subset of `exec`'s flags** — no `-C`,
  `-s`, `-p`, `--oss`. Everything else goes through `-c`.
- **Any confining codex sandbox denies every MCP tool call**, so a member loses
  `send_message` and `declare_done` and says nothing about it.
  `danger-full-access` is the default for exactly that reason.
- **codex reports no `total_cost_usd`.** Track tokens; dollars are unavailable.
- **codex reports usage cumulatively per thread**, unlike claude and agy.
  Summing raw `in`/`out` across turns overcounts massively — one investigation
  reached ~593M tokens against a far smaller real total. Always go through
  `deltaOf()` / `totalsOf()` in `src/usage.js`.
- **`agy` self-updates and has changed flag arity mid-session.** If a member goes
  silent at exit 0, check `agy --help` before anything else.
- **A claude member is one long-lived process** fed turns on stdin, so a message
  interrupts it immediately. **A codex member exits between turns** and is
  resumed by thread id, so a message queues until its current turn ends. Put the
  chattiest roles on claude.
- **The Browser pane reports `prefers-reduced-motion: reduce`**, so no animation
  plays there. Verify one by driving `Animation.currentTime` and reading computed
  styles, or open the app outside the pane.
- **Screenshots need the Browser pane displayed** (`preview_start{url}`
  re-displays it), the image is scaled to 800px wide, and region `zoom` is not
  implemented. If the pane wedges, close the stuck tabs and start a fresh one —
  check the daemon first with
  `curl -o /dev/null -w "%{http_code}" http://127.0.0.1:7788/`; it is almost
  never the fault.
- **`better-sqlite3` is not a dependency.** Use built-in `node:sqlite`
  (`DatabaseSync`, `{readOnly: true}`), which is what `src/bus.js` itself uses.
- **`node src/ctx.js <repo>` computes a per-repo db path.** A daemon launched
  with no repo argument writes to `~/.kingdom/workspace/kingdom.db` instead, and
  the CLI form then throws `unable to open database file`. Import `audit` or
  `report` from `src/ctx.js` and open that path by hand.
- **An ESM `import` of an absolute Windows path throws
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`.** Put a scratch script inside the target
  module's own tree, import relatively, run it there, delete it after.
- **Do not treat throwaway test daemons as production data.** An audit of an
  18-turn workspace db once read as "cache not being reused" — it was repeated
  cold-start spawns, never resumed. The shape to recognise: tiny turn count,
  every member's first context near 0.
- **This machine has historically run low on memory during `npm test`.** Check
  free memory before calling an unexplained failure a regression.
- **Never invent a $/token rate for a subscription-billed CLI.** Track it against
  a user-supplied quota instead of forcing it into `src/price.js`.
- **Never put a token in `kingdom.config.json`** — the running orchestrator
  writes that file back to disk and it is not gitignored. The real store is
  `<repoParent>/.kingdom/<repoName>/tokens.json` or `~/.kingdom/tokens.json`.

## 11. Machine and environment state *[verified 2026-09-03]*

- `.agents/kingdom-id.json` → `{agent: "king", role: "king", db:
  "E:\\AI\\.kingdom\\Agentic OS\\kingdom.db", repo: "E:\\AI\\Agentic OS",
  vault: "E:\\AGIOS Kingdom\\Obsidian Vault", vaultDir: "Kingdom"}`. Gitignored
  as per-machine identity — and it matters that it stays that way, because
  peasants run `git add -A`.
- `.claude/` holds `launch.json` (a `start` entry and a `daemon --port 7777`
  entry), `sessions/`, `backups/`, `scheduled_tasks.lock`. Gitignored.
- `.kingdom/` in **this** repo is gitignored and holds `workspace/`
  (`kingdom.config.json` at 136KB, `kingdom.db` plus `-shm`/`-wal`) and a
  directory literally named **`AIAgentic OS`** containing a 40KB `kingdom.db`.
  That name looks like a dropped path separator between `AI` and `Agentic OS`,
  and the canonical db per `.agents/kingdom-id.json` is
  `E:\AI\.kingdom\Agentic OS\`. **Unverified** — nobody has traced which code
  path wrote it. Worth one grep of the `kingdomDir()` join before dismissing it.
- `.kingdom-daemon-7777.{out,err}.log` at the root are gitignored per-launch
  noise from `electron/main.js` spawning the daemon detached.
- **`.claude.json` is untracked and NOT gitignored.** `.claude/` is ignored but
  the sibling file is not, and peasants run `git add -A` — it will get committed
  onto a branch by whoever presses Merge. Either ignore it or delete it.
- `Background.jpg` is now gitignored rather than deleted, with a comment saying
  why. The question flagged across three prior sessions is resolved.
- `python` and `py` are not installed here.
- Node 24+ is required everywhere (`node:sqlite`, no native modules). Electron
  is packaged with `asar: false` on purpose: the daemon runs as an external Node
  process, and a script inside `app.asar` is invisible to anything but Electron.

## 12. Auth, tokens, and the one FAQ

"OAuth session expired and could not be refreshed" is almost always **the
`claude` CLI not being logged in** — being signed into the desktop app is a
separate credential store. `claude auth status` returning
`{"loggedIn": false}` is the tell. Fix with `claude setup-token` (long-lived,
best for a daemon spawning many agents) or `claude auth login`, from a **plain
terminal**. `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` are all honoured and take precedence over the stored
login (`auth status` will still say `false`; `npm run doctor` knows the
difference).

Run everything from a plain terminal, **not from inside a Claude Code or Claude
Desktop session** — those set `CLAUDE_CODE_*` variables that put spawned
`claude` processes into managed-child-session mode, where they cannot refresh
their own token. `npm run doctor` detects this.

Token pool, so five agents do not share one rate limit:
`npm run token -- --global <tok> <tok>` → `~/.kingdom/tokens.json`. Resolution
order: `KINGDOM_CLAUDE_TOKENS` → `<repoParent>/.kingdom/<repo>/tokens.json` →
`~/.kingdom/tokens.json`. Assignment is stable per member across restarts, so
resumed sessions stay valid. A rate-limited member fails over to a sibling token
and resumes; it gives up once every token has been tried. Token values are never
logged, never sent to the UI, and never written to config — only the pool size
is ever reported.

## 13. Next steps

1. Exercise and record the **stateful flows** listed in §6 in a real Electron or
   browser session: composer submit, approval resolve, repository attach,
   automation create/edit/delete. Nothing else in the rewrite is open.
2. Re-run `KINGDOM_TEST_WIDTH=1 npm test` and record the **actual** result after
   any substantive change, including any pool/retry behaviour.
3. Decide `.claude.json` — gitignore it or remove it, before a peasant's
   `git add -A` decides for you.
4. Trace or dismiss the `.kingdom/AIAgentic OS/` directory name.
5. Ask before starting §9a, §9b, §9c or §9d. All four are designed; none are
   authorised.
6. Fix the stale counts if you are in those files anyway: `AGENTS.md` says 45
   suites, `README.md` says 55, both are 67. `AGENTS.md` also points at
   `E:\AI\CLAUDE.md` for the workspace map — **that file does not exist**.
7. Do not commit or push without a fresh explicit instruction.

## 14. Related files

`AGENTS.md` (the operating contract, read directly by Codex and Antigravity),
`CLAUDE.md` (imports `AGENTS.md`, adds commands and architecture for Claude
Code), `README.md` (user-facing; its layout table is stale), `PLAN.md` (the
authoritative UI rewrite contract), `docs/HANDOFF.md` (the record this file
supersedes), `docs/PLAN-court.md`, `docs/PLAN-saas.md`,
`docs/PROMPT-redesign-the-court.md`, `docs/RENAME.md`, and
`C:\Users\mayur\.claude\CLAUDE.md` (global; only includes `RTK.md`).
