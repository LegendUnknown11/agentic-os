# Kingdom as a product — what it would take

*Written 2026-08-16 against the working tree at `E:\AI\Agentic OS`. Every file
and line reference below was checked; nothing here is inferred from memory.*

## The short version

Kingdom today is a **single-user Electron app that drives CLI binaries you have
already installed and logged into, on your own machine, against your own disk.**
Every one of those clauses is load-bearing, and every one of them is false in a
SaaS. That is not a criticism — it is why the thing works at all — but it means
"turn this into a SaaS" is not a deployment task. Two subsystems have to be
built that do not exist: **an execution backend that does not shell out to a
logged-in CLI**, and **a control plane with accounts, tenancy and metering**.

The recommendation is to sell **the orchestration, not the compute**: host the
control plane, and let execution run on the customer's own machine or their own
cloud runner through a thin outbound-only agent. That version is reachable in
weeks rather than quarters, it sidesteps the two problems that kill solo-built
agent SaaS (custody of customer source code, and paying for inference you resell
at a loss), and it is the only version this codebase is already most of the way
toward.

## What you actually have

The parts worth building a company on:

- **Direct agent-to-agent messaging.** Members message each other over MCP
  instead of routing through an orchestrator (`src/mcp.js`, `src/bus.js`). This
  is the genuine differentiator and most competitors do not have it.
- **A turn-cost discipline nobody else ships.** Batching, the settle window,
  notice ride-along, idle sleep, observation masking, read cursors — plus, as of
  this session, correct per-turn cost accounting that separates fresh input from
  cache reads from cache writes (`src/price.js`, `src/usage.js`, `src/ctx.js`).
  Agent products routinely burn money on replayed context and cannot tell you
  so. You can. **This is the marketable wedge.**
- **Real isolation of work.** Git worktrees per member with merge and test
  discovery (`src/worktree.js`) — not a shared checkout everyone stomps on.
- **A skills/procedure system** (`skills/`, `src/skills.js`) and a memory
  substrate (`src/memory.js`, `src/vault.js`).
- **37 offline test suites.** Most agent projects at this stage have none. This
  is what makes a refactor of this size survivable.

The parts that are a personal project and must be consciously kept or cut: the
desktop pet window (`ui/pet.js`, `ui/pet-window.js`, `electron/pet-preload.cjs`),
wallpaper and music assets (`ui/assets.js`, `src/assets`), local dictation
(`src/stt.js`), the Obsidian vault as the *substrate* for memory rather than an
optional sync target, and the 105-role bench in `kingdom.config.json` — which is
a demo of range, not a product surface. None of these are wrong; they are simply
not things a buyer pays for, and each carries maintenance.

## Three products, pick one

The same codebase supports three genuinely different businesses. Choosing is the
whole plan; everything below assumes **B**.

**A — Hosted autonomous engineering** (the Devin/Factory shape). Customer
connects a GitHub repo, you run the court in your cloud. Highest ceiling and
highest cost: you take custody of customer source, run untrusted generated code
on your infrastructure, and pay for inference you must resell at a margin. It
needs container/microVM isolation, egress control, SOC2-shaped answers, and a
gross-margin model that survives a customer whose agent loops. Do not start
here.

**B — Hosted control plane, customer-side execution** ("bring your own
compute"). You host accounts, projects, the throne room, the chronicle, memory,
skills, cost analytics and team collaboration. A small runner on the customer's
machine or in their CI holds their keys and does the actual work, connecting
outbound to you. You never hold their source or their model credentials, and
inference is billed by their provider directly to them. **This is the
recommendation.** It is the shortest path from what exists, and the cost
instrumentation you already have becomes the headline feature rather than an
internal tool.

**C — Licensed desktop app plus a hosted extra.** Sell the Electron app, host
only vault sync and cost analytics. Lowest effort, lowest ceiling, and licence
enforcement on a desktop app is its own tar pit. Reasonable as a stepping stone
if you want revenue before the runner exists.

## The nine blockers, and where each one lives

### 1. Execution is `spawn()` of a CLI you are logged into — the central fact

`src/agent.js:144` and `:345` spawn `codex`, `claude` or `agy`. Authentication is
whatever those CLIs already hold: `src/agent.js:168` explicitly filters
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL` out of the child environment, precisely because the CLI's
own session is what should win.

You cannot host that. You cannot install the customer's CLI session on your
servers, and running consumer subscription CLIs on behalf of paying third
parties is not something the vendors' terms contemplate. So SaaS needs an
**API-backed backend**: a sibling of `src/agent.js` that implements the same
interface by calling the Claude Messages API (with its tool runner) and the
OpenAI Responses API directly, driving the tools already defined in
`src/mcp.js`.

The seam already exists — `src/agent.js` is written as one class per CLI behind
a common `send`/`stop`/event interface — which is the single most important
reason this refactor is feasible at all. Budget this as the largest work item
and the one that unblocks everything else, including product A later.

### 2. There is no authentication anywhere

`src/daemon.js:470` binds `127.0.0.1` and every route from `:182` to `:463` is
open. There is no user, no session, no tenant, no authorization check on
`/api/approvals`, `/api/diff`, `/api/vault` or the POST fallthrough at `:447`.
Binding to loopback *is* the security model.

### 3. One database, one repo, one process, one court

`dbPath(repo)` (`src/worktree.js:28`) is a single SQLite file per repo, and
`src/kingdom.js` holds the entire court in process memory for as long as it
runs. Multi-tenant means: tenant-scoped storage, and a court that can be
suspended and resumed from the database rather than being a process you must
keep alive. The bus is already the durable log that makes this possible.

### 4. No schema migrations

`src/bus.js:6-27` is one `create table if not exists` block executed at open
(`:47`). That is fine for a tool you can tell to delete its database. The first
time you change a column on data a paying customer cares about, it is not.
Versioned migrations are cheap now and expensive retroactively — do this early
regardless of which product you pick.

### 5. The sandbox is deliberately wide open

`AGENTS.md` records that any confining codex sandbox denies every MCP tool call,
so `danger-full-access` is the default. That is a correct local trade and an
unacceptable hosted one. Product B avoids the problem entirely by keeping
execution on the customer's side; product A cannot avoid it and must pay for
per-job microVM isolation.

### 6. Cost enforcement is per-court, not per-tenant

`#enforceBudget` in `src/kingdom.js` now works for the first time (the codex
`costUsd: 0` defect was fixed this session), but caps are currently absent from
`kingdom.config.json` by choice. In a SaaS, quotas stop being a preference and
become the thing standing between you and a customer's runaway loop. They must
be enforced server-side, per tenant, and they must fail closed.

### 7. Memory and instructions are a local Obsidian folder

`src/memory.js` and `src/vault.js` read `E:\AGIOS Kingdom\Obsidian Vault\`. For a
product this becomes a hosted store with Obsidian sync as an optional feature.
Note the on-disk vault index (938ms → 43ms) is a real optimisation worth keeping
the shape of.

### 8. Windows is assumed in 29 places

Across `src/*.js`: `LOCALAPPDATA`, `APPDATA`, `.exe` suffixes, PowerShell.
Hosted runners are Linux. This is mechanical work, but it is work, and there is
no CI catching regressions — `.github/` does not exist.

### 9. Nothing is observable from outside

No structured logs, no traces, no error reporting, no uptime signal. The
chronicle is the closest thing and it is per-court and local. You cannot operate
a service you cannot see.

## Phased plan

Each phase has a done-condition you can check, and each leaves the product
usable — no phase is a six-week branch that must land whole.

### Phase 0 — Decide and de-risk (days)

Pick the product (recommendation: B). Write down the one sentence a buyer would
repeat to a colleague. Confirm with the CLI vendors' terms what your runner may
legally do with a customer's own credentials on the customer's own machine.
**Done when:** the positioning sentence exists and the terms question is
answered.

### Phase 1 — Headless, portable, versioned core (2–3 weeks)

Nothing customer-visible; everything after depends on it.

- Split the orchestrator cleanly from Electron so `src/kingdom.js` +
  `src/daemon.js` run as a plain Node service with no desktop assumptions.
- Add versioned migrations to `src/bus.js`.
- Add authentication and a tenant scope to every route in `src/daemon.js`, even
  while it still binds loopback. Doing this before there are external callers is
  an afternoon; doing it after is a rewrite.
- Linux CI running `npm test` on every push. Fix the 29 platform-coupled sites
  as the CI finds them, not speculatively.

**Done when:** `npm test` is green on Linux in CI, and every daemon route
rejects an unauthenticated request.

### Phase 2 — The API-backed runtime (3–5 weeks, the big one)

`src/agent-api.js`: same interface as the CLI backends, implemented against the
Claude Messages API and the OpenAI Responses API, with `src/mcp.js`'s tools
bound directly rather than over a subprocess. Per-turn usage flows into the
`deltaOf`/`costOf` pipeline that already exists — and unlike the CLIs, these
APIs report usage per turn and unambiguously, so the cumulative-vs-per-turn trap
disappears for this backend.

**Done when:** a court completes a real multi-member task with no `codex`,
`claude` or `agy` binary installed anywhere, and `npm run ctx` prices it.

### Phase 3 — Control plane (3–4 weeks)

Accounts, organisations, projects, invitations. Per-tenant quotas enforced
server-side on top of the corrected cost pipeline. Billing. Structured logging
and error reporting. The throne room UI moves from "talks to my local daemon" to
"talks to an API with a session" — `ui/` is vanilla JS with no build step, which
makes this less painful than it sounds, but plan for it rather than discovering
it.

**Done when:** two separate accounts can run courts that cannot see each other,
and one of them can be cut off by hitting a quota.

### Phase 4 — The runner (2–3 weeks)

A small daemon the customer installs (`npx @kingdom/runner`, or a container in
their CI). It holds their model credentials and their checkout, opens an
outbound connection to your control plane, receives work, streams events back.
No inbound ports, no source code leaving their network.

**Done when:** a customer on a machine you have never touched runs a court from
your hosted UI, and you can prove from your side that you never received their
source.

### Phase 5 — Hosted execution (later, only if demand pulls)

Per-job container or microVM isolation, egress allowlists, ephemeral
credentials. Only start this when customers are actively asking to stop running
the runner themselves — it is where the margin risk and the compliance burden
both live.

## Pricing and who buys

The wedge is not "AI writes your code" — that market is crowded and the vendors
are in it. The wedge is **"you are burning money on replayed context and you
cannot see it."** `npm run ctx` on a real session already produces a sentence a
head of engineering would forward to their CFO. Lead with the ledger.

Under product B you are not reselling inference, so the natural shape is
**per-seat with a court-hours or turn-count allowance**, plus a free tier that
runs one court against one repo — which is also the best possible demo, because
it costs you nothing and costs the customer only their own key.

Charge more for what only you have: cross-agent messaging, the cost ledger,
shared skills and memory across a team, and audit of what every member did.

## What not to do

- **Do not port the pet window, wallpaper or music to the web** because they
  exist. Decide whether they are the brand or the personal project; if they stay,
  they stay as a deliberate identity choice, not as inertia.
- **Do not ship product A first.** Holding customer source and paying for their
  inference are the two things that turn a promising solo agent product into an
  unfundable one.
- **Do not scale the peasant bench as a feature.** 105 roles is a demo. Teams buy
  five agents that reliably finish, not a hundred that might.
- **Do not build the billing system before Phase 2.** Every metering decision
  depends on how the API-backed runtime reports usage, and guessing costs you the
  rewrite.
- **Do not remove the CLI backends.** They stay as the local/desktop path and as
  the escape hatch when a customer wants their own CLI session. The API backend
  is an addition, not a replacement.

## Decisions needed before Phase 1

1. **Which product — A, B or C?** Everything downstream branches here.
2. **Do the pet, wallpaper and music survive into the product?** This decides
   whether Phase 1 is "extract the orchestrator from Electron" or "extract the
   orchestrator and keep Electron as a first-class client."
3. **Is the Obsidian vault a customer-facing feature or your personal
   workflow?** It changes whether Phase 3 hosts documents or syncs folders.
4. **Solo build, or is there budget for help?** The phases above are sized for
   one person working steadily. Phase 2 is the one worth buying help for.
