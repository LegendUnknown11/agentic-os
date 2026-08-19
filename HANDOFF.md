# Handoff — Agentic OS (Kingdom) — 2026-08-19

## Goal & status

Agentic OS at `E:\AI\Agentic OS` is a multi-agent orchestrator shaped as a
kingdom: an orchestrator decomposes and delegates, a cheap briefer watches the
firehose and briefs it, and peasants work in isolated git worktrees. Members
message each other **directly over MCP** rather than routing through the
orchestrator. They run the Claude Code CLI, the Codex CLI, Antigravity
(`agy`), or opencode.

This is a standing `/loop` session with an open-ended mandate: keep optimizing
the app for API cost/token efficiency and fix bugs as found, until the user
says stop. There is no terminal condition — every session under this loop
should update this file rather than assume a successor.

**This session shipped three things, all committed and tested:**
citations on recall/vault answers, document upload so the court can reference
files, and quota-aware usage accounting for subscription-billed CLIs (codex
under a ChatGPT plan) that have no real $/token. `node test/run-all.js` → **55
suites, all green**, run just now as part of writing this handoff (not
recalled from earlier). Working tree is clean except one untracked stray file
— see *Open questions*.

## Current state (what exists now)

### Verified as of this writing

- `git log --oneline -2` → HEAD `a9dd393` ("court: a subscription has no
  price per token, so stop pretending one"), parent `0ff79f4` ("court: cite
  the note, read the file, ask when only the sovereign knows"). Branch
  `main`, no remote configured.
- `git status --porcelain` → only `?? Background.jpg`. Everything else is
  committed.
- `node test/run-all.js` → **55 suites, 4-wide, ~51s, all passed.** Just run
  as part of this handoff, not carried over from memory.

### Feature: citations on recall/vault answers

Recall and vault answers now cite their source note as a `vault:` markdown
link, so an answer's claim can be traced back to the note it came from
instead of taken on faith. Landed in `0ff79f4`.

### Feature: document upload

The court can now be handed documents, not just images/audio — extending the
existing `/api/assets` upload flow to cover documents so a member can
reference an uploaded file mid-task. Verified this session via the MCP
`list_uploads` round-trip and a live browser upload/list/delete cycle against
a running daemon, in addition to the automated suite. Landed in `0ff79f4`.

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
the user raised: a Kingdom-orchestrated redesign of an unrelated app
("Habitable") cost roughly 3x more than in-app estimates suggested. Queried
that project's own `kingdom.db` cost ledger directly via `node:sqlite`
(`DatabaseSync`, read-only) rather than reconstructing cost from CLI session
logs — the ledger's precomputed `costUsd` field is authoritative and avoids
re-deriving from raw cumulative usage. The user supplied the resolution
themselves: a meaningful fraction of that gap was codex quota consumption
under a flat plan, invisible to a $-only ledger. That is the direct origin
of this feature — it is not speculative work.

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

**An ESM `import` of an absolute Windows path throws
`ERR_UNSUPPORTED_ESM_URL_SCHEME`** (e.g. `import ... from 'E:/AI/Agentic
OS/src/bus.js'` from a scratch script elsewhere). Fix: write the scratch
script inside the target module's own directory tree and import relatively,
run it from there, delete it after.

## Next steps

1. **Decide what to do with `Background.jpg`** at the repo root — it is
   still untracked, still not referenced by any code path (the app's asset
   store keeps its own copy under `kingdomDir/assets`), and was flagged to
   the user twice this session with no resolution given yet. Remove it,
   gitignore it, or leave it — any of the three is fine, it's currently just
   unresolved.
2. **The `/loop` cost/efficiency mandate continues** — no specific next
   optimization is queued. Natural candidates surfaced this session but not
   started: wiring quota *enforcement* (pausing a member that exceeds its
   configured allowance, not just displaying it) if the user wants it, and
   the "structured question UI" plan captured separately (see *Pointers* —
   `ask_question` MCP tool letting any court member pose a multi-choice
   question to the sovereign through the existing approval pipeline). Ask
   the user before starting either, since neither was explicitly requested
   yet this session.
3. **No committed work is queued for a push** — there is still no git remote
   configured, so nothing can be pushed by accident.

## Watch out for

**Never invent a $/token rate for a subscription-billed CLI.** If a new CLI
or billing mode shows up that has no real per-token price, follow this
session's pattern: track it against a user-supplied quota/allowance, don't
force it into `src/price.js`'s metered-rate table.

**This machine has historically run low on memory during `npm test`** — not
re-observed this session (the full suite ran clean), but nothing has changed
to fix the underlying cause either. If an unexplained test failure shows up,
check free memory before assuming a real regression.

**Never push to `main` without a fresh, explicit "push" instruction for that
specific commit.** A prior push authorization does not carry forward to a
new commit, even within the same session. No remote is configured today.

**Never put a token in `kingdom.config.json`.** The real token store lives
outside the repo, at `<repoParent>/.kingdom/<repoName>/tokens.json` (or the
workspace home when no repo is attached).

## Open questions for the user

1. **What should happen to `Background.jpg`?** Untracked at the repo root,
   inert either way, flagged twice with no answer yet.
2. **Is the exact scale of the Habitable cost gap worth chasing further?**
   The user's own estimate moved from "~$40" to "maybe $120, maybe $300" of
   quota-plan usage during this session's conversation, and that number was
   never independently re-derived past the initial ~30%-of-plan figure the
   user supplied. The new quota-tracking feature will make future runs
   self-documenting; going back to precisely reconcile this one specific
   past run was not requested.
3. **Pick up the "ask the sovereign a structured question" feature next, or
   leave it shelved?** A full implementation plan exists (see *Pointers*)
   but was not started this session — unrelated to the citations/upload/quota
   work that was.

## Pointers

- Project root: `E:\AI\Agentic OS`; branch `main`, HEAD `a9dd393`, no
  remote, working tree clean except `Background.jpg` (untracked).
- Run the tests: `node test/run-all.js` (55 suites) —
  `KINGDOM_TEST_WIDTH=1` to serialize.
- Run the app in Electron: `npm start`. Run just the daemon for
  browser-driven testing: `node src/daemon.js --port 7777` (or
  `.claude/launch.json`'s `"daemon"` entry).
- Quota config shape (new this session): `kingdom.config.json` →
  `quotas: {"<cli>": {"label": "...", "limitTokens": N}}`. Surfaced at
  `GET /api/metrics` → `quotas: [{cli, label, used, limit, pct}]` and
  rendered in the Usage panel (`ui/panels.js`'s `openMetrics()`).
- A saved implementation plan for the "structured question" feature
  (an `ask_question` MCP tool reusing the existing approval pipeline) sits
  at `C:\Users\mayur\.claude\plans\plan-out-a-complete-logical-turing.md` —
  not started, not committed to any file in this repo.
- Codebase rules: `AGENTS.md`. Four rules govern every change: tests ship
  with the change and must fail without it; never trust a measurement you
  did not take; comments carry the evidence, not the intent; degrade, never
  wedge.
- Global Claude rules: `C:\Users\mayur\.claude\CLAUDE.md` (only includes
  `RTK.md`, a token-proxy CLI reference).
