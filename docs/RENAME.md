# De-theming: the decided map

**Done, 2026-10-21, on the `rename` branch: commits `dad0712`..`59944d6`**
(codemod `dad0712`, file renames `5e8bbdc`, code pass `31b85ee`, migration
`719dd08`, docs `59944d6`), cut from `functionality` at `fe9c67e`; the report
is [plans/functionality/rename.md](../plans/functionality/rename.md). This
file keeps the old -> new map because it has to name the old words; it is
excluded from the codemod (`scripts/rename/map.mjs`).

**Revised 2026-10-21 by the user** (see "2026-10-21 revision" below, which
wins over the original tables where they differ).

### As applied (where it differs from the tables below)

- `peasant` -> **`agent`** per the revision (not `member`). `class Agent` ->
  `AgentProcess`, `this.agents` -> `this.processes`, its locals -> `proc`.
- `this.summoned` -> **`this.added`**, not `this.roster`: `roster` is already
  a bus state key and an event name, so the table's choice would collide.
  The `summoned` state key and event type became `added`.
- `king` -> **`orchestrator`**, not `user`: every use in this codebase meant
  the orchestrator ("THE KING FIRST, then the briefer"), so `user` would have
  changed the meaning.
- The MCP tool `summon` -> **`add_agent`**; `wake_member` -> `wake_agent`;
  `pause_court`/`resume_court` -> `pause_team`/`resume_team`. The approval
  kind `summon` -> `add`.
- On disk the revision's names win: `.agenticos/`, `agenticos.db`,
  `agenticos.config.json`, `AGENTICOS_*`, `stateDir()`, branch prefix
  `agenticos/<name>`, commits `agenticos:` / `agenticos(<name>):`. **Migrated,
  not orphaned** (`src/legacy.js`): the "On-disk — rename, NO migration"
  section below is superseded.
- `briefer` stays `briefer` (the revision), not `planner`.

## 2026-10-21 revision (wins)

- Product and code name is **AgenticOS**, not AgentOS: class `AgenticOS`
  (`src/agenticos.js`), `.agenticos/`, `agenticos.db`,
  `agenticos.config.json`, `AGENTICOS_*` env vars, commit prefix
  `agenticos:`. On-screen name stays "Agentic OS".
- `peasant` becomes **`agent`** in code and UI, not `member`. To free the
  word, the CLI-process class `Agent` in `src/agent.js` (and its `agent` and
  `agents` variables) is renamed first, to `AgentProcess`, before peasant
  becomes agent. Existing `member` identifiers (`summon_member` and so on)
  become `agent` too.
- `briefer` **stays `briefer`**, because it briefs the orchestrator.
- **Migrate once, do not orphan.** On first launch, move `.kingdom/` to
  `.agenticos/`, `kingdom.db` to `agenticos.db` and `kingdom.config.json` to
  `agenticos.config.json`. Read old `KINGDOM_*` env vars as a fallback with a
  one-time warning. Rename the git branch prefix `kingdom/` for new branches
  only, and leave existing worktree branches alone. The migration needs a test.
- Out of scope: the GitHub repo name, git history and remote branch names.
- Everything else in the tables below stands.

Scope measured: **2115 occurrences across 111 files.** Mechanical, but large —
worth starting only with room to finish, because a half-applied rename is worse
than none.

## Words

| themed | becomes | note |
|---|---|---|
| `Kingdom` (class, `src/kingdom.js`) | `AgentOS` (`src/agentos.js`) | |
| `peasant` | `member` | **not `agent`** — `src/agent.js` has `class Agent` for the CLI process, and `kingdom.js` uses `agent`/`agents` 102 times for it. The role and the process it runs in are different things. `member` is already this codebase's own neutral word: `summon_member`, `dismiss_member`. |
| `court` | `team` | |
| `sovereign`, `king` | `user` in code, **"you"** in UI copy | |
| `crown` (incl. `CROWN` const) | `system` | CSS `--crown*` → `--system*`, `--gold-edge/wash` → `--system-edge/wash` |
| `briefer` | `planner` | |
| `summon` | `add` | `summon_member` → `add_agent`; `this.summoned` → `this.roster` (no collision; `#publishRoster` already exists) |
| `dismiss` | `remove` | `dismiss_member` → `remove_agent` |
| `throne room` | `dashboard` | |

User-facing text says **agent**; code says **member** for the role.

## On-disk — rename, NO migration (chosen)

Existing projects are orphaned. Accepted.

- `.kingdom/` → `.agentos/`
- `kingdom.db` → `agentos.db`
- `kingdom.config.json` → `agentos.config.json`
- branch prefix `kingdom/<name>` → `agent/<name>`
- commit prefixes `kingdom:` / `kingdom(<name>):` → `agentos:` / `agent(<name>):`
- 22 `KINGDOM_*` env vars → `AGENTOS_*`
- `kingdomDir()` → `stateDir()`

Orphaned by this: the playground's `csvkit`, `tocgen`, `linkcheck` — their task
boards, message history and worktrees. The git repos themselves are untouched;
only the court's own state under `.kingdom/` is stranded.

## Order

1. Words in `src/`, `ui/`, `test/` — one scripted pass, longest tokens first.
2. `node --check` every file, then the suite; fix fallout.
3. File renames (`src/kingdom.js`, `kingdom.config.json`, `docs/PLAN-court.md`).
4. Docs and prompts last — they are prose and will not break a test if wrong.

Watch for: `\bking\b` must be word-bounded (`working`, `making`), and
`this.agents` must survive untouched.
