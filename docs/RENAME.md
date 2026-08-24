# De-theming: the decided map

Not started. Decided, so it does not have to be re-derived.

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
