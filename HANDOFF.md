# Handoff — Agentic OS (Kingdom) — 2026-08-16

## Goal & status

Agentic OS is a multi-agent orchestrator at `E:\AI\Agentic OS`, shaped as a
kingdom: a king decomposes and delegates, a jester watches cheaply and briefs,
and peasants work in isolated git worktrees. Its differentiator is that members
message each other **directly over MCP** rather than routing through the king.
Members run the Codex CLI, the Claude Code CLI, or Antigravity (`agy`).

The 2026-08-16 session did three things. It rebuilt the **cost and token
instrumentation**, which was wrong in three independent ways, and parallelised
the test runner — committed as `bd13360` and `c7f4e79`. It wrote
`docs/PLAN-saas.md`, the plan for turning this into a product. And it
restructured **the front door**: the rail now holds the court instead of the
whole 105-role roster, and recruiting moved to its own searchable screen.

All of it is complete and tested. The UI work is uncommitted at the time of
writing; `kingdom.config.json` and `roles.json` remain uncommitted from before
the session and are deliberately excluded — see *Open questions*.

## Current state (what exists now)

### Verified as of this writing

- `node src/price.js`, `node src/recycle.js`, `node src/usage.js` and
  `node src/ctx.js` self-checks all exit 0 when run individually.
- `node src/ctx.js "E:/AI/Sant Dnyaneshwar"` reports
  `3 turns · 1.89M in · 0.01M out · $0.604`. Before this session the same
  command reported 2.37M and no dollar figure.
- **`node test/run-all.js` → 38 of 38 suites passed, 4-wide, 74.0s.** Exit code
  0. `turn batching` failed in the pool and passed on its serial retry, so it
  was reported as `flaky` — the polling fix reduced that class but did not
  eliminate it, and the remaining fixed sleeps are the ones asserting that
  nothing happened, which cannot be polled for.
- **The front door was verified in a real browser**, not just by reading code:
  the daemon was run against a scratch repo with `KINGDOM_CODEX_BIN` pointed at
  a stub so no API quota was spent, and summon/dismiss was driven end to end.
  Rail rows went 107 → 2, scroll height 4,179px → none.
- `node test/t-stt.js` fails with `mkl_malloc: failed to allocate memory` when
  the machine is down to ~0.6GB free, and passes above roughly 2.3GB. See
  *Watch out for*.
- `E:\AGIOS Kingdom\Obsidian Vault\Kingdom\Memories\` exists and holds 7 notes.
  There is no `Kingdom\Memory\` — which is what the `MEMORY_DIR` fix below was
  about.
- `kingdom.config.json` right now: king `codex/gpt-5.6-terra`, jester
  `codex/gpt-5.6-luna`, **105 peasants**, `recycleAtTokens: 80000`, and
  **no `maxBudgetUsd`, no `maxKingdomUsd`, no `prices`** — deliberately, see
  *Decisions*.

### Believed but not re-checked at handoff time

- The Electron app and the pet window were last exercised in the 2026-08-07
  session and have not been run since. The UI restructure was verified in a
  browser against the daemon, which is the same `ui/` Electron loads, but the
  Electron shell itself was not launched — and `electron/` was not touched.

### New files

| Path | What it is |
|---|---|
| `src/price.js` | `$/Mtok` rate card per `cli/model` plus `costOf()`. Prices fresh input, cache reads (0.1x) and claude cache writes (1.25x) separately. Returns **null**, never a guess, for a model with no published price. |
| `src/recycle.js` | Derives what `recycleAtTokens` should be, from a session's real context growth. Closed form plus a sweep table. |
| `docs/PLAN-saas.md` | What it would take to make this a product rather than a personal tool: three candidate product shapes, nine concrete blockers with the file each lives in, a five-phase plan, and four questions that must be answered before Phase 1. |
| `ui/court.js` | The two predicates that decide what the front door shows — `inCourt` (rail vs. roster) and `matchesQuery` (summon search). Pure and DOM-free specifically so `npm test` can check them; there is no browser in the test run. |

### Changed files

- `src/usage.js` — gained `totalsOf`, `isCumulative`, `deltaOf`, `ZERO`. The
  delta rule now lives beside the cache-field rule so all consumers share it.
- `src/ctx.js` — takes deltas, prices turns, reports a cost column and a
  cost-weighted split. Its auto-conclusion was rewritten (see *Decisions*).
- `src/kingdom.js` — `turn_end` now deltas usage and prices it when the CLI
  reports no cost; `#spawn` split into an idempotent promise-deduping wrapper
  plus `#doSpawn`; the delivery loop no longer awaits a spawn; approved crews
  spawn in parallel. `BATCH_MAX_WAIT_MS`, `NOTICE_HOLD_MS` and `settleMs` are
  now exported.
- `src/daemon.js` — uses the shared `deltaOf`; `/api/metrics` filters
  `turn_end` in SQL and counts messages with `count(*)`.
- `src/bus.js` — `events({type})` filters in SQL; new `countMessages()`.
- `src/memory.js` — `MEMORY_DIR` corrected from `'Memory'` to `'Memories'`.
- `src/replay.js` — imports the live delivery constants instead of keeping its
  own copy, with a drift guard in the self-check.
- `test/run-all.js` — concurrency pool with serial retry (see *Decisions*).
- `test/t-batching.js` — new case: a member behind a **failing** spawn must
  still be delivered. New case: concurrent wakes produce one agent. Five
  positive assertions moved off fixed sleeps onto a polling `until()` helper.
- `ui/app.js`, `ui/panels.js`, `ui/rail.js`, `ui/index.html`, `ui/app.css`,
  `ui/icons.js` — the front-door restructure. See *Decisions* for what changed
  and why.
- `.gitignore` — ignores `.tmp-*`. The two stale SQLite probe siblings
  (`.tmp-mcp-probe.db-shm`, `.tmp-mcp-probe.db-wal`, dated 2026-08-04) turned out
  to be **tracked**, not untracked — they were committed in `19ea8ad`. They are
  deleted from HEAD now, but they remain in history. That was judged not worth a
  history rewrite: together they are ~92KB of SQLite scratch from an MCP probe,
  with no credentials in them.
- `test/t-budget.js` — the token assertion corrected from 12,000 to 107,000
  (the old code ignored claude's cache read), plus a whole new section proving
  a codex member reporting `$0` still accrues spend and trips a cap.
- `README.md` — corrected two false claims about spend caps; documented the
  three cost tools and the test runner's behaviour.
- `AGENTS.md` — suite count 25 → 38.
- `package.json` — added `npm run recycle`.
- `kingdom.config.json`, `roles.json` — **were already modified before this
  session started.** The only change this session made to `kingdom.config.json`
  is net zero (caps were added, then removed at the user's instruction). Do not
  assume the rest of those two diffs is this session's work.

## Decisions made, and why

**Cost is computed from a rate card when the CLI will not report it.** Only the
claude CLI reports `total_cost_usd`; `src/agent.js` hardcodes `costUsd: 0` for
codex and agy, and the entire live court is codex. So `spentUsd` sat frozen
while the court burned tokens, and `#enforceBudget` compared `$0` against the
ceiling on every turn — meaning `maxBudgetUsd` and `maxKingdomUsd` **could never
fire at all**. Turns are now priced from `src/price.js` when the CLI is silent.

**An unpriced model spends nothing rather than an estimated amount.** `costOf`
returns `null` for a model not in the table, and null contributes zero to
`spentUsd`. A cap enforced against an invented price stops members for reasons
nobody can audit, which is worse than no cap. This is why `agy` members are
currently exempt from any cap: no verified Gemini rates were available.

**There are no spend caps in the config, by the user's explicit instruction**
("there shouldnt be a max budget"). The enforcement machinery works and is
tested — it is simply not switched on. Absent keys mean disabled; the code reads
`?? 0` and `0` is falsy. Do not add caps back without being asked.

**No `prices` key was added to `kingdom.config.json`.** The override mechanism
exists in `tableFrom()` for models the code does not know, but copying the
built-in table into config would recreate exactly the drift class that
`src/replay.js` was fixed for in the same session.

**`ctx.js` no longer advises "recycle sooner" on a high cache-read share.** That
advice was backwards twice over. A high replay share means the cache is working
— those tokens bill at a tenth of fresh ones — and recycling is the one action
that *destroys* the cached prefix, converting 0.1x tokens into 1.0x tokens and
buying a handover turn at the member's maximum context. The report now draws its
conclusion from the cost split, not the token split.

**The delivery loop starts a spawn instead of awaiting it.** Delivery runs
inside a single `ticking` critical section, and it used to `await this.#spawn()`
inline, so one peasant's worktree validation froze every other member's mail.
The batch is now left unacked and a later tick delivers it once the member is
live. The `ticking` guard stays — it exists because two overlapping ticks each
spawned the same member.

**Spawn deduplication lives inside `#spawn`, not at its call sites.** `#doSpawn`
awaits `createWorktree` before it ever reaches `agents.set`, so an `agents.has`
check at the top is not a lock: two callers both pass it and both run
`git worktree add` on the same path. That cascade has happened in this project
before, and there are now more routes into it.

**`recycleAtTokens` stays at 80,000.** This was the session's final measurement
and the answer is "do not move it", which is a finding rather than a shrug. On
the only session with usable data the king's context peaked at 15,448 — 19% of
the threshold, 11 turns of growth short of it, with 0 handovers. The threshold
never fired, so changing it would alter behaviour nobody has observed.
`src/recycle.js` also derives a floor of `T* = 8,352` for that growth rate, but
that floor assumes a successor *resumes* when in reality it *rediscovers* —
re-reading files at 10x the cache rate on a cold prefix, which nothing in the
event log measures. The gap between 8k and 80k is the rediscovery allowance.

**Failing test suites are retried once, serially, rather than quarantined.**
See *Dead ends* for the two approaches that lost.

**A test waits for a condition, never for a duration — unless it is asserting
that nothing happened.** A flat sleep before a positive assertion measures the
machine, not the code, and this repo has now lost two full runs to exactly that.
Negative assertions ("a lone notice must NOT cost a turn") genuinely need a
fixed window, because there is no condition to poll for; those keep their sleeps
and should not be converted.

**The rail is the court; the roster moved to its own screen.** Measured on a
running instance: the rail rendered 107 rows and 4,179px of scroll into a 580px
viewport, of which 105 said "not summoned". A member list that is 98% absence is
a wall. The rail now holds only the king, the jester and summoned peasants — 2
rows on a fresh court — and everyone else is behind **Summon** (Alt+E), which
searches name, title *and* description. No backend change was needed:
`kingdom.wake()` already adds to `summoned` and `sleep()` removes, so the UI
drives the existing endpoints.

**The empty states are now the loudest thing on screen, not the quietest.** The
goal bar used to set `hidden` when there was no goal — hiding itself exactly
when it had something to say — and a court with nobody in it showed a blank
canvas. There is now a persistent "Your court is empty" panel with three
clickable steps, shown whenever no peasant is summoned and no goal is set. It is
state-driven, not a one-shot tour, so it comes back the day you dismiss everyone;
a tutorial you can only see once is no use to someone returning in a month.

**Summon/dismiss shows a pending state rather than an optimistic one.** The
first version flipped the row immediately and was simply wrong — it mutated a
copy of the roster entry, so nothing happened. The fix is not a better
optimistic write: summoning creates a worktree, so the row says "Summoning…",
disables, and waits for the server's roster event to settle it. That is also
correct when the spawn fails.

**The visual work stayed inside the existing glass system.** `app.css` has five
stacked REFIT blocks that override each other, and the temptation was to
consolidate them. That is a separate job and not what makes the UI hard to use —
the appended section styles only new selectors, so it is not a sixth REFIT.

**The product recommendation is B — host the control plane, keep execution on
the customer's machine.** The reasoning is in `docs/PLAN-saas.md`. In short: the
two things that sink a solo-built agent SaaS are taking custody of customer
source and paying for inference you resell at a margin, and shape B avoids both
while being the shape this codebase is already closest to. The hosted-execution
version (A) stays reachable afterwards — Phase 2 is the shared prerequisite.

## Dead ends — don't retry these

### From this session

**Do not use a bare `process.argv` self-check guard in a `ui/` module.** The
`src/` files all end with `if (process.argv[1]?.endsWith('x.js'))`, and copying
that into `ui/court.js` threw `ReferenceError: process is not defined` in the
browser. Because `app.js` imports it first, the whole module graph died and the
throne room booted to an empty shell — header with no tools, no rail, no modes.
Guard with `typeof process !== 'undefined'`. Nothing in the test suite catches
this; only loading the page does.

**Do not anchor toolbar layout to a specific tool's name.** `buildTools()` had
`if (ico === 'diff') nav.append(moreButton())`, which silently assumed `diff`
was the last primary tool. Adding one after it put the overflow button in the
middle of the row. It is anchored to a computed `LAST_PRIMARY` now.

**Do not put timing- or memory-sensitive suites in a hand-maintained solo
list.** This was tried twice. The list only grew — `t-batching` first, then
`t-stt` — and it did not even work: `t-stt` failed when run alone anyway,
because the machine itself was out of memory. Retrying a failure serially covers
contention for memory, timing and ports alike, with no list to maintain and no
per-worker memory budget to guess at.

**Do not use `spawn` in the test runner without an `error` handler.**
`spawnSync` always came back with a status; `spawn` can fail to start a process
at all and then never emits `close`. A full run died outright with
`Error: spawn UNKNOWN (errno -4094)` after 30 green suites, losing every result
with it. `run()` in `test/run-all.js` now treats a start failure as just another
failed suite.

**Do not sum codex `usage` across turns.** codex reports it **cumulatively per
thread**. `src/daemon.js` already knew this; `src/ctx.js` and `src/kingdom.js`
did not, and summed raw. On the real Sant Dnyaneshwar database that read 2.37M
input tokens where the truth is 1.89M — a 25% overcount that grows with turn
count. Use `deltaOf` from `src/usage.js`.

**Do not treat a cache read as costing the same as fresh input.** It costs 0.1x.
The three token kinds differ by 12.5x end to end, so a token count cannot stand
in for a bill in either direction.

### Still true from the 2026-08-07 session

These concern `electron/` and `ui/`, untouched this session, and remain live:

- **Do not move the pet window with `setPosition`.** On a 125%-scaled display it
  re-applies the scale factor each call; measured compounding 144×172 → 432×467
  across one drag. Use `setBounds` with an explicitly computed size.
- **Do not compute the pet drag from renderer `screenX`/`screenY`.** Chromium's
  cached window origin updates a beat late, so the error feeds forward and the
  dog sails off. The cursor must be read from the main process.
- **Do not freeze the pet's drag size from `getBounds()`** — it returns whole
  DIPs while the physical box rounds up, creeping larger each drag.
- **Do not call `setBounds` on the pet window without lifting `resizable`
  first.** Windows pins min/max size when `resizable: false`, and the call is
  silently clamped.
- **Do not put a looping clip in the pet's `FIDGET` list** — a fidget only ends
  when its clip wraps.
- **Do not pass the `agy` prompt as a trailing positional.** See *Watch out for*.
- **Do not trust `EnumWindows`-based window measurement from PowerShell here.**
  It matches Electron's hidden helper windows, and a garbage-collected callback
  delegate returns partial results.

## Next steps

1. **Review and commit the working tree.** `git diff` then `git add -A` and
   commit. Be aware that `kingdom.config.json` and `roles.json` carry ~1,860
   lines of changes that predate this session; decide deliberately whether they
   belong in the same commit. Done when `git status` is clean.
   **Do not push without a fresh, explicit instruction from the user** — that is
   a standing rule in `E:\AI\CLAUDE.md`.

2. **Continue the UI work at the "feel" stage.** The sovereign chose
   *structure first, then feel*, and structure is done. Feel is untouched: no
   motion on state change, no sound, no weight behind a summon or a merge. The
   natural next pieces are transitions on rail state changes, a real sense of
   arrival when a member joins, and progress that is felt rather than read.
   Nothing here is started, so there is nothing half-built to clean up first.

3. **Read `docs/PLAN-saas.md` and answer its four closing questions.** It is the
   plan for turning this from a personal tool into a product, and Phase 1 cannot
   start until the product shape (A, B or C) is chosen. The recommendation is B
   — host the control plane, keep execution on the customer's side.

4. **Re-run `node src/recycle.js "<repo>"` after a session long enough to
   actually reach 80,000 context tokens.** The current answer rests on a
   3-turn sample where the threshold never fired. Done when the report stops
   printing `OBSERVED PEAK … never came close to recycling`.

5. **Consider pricing the `agy`/Gemini models** in `src/price.js` or via a
   `prices` key. Until then every agy member is invisible to cost reporting and
   exempt from any cap. This needs verified public rates, not estimates.

6. **Optional: confirm the live spend path end to end with one short real court
   run.** Everything in this session was verified offline against fixtures and a
   read-only replay of an existing database. Only a real run exercises pricing
   through `#enforceBudget` with live CLI usage payloads.

## Watch out for

**This machine runs out of memory, and that is what most test failures here
are.** It has 8.36GB total and was repeatedly down to 0.4–0.9GB free during this
session. At that level `test/t-stt.js` cannot load its Whisper model, `spawn`
itself starts failing with `UNKNOWN`, and neighbouring suites die with
`0xC0000409`. Check free memory before investigating any failure.

**`test/t-batching.js` used to assert against wall-clock deadlines, and this is
now fixed — do not reintroduce them.** Five positive assertions sat behind flat
`await wait(...)` calls, the worst giving a member 5,000ms to be revived when
reviving one means `git worktree add` plus `behindBase`, three or four git
subprocesses. On a loaded box (a full run taking 513.7s against a normal
74–105s) that budget was missed and the suite failed twice, then passed
standalone the moment the machine was quiet. Those five now poll a condition
through the `until()` helper at the top of the file, with a 60s ceiling. Fixed
waits remain only where the assertion is that *nothing* happened, which cannot
be polled for. Suite runtime is unchanged (27.6s).

**`npm test` runs four suites at a time now.** A suite that fails is re-run alone
before being reported; one that then passes prints `flaky (failed in the pool,
passed alone)` rather than being silently forgiven. Set `KINGDOM_TEST_WIDTH=1`
for the old one-at-a-time behaviour when debugging. Wall clock is 59–105s,
against 185s sequential, the spread tracking free memory.

**Test suites bind ports derived from the process PID, and a stray daemon on
port 7788 causes false failures.** Check for one before investigating a failing
suite.

**`kingdom.config.json` and `roles.json` were already dirty when this session
began.** Any `git diff` on them mixes this session's work with someone else's.

**`agy` updates itself, and 1.1.11 changed `--print` from a boolean to a flag
that takes the prompt as its value.** The old code passed the prompt as a
trailing positional, so agy's Go flag parser read the *next flag* as the prompt
and the member emitted no JSONL while exiting 0. Fixed in `src/agent.js`
`#runAgyTurn()` and `src/doctor.js`. If a member on agy ever goes silent with
exit 0, check `agy --help` before anything else. The king is now on
`codex/gpt-5.6-terra`, so this affects no live member at present.

**A bare `agy` call without `--dangerously-skip-permissions` exits 0 with no
output.** A manual probe without that flag looks like a broken CLI when it is
not; the agent code passes it automatically.

**`electron/pet-preload.cjs` must keep the `.cjs` extension** — `package.json`
declares `"type": "module"` and a sandboxed preload cannot be ESM.

**`ui/app.css` has five appended "REFIT" blocks** (at lines 597, 670, 743, 850
and 1024) that override earlier rules in the same file. Check whether a later
block already overrides what you are editing, or your change will appear to do
nothing.

**Screenshots of the app do not work through the Claude Code Browser pane** (it
does not composite frames). Use `mcp__claude-in-chrome` against
`http://127.0.0.1:<port>`, or a PowerShell desktop capture for the Electron
window.

## Open questions for the user

1. **Which product shape — A, B or C?** See `docs/PLAN-saas.md`. Nothing in
   Phase 1 can start without this, and it is the only question on this list that
   blocks other work.

2. **Do the pet window, wallpaper and music survive into the product, as brand
   or as personal workflow?** It decides whether Electron stays a first-class
   client or becomes one of several.

3. **What should happen to the pre-existing `kingdom.config.json` and
   `roles.json` changes?** They total roughly 1,860 lines, were already in the
   working tree when this session started, and were deliberately left out of
   this session's commit. They are still uncommitted.

4. **Should `agy`/Gemini models be priced?** Answering yes (with real published
   rates) makes agy members visible in `ctx.js` and eligible for a cap.
   Answering no keeps them permanently exempt, which is safe but silent.

3. **Is a real court run worth doing to confirm the live spend path?** It costs
   actual API quota. Everything else was verified without spending any.

## Pointers

- Project root: `E:\AI\Agentic OS`; branch `main`, one commit, working tree dirty
- Run the tests: `npm test` (or `node test/run-all.js`)
- Where the money went: `npm run ctx -- <repo>` — e.g.
  `node src/ctx.js "E:/AI/Sant Dnyaneshwar"`
- What a different delivery window would cost: `npm run replay -- <repo>`
- What `recycleAtTokens` should be: `npm run recycle -- <repo>`
- Run the app: `npm start`; preflight the CLIs: `node src/doctor.js`, **from a
  normal terminal**, not inside a Claude Code session
- Court databases live at `E:\AI\.kingdom\<repo name>\kingdom.db`. Only
  `Sant Dnyaneshwar` has turn data (3 turns); `Agentic OS` has none.
- The sovereign's vault: `E:\AGIOS Kingdom\Obsidian Vault\Kingdom\` — court
  instructions, decisions, and `Memories\` (7 notes, now actually read by
  `brainBlock` since the `MEMORY_DIR` fix)
- Codebase rules: `AGENTS.md` in the project root. Four rules govern every
  change here: tests ship with the change and must fail without it; never trust
  a measurement you did not take; comments carry the evidence, not the intent;
  degrade, never wedge.
- Workspace map and standing rules: `E:\AI\CLAUDE.md`
