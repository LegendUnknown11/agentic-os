// The Kingdom-era -> plain-word rename, as data. Read by scripts/rename/rename.mjs.
// rename-keep (this whole file is excluded from the rename: it has to hold the old words)
//
// docs/RENAME.md is the decided contract; its "2026-10-21 revision" wins over
// its older tables. Words that file does not map were decided here and are
// listed in plans/functionality/rename.md with the reason for each.
//
// Order matters: rules run top to bottom on every line, most specific first,
// so a compound like `kingdomDir` is settled before the bare word `kingdom`
// gets a chance at it.

/** Paths the rename never touches (tested against the repo-relative path). */
export const EXCLUDE = [
  /^node_modules\//,
  /^scripts\/rename\//,            // the codemod and this map: they must name the old words
  /^docs\/RENAME\.md$/,            // the old -> new map itself, maintained by hand
  /^test\/fixtures\/roster-v1\.json$/, // a byte-exact v1 roster: src/roster.js fingerprints it
  /^src\/legacy\.js$/,             // the one-time migration: reads the legacy names on purpose
  /^test\/t-legacy-migrate\.js$/,  // and its suite, which has to plant them
  /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico|icns|mp3|wav|ogg|zip|pdf)$/i,
];

/**
 * Lines left exactly as they are, because changing a word would make a record
 * false (a quoted rename, a historical role name). [fileRegex, lineRegex].
 * A line carrying the marker `rename-keep` is always skipped as well.
 */
export const KEEP_LINES = [
  [/^src\/roster\.js$/, /scout -> researcher and scribe -> writer/],
  [/^plans\/functionality\/f2-design\.md$/, /scout\/scribe are named researcher\/writer/],
  // Guards that the OLD vocabulary never comes back: renaming them would ban the new words.
  [/^test\/t-pages\.js$/, /must use the team vocabulary/],
  [/^test\/t-theme\.js$/, /the old gold role color must not survive/],
];

/** package-lock.json is only ever touched by these exact rules: integrity hashes and package names stay. */
export const LOCKFILE = 'package-lock.json';
export const LOCKFILE_RULES = [
  [/^(\s*)"name": "kingdom",$/, '$1"name": "agenticos",'],
];

/**
 * Phase 0, run only on the untouched tree (guard: src/agent.js still declares
 * `class Agent`). Frees the word "agent" for the role before `peasant` takes
 * it: the CLI-process class becomes AgentProcess, the process map
 * `this.agents` becomes `this.processes`, and src/kingdom.js's local `agent`
 * variables (each one holds a process) become `proc`.
 */
export const PHASE0_GUARD = { file: 'src/agent.js', has: /export class Agent extends/ };
export const PHASE0 = [
  {
    files: /^(src\/(agent|kingdom|agenticos|cli-adapters)\.js|test\/t-(tokens|agy|cli-adapters|context|opencode|agent|codex-args|claude-death|cursor|agent-guard)\.js)$/,
    rules: [[/\bAgent\b(?!\s+column)/g, 'AgentProcess']],
  },
  {
    files: /^(src|test|ui|electron)\//,
    rules: [[/\b(this|k\d*|kingdom|rk|ck|kChat|kCode)\.agents\b/g, '$1.processes']],
  },
  {
    files: /^src\/daemon\.js$/,
    rules: [[/\bkingdom\.agents\b/g, 'kingdom.processes']],
  },
  {
    files: /^src\/prompt\.js$/,
    rules: [[/`this\.agents`/g, '`this.processes`']],
  },
  {
    // Code only: a match after `//` or on a JSDoc line is prose and is left for the word pass.
    files: /^src\/(kingdom|agenticos)\.js$/,
    code: true,
    rules: [[/\.\.\.agent\b/g, '...proc'], [/(?<![.'"`\w/])agent(?![\w'"`:])/g, 'proc']],
  },
];

/**
 * Rules that apply only to some files, before the general word list. Each is
 * [regex, replacement, fileRegex].
 */
export const SCOPED = [
  // The MCP tool that asks for crew is `summon`; a bare `add` would read as add_task.
  [/^(\s*)summon: \{/, '$1add_agent: {', /^src\/mcp\/approvals\.js$/],
  [/'summon'(?=[,\]\)])/g, "'add_agent'", /^src\/modes\.js$/],
  [/\bsummon: 'summoning'/, "add_agent: 'adding'", /^ui\/status\.js$/],
  // UI copy addresses the person at the screen: "you", not "the user".
  [/'Brief the sovereign from live state'/, "'Brief you from live state'", /^ui\/graph\.js$/],
  [/`sovereign chose /, '`you chose ', /^ui\/main\.js$/],
  [/\(sender === 'sovereign' \|\| sender === 'user'\)/, "(sender === 'user')", /^ui\/thread\.js$/],
];

/** Files where `dismiss` is the ordinary UI word (close a notice), not "remove a member". */
export const DISMISS_IS_ORDINARY = /^(ui\/(feel\.js|pet\.html|notify\.js)|src\/mcp\/approvals\.js|test\/t-pages\.js|electron\/main\.js|roles-library\.json)$/;

/** Exact phrases, before the word list. [regex, replacement]. */
export const PHRASES = [
  // Prompt headings and pinned strings.
  [/STATE OF THE KINGDOM AT YOUR ACCESSION/g, 'STATE OF THE TEAM AT YOUR ONBOARDING'],
  [/PEASANT-TO-PEASANT/g, 'AGENT-TO-AGENT'],
  // The tool names. `summon` the MCP tool becomes add_agent; summon the verb becomes add.
  [/\bsummon (MCP )?tool\b/g, 'add_agent $1tool'],
  [/\bwith summon \(/g, 'with add_agent ('],
  [/cannot see `summon`/g, 'cannot see `add_agent`'],
  [/\breason summon and propose_role\b/g, 'reason add_agent and propose_role'],
  [/name: 'summon'/g, "name: 'add_agent'"],
  [/name === 'summon'/g, "name === 'add_agent'"],
  [/expose summon\b/g, 'expose add_agent'],
  [/\bsummon_member\b/g, 'add_agent'],
  [/\bdismiss_member\b/g, 'remove_agent'],
  [/\bwake_member\b/g, 'wake_agent'],
  // The budget event's scope: the whole team's spend, not one member's.
  [/scope: 'kingdom'/g, "scope: 'total'"],
  [/scope === 'kingdom'/g, "scope === 'total'"],
  [/scope, 'kingdom'\)/g, "scope, 'total')"],
  [/\bmaxKingdomUsd\b/g, 'maxTotalUsd'],
  [/#kingdomBudget\b/g, '#totalBudget'],
  [/\bkingdomCap\b/g, 'totalCap'],
  // kingdomDir() is the state directory (docs/RENAME.md).
  [/\bownKingdomDir\b/g, 'ownStateDir'],
  [/\bkingdomDir\b/g, 'stateDir'],
  // A fixture orchestrator name that was two old words at once.
  [/\bsovereign-regent\b/g, 'lead-orchestrator'],
  [/\bregentVerdict\b/g, 'leadVerdict'],
  [/\bregent\b/g, 'lead'],
  // Percent- and backslash-encoded paths in a traversal test.
  [/%2fkingdom\./g, '%2fagenticos.'],
  [/%5ckingdom\./g, '%5cagenticos.'],
  // "throne room" was the app's screen; "the throne" was the orchestrator's seat.
  [/\bthrone room\b/g, 'dashboard'],
  [/\bThrone room\b/g, 'Dashboard'],
  [/\bthrone-room\b/g, 'dashboard'],
  [/\bThe throne and the watch\b/g, 'The orchestrator and the monitor'],
  [/\bis not the throne\b/g, 'is not the orchestrator'],
  // The argument feature's panel of members.
  [/\bargument court\b/g, 'argument panel'],
  [/\bargument-court\b/g, 'argument-panel'],
  // summons, the noun.
  [/\bapproved your summons\b/g, 'approved your request to add agents'],
  [/\bsummons, but it was not completed/g, 'request to add agents, but it was not completed'],
  [/\bits summons were approved\b/g, 'its add request was approved'],
  [/\bsummons are durable history\b/g, 'adds are durable history'],
  [/\ban unsummoned peasant\b/g, 'an agent that was never added'],
  [/\bconfigured-but-unsummoned\b/g, 'configured-but-not-added'],
  [/\bunsummoned\b/g, 'not-added'],
  [/\bsummonable\b/g, 'addable'],
  // "kingdom" in prose means the whole team; as an identifier it is the AgenticOS instance.
  [/\b([Tt])he kingdom(?![.\-\w`"]| MCP)/g, '$1he team'],
  [/\b([Tt])his kingdom(?![.\-\w`"]| MCP)/g, '$1his team'],
  [/\b([Aa]) kingdom(?![.\-\w`"]| MCP)/g, '$1 team'],
  [/\b([Ee]very) kingdom(?![.\-\w`"]| MCP)/g, '$1 team'],
  [/\bkingdom-wide\b/g, 'team-wide'],
  [/\bagentic kingdom\b/g, 'agentic team'],
  // The product's name inside a sentence in a string; the identifier stays lowercase.
  [/\bno kingdom in this directory\b/gi, 'no AgenticOS team in this directory'],
  [/\bStart a kingdom here\b/g, 'Start a team here'],
  [/\bkingdom spend ceiling\b/g, 'team spend ceiling'],
  [/\brepo-relative kingdom\b/g, 'repo-relative team'],
  [/\bkingdom (tools?|up|state|folder|worktree|methods)\b/g, 'AgenticOS $1'],
  [/\bkingdoms\b/g, 'teams'],
  [/\bKingdom-level\b/g, 'AgenticOS-level'],
  [/\bKINGDOM\b(?!_)/g, 'TEAM'],
  // "accession" was a member's first turn on the team.
  [/\baccession\b/g, 'onboarding'],
  [/\bACCESSION\b/g, 'ONBOARDING'],
  [/\bAccession\b/g, 'Onboarding'],
  // "the king" in this codebase is always the orchestrator (see src/kingdom.js CROWN comment).
  [/\bking\b/g, 'orchestrator'],
  [/\bKING\b/g, 'ORCHESTRATOR'],
  [/\bKing\b/g, 'Orchestrator'],
  // scribe was renamed writer by the roster work already.
  [/\bscribe\b/g, 'writer'],
  [/\bScribe\b/g, 'Writer'],
  [/\bCourt Chronicler\b/g, 'Team Writer'],
];

/**
 * Prose-only rules: applied to the comment part of a JS line and to whole
 * Markdown lines, never to code, so `kingdom` the variable becomes
 * `agenticos` while "no kingdom tools" in a sentence reads "no AgenticOS tools".
 */
export const PROSE = [
  [/(?<![\w.\/#$`'"-])kingdom(?![\w.\/`'"(:-])/g, 'AgenticOS'],
];

/**
 * The word list: [old, new, {Cap, UPPER}]. Each pair yields three
 * case-preserving rules with identifier-aware boundaries:
 *   lower  (?<![A-Za-z])old(?![a-z])   -- `kingdomDir`, `t-court`, `KINGDOM_` ok; `courtesy`, `working` not
 *   Cap    (?<![A-Z])Old(?![a-z])      -- `isSovereignThread`, `listCourts`
 *   UPPER  (?<![A-Z])OLD(?![A-Z])      -- `KINGDOM_DB`, `CROWN`
 * Inflections are explicit pairs, listed before their stem.
 */
export const WORDS = [
  // kingdom -> AgenticOS (the product and its class)
  ['kingdom', 'agenticos', { Cap: 'AgenticOS', UPPER: 'AGENTICOS' }],
  // court -> team
  ['courts', 'teams'],
  ['court', 'team'],
  // sovereign -> user (UI copy says "you"; those strings are fixed by hand)
  ['sovereigns', 'users'],
  ['sovereign', 'user'],
  // peasant -> agent
  ['peasants', 'agents'],
  ['peasant', 'agent'],
  // crown -> system
  ['crown', 'system'],
  // summon -> add
  ['summoned', 'added'],
  ['summoning', 'adding'],
  ['summons', 'adds'],
  ['summon', 'add'],
  // dismiss -> remove (member sense; DISMISS_IS_ORDINARY files are skipped)
  ['dismissed', 'removed', { dismiss: true }],
  ['dismissing', 'removing', { dismiss: true }],
  ['dismissal', 'removal', { dismiss: true }],
  ['dismisses', 'removes', { dismiss: true }],
  ['dismiss', 'remove', { dismiss: true }],
];

/**
 * After the word pass, on changed lines only: an article that now sits before
 * a vowel. "a peasant" -> "a agent" -> "an agent".
 */
export const ARTICLES = [
  [/\b([Aa]) (agent|agents'|added|add|AgenticOS|agenticos|orchestrator|onboarding)\b/g, '$1n $2'],
];

/**
 * References to the renamed files, by name. `rename.mjs --paths-only --mv`
 * applies just these with the file moves, so the renames land as their own
 * commit with every import still resolving; the full pass includes them.
 */
export const PATH_RULES = [
  [/(?<![\w-])kingdom\.config\.json/g, 'agenticos.config.json'],
  [/(?<![\w-])kingdom\.js\b/g, 'agenticos.js'],
  [/(?<![\w-])courts\.js\b/g, 'teams.js'],
  [/(?<![\w-])court\.js\b/g, 'team.js'],
  [/(?<![\w-])courts-launch\b/g, 'teams-launch'],
  [/(?<![\w-])court-preload\b/g, 'team-preload'],
  [/\bt-accession\b/g, 't-onboarding'],
  [/\bt-courts\b/g, 't-teams'],
  [/\bt-multi-court\b/g, 't-multi-team'],
  [/\bt-summon-validation\b/g, 't-add-validation'],
  [/\bPLAN-court\b/g, 'PLAN-team'],
  [/\bPROMPT-redesign-the-court\b/g, 'PROMPT-redesign-the-team'],
  [/(?<=arms\/|\()court\.md\b/g, 'team.md'],
  // The same names inside a regex literal, dot escaped.
  [/(?<![\w-])kingdom\\\.js\b/g, 'agenticos\\.js'],
  [/(?<![\w-])courts\\\.js\b/g, 'teams\\.js'],
  [/(?<![\w-])court\\\.js\b/g, 'team\\.js'],
];

/** File and folder renames, applied with `git mv` by `rename.mjs --mv`. */
export const FILE_RENAMES = [
  ['src/kingdom.js', 'src/agenticos.js'],
  ['src/courts.js', 'src/teams.js'],
  ['kingdom.config.json', 'agenticos.config.json'],
  ['electron/courts-launch.js', 'electron/teams-launch.js'],
  ['electron/court-preload.cjs', 'electron/team-preload.cjs'],
  ['ui/court.js', 'ui/team.js'],
  ['ui/views/courts.js', 'ui/views/teams.js'],
  ['test/t-accession.js', 'test/t-onboarding.js'],
  ['test/t-courts.js', 'test/t-teams.js'],
  ['test/t-courts-launch.js', 'test/t-teams-launch.js'],
  ['test/t-multi-court.js', 'test/t-multi-team.js'],
  ['test/t-summon-validation.js', 'test/t-add-validation.js'],
  ['docs/PLAN-court.md', 'docs/PLAN-team.md'],
  ['docs/PROMPT-redesign-the-court.md', 'docs/PROMPT-redesign-the-team.md'],
  ['.claude/arms/court.md', '.claude/arms/team.md'],
];
