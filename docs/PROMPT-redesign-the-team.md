# Prompt — redesign the whole team

Paste everything below the line into a fresh agent session opened at
`E:\AI\Agentic OS`. It is self-contained: it does not assume the session that
wrote it, and every number in it was measured on 2026-08-16 rather than
estimated.

---

You are redesigning the team of AgenticOS, the multi-agent orchestrator in this
repository. Not tuning it — redesigning it. The current roster was assembled by
listing job titles, and nobody has ever checked it against the work that
actually arrives. Assume nothing in it is load-bearing until you have found the
evidence that it is.

## What the team is, mechanically

A team is defined entirely by `agenticos.config.json` at the repo root. The keys
that matter to you:

- `orchestrator` — one member. `{name, cli, model, effort, description, prompt}`.
  Currently `codex / gpt-5.6-terra / high`.
- `briefer` — one member, same shape plus `recycleAtTokens`. Currently
  `codex / gpt-5.6-luna / max`, recycled at 20,000 tokens.
- `agents` — an array of 105 entries, each
  `{name, title, description, prompt, cli, model, effort}`.
- `agentDefaults` — `{cli: "codex", model: "gpt-5.6-luna", effort: "max"}`.
  An agent that names none of its own inherits these, so the whole bench's
  model is one edit.
- `advisor`, `summarizer`, `brieferDigestAbove`, `recycleAtTokens`,
  `rolesSeeded`, `goal`, `models`, `efforts`.

`roles.json` (132KB) is the shipped standing library. `#seedRoles()` in
`src/agenticos.js:157` copies it into a team's config **once**, then sets
`rolesSeeded: true` and never looks at it again — deliberately, so a role the
user deletes stays deleted. It is already seeded here, so `roles.json` is
dead at runtime and is now a second copy that will drift. Decide what happens
to it; do not assume it must be kept in sync.

The orchestrator's system prompt is built in `#promptFor()`, `src/agenticos.js:1043`. Two
things there are derived from the roster and are what make its size a live cost:

- a names line — every agent name, comma-separated: **1,748 characters**
- the bench — `name (Title) — description` per agent:
  **17,597 characters, roughly 4,400 tokens**

Both are written into the orchestrator's prompt on every spawn, and both sit in the
cached prefix afterwards.

## What is actually there right now (measured, 2026-08-16)

- **105 agents**, and **all 105 are `codex / gpt-5.6-luna / effort: max`.**
  There is no tiering at all: `photonics-engineer`, `tax-specialist`, `debugger`
  and `coder` are the same machine at the same reasoning effort.
- Agent system prompts total **96,624 characters** — median 994, max 1,103.
  They are near-uniform in length, which is a strong hint they were generated
  from a template rather than written for a job.
- The roster reads as a directory of professions, not a team:
  `accessibility-engineer, aerospace-engineer, ai-safety-officer, prompt-engineer,
  analyst, architect, audio-dsp-engineer, auditor, av-engineer, backend,
  bioinformatics-specialist, blockchain-engineer, brand-designer, cad-specialist,
  chaos-engineer, climate-modeler, clinical-health-specialist, cloud-architect,
  coder, community-manager, compiler-engineer, copywriter, legal-counsel,
  cryptographer, customer-experience, data-engineer, dba, designer,
  desktop-engineer, embedded, evaluator, developer-advocate, event-coordinator,
  exploit-developer, fintech-protocol-engineer, forensics-specialist, frontend,
  game-engineer, gis-engineer, grant-specialist, growth-specialist,
  hardware-engineer, hardware-security-analyst, release-manager, iam-specialist,
  incident-commander, industrial-automation, instructional-designer,
  integration-specialist, internal-auditor, knowledge-graph-engineer,
  localization, maa-strategist, refactoring-engineer, materials-scientist, migration-engineer,
  mlops, mobile, motion-designer, multi-modal, network-engineer,
  neurotechnology-engineer, operator, penetration-tester, people-operations,
  performance, photonics-engineer, physical-security, debugger, privacy-officer,
  procurement-specialist, public-relations, quantitative-modeler,
  quantum-engineer, build-engineer, researcher, reverse-engineer, reviewer,
  risk-officer, robotics-engineer, scientific-computing-engineer, scout, writer,
  search-engineer, devops-engineer, seo-specialist, soc-analyst, solutions-engineer,
  sound-designer, data-steward, strategist, supply-chain-security,
  supply-chain-specialist, synthetic-data-specialist, systems, tax-specialist,
  technical-artist, technical-writer, tester, threat-intelligence-specialist,
  finops-analyst, video-streaming-engineer, virtualization-engineer, wasm-engineer,
  xr-spatial-engineer`
- **The team has almost never run.** `E:\AI\.kingdom\Agentic OS\kingdom.db` has
  0 messages and 0 events. `E:\AI\.kingdom\Sant Dnyaneshwar\kingdom.db` has 3
  orchestrator turns, 3 messages (all `user → orchestrator`), 49 events, and **not one
  event from any member other than the orchestrator.** So there is no usage history
  telling you which of the 105 earn their place. Say so in your report rather
  than inventing a ranking; propose how to get that evidence instead.
- `gpt-5.6-luna` is priced in `src/price.js` at $0.20 / $0.02 / $1.20 per Mtok
  (input / cached read / output). `gpt-5.6-terra` is $2 / $0.20 / $12. Those are
  the numbers to reason about model choice with.

## The questions you are being asked to answer

1. **How many members should there be, and why that number?** Argue it from
   something — the cost of the orchestrator's bench in its prompt, the quality of crew
   selection, what the user actually builds — not from taste. If the answer
   is "fewer, and here is which", name them. If the answer is "105 is fine
   because the bench is cached and selection quality dominates", make that case
   with the arithmetic; that position has been taken before in
   `docs/PLAN-saas.md`'s predecessor and was never tested.
2. **What is the axis the team is organised on?** Today it is *profession*.
   Candidate alternatives: stage of work (understand → design → build → verify →
   ship), risk (things that can lose data vs. things that cannot), or a small
   core plus an on-demand library the orchestrator can propose into with the existing
   `propose_role` MCP tool (`src/mcp.js:572`). Pick one and defend it.
3. **What should be tiered, and how?** One model and one effort for 105 roles
   cannot be right in both directions: `effort: max` on a copywriter is waste,
   and `gpt-5.6-luna` on an architect may be false economy. Propose per-role
   `cli` / `model` / `effort`, priced.
4. **What does a member's `prompt` need to say that its `description` does
   not?** The descriptions are what the orchestrator selects on; the prompts are what
   the member becomes. Today they are the same sentence twice. Rewrite the shape
   of both — one exemplar of each, fully written, is worth more than 105
   templated ones.
5. **What happens to `roles.json`?** Delete it, regenerate it from the new
   design, or keep it as the shipped default for new teams while this
   agenticos's config diverges.
6. **What should the orchestrator's prompt contain instead of 17,597 characters of
   bench?** If the bench shrinks, this solves itself. If it does not, consider
   whether the orchestrator should see titles only and fetch a description on demand —
   and check whether that is worse for selection before proposing it.

## How to work

Read before you design. At minimum: `AGENTS.md` (its four rules govern this
change), `src/agenticos.js` `#promptFor` and `#seedRoles`, `src/mcp.js` (what
tools each role can even see — an agent cannot add, only the orchestrator can),
`src/price.js`, `ui/team.js` (the UI now distinguishes *added* members from
the *addable* roster; a redesign that assumes one list is out of date), and
`docs/PLAN-saas.md` if a product shape matters to your answer.

Four rules from `AGENTS.md` apply to you specifically:

1. **Tests ship with the change**, and must fail without it. `test/t-roles.js`
   owns the roster.
2. **Never trust a measurement you did not take.** Every count and every price
   above is measured; if you carry it forward, re-measure it. If you invent a
   number, say it is invented.
3. **Comments carry the evidence, not the intent.**
4. **Degrade, never wedge.**

Two constraints that are not yours to relax:

- **`agenticos.config.json` is written back to disk by the running orchestrator
  and is not gitignored. Never put a token, key, or secret in it.**
- It already carries roughly 1,860 lines of uncommitted changes that predate
  this work. Do not fold them into your commit without asking.

## What to deliver

A written proposal first — `docs/PLAN-team.md` — with the new roster in full,
the reasoning for the shape, the per-role model/effort table with costs, and
the migration (this team is already `rolesSeeded`, so changing `roles.json`
alone changes nothing here). **Do not edit `agenticos.config.json` until the
user has read the plan and said go.** Deleting a role deletes it
permanently, and there is no undo path.

Where you cannot get evidence — and for the "which roles are actually used"
question you cannot, because the team has barely run — say so plainly and
propose the instrumentation that would answer it, rather than ranking 105 roles
on vibes.
