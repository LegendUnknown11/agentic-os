# Luna Prompt — Functionality, Models, MCP, Cache, and Tokens

You are the functionality owner for an Agentic OS optimization pass.

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

Reduce model-call, token, prompt-cache, and MCP overhead without weakening correctness, recovery, security, or revision-bound verification.

## Your ownership

- `src/**`
- `agenticos.config.json` only if an essential repository default must change
- `test/t-efficiency.js`
- `test/t-advisor.js`
- `test/t-summarize.js`
- `test/t-prompt.js`
- `test/t-tool-surface.js`
- `test/t-panels.js`
- `test/run-all.js`

Do not edit:

- `ui/**`
- `test/t-pages.js`
- `test/t-theme.js`
- `test/t-store.js`
- `PLAN.md`, `HANDOFF.md`, `CLAUDE.md`, or `AGENTS.md`

The UI agent is working separately against the API contract below. Keep it stable.

## Verified starting evidence

The following evidence is from 2026-09-10; refresh it before editing:

- `main` was clean at `e4005f3` and synchronized with `origin/main`.
- `npm.cmd test` passed 70 suites, 4-wide, in 84.7 seconds.
- Recorded workload: 61 turns, 2.82M input tokens, 75% cache reuse, and 30.5K output tokens.
- Fresh input represented roughly 68% of calculated token cost.
- Repository-default Code orchestrator prompt: 26,945 characters.
- Unfiltered orchestrator-role MCP definitions: 19,550 characters.
- The repository defines 107 specialist workers and 47 MCP tools.

## Plan

### 1. Establish the control

- Recheck Git status and preserve all user-owned changes.
- Run the current focused usage, prompt, advisor, summarizer, MCP, and metrics checks.
- Record prompt sizes and serialized `tools/list` sizes for every actual mode/role surface.
- Treat historical runtime metrics as evidence, not as a reproducible benchmark.

### 2. Make every model call measurable

- Extend the existing shared usage normalization. Do not create a parallel metrics framework.
- Add an optional telemetry callback to the one-shot model-call path.
- Capture purpose, CLI, model, effort, elapsed time, success/failure, reported usage, normalized cache reads/writes, output tokens, and cost classification.
- Persist compact `aux_call` events for prompt engineering, automatic model selection, summaries, and argument calls.
- Persist no prompts, responses, credentials, tool results, or file contents.
- Unsupported provider usage remains `null`/unavailable rather than estimated.

### 3. Freeze this additive `GET /api/metrics` contract

- Preserve all current response fields.
- Add:
  - `total.fresh`
  - `total.cached`
  - `total.written`
  - `total.cacheRate`
  - `cost.{fresh,cached,written,output,total,classification}`
  - `auxiliary.{calls,failures,input,cached,written,output,latencyMs,byPurpose}`
  - `mcp.{maskedCalls,maskedChars}`
- Add these member fields:
  - `cli`
  - `model`
  - `effort`
  - `fresh`
  - `written`
  - `cacheRate`
  - `costClassification`
- Define:
  - `fresh = max(0, input - cached - written)`
  - `cacheRate = input > 0 ? cached / input : null`
- `latencyMs` must contain `p50` and `p95` when samples exist.
- Cost classifications are `cli-reported`, `estimated`, `mixed`, `unpriced`, or `unavailable`.

### 4. Remove avoidable model calls

- Keep user-pinned model choices unchanged.
- Automatic routing remains opt-in and affects only workers marked `auto`.
- The selector performs no model call when there are no automatic workers.
- When exactly one allowed model exists, select it deterministically without asking another model.
- Build routing price context from the configured rate table instead of hard-coded dollar claims.
- Add a deterministic summary fast path. If the final agent text is already an accurate, clean sentence within the configured limit, use it directly.
- Continue using the summary model for long, multi-part, ambiguous, or unsuitable turns.
- Preserve existing failure degradation and concurrency limits.

### 5. Reduce prompt and cache-write cost

- Keep all 107 specialists discoverable.
- In the system prompt, list each specialist by name and title rather than embedding every full description.
- Keep full descriptions available through `roster`.
- Preserve doctrine, goal, memory index, skills index, mode rules, and stable prefix ordering.
- Keep dynamic goal, handover, and orientation content at the end.
- Repository-default Code orchestrator prompt must be at most 19,000 characters.
- Continue pinning prompt bytes in `t-prompt.js`.

### 6. Optimize MCP without replacing it

- Preserve all 47 tool names, role/mode enforcement, mutation semantics, and existing required arguments.
- Extend `roster` with optional:
  - `query: string`
  - `activeOnly: boolean`
  - `detail: boolean`
  - `limit: number`
- With no arguments, `roster` returns every member as compact `{name, role, title, awake, added}`.
- A query returns at most 20 matches by default.
- `detail:true` additionally returns description, CLI, model, effort, and auto state.
- Compress verbose descriptions and property help while retaining constraints and recovery instructions.
- Reduce every actual mode/role `tools/list` payload by at least 15% from the refreshed control.
- Keep incremental reads and existing payload bounds.
- Add bounds only to verified unbounded read operations. Never truncate mutation outcomes, errors, blockers, or recovery instructions.
- Count calls and characters saved by duplicate observation masking without storing masked content.
- Keep the current stdio MCP transport and existing SDK. Add no dependency or network daemon.

### 7. Verification

- Add one focused `t-efficiency.js` suite and register it in `test/run-all.js`.
- Ensure tests cover usage arithmetic, provider field variants, telemetry privacy, deterministic routing, summary fast path, prompt budget, roster filtering, tool-surface budgets, and masking counters.
- All 107 specialists must remain discoverable.
- All 47 MCP names and access gates must remain intact.
- Run focused tests, then `npm.cmd test` to its terminal summary, followed by `git diff --check`.
- Do not run quota-consuming or paid-provider probes without separate authorization.
- Do not commit, push, merge, or edit external configuration under `C:\Users\mayur`.

## Finish with

- Changed files.
- Exact tests and terminal results.
- Prompt and MCP sizes before and after.
- Model calls eliminated in fixtures.
- API contract delivered.
- Any unverified subscription-provider or live-runtime gates.
- A concise integration note for the UI agent.
