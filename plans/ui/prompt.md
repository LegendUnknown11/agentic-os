# Luna Prompt — UI/UX and Efficiency Presentation

You are the UI/UX owner for an Agentic OS optimization pass.

Repository:
`E:\AI\Agentic OS`

Start by reading, in order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `HANDOFF.md`
4. `PLAN.md`
5. Current Git status and implementation

`RTK.md` is currently absent; report that once and continue. Do not spawn additional agents.

## Goal

Polish the newly rebuilt AgentOS interface so cost, cache efficiency, model behavior, MCP savings, and recovery are understandable and actionable without changing the product identity or backend behavior.

## Your ownership

- `ui/**`
- `test/t-pages.js`
- `test/t-theme.js`
- `test/t-store.js`
- `test/t-thread.js` only when a directly affected interaction requires it

Do not edit:

- `src/**`
- `agenticos.config.json`
- `test/run-all.js`
- Backend/model/MCP tests
- `PLAN.md`, `HANDOFF.md`, `CLAUDE.md`, or `AGENTS.md`

The functionality agent owns the backend. Develop against the frozen contract below and handle missing fields gracefully until integration.

## Preserve

- Dark ink visual identity and current token palette.
- Run-first and urgency-first information hierarchy.
- Framework-free vanilla JavaScript renderer.
- Existing routes and Chat/Cowork/Code behavior.
- One shared stream/poll lifecycle.
- Existing status vocabulary.
- 44px targets, keyboard support, reduced motion, focus handling, stale-response rejection, and inline retry behavior.
- Literal colors remain confined to the `:root` token block.
- The `#bg` wash and existing responsive rail/drawer behavior.
- The custom hover-tip pattern; do not reintroduce native `title` tooltips.

## Frozen additive `GET /api/metrics` contract

- Existing response fields remain.
- New total fields:
  - `fresh`
  - `cached`
  - `written`
  - `cacheRate`
- New cost object:
  - `{fresh, cached, written, output, total, classification}`
- New auxiliary object:
  - `{calls, failures, input, cached, written, output, latencyMs:{p50,p95}, byPurpose}`
- New MCP object:
  - `{maskedCalls, maskedChars}`
- Member records add:
  - `cli`
  - `model`
  - `effort`
  - `fresh`
  - `written`
  - `cacheRate`
  - `costClassification`
- Any new object or field may temporarily be absent, `null`, unavailable, or unpriced.

## Plan

### 1. Freeze the visual control

- Inspect the current Overview, Usage, Settings, responsive drawer, and shared design primitives.
- Record the current first-look hierarchy, dense states, narrow layout, focus behavior, and loading/error handling.
- Keep this as an identity-preserving polish pass, not a rebrand or another interface rewrite.
- Add no framework, chart package, image, route, or remote asset.

### 2. Rebuild Usage as a cost-decision surface

- Keep the existing usage route.
- The first viewport must answer:
  - What is costing the most?
  - Is caching working?
  - Are auxiliary calls significant?
  - Which agent needs attention?
- Lead with:
  - fresh-input cost
  - cache reuse
  - auxiliary model-call count
  - total classified spend
- Clearly distinguish cached reads, new input, cache writes, and output.
- Use native cards, meters, and semantic text relationships. Do not add a chart dependency.
- Show cache percentages with text as well as geometry and color.
- Explain reported, estimated, mixed, unpriced, and unavailable figures.
- Never present an estimate as provider-reported spend.

### 3. Improve per-agent presentation

- Replace the cramped wide table with semantic per-agent records that behave as a calm grid on desktop and stacked definition lists on narrow screens.
- Each record shows:
  - agent
  - CLI/model/effort
  - turns
  - fresh input
  - cache rate
  - current context
  - classified spend
- Preserve meaningful term/value relationships for assistive technology.
- Long model names, agent names, numbers, and unavailable labels must wrap without clipping.

### 4. Add actionable diagnosis without another model call

- Derive at most one recommendation from metrics:
  - fresh cost dominates -> stabilize/reduce the cold prompt
  - cached replay cost dominates -> reduce turns and batch communication
  - auxiliary failures/calls dominate -> disable or repair the responsible helper
  - unpriced usage exists -> configure a rate or allowance before trusting cost
- Show no recommendation when evidence is weak or unavailable.
- Include condition, consequence, and the relevant Settings or conversation destination.
- Use normal links for navigation and buttons for in-place refresh/retry.

### 5. Consolidate Settings

- Merge the current Summaries and Advisor tabs into one “Models & efficiency” tab.
- Preserve all existing backend actions and values.
- Group controls by job:
  - automatic routing
  - prompt rewriting
  - per-turn summaries
  - model and effort
- Explain which controls create an auxiliary call, alter model choice, or restart a session.
- Preserve values and focus on save failure.
- Use stable in-flow pending/success/error feedback; essential results must not exist only in a toast.

### 6. Keep Overview quiet

- Add no permanent analytics dashboard.
- Fetch or reuse metrics once when needed; do not poll or repaint the whole page for unrelated SSE events.
- Show one compact warning only for:
  - cache collapse
  - repeated auxiliary failure
  - unpriced usage
  - abnormal fresh-input growth
- Every warning names the problem and provides one owned next action.
- When no condition is actionable, render nothing.

### 7. Interaction and rendering performance

- Add an explicit Refresh action to Usage.
- Reject stale responses when navigating away or refreshing twice.
- Preserve the last valid metrics during a refresh or recoverable failure.
- Scope busy state and live announcements to the affected region.
- Avoid rerendering Usage or Settings for unrelated store events.
- Preserve scroll, focus, draft values, and selected settings through updates.
- Keep visible text and accessible names synchronized.

### 8. Tests and visible QA

- Extend existing UI suites; do not create a new suite or edit `test/run-all.js`.
- Cover populated, zero, loading, stale-data, error/retry, unpriced, unavailable-cache, unavailable-auxiliary, and long-string states.
- Cover recommendation precedence and the no-recommendation state.
- Cover Settings consolidation, persistence, failed-save recovery, accessible names, and focus.
- Keep all existing behavioral assertions intact unless the approved layout change requires a narrowly explained update.
- Run focused UI suites, then `npm.cmd test` to its terminal summary and `git diff --check`.
- If the runtime is available, inspect the real Electron interface at 320, 375, 390, 720, 721, 768, 960, and 1280 CSS pixels.
- Check keyboard traversal, drawer focus/inert behavior, 200% zoom, increased text spacing, reduced motion, dense data, long strings, and forced colors when supported.
- Source tests and screenshots alone are not an interactive Electron pass.
- If browser or Electron control is unavailable, report the exact ceiling without installing new tooling.
- Do not commit, push, merge, or alter backend files.

## Finish with

- Changed files.
- Exact focused and full-suite results.
- UI states exercised.
- Responsive/accessibility evidence obtained.
- Missing runtime or assistive-technology gates.
- Any backend contract mismatch discovered.
- A concise integration note for the functionality agent.
