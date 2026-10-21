# f3-session: backend for what the T3 redesign left out

Branch `f3-session`, cut from `origin/functionality` at `e730bb6`, 2026-10-21.
Scope: the context-window meter, Compact session, the agent on a run, and spend
by day, plus a small amount of T3 UI to show them. Remote control, Browser
preview and Design canvas were **not** touched; they are specced separately.
HANDOFF.md, PLAN.md, CLAUDE.md and AGENTS.md were not edited. Their "Not built"
lines for the meter and Compact session, and the "Agent column" and "Spend
today" decisions, are now out of date. Whoever owns those files should update
them when this branch merges.

## Commits

| Commit | Piece | Tests that fail without it |
|---|---|---|
| `91848b6` | Context-window meter (backend) | `t-session` section 1; `t-panels` `/api/metrics.context` |
| `bb19979` | Compact session (backend + HTTP) | `t-session` section 2; `t-panels` `/api/compactSession` |
| `489bfe1` | Agent on a run: `lead` column and its migration | `bus.js` self-check; `t-session` section 3; `t-panels` `/api/runSpend` |
| `028adbe` | Spend by day: monotonic ledger | `bus.js` self-check (DST); `t-budget`; `t-session` section 4; `t-panels` |
| `f0a31c3` | UI: inspector meter and button, Runs Agent column, Spend today | `t-inspector`, `t-store`, `t-pages` |

There is one new suite, `test/t-session.js`, and it is registered in `test/run-all.js`. The suite count went from 95 to 96.

## API contract (all additive; no existing field changed)

**Context meter**
- `agenticos.config.json` → new `contextWindows: { "<model id>": tokens }`. The template
  fills in only the five configured claude models: 1M each, except `claude-haiku-4-5` at 200K. These are the
  Claude API's published maximum input sizes, taken from the claude-api skill's model table (cached
  2026-10-06). The codex, agy and opencode models are left out because I had no source for them. A model
  the table does not list gets `window: null`, and the meter says "window unknown". Existing
  workspaces copied the template before this key existed, so they have no table and every window
  is `null` until it is added.
- `AgenticOS#contextOf(name)` / `#contextAll()` →
  `{ name, role, model, tokens, window, pct, recycleAt, awake, busy, conversationId }`.
  The orchestrator comes first. `tokens` is the live agent's `ctxTokens()` when the member is awake, otherwise the
  `ctx:<name>:<conv>` key, which is the same figure the recycle threshold reads.
- `GET /api/metrics` → new `context: [...]` and `members[].context`.
- Stream `snapshot` → new `context: [...]`. Each `spend` event → new `window`.

**Compact session**
- `AgenticOS#compactSession(name)` calls the existing `recycleAgent`: it captures a handover note,
  retires the session and reseeds a successor. It is the same path that `recycleAtTokens` fires; there is no second path.
- `POST /api/compactSession {name}` → `200 {ok, name, by, before, after, window, conversationId}`.
  It refuses with `409 {ok:false, error, reason}`, where `reason` is one of:
  - `busy`: the member is mid-turn.
  - `asleep`: there is no live session.
  - `recycling`: a handover is already in progress.

  An unknown member → `500 {ok:false, error}`, as before.
- The action dispatcher now uses an error's own `status` and `reason` when it has them. Otherwise it returns 500, as before.
- Every outcome is recorded as a durable `session_compact` event. A success also emits
  `compacted` on the stream.

**Agent on a run**
- Run rows (`/api/run`, `/api/runs`, the `run` event) → new `lead` (string or null).
- `GET /api/runSpend` `runs[]` → new `lead` and `agents` (the members that spent on the run, highest
  spend first, from the new `Bus#runAgents()` over `run_spend`).
- `AgenticOS#createRun` records the orchestrator as lead, or another member of the team if
  the caller names one. The HTTP body cannot set it.

**Spend by day**
- `GET /api/metrics` → new `spendByDay: { timeZone, today, days[14] }`. Each day is
  `{ day: 'YYYY-MM-DD', usd, turns, tokens }`, newest first, and empty days are included.
- Stream `snapshot.spend` and every `spend` event → new `today: { day, usd, turns, tokens, timeZone }`.
- **Time zone:** the zone is `agenticos.config.json` `timeZone` if it is a valid IANA name, otherwise the
  daemon process's local zone. It is always returned by name. Days are bucketed when the data is read, from UTC
  timestamps, so changing the zone re-buckets history. The walk back goes one calendar day at a time, so a 23h or 25h DST day
  is neither skipped nor counted twice.

## Schema migrations

- `schema:runs:lead:v1` adds a nullable `runs.lead` column. It is also in the `CREATE` for fresh
  databases. Older runs read back `lead: null`: who led them was never recorded, and
  nothing is backfilled. The UI falls back to `agents[0]` (the top spender) and then to a dash.
- A new table `spend_ledger(id, ts, agent, usd, tokens)` with index `idx_spend_ledger_ts`
  (`create if not exists`, the same way `run_spend` was added). It gets one row per priced turn, whether or not a run is active.
  `clearSpend()` never touches it. **Not backfilled:** the ledger starts empty when you upgrade.

## UI changes (minimal, per `.claude/skills/ui-change`)

- **Inspector ("This session" card):** a Context row showing `120k of 400k · 30%`, or `42k · window
  unknown`, or `not measured yet`. When the window is known, the existing `meter()` primitive draws the bar (aria-labelled
  "Context window used"). Below it is a full-width Compact session `.button` at 44px. Its state
  is written as visible text underneath, with no `title` tooltip. It is disabled when the session is empty or a
  request is in flight. A refusal is shown as the daemon's own message in the toast. A reply that arrives after the
  thread has unmounted never repaints (`!mounted || root.isConnected === false`).
- **Store:** a new `state.context` is seeded by the snapshot, updated by `spend`, and zeroed by `recycled` or
  `compacted`. Both of those events still reach `notices`, as they did before.
- **Overview:** the Runs table columns are now Run, Agent, Stage, Updated, matching the canvas. Per-run spend is
  still in Settings → Usage → Run spend. The fourth counter is "Spend today" from the ledger, and shows "—"
  until the daemon has sent it. Lifetime spend is never shown under this label.
- **CSS:** two new selectors, `.inspector-context` and `.inspector-compact`, are declared beside the inspector block.
  They use tokens only. `t-theme` passes.
- No new status vocabulary was added, so `tone()` was not changed.

## Evidence

**Held**
- **Source:** before every commit I ran the full `npm test`: 96 suites. The only failure each time was `t-electron.js`
  (no display; the baseline was 95 suites with the same single failure). In the last run, `t-control.js`
  failed once in the parallel pool and then passed alone, both in the retry and again when I ran it by hand afterwards.
  `t-theme-geometry` ran in real Chromium and passed.
- **Real browser:** headless Chromium (Playwright, `/opt/pw-browsers/chromium`) against a seeded
  daemon served on 127.0.0.1, at 1440x900 and 720x900. What I saw:
  - Overview counters read `Spend today $1.75`. That is today's ledger row only; a $9 row from three days ago was left out, as it should be.
  - The Runs table header reads Run / Agent / Stage / Updated. A run with a recorded lead shows `orchestrator`. A legacy run shows `coder`, its top spender.
  - The inspector reads `Context 120k of 400k · 30%`, with `aria-valuenow=30`.
  - The button is 44px tall, with no `title`.
  - Clicking it ran a real compaction round trip: `200 {before:120000, after:0}`. The toast said "Compacted orchestrator: 120k to 0 tokens." and the meter went to `0 of 400k · 0%` with the button disabled.
  - No horizontal overflow at either width.

  The one console error is a 404 that page response events did not catch, consistent with
  Chromium's automatic `/favicon.ico` request (the UI declares no favicon). That is pre-existing and not part of this change.
  This check was a one-off script in the session scratchpad, not a committed suite.
- No paid provider was called. The browser check and the tests ran codex members against
  `process.execPath` (node) as a stand-in binary.

**Not held**
- **Electron and Windows:** `t-electron.js` cannot launch here.
- **A real member's compaction:** a real member is a live claude or codex session writing a real handover. The AgenticOS-level tests use
  stand-in agents, and the browser run's "handover" came from a node stand-in.
- **Context window figures:** the `contextWindows` numbers are API maxima. A subscription CLI session may run with a smaller
  effective window, and nothing here measures that.
- **The user's acceptance** of how the meter, button, Agent column and "Spend today" look.

## Open items

- Codex, agy and opencode models have no window in the template. Someone with a source should
  add them to `contextWindows`; until then their meters correctly say "window unknown".
- Spend history from before the ledger existed is not reconstructed. The "Spend today" figure
  on the upgrade day covers only turns taken after the upgrade.
- The meter only updates on `spend`, `recycled` and `compacted` events, plus the snapshot. A session
  switch or wake with no turn yet keeps showing the last value until the next turn, a reconnect, or
  `/api/metrics`.
- Compact session works only on a live, idle member. An asleep member resumes its saved session
  on its next message; it is not compacted while asleep, by design.
- HANDOFF.md and PLAN.md need their T3 "Not built" lines and two decisions revised (see the top of this file).
