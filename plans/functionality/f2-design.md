# f2-design — the court redesign (docs/PLAN-court.md), implemented

Thread f2-design, branch `f2-design`, cut from `origin/functionality` at
`e730bb6` on 2026-10-21. `origin/functionality` has since gained `6e67294`,
which only adds `plans/functionality/specs.md`. This branch is not rebased onto it.

## What shipped

| Commit | What it does |
|---|---|
| `e9dbca7` | Roster and config. `roles.json` and the template's `peasants` become the same 18 roles with tiers. The 90 retired roles move verbatim to `roles-library.json`. Adds `src/roster.js` (STANDING, MODE_BOUND, TIERS, ROSTER_VERSION). `test/t-roles.js` now pins the v2 contract. |
| `13c2a1a` | Migration. `planRosterMigration` is pure and lives in `src/roster.js`. `Kingdom#migrateRoster` runs on every launch. Adds the new suite `test/t-roster-migrate.js` and its fixture `test/fixtures/roster-v1.json`, which is the real 107-role v1 roster. |
| `0f72040` | Hand-coded role names and stale figures: `src/prompt.js`, `src/kingdom.js` (domains comment), `src/modes.js` self-check, `src/price.js`, three test fixtures, README. |
| `394a6ed` | Re-pins. The orchestrator prompt ceiling in `test/t-efficiency.js` goes from 11,000 to 8,500. The other pins were examined and left alone (reasons below). |
| this file | The report. |

## The roster (5 lifecycle tiers)

| Tier | Role | cli / model / effort |
|---|---|---|
| discovery | researcher | codex / gpt-5.6-luna / low |
| discovery | strategist | codex / gpt-5.6-terra / high |
| discovery | architect | codex / gpt-5.6-terra / high |
| construction | coder, refactoring-engineer, backend, dba | codex / gpt-5.6-luna / high |
| construction | frontend, designer | codex / gpt-5.6-luna / medium |
| verification | tester, reviewer, debugger | codex / gpt-5.6-luna / high |
| verification *(mode-bound)* | fact-checker | codex / gpt-5.6-luna / high |
| verification *(mode-bound)* | defendant, critic | codex / gpt-5.6-luna / medium |
| protection | auditor | codex / gpt-5.6-terra / high |
| protection | devops-engineer | codex / gpt-5.6-luna / medium |
| memory | writer | codex / gpt-5.6-luna / low |

That is 15 standing roles plus 3 mode-bound roles. Each role's tier is stored in its `tier` field.

**Descriptions versus prompts (plan Q4).** A description is a selection
trigger: when to summon the role, its scope, and a named
`not for ... (other-role)` boundary. A prompt holds the role's doctrine,
what it must not do, and how it knows it is finished. Prompts do not repeat
anything `src/prompt.js` already tells every peasant (`declare_done`,
`../<name>/`, `send_message`, `finish_task`).

`test/t-roles.js` enforces all of this:
- each named boundary role exists;
- no prompt restates its description or the shared block;
- every effort is valid for its model, and no role is on `max`;
- terra is used only by architect, auditor and strategist;
- the template's peasants equal `roles.json`.

## Old → new role map

Every v1 template role is either on the v2 bench or in `COVERED_BY`
(`src/roster.js`, mirrored as `coveredBy` in `roles-library.json`).
`test/t-roster-migrate.js` enforces that.

- **coder**: aerospace-engineer, audio-dsp-engineer, av-engineer,
  bioinformatics-specialist, cad-specialist, climate-modeler,
  compiler-engineer, embedded, game-engineer, gis-engineer,
  hardware-engineer, industrial-automation, multi-modal,
  neurotechnology-engineer, photonics-engineer, quantitative-modeler,
  quantum-engineer, robotics-engineer, scientific-computing-engineer,
  wasm-engineer
- **auditor**: ai-safety-officer, cryptographer, exploit-developer,
  hardware-security-analyst, iam-specialist, internal-auditor,
  penetration-tester, physical-security, privacy-officer, security-reviewer,
  soc-analyst, supply-chain-security, threat-intelligence-specialist
- **devops-engineer**: build-engineer, chaos-engineer, cloud-architect,
  finops-analyst, mlops, network-engineer, operator, release-manager,
  virtualization-engineer
- **writer**: community-manager, copywriter, developer-advocate,
  grant-specialist, instructional-designer, prompt-engineer,
  public-relations, seo-specialist, technical-writer
- **backend**: blockchain-engineer, data-engineer, fintech-protocol-engineer,
  integration-specialist, search-engineer, systems, video-streaming-engineer
- **researcher**: analyst, clinical-health-specialist, legal-counsel,
  materials-scientist, procurement-specialist, supply-chain-specialist,
  tax-specialist
- **frontend**: accessibility-engineer, desktop-engineer, localization,
  mobile, xr-spatial-engineer
- **designer**: brand-designer, customer-experience, motion-designer,
  sound-designer, technical-artist
- **strategist**: event-coordinator, growth-specialist, maa-strategist,
  people-operations, risk-officer
- **debugger**: forensics-specialist, incident-commander, performance,
  reverse-engineer
- **dba**: data-steward, knowledge-graph-engineer, migration-engineer
- **tester**: evaluator, synthetic-data-specialist
- **architect**: solutions-engineer

The 17 v2 names that were already in the v1 template keep their names. A
caveat on one of them: v1's `researcher` was *user* research. In v2 it is
external technical research, matching what `roles.json` and Cowork already
meant by the name.

## Migration (existing courts)

**Why it is needed.** A court's config is copied from the template once
(`defaultConfigPath`), and `rolesSeeded` is already `true`. Changing the
shipped files alone therefore changes no existing court.

**How it is recorded.** The repository's migration pattern is a once-flag. A
config-level marker is used here because the config is the thing being
migrated:
- `rosterVersion: 2` in the court's config;
- `rosterRetiring: [...]` while members are pending retirement;
- `retiredPeasants: [...]` as the archive;
- one `roster_migrated` bus event as the audit record.

**Rules (`planRosterMigration`, pure):**
- **Roles on the v2 bench.** Text is replaced only where it still matches a
  shipped fingerprint. The fingerprint is sha256-16 of title, description
  and prompt, taken from the v1 template and v1 `roles.json`. The model is
  replaced only where it is still `codex/gpt-5.6-luna/max` (or equals
  `peasantDefaults`) and the role is not on Auto. An edited prompt or a
  chosen model stays as it is.
- **Retired roles, untouched and idle.** Archived to `retiredPeasants` with
  `retiredFor`. They are never deleted.
- **Busy members** are kept on the roster and listed in `rosterRetiring`. A
  later launch retires them once they are idle. A member is busy if it:
  - is in the saved `summoned` crew,
  - owns a task that is not closed, or
  - holds a worktree, which means unmerged work.
- **Edited legacy roles and court-invented roles** are kept untouched.
- **`devops-engineer`** (new in v2, absent from the v1 template) is added
  only to a court that held a role it replaces (operator, build-engineer and
  so on). A hand-built court is left alone.
- **No resurrection.** Any other bench role a court lacks was deleted by its
  sovereign, and stays deleted.
- **Bus and vault are never touched.** Messages, events, tasks and memory
  cannot be lost by this change.
- **Failure degrades.** If the migration fails, the court keeps its old
  roster and `start()` shows a warning.

**One interaction found, and kept as designed.** `start()` already releases
any task held by a member who is not in service back to the pool, with a
notice (the existing orphan rule). As a result, a task-owning member that is
*not* summoned becomes idle after one `start()` and retires on the next
launch. The task itself is kept, unowned. The test asserts that the task
survives.

## Deviations from PLAN-court.md (the conservative option, each time)

1. **scout/scribe are named researcher/writer.** The repository renamed them
   after the plan was written, and `src/modes.js` crews Cowork with the new
   names.
2. **The bench has 18 entries, not 15.** fact-checker, defendant and critic
   are kept. Cowork's crew and its pipeline text name them; the plan predates
   that pipeline. They are labelled `MODE_BOUND`.
3. **`peasantDefaults` is left at claude/haiku/low.** The plan asked for
   luna/high. The efficiency pass set the current value after the plan, and
   every shipped role now names its own tier, so the defaults only reach
   roles added later via `propose_role`.
4. **The orchestrator and briefer models are left as is (claude/haiku).**
   The plan's terra/high and luna/low for them predate the efficiency pass.
   Changing the officers is out of scope for the 15 roles.
5. **A migration program exists after all.** The plan said "no migration
   script, one hand edit", but that assumed one machine with one tracked
   config. Today every court has its own copy under `.kingdom/`, which makes
   a hand edit unsafe for courts with work in flight.
6. **devops-engineer is added only where a predecessor existed.** An earlier
   draft added it to every v1 court, which grew the t-prompt fixture's
   orchestrator prompt by 46 bytes. That draft was rejected.
7. **The bench string stays `name (Title)` only.** The plan's §3/Q6 bench
   with descriptions was superseded by the efficiency pass, where full text
   goes through `roster(detail:true)`. This change leaves that alone.
8. **The plan's §5 "three sites" list was stale.** The prompt moved to
   `src/prompt.js`, and the orphaned-comment issue no longer exists. The
   names were re-grepped and every live reference now names a v2 role.

## Before → after (measured 2026-10-21; same script on `origin/functionality` and this branch)

| Measure | Before | After |
|---|---|---|
| Template peasants | 107 | 18 |
| `roles.json` roles | 17 (no tiers, no debugger) | 18 (tiered) |
| Model / effort spread | 107 × luna/max | 3 terra/high, 8 luna/high, 5 luna/medium, 2 luna/low |
| Peasant prompt bodies | 97,548 chars | 8,902 chars |
| Descriptions | 13,944 chars | 4,462 chars |
| Orchestrator bench (names + titles) | 3,910 chars | 545 chars |
| Orchestrator prompt, code | 10,920 B | 7,555 B |
| Orchestrator prompt, cowork | 12,612 B | 9,247 B |
| Orchestrator prompt, chat | 11,277 B | 7,912 B |
| Briefer prompt, code | 3,962 B | 3,962 B |
| `roster(detail:true)` payload | 41,226 chars | 9,451 chars |
| `tools/list`, code orch / briefer / peasant | 38 tools 15,698 B / 19 tools 7,791 B / 19 tools 7,580 B | unchanged |
| `tools/list`, cowork orch / briefer / peasant | 41 tools 16,500 B / 19 / 19 | unchanged |
| t-prompt pinned prompts | 6 | 6, bytes unchanged |
| Suites | 95 | 96 (+ t-roster-migrate) |

The code-mode peasant prompt figure (8,276 → 7,627 B) is not a like-for-like
comparison, because it is measured on the template's *first* peasant, which
changed from accessibility-engineer to researcher.

## Evidence held / not held

**Held: source evidence only.**
- Full `npm test` before each commit: 95/96 suites, and only `t-electron.js`
  fails (no display in this container).
- Flakes, each of which passed when retried alone, as the runner allows:
  `t-panels` (a run reads `blocked`, not `planning`) and `t-multi-court`.
- The `t-panels` flake also reproduces on untouched `origin/functionality`
  (1 of 6 runs alone), so this change did not cause it.
- The new assertions were shown to fail without their change:
  - the t-roles v2 block fails against the old `roles.json`;
  - t-roster-migrate fails with the `#migrateRoster` call removed;
  - the t-efficiency ceiling fails on the old template.

**Not held:**
- **Any real court run.** No provider calls were made, so there is no
  evidence of selection quality, actual cost per tier, or whether
  luna/medium is good enough for frontend or designer. The plan's own
  measurement (one short real court run per tiering, priced with
  `node src/ctx.js`) has still not been done.
- **The UI with an 18-role roster.** There is no visual or Electron
  evidence.
- **Windows.**
- **A migration against a real user's `.kingdom/` config.** Only the
  fixture copy of the v1 template was exercised.
- **The sovereign's acceptance** of the role set and texts.

## Open items

- `ui/court.js` (`cloud-architect`) and `ui/names.js` (`release-manager`)
  name retired roles, but only as self-check fixtures (search, and the
  unknown-role fallback). They were left alone because `ui/**` is out of
  scope.
- HANDOFF.md's "Key files" should gain `src/roster.js`, `roles-library.json`
  and `test/t-roster-migrate.js`, and its suite count goes from 95 to 96.
  That file belongs to the coordinator.
- `.claude/arms/court.md` could point at `src/roster.js`.
- The plan's §4 `summoned` event already exists (`kingdom.js` logs one), so
  usage evidence can be collected from now on. No usage report was built.
- `t-panels`'s `planning`/`blocked` race is pre-existing and worth its own
  fix.
