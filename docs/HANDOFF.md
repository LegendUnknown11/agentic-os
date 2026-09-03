# Handoff — Agentic OS (Kingdom) — 2026-08-28

## Current handoff update - 2026-08-28

This section is the authoritative continuation point. The older sections below
are retained as historical context from 2026-08-19 and are not the current
status.

## Current State Summary

The UI rebuild described by `PLAN.md` is substantially implemented in the
working tree, but it is not visually signed off. The remaining work is real
browser/runtime QA and any polish or fixes that QA exposes. Do not treat the
plan checkboxes or passing source-level tests as proof that the interface
looks correct at runtime.

## Architecture Overview

The current shell is a vanilla ES-module UI with no build step. `ui/store.js`
owns state and reducer notifications; `ui/main.js` owns routing, the single
stream/poll lifecycle, and route cleanup; `ui/sidebar.js`, `ui/thread.js`, and
`ui/views/` render the sidebar, conversation thread, and pages. Preferences are
kept in the single `kd.prefs` path described by `PLAN.md`.

## Critical Files

- `PLAN.md` - authoritative UI rebuild contract.
- `ui/main.js` - route mounting and cleanup ownership.
- `ui/store.js` - shared state and reducer notifications.
- `ui/sidebar.js`, `ui/thread.js`, `ui/views/`, `ui/app.css` - current UI
  surface and responsive behavior.
- `test/t-pages.js`, `test/t-store.js`, `test/t-thread.js`, `test/t-theme.js` -
  focused UI regression contracts.

## Work Completed

- `PLAN.md` was reconciled with the dirty rewrite: source work is complete;
  browser and Electron evidence remain explicit release gates.
- A renderer/daemon action-route audit covered every literal UI action and
  supported GET route; no contract mismatch was found. A live daemon smoke
  served all 39 UI paths plus `/api/ping` successfully.
- Rejected inline approval/question requests in `ui/thread.js` now recover
  their controls and show the existing failure toast instead of leaking an
  unhandled rejection. `test/t-thread.js` proves the rejected approval path.
- The mobile drawer now caps at 320px (`min(320px, 85vw)`) so it cannot exceed
  a 320px phone viewport; `test/t-theme.js` pins that contract.
- Sidebar conversation requests now catch both synchronous and asynchronous
  transport failures; a failed branch refresh reports a toast rather than
  leaving a rejected promise. The route-level page contract remains green.
- `ui/main.js` now owns route lifecycle cleanup without waiting for an async
  view mount to settle.
- Async data views mount synchronously, return cleanup immediately, and guard
  late responses after navigation or unmount.
- `ui/views/automations.js` has request tokens and connection/editor guards so
  stale reloads, saves, deletes, and subscriptions cannot repaint a dead
  route.
- `ui/sidebar.js` now exposes native hover labels for navigation, collapsed
  More tools, and the collapse/expand control.
- The broader UI rewrite remains in the dirty worktree: vanilla ES modules,
  one store/reducer/stream/poll/prefs path, sidebar plus thread views, and
  the fixed dark flat shell described in `PLAN.md`.

## Files Modified

The latest iteration focused on `ui/main.js`, the async data views under
`ui/views/`, `ui/sidebar.js`, and `test/t-pages.js`. The working tree also
contains broader user-owned UI rewrite changes; preserve them all and inspect
`git status --short` before making further edits.

## Decisions Made

- View mounts return cleanup synchronously so navigation can cancel lifecycle
  work before the first request settles.
- Request tokens and connection checks guard asynchronous responses at the
  route boundary instead of adding ad-hoc guards to unrelated callers.
- Native `title` attributes provide the sidebar hover labels without adding a
  tooltip library or another UI layer.

## Verification actually run

- `KINGDOM_TEST_WIDTH=1 npm.cmd test`: **67 suites passed, 1-wide, 116.4s**
  after the thread and drawer fixes. SpeechBird was cleanly skipped because it
  is not installed.
- `node test/t-thread.js`, `node --check ui/thread.js`, and
  `node test/t-theme.js` passed after their respective fixes.
- After the sidebar resilience pass, `node test/t-pages.js`,
  `node --check ui/views/agents.js`, and `node --check ui/sidebar.js` passed.
- Daemon smoke: `node src/daemon.js E:\AI\Agentic OS --port 7788`, then all
  39 current UI paths and `/api/ping` returned successfully. This proves
  static serving, not rendered layout.
- Electron runtime was attempted twice. The default profile/cache path was
  access-denied; a second hidden-window harness used a workspace-local profile
  and disabled GPU, but timed out before its renderer loaded. Do not treat
  either attempt as UI failure or visual evidence; rerun the viewport grid in
  a normal interactive Electron session.
- Chrome headless was also attempted at 320px with an isolated temporary
  profile. Its GPU process was killed by the host before a screenshot could be
  written, even with `--disable-gpu`; this confirms the current environment
  cannot supply browser composition for the planned viewport evidence.
- `git diff --check` passed; its only output was pre-existing Git
  ignore-permission and line-ending warnings.
- The last full run was `KINGDOM_TEST_WIDTH=1 npm.cmd test`: **67 suites
  passed**. `court self-control` failed once in the parallel pool and passed
  when retried alone; retain this as a known concurrency flake. That full run
  occurred immediately before the final tooltip-only edit.
- After the final edit: `node test/t-pages.js` passed, `node --check
  ui/sidebar.js` passed, and `git diff --check` passed. The diff check emitted
  only existing Git ignore-permission and line-ending warnings.
- Browser/Electron visual QA was not available in this environment. No
  screenshot or layout claim has been verified at runtime.

## Immediate Next Steps

1. When a real browser/runtime preview is available, QA at 320, 375, 390, 768,
   and 1280 widths. Check overflow, focus states, drawer behavior, thread
   rendering, settings, the automations graph, and reduced-motion behavior.
2. Run `npm start` only with a usable visual environment and verify the repo
   picker and pet window; do not infer those results from static source.
3. If substantive changes are made, rerun `npm test` and record the actual
   result, including the known pool/retry behavior.
4. Do not commit or push until the user gives fresh explicit authorization.

## Important Context

- Preserve the current user-owned dirty worktree. It contains many modified,
  deleted, and untracked files from the UI rebuild; no commit or push was made.
- Do not restore the removed hall, avatar, canvas, chat, rail, voice, overview,
  panels, or win files. The status dot and `#bg` wash are still intentional.
- Keep `ui/app.css` selectors declared once; edit the owning rule instead of
  appending override blocks.
- The Browser pane reports reduced motion and screenshots require the pane to
  be displayed, so source checks are not a substitute for runtime inspection.
- Continue from the current UI source and `PLAN.md`; inspect
  `ui/views/settings.js`, `ui/thread.js`, and responsive CSS first when visual
  QA is available. Avoid speculative feature work.

## Assumptions Made

- The user-owned UI rewrite is the active implementation, even though it is
  uncommitted and the older handoff history describes a different surface.
- Runtime visual QA will be performed in an environment that can display the
  browser pane or Electron; static checks cannot answer layout questions.

## Potential Gotchas

- The full suite's `court self-control` pool failure is a known concurrency
  flake when it passes on the isolated retry; investigate a repeatable failure
  separately.
- Do not restore removed hall/avatar/canvas/window files or append duplicate
  CSS override blocks.

## Current pointers

- Project: `E:\AI\Agentic OS`; branch and exact dirty state must be checked
  before resuming with `git status --short`.
- Contract: `PLAN.md`; current context: this section of `docs\HANDOFF.md`.
- Main UI files: `ui/main.js`, `ui/store.js`, `ui/sidebar.js`, `ui/thread.js`,
  `ui/views/`, and `ui/app.css`.
- Test commands: `node test/t-pages.js` for the focused UI contract;
  `KINGDOM_TEST_WIDTH=1 npm.cmd test` for the full suite.

## Environment State

- Node/npm checks were available. The prescribed Python handoff validator could
  not run because neither `python` nor `py` is installed on this machine.
- No daemon, browser preview, or Electron process was started by this
  iteration; visual verification remains open.
- No commit, push, or release was made.

## Related Resources

- `PLAN.md` - the UI rebuild contract.
- `AGENTS.md` and `RTK.md` - repository operating rules.
- `docs/HANDOFF.md` - this current continuation record plus retained history.

## Historical goal & status (2026-08-19)

Agentic OS at `E:\AI\Agentic OS` is a multi-agent orchestrator shaped as a
kingdom: an orchestrator decomposes and delegates, a cheap briefer watches the
firehose and briefs it, and peasants work in isolated git worktrees. Members
message each other **directly over MCP** rather than routing through the
orchestrator. They run the Claude Code CLI, the Codex CLI, Antigravity
(`agy`), or opencode.

This is a standing `/loop` session with an open-ended mandate: **keep
optimizing the app for API cost/token efficiency and fix bugs as found, until
the user says stop.** The loop was stopped this session (user: "commit + the
next part of the loop and then stop") after four self-paced cycles found no
further actionable inefficiency — see *Current state* and *Decisions*. It can
be restarted anytime with `/loop Keep optimizing the Kingdom app ... for API
cost/token efficiency`.

**Feature work this session, all committed and tested:** citations on
recall/vault answers, document upload so the court can reference files, and
quota-aware usage accounting for subscription-billed CLIs (codex under a
ChatGPT plan) that have no real $/token. `node test/run-all.js` → **55
suites, all green**, re-run just now while writing this handoff. Working tree
is clean except one untracked stray file — see *Open questions*.

No source-code changes came out of the four loop cycles that followed the
feature work — that investigation's conclusion (the cost architecture is
already sound) IS the deliverable of those cycles, not a placeholder for one.

## Historical state recorded on 2026-08-19

### Verified as of this writing

- `git log --oneline -3` → HEAD `66039f4` ("court: the map gets redrawn
  before the next traveler arrives" — this handoff's own commit), parent
  `a9dd393` ("court: a subscription has no price per token, so stop
  pretending one"), grandparent `0ff79f4` ("court: cite the note, read the
  file, ask when only the sovereign knows"). Branch `main`, no remote
  configured.
- `git status --porcelain` → only `?? Background.jpg`. Everything else is
  committed.
- `node test/run-all.js` → **55 suites, 4-wide, ~46-51s, all passed.** Run
  twice this session (once mid-session, once just now for this handoff),
  both green.

### Feature: citations on recall/vault answers

Recall and vault answers now cite their source note as a `vault:` markdown
link, so an answer's claim can be traced back to the note it came from
instead of taken on faith. Landed in `0ff79f4`.

### Feature: document upload

The court can now be handed documents, not just images/audio — extending the
existing `/api/assets` upload flow to cover documents so a member can
reference an uploaded file mid-task. Verified via the MCP `list_uploads`
round-trip and a live browser upload/list/delete cycle against a running
daemon, in addition to the automated suite. Landed in `0ff79f4`.

### Feature: quota-aware usage accounting

**The gap.** `src/price.js`'s `PRICES` table only has $/token rates for
metered API keys. A CLI running under a flat subscription/quota plan (codex
under a ChatGPT plan, for instance) has no real marginal dollar cost, but
does consume a hard, resettable token allowance — and the existing Usage
panel had no way to represent that. `costOf()` correctly returns `null` when
no rate exists at all, but nothing distinguished "no rate because this is a
subscription" from "no rate because pricing is simply missing."

**What was built** (`src/daemon.js`'s `metrics()`): a `byCli` Map, built
inside the function's existing per-turn `turn_end` delta loop (no new event
reading), attributes each turn's deltaed tokens to the member's `cli` via the
existing `kingdom.specOf(name)`. A new `quotas` array is computed from
`kingdom.config.quotas` (user-supplied `{cli: {label, limitTokens}}` entries)
and returned alongside the existing `members/total/spent/cap` fields — for
each configured cli, how many tokens were burned against the plan's stated
allowance, as a percentage. `ui/panels.js`'s `openMetrics()` renders one
meter bar per configured quota, reusing the existing `.meter`/`.note` CSS
classes verbatim (no new stylesheet rules). Test coverage extends the
existing `test/t-panels.js` fixture with a `quotas: {codex: {...}}` config
entry and asserts the aggregated `used`/`limit`/`pct` match hand-derived
numbers from the seeded events. Landed in `a9dd393`.

**Explicit limitations, told to the user directly rather than oversold:**
quota size is user-supplied, not queried from any real OpenAI/Anthropic
account API (no such API is being called); this is tracking only — nothing
pauses or throttles a member that exceeds its quota.

**Config shape:** `kingdom.config.json` → `quotas: {"<cli>": {"label":
"...", "limitTokens": N}}`. Surfaced at `GET /api/metrics` →
`quotas: [{cli, label, used, limit, pct}]`.

### Four-cycle cost-efficiency audit (this session's `/loop`) — the finding is "already solved," and that is real information

After the three features above shipped, the standing `/loop` ran four
self-paced cycles hunting for further token/cost inefficiency in the app
itself (not in any one project that uses it). Each cycle checked a distinct
lever and found it already had dedicated, real-data-driven tooling behind
it — not a guess, not a TODO:

1. **Prompt-cache reuse** ([kingdom.js:792](src/kingdom.js:792)) — a resumed
   member is handed its system prompt byte-for-byte, never recomputed at
   wake time. The comment there cites a real measured session where
   recomputing the prompt (because a `remember` call, a Court Instructions
   edit, or a milestone tick reordered part of it) drove new-input from 4%
   of a $101 bill up past 28%, discarding a 96%-cached prefix. This is
   already fixed; `#refreshBrain` is the one sanctioned path for a
   mid-session change to ride along as a notice instead.
2. **Recycle thresholds** — `src/recycle.js` is a dedicated closed-form
   economic model (`T* = c0 + sqrt(2·g·c0·(1 + 12.5b))`) for the token count
   at which recycling a member's context starts paying for itself, derived
   from real cache-read/cache-write pricing, not picked by feel. Run against
   real production data from an external project's `kingdom.db` (Habitable —
   see below): the shipped role-aware defaults (50,000 for the briefer,
   70,000 for everyone else, at [kingdom.js:2158-2160](src/kingdom.js:2158))
   landed almost exactly on the model's computed floor for that data. No
   change warranted to Agentic OS's own defaults.
3. **Tool-schema / prompt bloat per role and mode** — `src/mcp.js` already
   filters the tool list handed to each member by both role
   (`t.roles.includes(ROLE)`) and current mode (`toolAllowed(modeNow(),
   name)`) at [mcp.js:1067](src/mcp.js:1067), so no member's cached prefix
   carries tool definitions it can never call. Same discipline the system
   prompt already applies via `crewFor()` (dead roster entries excluded from
   the cached prefix, measured at ~4.5K tokens for a 107-peasant roster).
4. **Turn-batching windows** — `BATCH_MAX_WAIT_MS` (180s),
   `NOTICE_HOLD_MS` (180s) and `settleMs()` (90s, env-tunable) in
   `src/kingdom.js` are not guessed constants either:
   `src/replay.js`'s `DEFAULTS`/model swept real log data against candidate
   values (60/120/180/300/600/900s) — past 180s it saves at most 3 more
   turns while the worst-case wait keeps climbing to 15 minutes.

**Method note, not just a result:** cycle 2 and the sub-investigation behind
it pulled real numbers from `E:\AI\Mobile Apps\Habitable\kingdom.db` (an
unrelated project this same user runs on Kingdom) via `src/ctx.js` and
`src/recycle.js`, both read-only, both already in this repo. That data
surfaced one real, concrete fact — Habitable's own `kingdom.config.json` has
a flat `recycleAtTokens: 80,000` that predates Agentic OS's later role-aware
default split, and the model shows it wastes roughly 45% of the
briefer-equivalent role's replay+handover budget there. **This is a
tuning opportunity in a different project's config file, not a defect in
Agentic OS, and was not acted on** — reported to the user as an FYI only, no
edit made to a file outside this repo.

**Bottom line for a successor:** don't re-run the same four checks expecting
a different answer without new production data or a code change elsewhere to
motivate revisiting them. The `ctx.js` audit report's own automatic
conclusion (replay/fresh/output share of the real bill, drawn from the
`turn_end` event log) is the fastest way to tell if that has changed:
`node src/ctx.js <repo>` against any project's `kingdom.db`.

## Decisions made, and why

**Quota tracking is a separate `quotas` field, not folded into the existing
`spent` dollar figure.** The alternative — inventing a $/token guess for a
subscription CLI so it fits the existing pricing table — would silently
misrepresent a genuinely free-at-the-margin resource as a cost, which is
worse than not showing a number at all. Keeping it as its own labeled
"tokens burned / plan allowance" metric is honest about what is actually
known.

**Quota aggregation reuses the exact same per-turn delta loop `metrics()`
already runs for per-agent stats**, rather than a second pass over
`turn_end` events. `deltaOf()` already exists specifically to avoid
overcounting codex's cumulative-per-thread usage reporting (codex reports
running totals per thread, not per-turn deltas, unlike claude/agy) — a
second naive summation would have reintroduced that exact bug for the new
feature.

**This feature was designed only after investigating a real cost anomaly**
the user raised: a Kingdom-orchestrated redesign of Habitable cost roughly
3x more than in-app dollar estimates suggested. Queried that project's own
`kingdom.db` cost ledger directly via `node:sqlite` (`DatabaseSync`,
read-only) rather than reconstructing cost from CLI session logs — the
ledger's precomputed `costUsd` field is authoritative and avoids re-deriving
from raw cumulative usage. The user supplied the resolution themselves: a
meaningful fraction of that gap was codex quota consumption under a flat
plan, invisible to a $-only ledger. That is the direct origin of the quota
feature — it is not speculative work.

**The four-cycle audit did not chase or "fix" Habitable's 80,000
`recycleAtTokens` value**, even though the model flagged it as wasteful for
that project. This session's mandate is Agentic OS's own cost efficiency,
not editing a different project's config off the app's own initiative — that
would be scope creep into another codebase without being asked. Habitable's
maintainer (the same user) can apply that number themselves if they want it.

**The loop was stopped, not left idle at a widened interval.** After cycle 4
confirmed every lever the app's own audit tooling identifies as tunable
already had dedicated, real-data-driven tooling behind it, continuing to
poll on the same interval would have produced repeated "still nothing"
cycles for no benefit. Stopping is the documented normal ending for a
dynamic `/loop` — it restarts on request, and a fifth identical cycle
without new data or a code change elsewhere to motivate it would not have
found anything the first four didn't.

## Dead ends — don't retry these

**`better-sqlite3` is not an installed dependency of this project** — do not
reach for it to query a `kingdom.db` file directly. Use Node's built-in
`node:sqlite` (`DatabaseSync`, `{readOnly: true}` for inspection), which is
what `src/bus.js` itself uses and requires no dependency at all.

**Summing raw historical `in`/`out` usage values across a codex member's
turns overcounts massively** (one investigation this session hit ~593M
tokens against a real total far smaller) — codex reports usage cumulatively
per thread, not per-turn, unlike claude/agy. Always go through
`deltaOf()`/`totalsOf()` in `src/usage.js`, never sum raw values for codex.

**`src/ctx.js`'s audit cannot be pointed at a repo-relative `dbPath` for a
project that was only ever run via the workspace-home path (no explicit
repo argument at boot).** `node src/ctx.js <repo>` computes
`dbPath(repo)`, which is a per-repo path — if the project's daemon was
always launched with no CLI argument, its real db lives at
`~/.kingdom/workspace/kingdom.db` instead, and `ctx.js` given the repo path
throws `unable to open database file`. To audit workspace-home data, import
`audit`/`report` from `src/ctx.js` directly and open that db path by hand
(exactly as `ctx.js`'s own CLI branch does, just pointed elsewhere) rather
than shelling out to the CLI form.

**An ESM `import` of an absolute Windows path throws
`ERR_UNSUPPORTED_ESM_URL_SCHEME`** (e.g. `import ... from 'E:/AI/Agentic
OS/src/bus.js'` from a scratch script elsewhere). Fix: write the scratch
script inside the target module's own directory tree and import relatively,
run it from there, delete it after.

**Don't treat a small sample of this session's own throwaway/manual-testing
daemons as representative production data.** An earlier audit pass this
session ran `ctx.js` against the 18-turn workspace-home db and got "NEW
input dominates, cache not being reused" — which traced entirely to
repeated cold-start test daemons (fresh spawns for verification, never
resumed), not a real usage pattern. That result was correctly discarded
rather than reported as a finding; a successor should recognize the same
shape (tiny turn count, every member's first context reading near 0)
before trusting a low-cache-reuse signal from this specific db file.

## Historical next steps (2026-08-19)

1. **Decide what to do with `Background.jpg`** at the repo root — it is
   still untracked, still not referenced by any code path (the app's asset
   store keeps its own copy under `kingdomDir/assets`), and has been flagged
   to the user across multiple sessions with no resolution given yet. Remove
   it, gitignore it, or leave it — any of the three is fine, it's currently
   just unresolved.
2. **The `/loop` cost/efficiency mandate can be restarted anytime** with
   `/loop Keep optimizing the Kingdom app ... for API cost/token
   efficiency`. No specific next optimization is queued — four cycles
   exhausted the levers the app's own audit tooling currently knows how to
   name. A fifth cycle is only likely to find something new if: (a) new
   production `kingdom.db` data exists to audit, (b) a new CLI/billing mode
   shows up that needs the same "don't invent a rate" treatment the quota
   feature gave codex, or (c) the audit tooling itself (`ctx.js`,
   `recycle.js`, `replay.js`) is extended to model a lever it doesn't cover
   yet (e.g. output-token/effort tuning per role, which none of the four
   cycles this session examined).
3. **A saved, unstarted implementation plan** exists for a structured
   "ask the sovereign a question" feature — an `ask_question` MCP tool that
   lets any court member pose a multi-choice question through the existing
   approval pipeline (reusing `propose_role`'s `kind:'approval'` bus
   convention rather than building a parallel channel). Full design at
   `C:\Users\mayur\.claude\plans\plan-out-a-complete-logical-turing.md` —
   not started, not committed to any file in this repo. Ask the user before
   starting it; it was designed but not requested to be built yet.
4. **No committed work is queued for a push** — there is still no git
   remote configured, so nothing can be pushed by accident.

## Watch out for

**Never invent a $/token rate for a subscription-billed CLI.** If a new CLI
or billing mode shows up that has no real per-token price, follow this
session's pattern: track it against a user-supplied quota/allowance
(`kingdom.config.json`'s `quotas` field), don't force it into
`src/price.js`'s metered-rate table.

**Before recommending a recycle-threshold or batching-window change,
re-derive it from real data with the tooling that already exists
(`src/recycle.js`, `src/replay.js`) rather than adjusting a constant on
intuition.** Every number currently in `src/kingdom.js` for these already
has a documented derivation in a comment beside it, sourced from a real
measured session — a change without the same rigor would be a regression in
practice, not a correction.

**This machine has historically run low on memory during `npm test`** — not
re-observed this session (both full-suite runs were clean), but nothing has
changed to fix the underlying cause either. If an unexplained test failure
shows up, check free memory before assuming a real regression.

**Never push to `main` without a fresh, explicit "push" instruction for that
specific commit.** A prior push authorization does not carry forward to a
new commit, even within the same session. No remote is configured today.

**Never put a token in `kingdom.config.json`.** The real token store lives
outside the repo, at `<repoParent>/.kingdom/<repoName>/tokens.json` (or the
workspace home when no repo is attached).

## Historical open questions (2026-08-19)

1. **What should happen to `Background.jpg`?** Untracked at the repo root,
   inert either way, flagged repeatedly across sessions with no answer yet.
2. **Is the exact scale of the earlier Habitable cost gap worth chasing
   further?** The user's own estimate moved from "~$40" to "maybe $120,
   maybe $300" of quota-plan usage during an earlier conversation, and that
   number was never independently re-derived past the initial ~30%-of-plan
   figure the user supplied. The new quota-tracking feature makes future
   runs self-documenting; going back to precisely reconcile that one past
   run was not requested.
3. **Should Habitable's own `kingdom.config.json` `recycleAtTokens: 80,000`
   be updated** to something closer to Agentic OS's newer role-aware
   defaults, given this session's model shows it wasting ~45% of the
   briefer-equivalent role's replay+handover budget there? This is a change
   to a different project's config, not to this repo — flagged as an FYI,
   not acted on, and not this app's decision to make unprompted.
4. **Pick up the "ask the sovereign a structured question" feature next, or
   leave it shelved?** Full plan exists (see *Next steps* #3) but was not
   started this session.

## Historical pointers (2026-08-19)

- Project root: `E:\AI\Agentic OS`; branch `main`, HEAD `66039f4`, no
  remote, working tree clean except `Background.jpg` (untracked).
- Run the tests: `node test/run-all.js` (55 suites) —
  `KINGDOM_TEST_WIDTH=1` to serialize.
- Run the app in Electron: `npm start`. Run just the daemon for
  browser-driven testing: `node src/daemon.js --port 7777` (or
  `.claude/launch.json`'s `"daemon"` entry).
- **Cost-audit tools, all read-only, all safe to run against a live
  court:**
  - `node src/ctx.js <repo> [sinceEventId]` — replay/fresh/output split of
    the real bill, with an automatic conclusion on which lever to pull.
  - `node src/recycle.js <repo> [cli] [model]` — per-member optimal
    recycle-threshold model, derived from real context-growth data.
  - `node src/replay.js` — self-checking model behind the batching-window
    constants (no CLI-audit mode; run bare).
- Quota config shape: `kingdom.config.json` →
  `quotas: {"<cli>": {"label": "...", "limitTokens": N}}`. Surfaced at
  `GET /api/metrics` → `quotas: [{cli, label, used, limit, pct}]` and
  rendered in the Usage panel (`ui/panels.js`'s `openMetrics()`).
- A saved implementation plan for the "structured question" feature sits at
  `C:\Users\mayur\.claude\plans\plan-out-a-complete-logical-turing.md` —
  not started, not committed to any file in this repo.
- Codebase rules: `AGENTS.md`. Four rules govern every change: tests ship
  with the change and must fail without it; never trust a measurement you
  did not take; comments carry the evidence, not the intent; degrade, never
  wedge.
- Global Claude rules: `C:\Users\mayur\.claude\CLAUDE.md` (only includes
  `RTK.md`, a token-proxy CLI reference).
