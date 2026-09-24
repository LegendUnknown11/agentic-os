// The kingdom: orchestrator (decides), briefer (watches everything, briefs the orchestrator),
// peasants (do the work in isolated worktrees).
//
// The briefer exists so the orchestrator's context survives a long session. The orchestrator
// never drinks the firehose; it reads briefings.
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Agent, MUTES_KINGDOM_TOOLS } from './agent.js';
import { brainBlock, brainFingerprint, remember } from './memory.js';
import { skillsBlock, expandSkillCommand, listSkills } from './skills.js';
import { engineerPrompt, outputEvidence, pickModels } from './advisor.js';
import { summarize, settingsOf as summarizerSettings } from './summarize.js';
import { Bus } from './bus.js';
import { inputTokens, deltaOf, totalsOf, hasUsage } from './usage.js';
import { costOf, tableFrom } from './price.js';
import { forecast as forecastOf } from './forecast.js';
import { readApproval, badRole, badSummon } from './approval.js';
import { parseWindow, autoWindow, fmtTokens } from './compact.js';
import { ripeness, checkTiming } from './ripeness.js';
import { argue, pickPanel, verdictNote } from './argue.js';
import { modeOf, modeName, modeBlock, canSummon } from './modes.js';
import { buildPrompt } from './prompt.js';
import {
  assertRepo, ensureRepo, behindBase, commitAll, createWorktree, dbPath, diffOf, statOf, kingdomDir,
  globalTokenStore, mergeWorktree, removeWorktree, pushBase, runTests, testCommand, worktreePath,
  revisionOf, createRunWorktree, mergeIntoRun, mergeRunBranch, runWorktreePath,
} from './worktree.js';
import { mirrorToProject, noteWritten } from './vault.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PATH = join(HERE, 'mcp.js');
const POLL_MS = 300;

// Who the CROWN speaks as when it tells a member something itself — an approval
// landed, a merge failed, a member is confined. Not a role and not a member: a
// member name, because every sender is one, but one nobody can ever be.
//
// It has to be distinct because bus.pending() drops rows where sender = the
// reader, which is right — a member must not be handed its own outbound
// messages back as if they were mail. These notices used to be posted as
// `bus.post(CROWN, this.config.orchestrator.name, ...)`: the ROLE as
// sender, the NAME as recipient. The shipped default name IS "orchestrator", so
// in the out-of-the-box configuration all nineteen of them were posted by the
// king to the king and swallowed by that guard before delivery.
//
// Watched live: a summon was approved, five peasants woke in their worktrees,
// "The sovereign approved your summons ... Assign their work." was written to
// the bus as message #3 — and the orchestrator sat idle, because it never
// arrived. The court stalls after every approved summon and the log shows the
// notice sitting there, sent.
export const CROWN = 'crown';
// Every delivered message costs the recipient a FULL context replay, so the
// cost of a session is driven by TURN COUNT, not message size. These three
// constants exist to collapse many messages into few turns.
// This is the BACKSTOP for a member that will not go idle, not a second
// window. It MUST stay comfortably above settleMs(): the ripeness test is
// `(idle && quiet for settleMs) || older than BATCH_MAX_WAIT_MS`, so a cap
// below the window silently clamps it — raising the window would do nothing
// and nothing would report the conflict. `settleFloor` below pins the gap.
export const BATCH_MAX_WAIT_MS = 180_000;  // hold a batch this long waiting for idle
// Pure FYI never wakes an agent on its own. Deliberately EQUAL to the backstop
// above: a held notice then never extends the tail beyond what an ordinary
// batch already costs, so routing something through `notice` is free in
// latency terms rather than a hidden delay. Swept against the real log at
// 60/120/180/300/600/900s — past 180s it saves at most 3 more turns while the
// worst wait tracks the hold all the way to 15 minutes. If BATCH_MAX_WAIT_MS
// is ever lowered, lower this with it or notices become the tail.
export const NOTICE_HOLD_MS = 180_000;
// A handover note goes into the successor's system prompt and stays there for
// that session's whole life, so it is charged on every turn the successor takes.
// 6000 chars is ~1500 tokens — generous for "facts and decisions, not
// narrative", and 7.5% of the briefer's 20k window rather than the 25% an
// uncapped monologue was taking.
export const HANDOVER_CAP = 6_000;
// Concurrent summariser children. Two, because a summary is a caption on a
// panel and the court's own work is what the CPU is for.
const SUMMARY_CONCURRENCY = 2;
// The event log grows for the whole session — a day-long run accumulates tens
// of thousands of tool events — and prune() only ever ran at startup.
const PRUNE_EVERY_MS = 5 * 60_000;
// A spawn that fails for a reason a retry cannot change — no such CLI on PATH,
// a repo whose worktree will not create — was retried on every 300ms tick, for
// the life of the session, each attempt several git subprocesses and one more
// error at the throne room. Back off to a minute and stay there.
const SPAWN_BACKOFF_MAX_MS = 60_000;
// Even an idle member is worth a pause: two messages seconds apart would
// otherwise cost two full context replays instead of one. Measured on a real
// run, the orchestrator took six separate 70k-context turns inside 2.5 minutes because
// each peasant reply landed just after the previous batch was acked — 420k
// tokens where one turn would have done. 4s was far too eager; the cost of
// waiting is latency, the cost of not waiting is a whole replay.
//
// 90s, and both numbers come from a search rather than a guess. Run
// `npm run replay -- <repo> <settleMs> <backstopMs>` to reproduce: it replays a
// real message log through THIS ripeness rule and reports turns saved against
// the waiting it costs.
//
// Against 272 real messages, versus the old 15s/45s:
//
//     settle  backstop   turns saved   mean wait   worst wait
//        45s      150s     16 ( 7.6%)         49s         180s
//        60s      180s     27 (12.8%)         62s         180s
//     >  90s      180s     41 (19.4%)         82s         180s
//        90s      240s     44 (20.9%)         90s         240s
//
// 90s/180s is picked because it is 2.6x the saving of 45s for an IDENTICAL
// worst case — the backstop, not the window, sets the tail. Widening the
// backstop to 240s buys three more turns for another minute of tail: declined.
// Past 90s the marginal return halves (8.5 turns per extra 15s up to 90s, 4.0
// beyond it), so this is the knee and not an arbitrary stopping point.
//
// Two earlier numbers here were wrong and are worth remembering: 15s was far
// too narrow (member-to-orchestrator gaps are p25 10.4s, median 40.6s), and the "a
// third of turns" figure that first justified widening came from clustering
// timestamps, which overstates by ~4x because it ignores that the sovereign
// bypasses the window entirely and a busy member's queue already drains as one
// batch.
//
// The sovereign is exempt (see `urgent` below), so no human ever waits for
// this; only agents talking to each other do.
// Read lazily, not at import: it must be tunable at runtime (and by tests).
export const settleMs = () => Number(process.env.KINGDOM_SETTLE_MS ?? 90_000);
// Models that take no effort flag at all (per the sovereign's Model Guidance).
const NO_EFFORT_MODELS = ['haiku'];
// A member awake but unaddressed still holds context you will pay to replay.
// Sleeping is free and revival is transparent, so sleep early.
const IDLE_SLEEP_MS = Number(process.env.KINGDOM_IDLE_SLEEP_MS ?? 300_000); // 0 disables
const DIGEST_DIFF_LIMIT = 12_000; // the briefer is cheap, but this is per-done
// #41: "the orchestrator is draining my usage like crazy" / "it kept going" —
// the existing dollar ceilings (maxKingdomUsd, maxBudgetUsd) ship OFF by
// default and only fire once a model IS priced, so an unpriced or
// misconfigured court had no ceiling of any kind until real money had
// already gone. A turn budget counts turns directly, needs no price table,
// and — unlike the dollar caps above — ships ON by default: 500 real turns
// is deliberately generous (a normal working session is a small fraction of
// that) so it interrupts a genuine runaway before it interrupts real work,
// not the other way round. `turnBudget: 0` in kingdom.config.json turns it
// off, the same convention as every cap above it.
const DEFAULT_TURN_BUDGET = 500;
// The pause reason #enforceTurnBudget writes; start() reads it back to tell a
// budget pause from a manual one.
const TURN_BUDGET_PAUSE = /-turn budget for this session was reached/;

export class Kingdom extends EventEmitter {
  constructor(repo, configPath) {
    super();
    this.repo = repo;
    this.configPath = configPath;
    // This runs before any handler exists, so a throw here is not an error the
    // court reports — it is a court that does not come up at all. #persistConfig
    // writes atomically now, but a file truncated by an OLDER build, or edited
    // by hand, must still be survivable: fall back to the shipped template and
    // keep the broken file for the sovereign to look at.
    try {
      this.config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      const template = join(HERE, '..', 'kingdom.config.json');
      this.config = JSON.parse(readFileSync(template, 'utf8'));
      this.configBroken = `${configPath} could not be read (${e.message}); `
        + 'started from the shipped defaults instead. Your roster, goal and model '
        + 'choices are in that file if it can be repaired.';
      try { renameSync(configPath, `${configPath}.broken`); } catch { /* nothing to keep */ }
    }
    this.#seedRoles();
    // Fixed for the instance's life, like this.bus below — attachRepo() mutates
    // this.repo afterward, but the Bus (and every member's KINGDOM_DB) must keep
    // pointing at whatever db the daemon actually opened, not wherever repo
    // later points.
    this.dbPath = dbPath(repo);
    this.bus = new Bus(this.dbPath);
    this.agents = new Map(); // name -> Agent (awake, has a live process)
    this.summoned = new Set(); // members in service; may be idle-slept and revived
    this.paused = false; // true: the tick loop still runs control/approvals, nobody gets a new turn
    this.lastActive = new Map(); // name -> ts, for idle sleep
    this.approvals = new Map(); // id -> payload
    this.turnBuf = new Map();   // name -> events of the turn in flight, for the summariser
    this.lastBatch = new Map(); // name -> {from,to}, so a dead turn can be redelivered
    this.turnsSinceSpawn = new Map(); // name -> turns, so nobody recycles on turn one
    this.lastUsage = new Map(); // name -> last usage totals; codex reports cumulatively
    this.spawning = new Map(); // name -> in-flight spawn promise, so nobody spawns twice
    this.activeConversation = new Map(); // name -> conversation id currently live for that member
    this.base = null;
    this.timer = null;
  }

  /** Which conversation a member is currently in — bus-backed so a restart resumes the same one. */
  #activeConv(name) {
    const cached = this.activeConversation.get(name);
    if (cached) return cached;
    const saved = this.bus.get(`activeConversation:${name}`) || 'default';
    this.activeConversation.set(name, saved);
    return saved;
  }

  #setActiveConv(name, conversationId) {
    this.activeConversation.set(name, conversationId);
    this.bus.set(`activeConversation:${name}`, conversationId);
  }

  /**
   * Copy the standing court (roles.json) into this kingdom's config, ONCE.
   *
   * A seed, not a live merge: after this the config is the single source of
   * truth, so a role the sovereign edits stays edited and a role they delete
   * stays deleted. Without the marker, deleting a role would silently
   * resurrect it on the next launch.
   */
  #seedRoles() {
    if (this.config.rolesSeeded) return;
    let library = [];
    try {
      library = JSON.parse(readFileSync(join(HERE, '..', 'roles.json'), 'utf8')).peasants ?? [];
    } catch {
      return; // no library shipped; the config stands on its own
    }
    const defaults = this.config.peasantDefaults ?? {};
    const have = new Set((this.config.peasants ?? []).map((p) => p.name));
    this.config.peasants = [
      ...(this.config.peasants ?? []),
      // cli/model/effort come from peasantDefaults unless the role names its own,
      // so the sovereign sets the whole court's model in one place.
      ...library.filter((r) => !have.has(r.name)).map((r) => ({ ...defaults, ...r })),
    ];
    this.config.rolesSeeded = true;
    this.#persistConfig();
  }

  roleOf(name) {
    return name === this.config.orchestrator.name ? 'orchestrator'
      : name === this.config.briefer.name ? 'briefer'
      : 'peasant';
  }

  /** Every member spec: the two officers first, then the peasants. */
  #members() {
    return [this.config.orchestrator, this.config.briefer, ...this.config.peasants];
  }

  specOf(name) {
    if (name === this.config.orchestrator.name) return this.config.orchestrator;
    if (name === this.config.briefer.name) return this.config.briefer;
    return this.config.peasants.find((p) => p.name === name);
  }

  #turnEndCache = { mark: -1, rows: [] };

  #turnEndRows() {
    const mark = this.bus.lastEventId();
    if (this.#turnEndCache.mark !== mark) {
      this.#turnEndCache = {
        mark,
        rows: this.bus.events({ limit: 100_000, type: 'turn_end' }),
      };
    }
    return this.#turnEndCache.rows;
  }

  /**
   * What a proposed crew has cost per turn, for the summon approval card.
   *
   * MEMOISED ON THE LOG'S HIGH-WATER MARK, because the surface that calls it
   * is polled: /api/approvals is re-fetched every few seconds while the panel
   * is open, and events() JSON.parses every row it returns. That is the exact
   * trap metrics() documents — it was pulling all 20,000 retained events just
   * to keep the turn_ends — so the mark is checked with lastEventId(), an
   * O(1) primary-key probe, and the log is re-read only when it has actually
   * moved. A court mid-turn invalidates on its own; an idle court computes
   * once and answers from cache for as long as the sovereign reads the card.
   */
  forecast(names) {
    return forecastOf(this.#turnEndRows(), names, {
      specOf: (n) => this.specOf(n),
      table: tableFrom(this.config),
      quotaClis: Object.keys(this.config.quotas ?? {}),
      // Small table (one row per sovereign order), so unlike #turnEndRows()
      // this needs no memoisation of its own — re-read fresh every call.
      campaigns: this.bus.campaigns(),
    });
  }

  #publishRoster() {
    if (this.stopping) return [];
    const roster = this.#members().map((s) => ({
      name: s.name,
      role: this.roleOf(s.name),
      title: s.title ?? '',
      description: s.description ?? '',
      cli: s.cli ?? 'claude',
      model: s.model ?? null,
      effort: s.effort ?? null,
      auto: s.auto === true,
      takesEffort: !NO_EFFORT_MODELS.some((m) => (s.model ?? '').includes(m)),
      awake: this.agents.has(s.name),
      // In the crew but idle-slept is NOT the same as never summoned: one wakes
      // on its next message with its memory intact, the other is not in the
      // court at all. Showing both as "asleep" made a working court look dead.
      summoned: this.summoned.has(s.name),
    }));
    this.bus.set('roster', JSON.stringify(roster));
    this.emit('roster', { roster, models: this.models(), efforts: this.efforts() });
    return roster;
  }

  /**
   * Pool of claude auth tokens, so five agents don't fight over one rate limit.
   * Sources, first non-empty wins:
   *   1. KINGDOM_CLAUDE_TOKENS  (comma-separated)
   *   2. <kingdomDir>/tokens.json      -> this repo only
   *   3. ~/.kingdom/tokens.json        -> every repo (the usual case)
   *   4. nothing — every agent just inherits the ambient environment
   *
   * tokens.json lives OUTSIDE the target repo (same place as the database), so
   * it cannot be committed by accident. Values are never logged or sent to the
   * UI; only the count is.
   */
  #loadTokens() {
    const fromEnv = (process.env.KINGDOM_CLAUDE_TOKENS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (fromEnv.length) return fromEnv;
    for (const p of [join(kingdomDir(this.repo), 'tokens.json'), globalTokenStore()]) {
      try {
        const f = (JSON.parse(readFileSync(p, 'utf8')).claude ?? []).filter(Boolean);
        if (f.length) return f;
      } catch {}
    }
    return [];
  }

  tokenCount() {
    return this.#loadTokens().length;
  }

  /**
   * Stable per member, so a resumed agent keeps the token it started on.
   * `offset` (bumped by quota failover) shifts it onto a sibling token.
   */
  authEnvFor(name) {
    const pool = this.#loadTokens();
    if (!pool.length) return null;
    const order = this.#members()
      .findIndex((s) => s.name === name);
    const offset = Number(this.bus.get(`tokenshift:${name}`) ?? 0);
    return { CLAUDE_CODE_OAUTH_TOKEN: pool[(Math.max(order, 0) + offset) % pool.length] };
  }

  /**
   * A rate-limited agent used to just stall. If the pool has a spare token,
   * move this member onto the next one and restart it — its session resumes,
   * so no work is lost. Gives up after trying every token so a globally
   * exhausted account doesn't spin.
   */
  async #failoverToken(name) {
    const pool = this.#loadTokens();
    if (pool.length < 2) return false;
    const tried = Number(this.bus.get(`tokentries:${name}`) ?? 0);
    if (tried >= pool.length - 1) return false;

    this.bus.set(`tokenshift:${name}`, String(Number(this.bus.get(`tokenshift:${name}`) ?? 0) + 1));
    this.bus.set(`tokentries:${name}`, String(tried + 1));

    if (this.agents.has(name)) {
      this.agents.get(name).stop();
      this.agents.delete(name);
      await this.#spawn(name);
    }
    this.emit('failover', { name, attempt: tried + 1, poolSize: pool.length });
    return true;
  }

  /**
   * The `/` menu: every skill's name, trigger and parts — never a body.
   *
   * Read off disk each call rather than cached, so a skill the sovereign has
   * just written in Obsidian appears in the menu without a restart. It is a
   * couple of dozen small files; caching it would be work to save nothing.
   */
  skills() {
    return listSkills(this.config.vault, this.config.vaultWriteDir ?? 'Kingdom')
      .map(({ name, description, combo, source }) => ({ name, description, combo, source }));
  }

  /**
   * Which members make up a domain, so a whole side of the stack can be moved
   * onto one model in a single choice ("GPT on the frontend, Claude on the
   * backend") instead of setting six dropdowns by hand.
   *
   * Overridable per kingdom with `"domains"` in the config. Cross-cutting roles
   * — tester, reviewer, refactoring-engineer, debugger, researcher, writer — are in NEITHER by
   * default: they follow the work rather than a layer, and sweeping them with a
   * layer choice is how a reviewer ends up on a model nobody chose for it.
   * A member listed in both domains simply takes whichever was applied last.
   */
  domains() {
    return this.config.domains ?? { frontend: ['designer', 'coder', 'frontend'],
      backend: ['backend', 'dba', 'architect', 'devops-engineer'] };
  }

  /** Put every member of one domain on the same model. */
  async setDomainModel(domain, patch) {
    const names = this.domains()[domain];
    if (!names) throw new Error(`No such domain: ${domain}`);
    const applied = [];
    for (const n of names) {
      if (!this.specOf(n)) continue;   // a role the sovereign deleted
      try {
        await this.setModel(n, patch);
        applied.push(n);
      } catch { /* one bad member must not abandon the rest of the sweep */ }
    }
    this.emit('domain', { domain, applied, ...patch });
    return { domain, applied };
  }

  /** Model choices offered in the UI. Editable in kingdom.config.json. */
  models() {
    return this.config.models
      ?? { claude: ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1'], codex: [] };
  }

  /**
   * Effort choices per CLI. Different flags entirely: claude takes `--effort`,
   * codex takes a `model_reasoning_effort` config override, and they do not
   * accept the same words.
   */
  efforts() {
    return this.config.efforts
      ?? { claude: ['low', 'medium', 'high'], codex: ['low', 'medium', 'high', 'xhigh', 'max'] };
  }

  /**
   * Effort levels a SPECIFIC model accepts. codex publishes a different ladder
   * per model — luna tops out at "max", sol and terra go on to "ultra" — so a
   * single per-CLI list offers levels that the chosen model silently ignores.
   */
  effortsFor(model) {
    const e = this.efforts();
    return e.byModel?.[model] ?? e.codex ?? [];
  }

  /** The advisor's own settings, as shown and edited from the throne room. */
  advisor() {
    const a = this.config.advisor ?? {};
    return {
      cli: a.cli ?? 'codex',
      model: a.model ?? 'gpt-5.6-luna',
      effort: a.effort ?? 'max',
      promptEngineer: a.promptEngineer !== false,
      autoModel: a.autoModel !== false,
      allow: a.allow ?? [],
      guidance: a.guidance ?? null,
    };
  }

  /**
   * The ONLY writer of kingdom.config.json, and it writes atomically.
   *
   * This file is rewritten on every model change, goal edit, advisor toggle and
   * milestone tick, and it is read in the CONSTRUCTOR — before any handler
   * exists to catch a parse failure. So a kill mid-write (window close, an
   * Electron teardown racing a setModel) truncates it and every future launch
   * throws before the court can start, with no recovery but hand-editing. Same
   * shape as the approval-parse outage approval.js was written to fix.
   *
   * tmp + rename, because rename is atomic: a reader sees the old file or the
   * new one, never half of either. vault.js:writeIndex already does this.
   */
  #persistConfig() {
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.config, null, 2));
    renameSync(tmp, this.configPath);
  }

  /**
   * Write the kingdom's MCP server into a member's workspace for `agy`.
   *
   * Workspace-scoped rather than global (`~/.gemini/config/mcp_config.json`)
   * on purpose: the env carries KINGDOM_AGENT, so a global file would give
   * every member the same identity and their messages would all come from
   * whoever was configured last.
   */
  #writeAgyMcp(name, cwd, role) {
    // Identity, per member, in the member's own workspace.
    //
    // The GLOBAL config is the only one headless agy reads, so every member
    // shares one server declaration and its env cannot name any of them. What
    // saves it: the MCP server inherits the agy process's cwd, which IS the
    // member's worktree. So identity travels by directory instead of by env,
    // and mcp.js reads this file when KINGDOM_AGENT is unset.
    try {
      mkdirSync(join(cwd, '.agents'), { recursive: true });
      writeFileSync(join(cwd, '.agents', 'kingdom-id.json'), JSON.stringify({
        agent: name,
        role,
        db: this.dbPath,
        repo: this.repo,
        ...(this.config.vault
          ? { vault: this.config.vault, vaultDir: this.config.vaultWriteDir ?? 'Kingdom' }
          : {}),
      }, null, 2));
    } catch (e) {
      this.#warn(`Could not write .agents/kingdom-id.json for "${name}": ${e.message}. `
        + 'It will run without the kingdom tools.');
    }
  }

  /** What a member's MCP server is told about who and where it is. */
  #mcpEnv(name, role) {
    return {
      KINGDOM_AGENT: name,
      KINGDOM_ROLE: role,
      KINGDOM_DB: this.dbPath,
      // read_diff needs the repo, not the worktree — omitted entirely rather
      // than passed as null, so mcp.js's own cwd-derived fallback
      // (identityFromCwd) still works when no repo is attached.
      ...(this.repo ? { KINGDOM_REPO: this.repo } : {}),
      ...(this.config.vault ? {
        KINGDOM_VAULT: this.config.vault,
        KINGDOM_VAULT_DIR: this.config.vaultWriteDir ?? 'Kingdom',
      } : {}),
    };
  }

  /**
   * Write the kingdom's MCP server configuration for `opencode` into workspace.
   */
  #writeOpenCodeMcp(name, cwd, role) {
    try {
      const file = join(cwd, '.opencode.json');
      const cfg = {
        mcp: {
          kingdom: {
            type: 'local',
            command: [process.execPath, MCP_PATH],
            enabled: true,
            environment: this.#mcpEnv(name, role),
          },
        },
      };
      writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
      this.#warn(`Could not write .opencode.json for "${name}": ${e.message}.`);
    }
  }

  /**
   * Keep the kingdom's own droppings out of the sovereign's repository.
   *
   * An agy member needs `.agents/kingdom-id.json` in its cwd — that is how the
   * MCP server works out who it is talking to. For the orchestrator and briefer that
   * cwd IS the repo root, so the court leaves an untracked directory in a repo
   * it does not own, where it shows up in every `git status` and rides along
   * with anyone's `git add -A`.
   *
   * `.git/info/exclude` is the right place for it: it is per-clone, never
   * committed, and worktrees share the common dir so one write covers every
   * peasant too. Appending to a file the sovereign may also use, so it reads
   * first and only adds the line if it is missing.
   */
  #excludeAgentsDir() {
    const file = join(this.repo, '.git', 'info', 'exclude');
    try {
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { /* no exclude file yet */ }
      if (/^\.agents\/?$/m.test(text)) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file,
        `${text}${text && !text.endsWith('\n') ? '\n' : ''}`
        + `# written by the kingdom: an agy member's identity file, not project source\n.agents/\n`);
    } catch (e) {
      this.#warn(`Could not exclude .agents/ from git in ${this.repo}: ${e.message}. `
        + 'It will show up as untracked.');
    }
  }

  #usesAgy() {
    return this.#members().some((s) => (s?.cli ?? 'claude') === 'agy');
  }

  /**
   * Declare the kingdom's MCP server in agy's GLOBAL config.
   *
   * Measured on agy 1.1.10: a workspace `.agents/mcp_config.json` is IGNORED in
   * headless (`-p`) mode, and `~/.gemini/config/mcp_config.json` is honoured.
   * There is no flag and no config-dir env var, so this is the only route.
   *
   * Merged, never overwritten: this file belongs to the user's Antigravity
   * install, not to the kingdom, and it may hold servers we know nothing about.
   * Only the "kingdom" key is ours to write.
   */
  #installAgyMcp() {
    const path = join(homedir(), '.gemini', 'config', 'mcp_config.json');
    try {
      let cfg = {};
      try {
        const raw = readFileSync(path, 'utf8').trim();
        if (raw) cfg = JSON.parse(raw);
      } catch { /* absent or unreadable: start clean */ }

      cfg.mcpServers ??= {};
      cfg.mcpServers.kingdom = {
        command: process.execPath,
        args: [MCP_PATH],
        // No cwd key on purpose — omitting it is what makes the server inherit
        // the member's worktree, which is the only thing carrying identity.
        env: { KINGDOM_FROM_CWD: '1' },
      };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(cfg, null, 2));
      return true;
    } catch (e) {
      this.#warn(`Could not write agy's global MCP config (${path}): ${e.message}. `
        + 'Antigravity members will have no kingdom tools.');
      return false;
    }
  }

  /**
   * Report a non-fatal problem.
   *
   * NOT this.emit('error', ...): EventEmitter throws that at the process when
   * nothing is listening, so an advisory failure would kill the court in any
   * embedding that did not happen to attach a handler. A warning must never be
   * more destructive than the thing it is warning about.
   */
  #warn(message) {
    if (this.listenerCount('error')) this.emit('error', new Error(message));
    else console.warn(`[kingdom] ${message}`);
  }

  /** Sovereign edits the advisor: which model runs it, and what it may pick. */
  setAdvisor(patch = {}) {
    const a = { ...this.advisor(), ...patch };
    this.config.advisor = a;
    this.#persistConfig();
    this.emit('advisor', a);
    return a;
  }

  async start() {
    // Said now rather than in the constructor, which had nobody listening.
    if (this.configBroken) this.emit('failure', { name: 'orchestrator', message: this.configBroken });

    // Keep persisted state and the bus on the same public vocabulary. Old
    // Research, Build, and Automate courts become Cowork once, before anybody
    // can read the mode key through MCP.
    const savedMode = this.config.mode;
    const canonicalMode = modeName(savedMode);
    if (savedMode !== canonicalMode) {
      this.config.mode = canonicalMode;
      this.#persistConfig();
    }

    // Creates the repository if the folder is not one yet — you point the
    // kingdom at a folder, not at a checkout you prepared first. No repo at
    // all is now a valid start: Chat and Cowork don't need one, and Code
    // mode is refused (see setMode) until one is attached.
    if (this.repo) {
      this.base = await ensureRepo(this.repo, {
        onInit: (what) => this.emit('started', { init: what, dir: kingdomDir(this.repo) }),
      });
      this.bus.set('base', this.base);
    } else {
      this.base = null;
    }
    await this.#reconcileRun();
    this.bus.prune();
    // Restore the crew BEFORE the delivery loop starts. #tick only iterates
    // `summoned`, so a peasant woken before a restart would otherwise never be
    // handed its mail again — a silent stall, the worst failure mode there is.
    // They are left asleep; the first message addressed to one revives it with
    // its session intact.
    let restored = [];
    try {
      const saved = JSON.parse(this.bus.get('summoned') ?? '[]');
      restored = Array.isArray(saved) ? saved : [];
    } catch {
      this.#warn('The saved crew list is unreadable; no previous crew was restored.');
    }
    for (const n of restored) {
      if (this.specOf(n)) this.summoned.add(n);
    }
    // Survives a restart for the same reason `summoned` does: a pause is a
    // decision, and a crash or a redeploy must not silently undo it.
    this.paused = this.bus.get('paused') === '1';
    // The turn-budget baseline: `bus.get('turns')` is a LIFETIME count, kept
    // restart-safe on purpose (same reasoning as spentUsd/maxKingdomUsd — a
    // crash or a redeploy must not silently reset it). Comparing a
    // per-SESSION budget straight against that lifetime number meant any
    // court that had already taken turnBudget-or-more turns in its life
    // paused on the very first turn after upgrading to this feature, and
    // "add 100 turns" only ever bought 100 against a total that never moves.
    //
    // "Session" here means one daemon run: the baseline is re-latched to the
    // lifetime count on every start(), and any "add 100 turns" extension from
    // the previous run is dropped, so a court opened tomorrow gets its full
    // budget again. The one exception is a court that is still PAUSED FOR ITS
    // TURN BUDGET: its baseline and extension are kept, so the pause (restored
    // above like any other) still reads correctly and a crash-restart loop
    // cannot hand itself a fresh budget by bouncing while it is over the cap.
    // An unpaused crash loop can at most spend one budget per run before it
    // pauses, and that pause then survives every later restart.
    const pausedForTurns = this.paused && TURN_BUDGET_PAUSE.test(this.bus.get('pausedWhy') ?? '');
    if (this.bus.get('turnBudgetBaseline') == null || !pausedForTurns) {
      this.bus.set('turnBudgetBaseline', String(this.turnsLifetime()));
      this.bus.set('turnBudgetExtra', '0');
    }
    // Restored crew is INHERITED, not approved. It costs money the moment
    // anyone messages it — a peasant approved weeks ago woke, took a turn and
    // was billed this session without an approval card ever appearing. Say who
    // is already in service so it is a choice, not a surprise.
    const inherited = [...this.summoned].filter((n) => this.roleOf(n) === 'peasant');
    if (inherited.length) {
      this.emit('inherited', { names: inherited });
      this.bus.post(CROWN, this.config.orchestrator.name,
        `AWARENESS ONLY — TAKE NO ACTION. Still in service from a previous session: `
        + `${inherited.join(', ')}. They were approved then, not now, and they cost money the `
        + `moment anyone messages them. Do not use one unless this session's work needs it.`,
        'notice');
    }
    // agy reads only the GLOBAL mcp_config.json, so the declaration has to be
    // installed before any Antigravity member is spawned.
    if (this.#usesAgy() || this.config.advisor?.cli === 'agy' || this.config.summarizer?.cli === 'agy') {
      this.#installAgyMcp();
      if (this.repo) this.#excludeAgentsDir();
    }
    // The goal lives in the config; the bus copy is what the MCP tools read,
    // and it must be refreshed on every start or a restarted court forgets.
    this.bus.set('goal', JSON.stringify(this.goal() ?? ''));
    // Published before the first member spawns: every MCP server reads this to
    // decide which tools it may offer, and one that starts before the key
    // exists would fall back to Code and hand a Chat-mode court a summon tool.
    this.bus.set('mode', this.mode());
    this.#publishRoster();
    this.#reloadApprovals();
    await this.#spawn(this.config.orchestrator.name);
    await this.#spawn(this.config.briefer.name);

    // The court keeps two records of who is doing what — `summoned` and
    // `tasks.owner` — and boot restores only the first. A task owned by
    // somebody the restored roster does not contain is unreachable: claimTask
    // refuses a task that already has an owner, so no peasant may take it, and
    // the orchestrator reads `active` as work in hand and does not reassign.
    //
    // sleep() closes the runtime door. This is the other one, and it does not
    // go through sleep() at all: the restore loop above drops any name specOf()
    // no longer answers for, so removing or renaming a peasant in
    // kingdom.config.json between runs strands everything it had claimed, with
    // no dismissal ever happening. Same divergence, same deadlock, different
    // door.
    //
    // After the spawns, not before: #spawn is what puts the orchestrator and
    // briefer into `summoned`, so by here the set is complete and the test is
    // simply "can anybody work this" — no special cases for the crown.
    const orphans = this.bus.tasks()
      .filter((t) => t.owner && t.state !== 'done' && !this.summoned.has(t.owner));
    const orphanLoss = this.#releaseHeldTasks(orphans);
    if (orphans.length) {
      this.bus.post(CROWN, this.config.orchestrator.name,
        `AWARENESS ONLY — TAKE NO ACTION. ${orphans.map((t) => `#${t.id} (${t.title})`).join(', ')} `
        + `${orphans.length === 1 ? 'was' : 'were'} still held by somebody no longer in this court `
        + `(${[...new Set(orphans.map((t) => t.owner))].join(', ')}). `
        + `${orphans.length === 1 ? 'It is' : 'They are'} unclaimed again — nobody is working on `
        + `${orphans.length === 1 ? 'it' : 'them'}.${orphanLoss}`, 'notice');
    }

    this.timer = setInterval(() => this.#tick().catch((e) => this.emit('error', e)), POLL_MS);
    this.emit('started', { base: this.base, dir: kingdomDir(this.repo) });
  }

  /**
   * A proposal the sovereign never answered must survive an app restart.
   *
   * The read is guarded because this runs inside start(). One approval row
   * whose body was not JSON threw here, the exception escaped start(), and
   * the DAEMON NEVER CAME UP — not a degraded panel, no court at all, with no
   * way back except editing SQLite by hand. #surfaceApprovals had always
   * guarded the identical parse; this copy was missed, which is why the rule
   * now lives in one place (`readApproval`) that all three readers share.
   *
   * tail: the newest 1,000, not the oldest — retention keeps 5,000 messages,
   * and an unanswered proposal is by definition a recent one.
   */
  #reloadApprovals() {
    for (const m of this.bus.approvals()) this.#offerApproval(m);
  }

  #offerApproval(m) {
    if (this.bus.get(`resolved:${m.id}`)) return;
    const p = readApproval(m.body);
    if (!p) {
      console.warn(`kingdom: approval #${m.id} from ${m.sender} is unreadable — skipped`);
      return;
    }
    this.approvals.set(m.id, { ...p, from: m.sender });
    this.emit('approval', { id: m.id, from: m.sender, ...p });
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    // Detach BEFORE killing: a child's 'exit' fires asynchronously, and its
    // handler writes to the bus. Closing the db first made shutdown throw
    // "database is not open" every time a member was running.
    for (const a of this.agents.values()) {
      a.removeAllListeners();
      a.stop();
    }
    this.agents.clear();
    this.bus.close();
  }

  // --- spawning -------------------------------------------------------

  /**
   * Wake a member, at most once, however many callers ask at once.
   *
   * The dedupe has to live HERE rather than at the call sites. `#doSpawn`
   * awaits `createWorktree` before it ever reaches `agents.set`, so a bare
   * `agents.has` check at the top is not a lock: two callers both pass it and
   * both run `git worktree add` on the same path. That is the spawn cascade
   * this project has already had once, and it now has more ways to happen —
   * delivery no longer awaits, and an approved crew spawns in parallel.
   *
   * Returns the SAME promise to every concurrent caller, so they all get the
   * one agent and any failure reaches all of them.
   */
  #spawn(name, seedPrompt = null, conversationId = null) {
    const live = this.agents.get(name);
    if (live) return Promise.resolve(live);
    const inflight = this.spawning.get(name);
    if (inflight) return inflight;

    // The dedupe above collapses CONCURRENT attempts; nothing collapsed
    // sequential ones. A spawn that fails the same way every time — a CLI
    // missing from PATH, a repo whose worktree cannot be created — was retried
    // by the delivery loop every 300ms forever, each attempt running several
    // git subprocesses and pushing another error at the throne room. Back off
    // instead, and let the batch sit unacked as it already does.
    const failed = this.spawnFailed?.get(name);
    if (failed && Date.now() - failed.at < Math.min(SPAWN_BACKOFF_MAX_MS, 1000 * 2 ** failed.n)) {
      return Promise.resolve(null);
    }

    const p = this.#doSpawn(name, seedPrompt, conversationId)
      .then((agent) => { this.spawnFailed?.delete(name); return agent; })
      .catch((e) => {
        (this.spawnFailed ??= new Map())
          .set(name, { at: Date.now(), n: Math.min((failed?.n ?? 0) + 1, 8) });
        throw e;
      })
      .finally(() => this.spawning.delete(name));
    this.spawning.set(name, p);
    return p;
  }

  async #doSpawn(name, seedPrompt = null, conversationId = null) {
    if (this.agents.has(name)) return this.agents.get(name);
    const spec = this.specOf(name);
    if (!spec) throw new Error(`No such member of the court: ${name}`);
    const role = this.roleOf(name);

    // Every member has exactly one live session at a time, bound to whichever
    // conversation is active — switchConversation() is what changes which one
    // that is. `this.bus.createConversation` is idempotent, so a first-ever
    // spawn into 'default' (or a caller-minted id) needs no separate existence
    // check.
    const convId = conversationId || this.#activeConv(name);
    this.bus.createConversation(name, { id: convId, title: convId === 'default' ? 'Conversation' : '' });
    this.#setActiveConv(name, convId);

    // Peasants work in isolation; orchestrator and briefer observe from the repo root.
    //
    // The mode decides whether isolation applies at all. In Research and Build
    // it is doing MORE work than in Code: with merge disabled, the worktree is
    // the thing that makes "read-only against the repo" true — enforced by the
    // checkout rather than by a per-CLI sandbox flag that only codex has.
    // A worktree protects a repo, so it needs one to exist: with none attached
    // (Chat/Research/Build before Code mode ever picks one) there is nothing
    // to isolate from, and every member works directly in the workspace home.
    const inWorktree = role === 'peasant' && modeOf(this.mode()).worktrees && Boolean(this.repo);
    // opencode has no --tools flag to strip native tools the way claude does,
    // and it discovers MCP config from a fixed `.opencode.json` in its cwd —
    // so orchestrator and briefer, who otherwise share the repo root as their
    // cwd, would clobber each other's identity file on every restart (whoever
    // spawns second overwrites the first's KINGDOM_AGENT, silently handing
    // them the wrong role's toolset). Measured live: this is exactly what
    // made a real run's orchestrator lose its summon tool and fall back to
    // writing six projects directly into the repo itself, single-threaded, in
    // one turn that blew a 20-minute watchdog. A small per-officer directory
    // gives each its own `.opencode.json` with no collision; MCP tools still
    // reach the real repo via KINGDOM_REPO in that file's environment block,
    // unaffected by cwd, so nothing here changes what officers can observe.
    const officerCwd = (spec.cli ?? 'claude') === 'opencode' && role !== 'peasant'
      ? join(kingdomDir(this.repo), 'officers', name)
      : this.#cwd();
    if (officerCwd !== this.#cwd()) mkdirSync(officerCwd, { recursive: true });
    const cwd = inWorktree
      ? await createWorktree(this.repo, name, this.base)
      : officerCwd;

    // A reused branch that still holds unmerged work cannot be caught up
    // safely, so the member must be TOLD it is looking at old code rather than
    // reporting on it as if it were current. Posted to the bus rather than
    // baked into the prompt: a RESUMED member is never re-sent its prompt, and
    // that is exactly the member whose worktree is stale.
    if (inWorktree) {
      const behind = await behindBase(this.repo, name, this.base);
      if (behind) {
        this.bus.post(CROWN, name,
          `Your worktree is ${behind} commit(s) behind "${this.base}" and still holds your `
          + `own unmerged work, so the crown did not move it for you. Anything you read here `
          + `may be out of date — say so in what you report, and ask before rebasing.`,
          'notice');
        this.emit('stale', { name, behind });
      }
    }

    // `|| null`, not `??`: recycling and CLI switches blank this to '', and an
    // empty string would sail past `??=` and become a literal --session-id ''.
    // Keyed by conversation, not just member: each conversation is its own
    // CLI session, since no backend supports holding two open in one process.
    const saved = this.bus.get(`session:${name}:${convId}`) || null;

    // A RESUMED member is handed the prompt it was born with, byte for byte.
    //
    // This used to be recomputed at wake time, and brainBlock/skillsBlock/
    // goalBlock all move: one `remember` call reorders the memory index (it is
    // sorted newest-first), a Court Instructions edit, a milestone tick or a
    // touched skill file all change it. A changed system prefix is a changed
    // prefix — the whole cached context is then billed at the fresh rate, and
    // members cycle sleep->wake every 5 minutes, so this fired far more often
    // than a recycle does. Measured on a real session: new input was 28% of a
    // $101 bill while 96% of the tokens were replay.
    //
    // #refreshBrain already exists to carry a changed brain to a live member,
    // as a notice that rides along with real traffic. That is the ONE path for
    // mid-session change now, which also stops the brain arriving twice.
    const prompt = saved
      ? (this.bus.get(`prompt:${name}:${convId}`) || this.#promptFor(name, role, spec, seedPrompt, null))
      : this.#promptFor(name, role, spec, seedPrompt, this.#orientation(convId));
    if (!saved) this.bus.set(`prompt:${name}:${convId}`, prompt);

    const agent = new Agent(
      {
        ...spec,
        // The orchestrator's tools:'' enforces "delegates rather than edits" —
        // but Chat mode has no crew to delegate an uploaded file to, so with
        // no exception it can never see what the sovereign attaches. Read-only,
        // and only in Chat mode: it still cannot Bash/Write/escape its role.
        tools: role === 'orchestrator' && this.mode() === 'chat' ? 'Read' : spec.tools,
        // A fresh session (restart, recycle, CLI switch) gets the state of the
        // kingdom so it can continue rather than interrogate the sovereign.
        prompt,
        resume: Boolean(saved),
        // Per-member cap, else the kingdom-wide default. A looping peasant
        // stops costing money on its own instead of running until noticed.
        maxBudgetUsd: spec.maxBudgetUsd ?? this.config.maxBudgetUsd ?? null,
      },
      {
        cwd,
        sessionId: saved ?? null,
        // A resumed thread keeps its history, so the estimate must not restart
        // at zero — a restarted member would look freshly empty and never recycle.
        ctxSeed: saved ? Number(this.bus.get(`ctx:${name}:${convId}`) ?? 0) : 0,
        // peasants read each other's worktrees to review; everyone reaches the vault
        addDirs: [
          // No repo, no worktrees anywhere to read — and the dir was never created.
          ...(role === 'peasant' && this.repo ? [join(kingdomDir(this.repo), 'wt')] : []),
          ...(this.config.vault && existsSync(this.config.vault) ? [this.config.vault] : []),
        ],
        env: (spec.cli ?? 'claude') === 'claude' ? this.authEnvFor(name) : null,
        mcp: {
          command: process.execPath,
          args: [MCP_PATH],
          env: this.#mcpEnv(name, role),
        },
      }
    );
    // Which conversation this live process/session belongs to — read by
    // #record, recycleAgent, setModel and switchConversation so they touch
    // only the right conversation's bus keys, not every conversation the
    // member has.
    agent.conversationId = convId;

    // agy takes no MCP flags at all: it reads `.agents/mcp_config.json` from
    // the workspace. Without this file an Antigravity member has no
    // send_message and no declare_done, which is not a court member — the same
    // failure codex had for weeks, arrived at by a different route.
    if ((spec.cli ?? 'claude') === 'agy') this.#writeAgyMcp(name, cwd, role);
    else if ((spec.cli ?? 'claude') === 'opencode') this.#writeOpenCodeMcp(name, cwd, role);

    agent.on('ready', (sid) => {
      this.bus.set(`session:${name}:${convId}`, sid);
      this.emit('agent', { name, state: 'ready', sessionId: sid });
    });
    agent.on('text', (t) => this.#record(name, 'text', { text: t }));
    // The prohibition in #promptFor is the ONLY thing keeping a member out of
    // its CLI's own multi-agent system: codex 0.145.0 offers spawn_agent under
    // every feature flag there is — features.multi_agent=false and
    // features.collaboration_modes=false are both valid config and neither
    // removes it, measured by asking for the tool under each.
    //
    // A prohibition can be talked past, and the first time one was, nothing
    // here noticed. A whole four-module build ran through codex's own
    // sub-agents and codex's own todo list, in the base repository: no summon
    // card, no worktree, no test gate, no merge, one cost line for what five
    // workers did. The orchestrator then signed off with "Court work: ...
    // assigned as independent slices", believing it had used us. It was caught
    // by a human reading the raw event stream.
    //
    // So: a bypass may still happen, but it may never again be quiet. Reported,
    // not blocked — killing a turn mid-flight loses the work as well.
    agent.on('tool', (t) => {
      this.#record(name, 'tool', t);
      if (t?.name !== 'collab_tool_call') return;
      const msg = `"${name}" called its CLI's own "${t.input?.tool ?? 'collab'}" tool instead of `
        + "the kingdom's. That work runs inside its own process: unseen, unapproved, outside "
        + 'any worktree, unbilled per member, and impossible to test or merge from here.';
      this.emit('failure', { name, message: msg });
      this.bus.post(CROWN, this.config.orchestrator.name,
        `AWARENESS ONLY — TAKE NO ACTION. ${msg}`, 'notice');
    });
    agent.on('error', async (e) => {
      const msg = String(e);
      this.#record(name, 'error', { message: msg });
      this.#rewindForRetry(name, msg);
      // A session limit is not a fault — it is a wait. Surface the reset time
      // instead of reporting the member as broken.
      const reset = msg.match(/resets?\s+([^·)\n]+)/i)?.[1]?.trim();
      if (/session limit/i.test(msg)) {
        if (await this.#failoverToken(name)) return;
        this.emit('limited', { name, resetsAt: reset ?? 'unknown' });
        this.bus.post(CROWN, this.config.orchestrator.name,
          `"${name}" has hit the account's session limit${reset ? `, which resets ${reset}` : ''}. ` +
          `This is not a fault and retrying will not help. Do not wait on it.`, 'notice');
        return;
      }
      if (/usage limit|rate limit|quota|429|too many requests/i.test(msg)) {
        if (await this.#failoverToken(name)) return; // moved to a spare token; not a failure yet
      }
      this.#escalateFailure(name, msg);
    });
    agent.on('stderr', (d) => this.emit('stderr', { name, data: d }));
    agent.on('turn_end', (u) => {
      // This is the launched agent's configuration, not the config as it may
      // look after a later model change. The advisor can only compare effort
      // against the output it actually produced when the historical turn keeps
      // that snapshot beside its usage.
      const turnSpec = { ...(this.config.peasantDefaults ?? {}), ...agent.spec };
      this.#record(name, 'turn_end', {
        ...u,
        cli: turnSpec.cli ?? null,
        model: turnSpec.model ?? null,
        effort: turnSpec.effort ?? null,
      });
      this.#summarizeTurn(name);   // async, deliberately not awaited
      this.lastActive.set(name, Date.now());

      // codex reports its usage CUMULATIVELY per thread, so this must be a
      // delta or every earlier turn is counted again — the same rule ctx.js
      // and daemon.js use, now shared from usage.js rather than re-derived
      // (re-deriving it is how these three drifted apart the last two times).
      const usage = u.usage;
      const d = deltaOf(this.lastUsage.get(name), usage);
      if (hasUsage(usage)) this.lastUsage.set(name, totalsOf(usage));

      // Only claude reports total_cost_usd; codex and agy hardcode 0. That
      // left `spentUsd` frozen at 44.18 through three runs while the court
      // burned 42M tokens — and, worse, left maxBudgetUsd and maxKingdomUsd
      // permanently unable to fire on a court that is entirely codex. So when
      // the CLI will not say what a turn cost, price it from the rate card.
      // An unpriced model yields null, and null spends nothing: a cap enforced
      // against an invented price would be worse than no cap.
      // `peasantDefaults` is normally baked into each spec at seed time, but a
      // hand-added peasant may omit cli/model, and an unpriced member silently
      // opts itself out of the cap. Resolve the same way #seedRoles does.
      const def = this.config.peasantDefaults ?? {};
      const spec = { ...def, ...(this.specOf(name) ?? {}) };
      const reported = u.costReported === true
        || (u.costReported == null && Number(u.costUsd) > 0);
      const priced = reported
        ? Number(u.costUsd) || 0
        : costOf(d, spec.cli, spec.model, tableFrom(this.config));
      // price.js returns null to mean "we refuse to invent a number", and this
      // line used to turn that refusal into 0 — so an unpriced model accrued
      // nothing forever and maxBudgetUsd/maxKingdomUsd COULD NOT FIRE on it.
      // That is the same hole price.js was written to close, one layer up: the
      // agy and opencode model lists have no rate card between them, so
      // thirteen of the twenty-two selectable models spend without a cap.
      // Still 0 for the arithmetic — but said out loud, once per member.
      if (priced === null && !this.bus.get(`unpriced:${name}`)) {
        this.bus.set(`unpriced:${name}`, '1');
        this.emit('failure', { name, message:
          `"${name}" runs ${spec.cli ?? 'claude'}/${spec.model ?? 'default'}, which has no price `
          + `in the rate card. Its spend cannot be tracked, and maxBudgetUsd/maxKingdomUsd `
          + `CANNOT stop it. Add a "prices" entry for it in kingdom.config.json.` });
      }
      const cost = priced ?? 0;
      const spent = Number(this.bus.get('spentUsd') ?? 0) + cost;
      this.bus.set('spentUsd', String(spent));
      const mine = Number(this.bus.get(`spent:${name}`) ?? 0) + cost;
      this.bus.set(`spent:${name}`, String(mine));

      // Tokens are still tracked alongside: they are the honest readout for a
      // model with no published price, and they are what `/autocompact` tunes on.
      const spentTok = d.in + d.out;
      const tokens = Number(this.bus.get('tokens') ?? 0) + spentTok;
      this.bus.set('tokens', String(tokens));
      this.bus.set(`tokens:${name}`, String(Number(this.bus.get(`tokens:${name}`) ?? 0) + spentTok));

      // Fallback only: the agent measures its own context now (Agent#ctxTokens).
      const ctx = u.ctx ?? inputTokens(u.usage ?? {});
      this.bus.set(`ctx:${name}:${agent.conversationId ?? 'default'}`, String(ctx));
      this.#countTurns();
      // `turns` here is SESSION-scoped (what the turn budget is measured
      // against and what the header shows) — `lifetimeTurns` rides along
      // beside it for anything that wants the restart-safe whole-life count
      // instead (#41 follow-up: "lifetime turns available if the spend
      // display needs them").
      this.emit('spend', {
        total: spent, tokens, turns: this.turnsThisSession(), lifetimeTurns: this.turnsLifetime(),
        name, ctx, spentByAgent: mine,
      });
      this.#enforceTurnBudget();

      if (this.#enforceQuota(name)) return;

      // Any member whose context has grown expensive gets recycled — not just
      // the briefer. The orchestrator is usually the worst offender.
      //
      // But NEVER on a member's first turn. A single file-reading turn blows
      // past any threshold on its own: measured, the architect ended one turn
      // at 105,968, was recycled, and its successor ended ITS first turn at
      // 76,121 and was recycled again — two handover turns bought for three
      // productive ones, and no session ever lived long enough to be worth
      // inheriting. Requiring a second turn bounds that without depending on
      // the context estimate being well calibrated, which for codex it is not.
      const turns = (this.turnsSinceSpawn.get(name) ?? 0) + 1;
      this.turnsSinceSpawn.set(name, turns);
      if (ctx > this.#recycleThreshold(name) && turns >= 2) {
        this.recycleAgent(name).catch((e) => this.emit('error', e));
        return;
      }
      this.#enforceBudget(name, mine, spent);
    });
    agent.on('exit', (code) => {
      this.emit('agent', { name, state: 'exited', code });
      this.#publishRoster();
    });

    // A confined codex member has no send_message, no declare_done, no vault —
    // and says nothing about it. Every one of its tool calls comes back
    // "user cancelled". Never let that be discovered by watching it fail.
    if ((spec.cli ?? 'claude') === 'codex' && MUTES_KINGDOM_TOOLS.has(spec.sandbox)) {
      const msg = `"${name}" runs codex under sandbox "${spec.sandbox}", which makes codex `
        + 'DENY every kingdom tool call. It cannot message anyone, declare_done, or reach '
        + 'the vault. Remove "sandbox" from its config to restore them.';
      this.emit('failure', { name, message: msg });
      this.bus.post(CROWN, this.config.orchestrator.name,
        `AWARENESS ONLY — TAKE NO ACTION. ${msg}`, 'notice');
    }

    agent.start();
    this.#refreshBrain(name, Boolean(saved));
    this.turnsSinceSpawn.set(name, 0);
    this.agents.set(name, agent);
    this.summoned.add(name);
    this.bus.set('summoned', JSON.stringify([...this.summoned]));
    this.lastActive.set(name, Date.now());
    this.#publishRoster();
    this.emit('agent', { name, state: 'awake', role, cwd });
    return agent;
  }

  /**
   * Put a batch back in the member's inbox when its turn died without running.
   *
   * ONE retry per batch, recorded on the bus: a permanently broken CLI would
   * otherwise redeliver, fail and redeliver forever. After that the order is
   * genuinely gone and #escalateFailure says so — which is still better than
   * losing it in silence, but the retry catches the whole transient class
   * (a spawn that could not start, a turn that emitted nothing, a rate limit).
   */
  #rewindForRetry(name, message) {
    if (!/no output|could not be started|turn exceeded|session limit|usage limit|rate limit|quota|429/i
      .test(message)) return;
    const b = this.lastBatch.get(name);
    if (!b) return;
    this.lastBatch.delete(name);
    if (this.bus.get(`retried:${b.to}`)) return;
    this.bus.set(`retried:${b.to}`, '1');
    this.bus.set(`cursor:${name}`, String(b.from));
    this.#recordRecovery(name, 'transport-retry', message, { batch: b, attempt: 1 });
    this.emit('redelivered', { name, through: b.to });
  }

  /**
   * Keep a RESUMED member's brain current.
   *
   * The system prompt is only sent when a session is created. A resumed member
   * keeps the prompt it was born with, so an edit to Court Instructions or a
   * newly recorded memory would reach nobody until they happened to recycle —
   * observed: a resumed orchestrator answered from the CLI's own private memory store
   * because the court's had never been put in front of it.
   *
   * Sent as a notice, so it rides along with the member's next real message
   * instead of buying a turn of its own. A fresh session already has it in the
   * prompt, so that case only records the fingerprint.
   */
  #refreshBrain(name, resumed) {
    const dir = this.config.vaultWriteDir ?? 'Kingdom';
    const now = brainFingerprint(this.config.vault, dir);
    if (!now) return;                                  // no vault, nothing to keep current
    const key = `brain:${name}`;
    if (this.bus.get(key) === now) return;
    if (resumed) {
      const block = brainBlock(this.config.vault, dir);
      if (block.trim()) {
        this.bus.post(CROWN, name,
          `AWARENESS ONLY — TAKE NO ACTION. The sovereign's standing instructions or the `
          + `court's memory have changed since your session began. This replaces what you `
          + `were told at your accession:\n${block}`, 'notice');
        this.emit('brain', { name, refreshed: true });
      }
    }
    this.bus.set(key, now);
  }

  /**
   * A silently stalled kingdom is the worst failure mode: quota exhaustion or a
   * dead CLI looks exactly like "still thinking". Tell the orchestrator (so it can
   * re-plan) and the sovereign (so they can act), throttled so an error storm
   * cannot flood either.
   */
  #escalateFailure(name, message) {
    const now = Date.now();
    if (now - Number(this.bus.get(`failnotify:${name}`) ?? 0) < 60_000) return;
    this.bus.set(`failnotify:${name}`, String(now));
    const recovery = this.#recordRecovery(name, 'unresolved-process-failure', message);
    if (recovery && recovery.attempts >= 2) {
      this.#runBlock(recovery.run, `worker ${name} failed after recovery attempts`,
        `preserve ${name}'s worktree, reassign the task or choose another approved model, then resume`,
        { name, message: String(message).slice(0, 600) });
    }
    if (name !== this.config.orchestrator.name) {
      // A notice, not a message. This is awareness, and the orchestrator cannot act on
      // it faster than a notice arrives anyway: notices ride along with the
      // next real traffic, or buy their own turn after NOTICE_HOLD_MS. So the
      // worst case is unchanged and the common case is free — against an orchestrator
      // whose turns are 61% of the court's output and whose context reaches
      // 70k+, a full replay to be told "someone died, carry on" is not worth it.
      this.bus.post(CROWN, this.config.orchestrator.name,
        `AWARENESS: "${name}" has failed and may be unable to continue. ` +
        `Do not wait on them indefinitely. Error: ${message.slice(0, 300)}`, 'notice');
    }
    this.emit('failure', { name, message });
  }

  /**
   * A REAL ceiling, enforced by the orchestrator across restarts.
   *
   * `--max-budget-usd` alone is not one: the CLI counts per process, so every
   * restart, model change, failover and daemon relaunch resets it to zero. A
   * $5 cap let a run reach $41. This tracks cumulative spend in the bus, which
   * survives all of that, and stops the member for real.
   */
  #enforceBudget(name, spentByAgent, spentTotal) {
    const perMember = this.specOf(name)?.maxBudgetUsd ?? this.config.maxBudgetUsd ?? 0;
    const kingdomCap = this.#kingdomBudget();

    if (kingdomCap && spentTotal >= kingdomCap) {
      this.emit('budget', { scope: 'kingdom', spent: spentTotal, cap: kingdomCap });
      for (const n of [...this.agents.keys()]) this.sleep(n);
      return;
    }
    if (perMember && spentByAgent >= perMember) {
      this.emit('budget', { scope: 'member', name, spent: spentByAgent, cap: perMember });
      this.sleep(name);
      // #41 audit: every other "the crown noticed something, here is FYI"
      // post to the orchestrator in this file is tagged 'notice' — this one
      // was not, so it was eligible to buy the orchestrator a full unprompted
      // turn on its own (default kind 'message' is real traffic to
      // ripeness.js, not gated behind hadRealTurn/noticeHoldMs the way a
      // notice is) purely because a MEMBER's own spend crossed a threshold,
      // with nothing the sovereign said and nothing the orchestrator itself
      // did. It still reaches the orchestrator promptly by riding along with
      // real traffic once there is any, same as every other AWARENESS post.
      this.bus.post(CROWN, this.config.orchestrator.name,
        `AWARENESS ONLY — TAKE NO ACTION. "${name}" reached its spend ceiling ($${spentByAgent.toFixed(2)} of ` +
        `$${perMember}) and has been stopped. Do not wait on it. The sovereign ` +
        `must raise its budget or reassign the work.`, 'notice');
    }
    this.#enforceRunBudget(spentTotal);
  }

  /**
   * A per-run ceiling, beside maxBudgetUsd (per member, forever) and
   * maxKingdomUsd (the whole court, forever). A run's own baseline is
   * captured once in createRun(); this compares cumulative kingdom spend
   * against that baseline, so it survives a restart the same way the other
   * two ceilings do. Unrelated work is deliberately left alone — #runBlock is
   * the same mechanism a stuck recovery or a failed verification already
   * uses to stop THIS run while the rest of the court keeps going.
   */
  #enforceRunBudget(spentTotal) {
    const run = this.#activeRun();
    const cap = this.config.maxRunUsd ?? 0;
    if (!run?.id || !cap) return;
    const baseline = Number(this.bus.get(`run:${run.id}:baselineSpentUsd`) ?? 0);
    const spent = spentTotal - baseline;
    if (spent < cap) return;
    this.emit('budget', { scope: 'run', runId: run.id, spent, cap });
    this.#runBlock(run, `run spend ceiling reached ($${spent.toFixed(2)} of $${cap})`,
      'the sovereign must raise maxRunUsd or stop the run');
  }

  #cliOf(name) {
    const spec = { ...(this.config.peasantDefaults ?? {}), ...(this.specOf(name) ?? {}) };
    return spec.cli ?? 'claude';
  }

  #quotaFor(name) {
    const cli = this.#cliOf(name);
    const quota = this.config.quotas?.[cli];
    const cap = Number(quota?.limitTokens ?? 0);
    const names = this.#members()
      .map((s) => s.name).filter((n) => this.#cliOf(n) === cli);
    return {
      cli, label: quota?.label ?? cli, cap,
      used: names.reduce((sum, n) => sum + Number(this.bus.get(`tokens:${n}`) ?? 0), 0),
    };
  }

  /** Stops measured plan usage; a future turn is never reserved from a forecast. */
  #enforceQuota(name) {
    const quota = this.#quotaFor(name);
    if (!quota.cap || quota.used < quota.cap) return false;

    const key = `quota:${quota.cli}`;
    if (this.bus.get(key) !== String(quota.cap)) {
      this.bus.set(key, String(quota.cap));
      this.emit('budget', { scope: 'quota', ...quota });
      const message = `${quota.label} is exhausted (${quota.used.toLocaleString()} of `
        + `${quota.cap.toLocaleString()} tokens). ${quota.cli} members were stopped before another turn. `
        + 'Raise the plan limit or switch the work to a CLI with quota remaining.';
      this.emit('failure', { name, message });
      this.bus.post(CROWN, this.config.orchestrator.name, `AWARENESS: ${message}`, 'notice');
    }
    for (const n of [...this.agents.keys()]) if (this.#cliOf(n) === quota.cli) this.sleep(n);
    return true;
  }

  /** Reset a member's cumulative spend — the sovereign lifting a ceiling. */
  clearSpend(name) {
    if (name) this.bus.set(`spent:${name}`, '0');
    else {
      this.bus.set('spentUsd', '0');
      for (const m of this.#members()) {
        this.bus.set(`spent:${m.name}`, '0');
      }
    }
    this.#publishRoster();
  }

  /** Turns, not messages, are what a session costs. Worth watching. */
  #countTurns() {
    const n = Number(this.bus.get('turns') ?? 0) + 1;
    this.bus.set('turns', String(n));
    return n;
  }

  #record(name, type, payload) {
    const conversationId = this.agents.get(name)?.conversationId ?? 'default';
    this.bus.logEvent(name, type, payload, conversationId);
    // `kind`, not `type`: consumers wrap this in an envelope that has its own
    // `type`, and a collision there silently swallowed every agent event.
    this.emit('event', { name, kind: type, payload, conversationId });

    // Buffer the turn so the summariser has something to condense. Every agent
    // event passes through here, so this is the one place it can be collected
    // without threading a second listener through the spawn path.
    if (type === 'text' || type === 'tool') {
      const buf = this.turnBuf.get(name) ?? [];
      buf.push({ kind: type, payload });
      // A pathological turn must not grow without bound; the tail is what a
      // summary is about anyway.
      if (buf.length > 400) buf.splice(0, buf.length - 400);
      this.turnBuf.set(name, buf);
    }
  }

  #recordAuxCall(data) {
    const usage = data.usage ?? {};
    this.#record('aux', 'aux_call', {
      purpose: data.purpose ?? 'advisor',
      cli: data.cli ?? null,
      model: data.model ?? null,
      effort: data.effort ?? null,
      elapsedMs: Number(data.elapsedMs) || 0,
      success: Boolean(data.success),
      failure: data.failure ?? null,
      input: Number(usage.in) || 0,
      cached: Number(usage.cached) || 0,
      written: Number(usage.written) || 0,
      fresh: Number(usage.fresh) || 0,
      output: Number(usage.out) || 0,
      costUsd: data.costUsd ?? null,
      costClassification: data.costClassification ?? 'unavailable',
    });
  }

  /**
   * Condense the turn that just ended into one line.
   *
   * Fire-and-forget on purpose: it takes seconds, and nothing in the court may
   * wait on it. The raw lines are already on the stream; the summary lands
   * afterwards and the UI slots it in.
   */
  async #summarizeTurn(name) {
    const events = this.turnBuf.get(name) ?? [];
    const conversationId = this.agents.get(name)?.conversationId ?? 'default';
    this.turnBuf.set(name, []);
    const s = summarizerSettings(this.config);
    if (!s.enabled || !events.length) return;

    // Each of these spawns a whole `codex exec` child — 1-2s of process startup
    // before a token moves, holding a 90s timeout. Ten members ending turns
    // together spawned ten at once, for a one-line caption on a panel.
    //
    // DROPPED, not queued: a summary is cosmetic and a late one is worth less
    // than the process it waits on. The catch below already swallows every
    // failure, so losing one costs exactly the caption.
    if (this.summarising >= SUMMARY_CONCURRENCY) return;
    this.summarising = (this.summarising ?? 0) + 1;

    try {
      const line = await summarize(s, { name, role: this.roleOf(name), events }, {
        cwd: this.repo,
        priceTable: tableFrom(this.config),
        onTelemetry: (data) => this.#recordAuxCall(data),
      });
      if (!line) return;
      // Recorded as an event, not just emitted: a summary that vanished on
      // reload would be worth less than the raw text it replaces.
      this.bus.logEvent(name, 'summary', { text: line }, conversationId);
      this.emit('event', { name, kind: 'summary', payload: { text: line }, conversationId });
    } catch { /* cosmetic; never surfaces as a failure */ }
    finally { this.summarising--; }
  }

  /** The summariser's settings, as shown and edited from the throne room. */
  summarizer() {
    return summarizerSettings(this.config);
  }

  setSummarizer(patch = {}) {
    const s = { ...this.summarizer(), ...patch };
    this.config.summarizer = s;
    this.#persistConfig();
    this.emit('summarizer', s);
    return s;
  }

  /**
   * What shape the court is in — see src/modes.js for the table and the why.
   *
   * Persisted, because the shape you were working in yesterday is the shape you
   * expect to find today; and published two ways, because two very different
   * things need it. The SSE event drives the UI. The bus key is how every
   * member's MCP server learns it — the same channel `roster` already travels
   * on, and the only one that reaches a process the orchestrator does not own.
   */
  mode() {
    return modeName(this.config.mode);
  }

  /**
   * Change shape now.
   *
   * `queueMode` is the one that waits for idle; this is the immediate form,
   * used by the sovereign's own switch and by that deferred apply. A flip
   * deliberately does NOT rewrite anybody's system prompt: `prompt:${name}` is
   * byte-stable on purpose (see #doSpawn), and the measurement there is that
   * changing it billed 96% of a $101 session as replay. Live members are TOLD,
   * which rides along with traffic they were going to pay for anyway.
   */
  setMode(name, { why = '', by = 'sovereign' } = {}) {
    const next = modeName(name);
    const prev = this.mode();
    if (next === prev) { this.pendingMode = null; return { mode: next, changed: false }; }
    // Code is the one mode that edits the repo rather than the vault — with
    // none attached it has nothing to work on. Thrown, not returned: the
    // daemon's generic action dispatch already turns a throw into
    // {ok:false,error} over HTTP, so the toolbar can surface this directly.
    if (next === 'code' && !this.repo) {
      throw new Error('Code mode needs a repository — attach one first.');
    }
    this.pendingMode = null;

    this.config.mode = next;
    this.#persistConfig();
    this.bus.set('mode', next);

    const m = modeOf(next);
    for (const who of this.agents.keys()) {
      // A member asleep through several flips only needs the CURRENT mode —
      // superseding avoids queuing every intermediate one into its next turn.
      this.bus.supersede(who, '--- THIS COURT IS IN ');
      // modeBlock(), not a hand-rolled label+blurb: a live flip used to send
      // only those two things, dropping the crew-empty line and the pipeline
      // vocabulary (Cowork's automation syntax and fact-checker nudge) that a
      // freshly-spawned member gets baked into its prompt. Measured effect: a
      // live-flipped orchestrator without that guidance did not
      // know it owned workflow_save, delegated the request to a "coder"
      // peasant that does not exist in this mode, and needed three rounds of
      // the sovereign hand-writing the exact tool call before it worked.
      this.bus.post(CROWN, who,
        modeBlock(next).trim() + (why ? `\nWhy: ${why}` : ''),
        'notice');
    }
    this.emit('mode', { mode: next, previous: prev, pending: null, why, by });
    return { mode: next, previous: prev, changed: true };
  }

  /**
   * A real directory for one-shot subprocess calls (advisor, argue) that read
   * text but never write — they just need somewhere valid to run from. `null`
   * would reach a CLI's `-C <dir>` flag as a literal null arg and fail the
   * call outright; the workspace home is a real directory even with no repo.
   */
  #cwd() {
    return this.repo ?? kingdomDir(this.repo);
  }

  /** Is anyone mid-turn? */
  #anyBusy() {
    for (const a of this.agents.values()) if (a.busy) return true;
    return false;
  }

  /**
   * Ask for a shape change, but not mid-thought.
   *
   * A flip changes which tools exist and whether anything can ever merge. Doing
   * that to a member that is mid-turn means it began under one set of rules and
   * finishes under another — it reaches for `request_merge` because it had one
   * when it started planning, and gets a refusal for a decision it was never
   * told about. So a flip is HELD and applied from #tick once nobody is busy.
   * Nothing is cut short, which is the whole point.
   *
   * A second request replaces the first rather than queueing behind it: the
   * newest classification is the one that read the newest message.
   */
  queueMode(name, { why = '', by = 'advisor' } = {}) {
    const next = modeName(name);
    if (next === this.mode()) {
      this.pendingMode = null;
      return { mode: next, changed: false };
    }
    // The advisor classifies in the background; it must degrade like every
    // other advisor failure (mode just doesn't move) rather than throw out of
    // a call nothing is watching for an exception.
    if (next === 'code' && !this.repo) return { mode: this.mode(), changed: false };
    if (!this.#anyBusy()) return this.setMode(next, { why, by });

    this.pendingMode = { mode: next, why, by };
    this.emit('mode', { mode: this.mode(), pending: next, why, by });
    return { mode: this.mode(), pending: next, changed: false };
  }

  /**
   * Pick a repository from inside the app, instead of on the command line.
   *
   * Only meaningful the first time: workspace state (db, config, vault,
   * goal, roster) already lives at kingdomDir(null) and stays there — this
   * does not migrate it into a repo-relative .kingdom/<repoName>/. It only
   * gives Code mode something to point its worktrees at. Attaching a
   * DIFFERENT repo later still needs a fresh court, same as switching repos
   * always has (see electron/main.js's "already running" dialog).
  */
  async attachRepo(path) {
    const repo = resolve(path);
    if (this.repo && this.repo !== repo) throw new Error('A different repository requires a fresh court.');
    this.base = await assertRepo(repo);
    this.repo = repo;
    if (this.#usesAgy()) this.#excludeAgentsDir();
    this.config.repo = this.repo;
    this.#persistConfig();
    this.bus.set('base', this.base);

    // A LIVE member cannot change directory. Its cwd was fixed when it was
    // spawned, and agent.js hands a resumed session its ORIGINAL cwd back (see
    // the comment beside the -C flag there), so resuming is not enough either.
    // Without this, a court that was already awake when the repo arrived goes
    // on reporting the repo-less workspace home and telling the sovereign
    // there is no repository — which is exactly what it was asked to fix.
    //
    // Only members stranded in the REPO-LESS home are restarted: a peasant in
    // a worktree is already somewhere valid, and a re-attach of the same repo
    // must not cost the whole court a respawn. The fresh session picks up
    // #orientation(), which exists for precisely this kind of restart.
    const stranded = kingdomDir(null);
    for (const [name, agent] of [...this.agents]) {
      if (agent.cwd !== stranded) continue;
      agent.recycling = true;          // so the delivery backstop lets go of it
      agent.stop();
      this.agents.delete(name);
      this.bus.set(`session:${name}:${agent.conversationId ?? 'default'}`, '');
      await this.#spawn(name, null, agent.conversationId);
    }

    this.emit('repo', { repo: this.repo, base: this.base });
    return { repo: this.repo, base: this.base };
  }

  /** The system prompt a member would be spawned with. Handy when a member is
   *  behaving oddly and you want to see what it was actually told. */
  briefFor(name) {
    const spec = this.specOf(name);
    return spec ? this.#promptFor(name, this.roleOf(name), spec, null) : null;
  }

  /**
   * The court's standing goal: what all of this is FOR.
   *
   * Everything else the court knows is either a single message or a transcript
   * that gets recycled away. A goal survives both, and every member is told it
   * on every spawn — which is the difference between a court that is working
   * towards something and one that is answering the last thing it was asked.
   */
  goal() {
    const g = this.config.goal;
    if (!g?.text) return null;
    return {
      text: g.text,
      setAt: g.setAt ?? null,
      milestones: (g.milestones ?? []).map((m) =>
        (typeof m === 'string' ? { text: m, done: false } : m)),
    };
  }

  setGoal(patch = {}) {
    if (patch.text === null || patch.text === '') {
      delete this.config.goal;
      this.#persistConfig();
      this.bus.set('goal', '');
      this.emit('goal', null);
      this.bus.post(CROWN, this.config.orchestrator.name,
        'AWARENESS ONLY — TAKE NO ACTION. The sovereign has cleared the standing goal. '
        + 'Finish what is in flight; do not start anything new towards it.', 'notice');
      return null;
    }
    const g = { ...(this.config.goal ?? {}), ...patch };
    g.setAt ??= Date.now();
    g.milestones = (g.milestones ?? []).map((m) =>
      (typeof m === 'string' ? { text: m, done: false } : m));
    this.config.goal = g;
    this.#persistConfig();

    const out = this.goal();
    this.bus.set('goal', JSON.stringify(out));
    this.emit('goal', out);
    // Told through the BUS, not injected: a goal the court never saw recorded
    // is a goal a successor cannot discover.
    if (patch.text) {
      this.bus.post('sovereign', this.config.orchestrator.name,
        `STANDING GOAL — this is what the court is working towards until I say otherwise:\n\n`
        + `${g.text}\n\n`
        + (out.milestones.length
          ? `Milestones:\n${out.milestones.map((m) => `  [${m.done ? 'x' : ' '}] ${m.text}`).join('\n')}\n\n`
          : '')
        + `Judge every piece of work against this. If a request conflicts with it, say so.`,
        'assignment');
    }
    return out;
  }

  /** Mark a milestone done or undone by index. */
  setMilestone(index, done) {
    const g = this.config.goal;
    if (!g?.milestones?.[index]) return this.goal();
    const m = g.milestones[index];
    g.milestones[index] = typeof m === 'string' ? { text: m, done } : { ...m, done };
    this.#persistConfig();
    const out = this.goal();
    this.bus.set('goal', JSON.stringify(out));
    this.emit('goal', out);
    return out;
  }

  #promptFor(name, role, spec, seedPrompt, orientation = null) {
    return buildPrompt({
      name, role, spec, seedPrompt, orientation,
      config: this.config, mode: this.mode(), goal: this.goal(), repo: this.repo,
    });
  }

  /** The run table is the only record of a run; nothing else may stand in for it. */
  #activeRun() {
    return this.bus.currentRun();
  }

  #runBlock(run, operation, next, extra = {}) {
    if (!run || !['planning', 'running', 'paused', 'verifying', 'ready_for_review'].includes(run.state)) return;
    const blocker = { operation, next, at: Date.now(), ...extra };
    // The blocker itself travels on the event; the run table records the state.
    const nextRun = { ...this.bus.updateRun(run.id, { state: 'blocked' }), blocker, blockers: [blocker] };
    this.bus.post(CROWN, this.config.orchestrator.name,
      `RUN BLOCKED: ${operation}. Preserved work is available. Next action: ${next}`, 'notice');
    this.emit('run', nextRun);
  }

  #recordRecovery(name, operation, message, extra = {}) {
    const run = this.#activeRun();
    if (!run) return null;
    const entry = { name, operation, message: String(message).slice(0, 600), at: Date.now(), ...extra };
    const next = this.bus.updateRun(run.id, { recoveryHistory: [...run.recoveryHistory, entry] });
    this.emit('recovery', entry);
    // Per (name, operation), not the whole run's history: a benign, already-
    // resolved transport-retry on one worker must not count toward another
    // worker's unresolved-process-failure threshold — or toward its own,
    // since a resolved retry and an unresolved failure are different kinds.
    const attempts = next.recoveryHistory.filter((e) => e.name === name && e.operation === operation).length;
    return { run: next, entry, attempts };
  }

  /** Evidence for a done submission, including the exact revision tested. */
  verification(peasant, submissionId = null) {
    const key = submissionId == null
      ? `verification:${peasant}` : `verification:${peasant}:${submissionId}`;
    const raw = this.bus.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /**
   * Integrate a verified worker branch into the run checkout. This is the only
   * automatic integration path; the original repository checkout is untouched.
   */
  async integrateVerified(peasant, { runId = null, revision = null } = {}) {
    const id = runId ?? this.#activeRun()?.id;
    if (!id || !this.repo) throw new Error('No active run or repository is attached.');
    const evidence = this.verification(peasant) ?? {};
    const expected = revision ?? evidence.revision;
    if (!evidence.valid || !expected) {
      throw new Error(`"${peasant}" has no current passing verification to integrate.`);
    }
    const key = `integration:${id}:${peasant}:${expected}`;
    const prior = this.bus.get(key);
    if (prior) {
      try { return JSON.parse(prior); } catch { return { runId: id, peasant, revision: expected }; }
    }
    if (!existsSync(runWorktreePath(this.repo, id))) await createRunWorktree(this.repo, id, this.base);
    const result = await mergeIntoRun(this.repo, peasant, id, { expectedRevision: expected });
    const integrated = { runId: id, peasant, sourceRevision: expected,
      revision: result.revision, branch: result.branch, at: Date.now() };
    this.bus.set(key, JSON.stringify(integrated));
    this.bus.logEvent(peasant, 'integrated', integrated);
    this.emit('integrated', integrated);
    return integrated;
  }

  /** Stop only the workers owned by an active run and leave unrelated court members alone. */
  stopRun(runId = null, why = 'stopped by the sovereign') {
    const run = this.#activeRun();
    if (!run || (runId != null && String(run.id) !== String(runId))) {
      throw new Error('No matching active run.');
    }
    const taskIds = new Set(run.taskIds.map(Number));
    const names = new Set(this.bus.tasks()
      .filter((t) => t.owner && taskIds.has(Number(t.id))).map((t) => t.owner));
    for (const name of names) {
      // Route through sleep(), not a raw agents.delete: it also drops the
      // name from `summoned` (or the delivery loop respawns it on the next
      // message addressed to it) and releases whatever it still owns back to
      // pending (or the task board keeps reporting stale "active" work that
      // nobody is doing).
      //
      // `this.agents.has(name)` alone missed a worker #maybeIdleSleep already
      // put to sleep for inactivity: it drops the live agent but deliberately
      // keeps the name in `summoned` so it can be woken again cheaply. Such a
      // worker still owns its task claims and is still summoned when its run
      // is cancelled, so it must still be released — sleep() is a safe no-op
      // on the live-agent side when there is none.
      if (this.agents.has(name) || this.summoned.has(name)) this.sleep(name, why);
    }
    const stopped = this.bus.stopRun(run.id);
    this.#publishRoster();
    this.emit('run', stopped);
    return stopped;
  }

  async createRun(fields = {}) {
    const baselineRevision = fields.baselineRevision ?? (this.repo ? await revisionOf(this.repo) : null);
    const run = this.bus.createRun({ ...fields, baselineRevision });
    // maxRunUsd is scoped to what THIS run spends, not lifetime court spend —
    // captured once, here, in the bus's own restart-safe key-value store (no
    // runs-table column needed). Same reasoning as #enforceBudget's own
    // comment on why counting per-process was the bug in the first place.
    this.bus.set(`run:${run.id}:baselineSpentUsd`, String(Number(this.bus.get('spentUsd') ?? 0)));
    await this.#reconcileRun();
    const current = this.bus.run(run.id);
    this.emit('run', current);
    return current;
  }

  async approveRun(runId = null, fields = {}) {
    const run = this.bus.approveRun(runId, fields);
    await this.#reconcileRun();
    const current = this.bus.run(run.id);
    this.emit('run', current);
    return current;
  }

  pauseRun(runId = null, why = '') {
    const run = this.bus.run(runId);
    if (!run) throw new Error('No active run.');
    this.pause(why);
    const current = this.bus.run(run.id);
    this.emit('run', current);
    return current;
  }

  async resumeRun(runId = null) {
    const run = this.bus.run(runId);
    if (!run) throw new Error('No active run.');
    if (this.paused) this.resume();
    // Pausing the court leaves a blocked run blocked; Resume still means go.
    if (['paused', 'blocked'].includes(this.bus.run(run.id).state)) this.bus.resumeRun(run.id);
    await this.#reconcileRun();
    const current = this.bus.run(run.id);
    this.emit('run', current);
    return current;
  }

  async applyRun(runId = null) {
    const run = this.bus.run(runId);
    if (!run) throw new Error('No active run.');
    if (!this.repo) throw new Error('No repository is attached.');
    if (run.state !== 'ready_for_review' || !run.finalApproval) {
      throw new Error(`Run ${run.id} needs a final approved review before it can be applied.`);
    }
    const currentRevision = await revisionOf(this.repo);
    if (run.baselineRevision && currentRevision !== run.baselineRevision) {
      this.#runBlock(run, 'source-state comparison', 'refresh the review against the changed source before applying', {
        baselineRevision: run.baselineRevision, currentRevision,
      });
      throw new Error('Source changed since the run baseline; refresh the review before applying.');
    }
    const applied = await mergeRunBranch(this.repo, run.id, this.base);
    const completed = this.bus.applyRun(run.id);
    this.emit('run', completed);
    return { ...completed, applied };
  }

  async #reconcileRun() {
    const run = this.#activeRun();
    if (!run || !this.repo || !['planning', 'running', 'paused', 'verifying'].includes(run.state)) return;
    try {
      await createRunWorktree(this.repo, run.id, this.base);
    } catch (e) {
      this.#runBlock(run, 'startup reconciliation',
        `repair the run branch/worktree, then resume after refreshing review: ${e.message}`);
    }
  }

  // --- the loop -------------------------------------------------------

  async #tick() {
    // setInterval does NOT wait for an async callback, so a tick that awaits
    // (spawning a slept member, running tests) will overlap the next one. Two
    // ticks then both see a member as "not awake" and both spawn it — which
    // showed up as `git worktree add: already exists` and a spawn cascade.
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Before delivery, not after: #deliver hands messages to idle members, and
      // a message delivered under a mode that is one line away from changing is
      // a member briefed on rules it will not have.
      if (this.pendingMode && !this.#anyBusy()) {
        const p = this.pendingMode;
        this.setMode(p.mode, { why: p.why, by: p.by });     // clears pendingMode
      }
      await this.#deliver();
    } finally {
      this.ticking = false;
    }
  }

  async #deliver() {
    const now = Date.now();

    // The backstop must never be tighter than the window it backs up, or the
    // window is silently capped and tuning it does nothing. Checked here rather
    // than at start() because settleMs() reads the environment on every call
    // and the sovereign can widen the window mid-session — but LATCHED on the
    // message, because sitting inside the per-member loop it emitted roughly
    // three errors a second per member for the life of the session. Re-arms
    // when the numbers change, so a fix is noticed and so is a second mistake.
    const badTiming = checkTiming(BATCH_MAX_WAIT_MS, settleMs());
    if (badTiming !== this.timingWarned) {
      this.timingWarned = badTiming;
      if (badTiming) this.emit('error', new Error(badTiming));
    }

    // prune() ran once, at start, and then the log grew for the rest of the
    // session — while /api/metrics reads it every 5 seconds and JSON.parses
    // every row it gets back. A day-long court is exactly the case the
    // retention limit was written for and the only case it never applied to.
    if (now - (this.lastPrune ?? 0) > PRUNE_EVERY_MS) {
      this.lastPrune = now;
      try {
        this.bus.prune();
        this.#turnEndCache.mark = -1;
      } catch (e) { this.emit('error', e); }
    }

    // Approval visibility must not depend on a member delivery succeeding.
    // A failed worktree/agent can otherwise abort this method before the
    // sovereign's approval request is surfaced.
    this.#applyMilestones();
    this.#surfaceApprovals();
    this.#applyArguments();
    this.#applyControl();

    // THE KING FIRST, then the briefer, then everyone else.
    //
    // This loop awaits each member's spawn inline, and waking a peasant means
    // validating its worktree — several git subprocesses, ~100ms each on
    // Windows. `summoned` is restored in whatever order it was saved, which put
    // the orchestrator fifth behind three peasants: measured 3.6s from the sovereign
    // pressing enter to the orchestrator being handed the text, of which 3.3s was
    // waiting for peasants nobody was waiting on. Nothing else in the court has
    // a human sitting in front of it.
    // A pause freezes turns, not the court: control/approvals/arguments above
    // still run so a `resume` sent while paused is not stuck behind the very
    // thing it is meant to lift. Nobody mid-turn is interrupted — this only
    // stops the NEXT one from being handed out.
    if (this.paused) return;

    const rank = (n) => (n === this.config.orchestrator.name ? 0 : n === this.config.briefer.name ? 1 : 2);
    for (const name of [...this.summoned].sort((a, b) => rank(a) - rank(b))) {
      const pending = this.bus.pending(name, 200, this.#activeConv(name));
      if (!pending.length) {
        this.#maybeIdleSleep(name, now);
        continue;
      }
      if (this.#enforceQuota(name)) continue;

      const highest = pending[pending.length - 1].id;

      // Approvals belong to the sovereign; an argue request belongs to the
      // argument court; `done` starts verify -> digest. None of the three is
      // traffic for a member to read.
      const deliverable = [];
      for (const msg of pending) {
        if (msg.kind === 'approval') continue;
        // Posted with a null recipient so #applyArguments can sweep it, and a
        // null recipient matches EVERY summoned member in bus.pending() — the
        // same trap a milestone notice fell into, where one FYI bought a full
        // context replay for the whole court. Skipped here so it costs nobody
        // a turn; the verdict comes back addressed to whoever asked.
        if (msg.kind === 'argue') continue;
        // Same null-recipient trap as 'argue' above: this is a request for
        // #applyControl, not traffic for the crew.
        if (msg.kind === 'control') continue;
        if (msg.kind === 'done' && name === this.config.orchestrator.name) {
          // ONCE per declaration. This loop runs before the ripeness gate and
          // before the ack, so a `done` that arrives alongside any other message
          // is re-seen on every 300ms tick until the whole batch ripens.
          // Measured on a real run: one declare_done from the designer ran
          // commitAll + the test suite + two diffs 131 times, and queued 131
          // digest turns onto the briefer. Recorded on the bus, not in memory,
          // so a restart between the fire and the ack cannot replay it either.
          if (!this.bus.get(`done:${msg.id}`)) {
            this.bus.set(`done:${msg.id}`, '1');
            this.#onDone(msg).catch((e) => {
              this.emit('error', e);
              // The guard is set BEFORE the work, which is what stops the tick
              // storm — but it also means a failure strands the peasant's
              // finished work forever: no tests, no digest, no done-report, and
              // the orchestrator is never told the work exists. commitAll's `git add -A`
              // throws on a .git/index.lock collision, which is routine on
              // Windows and exactly the transient worth retrying.
              //
              // ONE retry, recorded separately, same shape as `retried:`. A
              // permanently broken worktree must not go back to replaying the
              // test suite 131 times.
              if (!this.bus.get(`doneretry:${msg.id}`)) {
                this.bus.set(`doneretry:${msg.id}`, '1');
                this.bus.set(`done:${msg.id}`, '');
              }
            });
          }
          continue;
        }
        deliverable.push(msg);
      }
      if (!deliverable.length) {
        this.bus.ack(name, highest);
        continue;
      }

      // Re-typing the same order means "this still has not happened", not "do
      // it again". When the court stalls the sovereign repeats themselves —
      // observed seven identical "Resume" messages and two "Merge" — and every
      // one of them was then delivered in a single batch, so the orchestrator was told
      // to resume seven times and duly acted on it. Keep the last of any
      // identical run from the same sender; the earlier copies are noise that
      // costs a replay each.
      const seen = new Set();
      for (let i = deliverable.length - 1; i >= 0; i--) {
        const key = JSON.stringify([deliverable[i].sender, deliverable[i].body]);
        if (seen.has(key)) deliverable.splice(i, 1);
        else seen.add(key);
      }

      // Interrupting a busy agent wastes a whole replay on a partial thought,
      // so wait for it to finish — but never forever. The decision itself lives
      // in ripeness.js: it is pure, and the bugs that lived here were only ever
      // findable by driving states that a real court reaches once an hour.
      //
      // `hadReal:${name}` persists (survives a restart) whether this member has
      // EVER been handed a real, non-notice batch — see ripeness.js's
      // `hadRealTurn`. A member spawned at boot with nothing but housekeeping
      // notices in its inbox (inherited crew, orphaned tasks) must not take a
      // turn nobody asked for just because it sat there long enough (#40).
      const agent = this.agents.get(name);
      const allNotices = deliverable.every((m) => m.kind === 'notice');
      const { ripe } = ripeness(deliverable, {
        now,
        awake: Boolean(agent),
        busy: Boolean(agent?.busy),
        recycling: Boolean(agent?.recycling),
        settleMs: settleMs(),
        backstopMs: BATCH_MAX_WAIT_MS,
        noticeHoldMs: NOTICE_HOLD_MS,
        hadRealTurn: this.bus.get(`hadReal:${name}`) === '1',
      });
      if (!ripe) continue;
      if (!allNotices) this.bus.set(`hadReal:${name}`, '1');

      // An idle-slept member is revived on demand; its session resumes.
      //
      // Started, NOT awaited. Waking a peasant validates its worktree — several
      // git subprocesses, ~100ms each on Windows — and this loop runs inside a
      // single `ticking` critical section, so awaiting it here stopped every
      // other member's mail too. Measured before: 3.6s from the sovereign
      // pressing enter to the orchestrator being handed the text, 3.3s of it spent on
      // peasants nobody was waiting for. Ordering the orchestrator first (see `rank`
      // above) hid that for the orchestrator alone; this removes it for everyone.
      //
      // The batch stays UNACKED, so the next tick delivers it once the member
      // is live. That is the whole trick: no state to unwind if the spawn
      // fails, and #spawn dedupes so repeated ticks cannot pile up spawns.
      if (!agent) {
        this.#spawn(name).catch((e) => this.emit('error', e));
        continue;
      }
      const live = agent;

      // ONE turn for the whole batch instead of one turn per message.
      live.send(deliverable.length === 1
        ? this.#envelope(deliverable[0])
        : `You have ${deliverable.length} new messages.\n\n` +
          deliverable.map((m) => this.#envelope(m)).join('\n\n---\n\n'));

      this.bus.ack(name, highest);
      // Remember where this batch started. The ack happens BEFORE the turn is
      // known to have worked, so a turn that dies outright takes the sovereign's
      // order with it — that is how a 53k-char brief vanished with the court
      // reporting nothing at all.
      this.lastBatch.set(name, { from: deliverable[0].id - 1, to: highest });
      this.lastActive.set(name, now);
      for (const m of deliverable) this.emit('delivered', { to: name, msg: m });
    }

  }

  /**
   * The next unread requests of one kind, as [message, parsed body] pairs.
   *
   * Requests addressed to nobody (milestone, argue, control) are never
   * delivered, so each kind keeps its own cursor over the log. Advanced ONCE,
   * after the read, not per row — that was up to 50 writes per sweep to move
   * one integer. Safe because every consumer is idempotent: re-scanning after
   * a crash mid-sweep costs a re-read and nothing else.
   */
  #sweep(kind) {
    const key = `${kind}:cursor`;
    const rows = this.bus.history({ since: Number(this.bus.get(key) ?? 0), limit: 50 });
    if (rows.length) this.bus.set(key, String(rows[rows.length - 1].id));
    return rows.filter((m) => m.kind === kind).flatMap((m) => {
      try { return [[m, JSON.parse(m.body)]]; } catch { return []; }
    });
  }

  /**
   * Apply milestone claims the orchestrator has posted.
   *
   * They are addressed to "orchestrator", which is nobody's inbox — no member
   * would ever be delivered them — so they need their own sweep. And the
   * ORCHESTRATOR applies them rather than the MCP server, because it owns
   * kingdom.config.json; a second writer would lose updates.
   */
  #applyMilestones() {
    for (const [m, claim] of this.#sweep('milestone')) {
      const g = this.setMilestone(claim.index, true);
      const hit = g?.milestones?.[claim.index];
      if (!hit) continue;
      this.emit('milestone', { index: claim.index, text: hit.text, by: m.sender, evidence: claim.evidence });
      const left = g.milestones.filter((x) => !x.done).length;
      // To the KING, not to everyone. `recipient: null` matches every summoned
      // member in bus.pending(), so one milestone put a full context replay in
      // front of the whole court to read "TAKE NO ACTION" — while the orchestrator's own
      // prompt says "Never broadcast what one member needs to hear." Every other
      // orchestrator notice in this file addresses the orchestrator; this one did not.
      this.bus.post(CROWN, this.config.orchestrator.name,
        `AWARENESS ONLY — TAKE NO ACTION. Milestone reached: "${hit.text}". `
        + (left ? `${left} still open.` : 'That was the last one; the goal is complete.'),
        'notice');
    }
  }

  #argueQueue = [];
  #arguing = false;

  /**
   * Run arguments the court has asked for.
   *
   * Same shape as #applyMilestones and for the same reason: the request is
   * addressed to nobody, so no delivery would ever pick it up and it needs
   * its own sweep. The ORCHESTRATOR runs it rather than the MCP server because
   * the argument writes a vault note and posts a notice, and one writer is
   * the whole point.
   *
   * ONE AT A TIME, through a queue. A sweep can find several requests at
   * once and each is three to five model calls across two vendors; firing
   * them concurrently would multiply the bill by however many happened to
   * land in the same 50-row window. The cursor advances over the whole sweep
   * as it does for milestones, so nothing is re-read — the queue, not the
   * cursor, is what holds the backlog.
   */
  #applyArguments() {
    for (const [m, req] of this.#sweep('argue')) {
      const question = String(req?.question ?? '').trim();
      if (!question) continue;
      this.#argueQueue.push({ question, asker: m.sender });
    }
    this.#drainArguments();
  }

  /**
   * Degrade, never wedge: every exit from here posts something back to
   * whoever asked. A member told "the verdict arrives later" and then left
   * with silence is the exact stall AGENTS.md rule 4 forbids.
   */
  #drainArguments() {
    if (this.#arguing || !this.#argueQueue.length || this.stopping) return;
    const { question, asker } = this.#argueQueue.shift();

    // The verdict goes back to WHOEVER ASKED. Hardcoding the orchestrator here is
    // the bug t-questions.js exists to pin, and the argument court has the
    // same shape: it answers a caller, not a fixed address.
    //
    // CROWN, not the literal 'orchestrator': argue is roles: ['orchestrator'],
    // so the asker is ALWAYS the orchestrator, and the shipped orchestrator
    // name is "orchestrator" too. Posted role-to-name, every verdict was sender
    // === recipient and bus.pending() dropped it — #54's bug in the one tool
    // whose whole purpose is settling a contested decision.
    const reply = (body) => this.bus.post(CROWN, asker, body, 'notice');

    const cap = this.#kingdomBudget();
    const spent = Number(this.bus.get('spentUsd') ?? 0);
    if (cap && spent >= cap) {
      reply(`The argument court was not convened: the kingdom is at its spend ceiling `
        + `($${spent.toFixed(2)} of $${cap}). Decide it yourself or ask the sovereign to raise the cap.`);
      return;
    }

    const panel = pickPanel(this.config);
    if (!panel) {
      reply('The argument court needs two different models to argue and a third to judge, '
        + 'and this kingdom has only one configured. Decide it yourself.');
      return;
    }

    this.#arguing = true;
    // #runArgument posts the verdict itself, addressed to the asker. A second
    // copy from here is a second notice in somebody's context for one answer.
    this.#runArgument(question, panel, { tell: asker })
      .catch((e) => {
        this.emit('argued', { question, error: e.message });
        reply(`The argument court could not settle "${question.slice(0, 90)}": ${e.message}. `
          + `Decide it yourself rather than waiting.`);
      })
      .finally(() => {
        this.#arguing = false;
        this.#drainArguments();
      });
  }

  /**
   * Run the control the court asked for: mode, wake, sleep, model.
   *
   * These are levers the SOVEREIGN already had (they are the same Kingdom
   * methods daemon.js's ACTIONS map calls) and the court had none of. The
   * orchestrator is the one that discovers mid-conversation that this is a
   * coding job rather than a chat, or that a member has been idle for an hour,
   * and until now its only move was to ask the sovereign to click something.
   *
   * One sweep for all of them rather than one per tool: mcp.js runs in its own
   * process and reaches the court only through the bus, so every lever needs a
   * request row, a cursor and a delivery skip. Sharing them makes the next
   * lever one line in the switch below instead of a third copy of this.
   *
   * The Kingdom methods do the refusing, not this — setMode throws for Code
   * with no repo, setModel throws for a name nobody holds — and the member is
   * told what it was, rather than left wondering whether the call landed.
   */
  #applyControl() {
    for (const [m, req] of this.#sweep('control')) {
      // CROWN for the same reason the argument verdict uses it: every lever in
      // src/mcp/control.js is roles: ['orchestrator'], so m.sender is the
      // orchestrator, and role-as-sender to name-as-recipient is self-addressed
      // mail that pending() drops. Every "mode switched", every "wake failed",
      // every `${op} failed: …` below was written and never delivered.
      const say = (body) => body && this.bus.post(CROWN, m.sender, body, 'notice');
      // Degrade, never wedge: every path here ends in something the caller can
      // read, because a member told nothing cannot tell "refused" from "lost".
      try {
        Promise.resolve(this.#control(req, m.sender))
          .then(say)
          .catch((e) => say(`${req.op} failed: ${e.message}`));
      } catch (e) {
        say(`${req.op} failed: ${e.message}`);
      }
    }
  }

  /** One lever. Returns what to tell the caller, or null if it was told already. */
  #control(req, by) {
    switch (req.op) {
      case 'mode': {
        const r = this.setMode(req.mode, { why: req.why ?? '', by });
        // A real change already notices every member, this one included. Only
        // the no-op needs a word back, or the caller cannot tell it landed.
        return r.changed ? null : `The court is already in ${modeOf(r.mode).label} mode.`;
      }
      case 'wake':
        return this.wake(req.name).then(() => `${req.name} is awake.`);
      case 'sleep':
        // Not a nap: sleep() takes the member off the roster entirely, which is
        // what makes it a cost lever. Said plainly so it is not called by mistake.
        this.sleep(req.name);
        return `${req.name} has been stood down and is off the roster. Summon it again to bring it back.`;
      case 'model':
        return this.setModel(req.name, { cli: req.cli, model: req.model, effort: req.effort })
          .then((r) => `${r.name} is now on ${r.cli}${r.model ? ' / ' + r.model : ' (the CLI default)'}`
            + `${r.effort ? ' at ' + r.effort + ' effort' : ''}.`
            + (r.cliChanged ? ' The CLI changed, so its session did not carry over.' : ''));
      case 'pause': {
        const r = this.pause(req.why ?? '');
        return r.changed ? null : 'The court is already paused.';
      }
      case 'resume': {
        const r = this.resume();
        return r.changed ? null : 'The court is not paused.';
      }
      case 'budget': {
        const { cap } = this.setBudget(req.capUsd);
        return `Kingdom spend ceiling is now ${cap ? '$' + cap : 'unlimited'}.`;
      }
      case 'push':
        this.requestPush(req.reason ?? '', by);
        return null;
      default:
        return `No such control: ${req.op}.`;
    }
  }

  /** Surface approval requests to the sovereign exactly once. */
  #surfaceApprovals() {
    const seen = Number(this.bus.get('approvals:cursor') ?? 0);
    const rows = this.bus.approvals({ since: seen });
    // Once, after the sweep — see #applyMilestones. Idempotent here too: a
    // re-scan is guarded by `resolved:${m.id}` and by approvals being a Map.
    if (rows.length) this.bus.set('approvals:cursor', String(rows[rows.length - 1].id));
    for (const m of rows) this.#offerApproval(m);
  }

  /**
   * A member nobody has spoken to in a while is stopped. Stopped members cost
   * nothing and revive with their memory intact on the next message — the
   * Habitable run kept seven agents alive while two did the work.
   */
  #maybeIdleSleep(name, now) {
    if (!IDLE_SLEEP_MS) return;
    if (name === this.config.orchestrator.name) return; // the orchestrator is the entry point
    const agent = this.agents.get(name);
    if (!agent || agent.busy) return;
    const since = this.lastActive.get(name) ?? now;
    if (now - since < IDLE_SLEEP_MS) return;

    // A woken peasant going quiet with claimable work on the list is a member
    // that stopped, not a member that is finished. Agent teams solve this with
    // a TeammateIdle hook whose exit code 2 means "here is feedback, keep
    // working"; the court's equivalent is to spend one message before spending
    // a whole respawn. Nudged ONCE — lastActive moves when the message lands,
    // so a peasant that ignores it sleeps on the next pass rather than being
    // poked forever.
    if (this.roleOf(name) === 'peasant' && !this.nudged?.has(name)) {
      const open = this.bus.availableTasks();
      if (open.length) {
        (this.nudged ??= new Set()).add(name);
        // 'orchestrator', not the orchestrator's name. The orchestrator never said this, and
        // posting it under their name put words in the sovereign's court: it
        // appears in the bus and the log as the orchestrator speaking, and a
        // peasant may reply to the orchestrator about a message the orchestrator never sent,
        // costing a turn on both sides. Every other orchestrator message uses
        // this sender.
        this.bus.post(CROWN, name,
          `You have gone quiet with ${open.length} task${open.length > 1 ? 's' : ''} unclaimed. `
          + `Call claim_task to take the next one, or say what is blocking you. Do not stop with work on the list.`,
          'assignment');
        return;
      }
    }
    this.nudged?.delete(name);

    agent.stop();
    this.agents.delete(name);
    this.#publishRoster();
    this.emit('agent', { name, state: 'idle-slept' });
    this.#rescueWork(name).catch((e) => this.emit('error', e));
  }

  /**
   * A peasant cannot commit — its .git is outside the sandbox — so the ONLY way
   * its work becomes visible is the crown committing it. If a peasant goes quiet
   * without calling declare_done (it hit the git error and reported a blocker
   * instead, or was rate limited, or simply stopped), its edits sit in the
   * worktree where nothing will ever look at them.
   *
   * So: never let a peasant fall asleep on top of uncommitted work. Commit it as
   * WIP on its own branch — cheap, reversible, and the difference between work
   * that can be recovered and work that is silently lost.
   */
  async #rescueWork(name) {
    // Nothing to rescue without a worktree: a repo-less peasant edits the
    // vault directly, with no git tracking to fall behind on.
    if (this.roleOf(name) !== 'peasant' || !this.repo) return;
    if (!(await commitAll(this.repo, name, `WIP: ${name} slept with uncommitted work`))) return;
    this.bus.post(CROWN, this.config.orchestrator.name,
      `AWARENESS ONLY — TAKE NO ACTION. "${name}" went idle with uncommitted edits, ` +
      `so the crown committed them as WIP on its branch. Nothing is lost; the work ` +
      `was never declared done, so it has NOT been tested or reviewed.`, 'notice');
    this.emit('rescued', { peasant: name });
  }

  #envelope(msg) {
    const tag = msg.kind === 'assignment' ? 'ORDER FROM'
      : msg.kind === 'notice' ? 'FYI — NO ACTION REQUIRED, FROM'
      : 'MESSAGE FROM';
    const attachments = Array.isArray(msg.attachments) ? msg.attachments
      .map((item) => typeof item === 'string' ? item : item?.name)
      .filter(Boolean) : [];
    const files = attachments.length
      ? `\n\nATTACHED ASSETS (uploaded beside the court; use list_uploads for their paths):\n`
        + attachments.map((name) => `- ${name}`).join('\n')
      : '';
    const control = msg.recipient === this.config.orchestrator.name && msg.kind === 'assignment'
      ? '\n\n[COURT CONTROL] If specialist help is needed, call the summon MCP tool now. '
        + 'Do not ask for approval only in prose; prose does not create an approval card.'
      : '';
    return `[${tag} ${msg.sender}]\n${msg.body}${files}${control}`;
  }

  /**
   * Release tasks held by somebody who is no longer going to finish them, and
   * return the sentence naming whatever that release threw away (empty when it
   * threw away nothing).
   *
   * Shared by the boot-time orphan sweep and dismissal because the invariant is
   * the same and #53 taught the cost of fixing one door: a task in `verifying`
   * has a controller check running against the DEPARTING owner's worktree, and
   * that worktree leaves with them. Releasing it is right — nobody can finish
   * that check — but a plain `state: 'pending'` write is the same silent
   * collapse #53 was: the submission is discarded and nothing says so.
   *
   * The submission marker goes with it. finish_task records
   * `submission:task:<id>` and reassign_task reads it to tell an in-flight
   * verification from a resolved one; left behind, it points at a verification
   * that can never land. Cleared to '' rather than deleted — the bus has no
   * key delete, and its reader already guards on falsy.
   */
  #releaseHeldTasks(tasks) {
    const discarded = [];
    for (const t of tasks) {
      if (t.state === 'verifying') {
        this.bus.set(`submission:task:${t.id}`, '');
        discarded.push(t.id);
      }
      this.bus.updateTask(t.id, { owner: null, state: 'pending' });
    }
    if (!discarded.length) return '';
    return ` ${discarded.map((id) => `#${id}`).join(', ')} `
      + `${discarded.length === 1 ? 'was' : 'were'} awaiting verification, and that check went with `
      + `${discarded.length === 1 ? 'its' : 'their'} owner — the submitted work must be redone or `
      + 'resubmitted, not assumed verified.';
  }

  /** peasant done -> run its tests -> hand the diff to the briefer to digest. */
  async #onDone(msg) {
    const peasant = msg.sender;
    this.emit('agent', { name: peasant, state: 'verifying' });

    // No repo, no worktree — nothing to commit, test or diff. The deliverable
    // is whatever vault_write already landed; report the summary straight
    // through instead of running a verification pipeline that has no target.
    if (!this.repo) {
      const evidence = {
        ran: false, ok: false, valid: false, stale: false, revision: null,
        submittedAt: msg.ts ?? Date.now(), submissionId: msg.id, summary: msg.body,
      };
      this.bus.set(`verification:${peasant}`, JSON.stringify(evidence));
      this.bus.set(`verification:${peasant}:${msg.id}`, JSON.stringify(evidence));
      this.bus.post(CROWN, this.config.orchestrator.name,
        `"${peasant}" declared done.\n${msg.body}\n\n` +
        `No repository is attached, so nothing was committed, tested or diffed — ` +
        `check the vault for what it wrote.`, 'done-report');
      this.emit('verified', { peasant, tests: evidence, revision: null, stat: '' });
      return;
    }

    const wt = worktreePath(this.repo, peasant);
    await commitAll(this.repo, peasant, `kingdom(${peasant}): ${msg.body.split('\n')[0].slice(0, 90)}`);
    const submittedRevision = await revisionOf(wt).catch(() => null);
    const tests = await runTests(wt, { revision: submittedRevision });
    const currentRevision = await revisionOf(wt).catch(() => submittedRevision);
    const valid = Boolean(tests.ran && tests.ok && !tests.stale && submittedRevision
      && currentRevision === submittedRevision);
    const evidence = {
      ...tests,
      revision: currentRevision,
      submittedRevision,
      currentRevision,
      valid,
      submittedAt: msg.ts ?? Date.now(),
      submissionId: msg.id,
      summary: msg.body,
    };
    // Keep the old per-member key for the existing review UI, and add an
    // immutable submission key so a later task cannot overwrite its evidence.
    this.bus.set(`verification:${peasant}`, JSON.stringify(evidence));
    this.bus.set(`verification:${peasant}:${msg.id}`, JSON.stringify(evidence));
    const activeRun = this.#activeRun();
    if (activeRun) {
      const verificationEvidence = [...activeRun.verificationEvidence, { peasant, ...evidence }];
      // A run already blocked on something else — or in any state this
      // submission cannot legally leave — must not be silently cleared back
      // to verifying by an unrelated, later peasant's success. transitionRun's
      // allowed-map is the one source of truth for that, not a raw write; a
      // disallowed move still records the evidence, just without forcing
      // state. An invalid submission's own 'blocked' transition is #runBlock's
      // job below, which the caller already guards by run state.
      if (valid) {
        try { this.bus.transitionRun(activeRun.id, 'verifying', { verificationEvidence }); }
        catch { this.bus.updateRun(activeRun.id, { verificationEvidence }); }
      } else {
        this.bus.updateRun(activeRun.id, { verificationEvidence });
      }
    }
    const [diff, stat] = await Promise.all([
      diffOf(this.repo, peasant, this.base),
      statOf(this.repo, peasant, this.base),
    ]);
    this.bus.set(`tests:${peasant}`, JSON.stringify(evidence));
    this.emit('verified', { peasant, tests: evidence, revision: currentRevision, stat });

    if (activeRun && !valid) {
      this.#runBlock(activeRun, `verification of ${peasant}`,
        `preserve the branch, inspect the failed or stale evidence, and rerun verification`,
        { peasant, revision: currentRevision, submissionId: msg.id });
    }

    const verdict = `TESTS: ${tests.ran ? (valid ? 'PASSED' : 'FAILED OR STALE') : 'NONE FOUND (treat as unverified)'}`;

    // The digest costs two turns — one for the briefer to read, one to brief.
    // Worth it when several peasants are in flight and the orchestrator needs a
    // filtered view. Pure overhead when one peasant did one thing: the orchestrator
    // can read_diff itself if the summary looks off.
    // AWAKE peasants, not summoned ones. `summoned` carries every peasant
    // inherited from previous sessions — measured: seven of them, all asleep,
    // none doing anything. Counting those made a court where ONE peasant did
    // ONE thing take the two-turn briefer digest anyway, and a briefer turn
    // averaged 1M input tokens. "In flight" means holding a live process.
    const workers = [...this.agents.keys()].filter((n) => this.roleOf(n) === 'peasant').length;
    const useBriefer = this.config.brieferDigestAbove ?? 1;
    // Do not tell the orchestrator to call a tool this mode does not give it. The
    // instruction survived into Research and Build otherwise, and an orchestrator that
    // reaches for a withheld tool spends a turn to be told no.
    const next = modeOf(this.mode()).merge
      ? `then request_merge or send_back.`
      : `The work stays on its branch — nothing merges in this mode. Say whether it is `
        + `good enough and what is still open.`;
    // An idle-slept briefer has no live process to hand the digest to; the
    // orchestrator gets the plain report rather than nothing.
    const briefer = this.agents.get(this.config.briefer.name);
    if (workers <= useBriefer || !briefer) {
      this.bus.post(CROWN, this.config.orchestrator.name,
        `"${peasant}" submitted work for verification.\n${msg.body}\n\n${verdict}` +
        `\nREVISION: ${currentRevision ?? '(unknown)'}\n${tests.output.slice(-1200)}\n\n` +
        `CHANGED:\n${stat}\n\nUse read_diff("${peasant}") if you need the actual changes, ` +
        next, 'done-report');
      return;
    }

    const truncated = diff.length > DIGEST_DIFF_LIMIT;
    briefer.send(
      `[ORCHESTRATOR] "${peasant}" submitted work for verification. Digest this for the orchestrator, then ` +
      `call brief_orchestrator with your digest.\n\n` +
      `THEIR SUMMARY:\n${msg.body}\n\n` +
      `${verdict}\nREVISION: ${currentRevision ?? '(unknown)'}\n` +
      `${tests.output}\n\n` +
      `DIFFSTAT:\n${stat}\n\n` +
      `DIFF${truncated ? ' (truncated)' : ''}:\n${diff.slice(0, DIGEST_DIFF_LIMIT)}`
    );
  }

  recycleBriefer() {
    return this.recycleAgent(this.config.briefer.name);
  }

  /**
   * Retire a member whose context has grown too expensive and replace it with a
   * successor carrying a handover note.
   *
   * Originally briefer-only. That was a mistake: the KING accumulates the most
   * context of anyone (observed at 227k tokens, replayed on every single turn)
   * and had no recycle at all. Whoever talks most needs this most.
   */
  async recycleAgent(name) {
    const agent = this.agents.get(name);
    if (!agent || agent.recycling) return;
    agent.recycling = true;

    const note = await this.#captureHandover(agent);
    const convId = agent.conversationId ?? this.#activeConv(name);

    agent.stop();
    this.agents.delete(name);
    // Scoped to the conversation that was actually recycled — a member with
    // several conversations must not have the OTHER ones silently reset too.
    this.bus.set(`session:${name}:${convId}`, ''); // fresh session, seeded by the note
    this.bus.set(`ctx:${name}:${convId}`, '0');
    // A masked tool result says "you already have this". The successor does
    // not — it is a fresh context holding only a handover note — so the ledger
    // has to die with the session that earned it.
    this.bus.set(`served:${name}`, '');
    await this.#spawn(name, note, convId);
    this.emit('recycled', { name, note });
  }

  /**
   * Move a member's live session to a different conversation.
   *
   * No CLI backend supports holding two sessions open in one process (every
   * resume flag continues ONE thread), so this is kill-and-respawn, not a
   * cheap in-process swap: if the member was mid-turn, that generation is
   * lost. Never silent about it — `interrupted` rides the returned result and
   * the emitted event, so the caller can say so rather than let the thread
   * just change under the sovereign.
   *
   * Sovereign-initiated only (called from daemon.js's ACTIONS map) — unlike
   * `mode`/`wake`/`sleep`/`model`, this has no #control() lever, because
   * conversations are a Chat-mode/orchestrator concept and no peasant flow
   * needs to switch one.
   */
  async switchConversation(name, conversationId, { by = 'sovereign' } = {}) {
    const spec = this.specOf(name);
    if (!spec) throw new Error(`No such member of the court: ${name}`);
    this.bus.createConversation(name, { id: conversationId }); // idempotent
    const from = this.#activeConv(name);
    if (from === conversationId) return { interrupted: false, changed: false, from, conversationId };

    const live = this.agents.get(name);
    let interrupted = false;
    if (live) {
      interrupted = Boolean(live.busy);
      live.recycling = true; // so the delivery backstop lets go of it
      live.stop();
      this.agents.delete(name);
      // A masked tool result says "you already have this" about the OLD live
      // session; the new one starts from nothing.
      this.bus.set(`served:${name}`, '');
    }
    this.#setActiveConv(name, conversationId);
    await this.#spawn(name, null, conversationId);
    this.emit('conversationSwitched', { name, conversationId, from, interrupted, by });
    return { interrupted, changed: true, from, conversationId };
  }

  /**
   * Fork a conversation at `forkAtMessageId` into a new sibling, seeded with
   * the prior turns replayed as context, then post `newText` as its first
   * message. This is how both "edit a past message" and "regenerate a reply"
   * work: neither claude/codex/agy/opencode support rewinding a session in
   * place, so the only way to change history is to start a fresh one that has
   * been told what happened up to the fork point — the same replay technique
   * #orientation() already uses for a fresh member.
   */
  async branchFrom(name, conversationId, forkAtMessageId, newText, { by = 'sovereign' } = {}) {
    const source = this.bus.conversation(conversationId);
    if (!source) throw new Error(`No such conversation: ${conversationId}`);
    const prior = this.bus.history({ conversation: conversationId, limit: 10_000 })
      .filter((m) => m.id <= Number(forkAtMessageId));
    const log = prior.map((m) =>
      `${m.sender}->${m.recipient ?? '*'}: ${m.body.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    const forked = this.bus.forkConversation(
      conversationId, Number(forkAtMessageId), name, source.title ? `${source.title} (branch)` : ''
    );
    // The member must actually be live IN the new conversation before either
    // the replay notice or newText is posted, or the delivery loop (scoped to
    // whichever conversation is active) never picks either one up.
    await this.switchConversation(name, forked.id, { by });
    if (prior.length) {
      this.bus.post(CROWN, name,
        `AWARENESS ONLY — TAKE NO ACTION. This is a new branch of an earlier conversation, `
        + `forked at message #${forkAtMessageId}. Prior turns up to that point, for context `
        + `(oldest first):\n${log}`,
        'notice', forked.id);
    }
    await this.speakTo(name, newText, forked.id);
    return forked;
  }

  /**
   * What a member waking into a FRESH session needs to know so it never has to
   * ask the sovereign "what were we doing?". Built from the bus, so it works
   * after a restart, a recycle, or a CLI switch alike.
   *
   * `conversationId` scopes this the same way bus.js#pending() scopes
   * delivery: an inclusion list, not an exclusion one. Only `assignment` rows
   * (real sovereign<->orchestrator chat turns) are conversation-scoped — a
   * fresh conversation must not orient itself with a DIFFERENT conversation's
   * chat as if it were "what we were just doing" (observed for real: a brand
   * new Chat-mode conversation, asked what the sovereign had just said,
   * recited a completely different conversation's last message). Everything
   * else — mode changes, worktree notices, peasant reports — is still
   * court-wide operational context every conversation needs.
   */
  #orientation(conversationId = 'default') {
    const recent = this.bus.history({ limit: 500 })
      .filter((m) => m.kind !== 'assignment' || m.conversation_id === conversationId)
      .slice(-25);
    if (!recent.length) return null;

    const goal = [...recent].reverse().find((m) => m.sender === 'sovereign');
    const crew = [...this.summoned]
      .map((n) => (this.agents.has(n) ? n : `${n} (asleep)`)).join(', ');
    const waiting = [...this.approvals].map(([id, p]) => `#${id} ${p.kind}`).join(', ');
    const log = recent.map((m) =>
      `#${m.id} ${m.sender}->${m.recipient ?? '*'} [${m.kind}] ` +
      m.body.replace(/\s+/g, ' ').slice(0, 160)).join('\n');

    return [
      goal && `THE SOVEREIGN'S STANDING GOAL:\n${goal.body.slice(0, 700)}`,
      `IN SERVICE: ${crew || 'nobody yet'}`,
      waiting && `AWAITING THE SOVEREIGN'S APPROVAL: ${waiting}`,
      `RECENT COURT TRAFFIC (oldest first):\n${log}`,
      `You have inherited work in progress. Do NOT ask the sovereign to ` +
      `re-explain it — continue from the above, and use read_bus, read_diff or ` +
      `vault_search if you need more.`,
    ].filter(Boolean).join('\n\n');
  }

  /** Ask a member for a handover note before its session is discarded. */
  #captureHandover(agent) {
    return new Promise((res) => {
      let last = '';
      let timer;
      let settled = false;
      const grab = (t) => (last += t);
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        agent.off('text', grab);
        // The TAIL, and capped. `grab` accumulates every text event of the
        // retirement turn, not just the note, so a member that thinks out loud
        // hands its successor the whole monologue — embedded verbatim at the
        // FRONT of a fresh context, permanently, and compounding down a recycle
        // chain. The one thing recycling exists to bound was the one thing with
        // no bound. Tail because the note is what it was asked for and the
        // reasoning is what came before it, the same choice summarize.js makes.
        res(last.trim().slice(-HANDOVER_CAP));
      };
      agent.on('text', grab);
      agent.once('turn_end', done);
      timer = setTimeout(done, 120_000); // a wedged member must not block this
      try {
        agent.send(
          '[ORCHESTRATOR] Your session is about to be replaced by a successor who ' +
          'will inherit ONLY what you write now. Reply with a compact handover: ' +
          'the goal you are pursuing, what has been decided and merged, the state ' +
          'of everyone you are working with, open threads, and what happens next. ' +
          'Facts and decisions, not narrative.'
        );
      } catch {
        done(); // a dead transport has no handover, but must not block its successor
      }
    });
  }

  /**
   * `/autocompact 300k` — the compaction window, changed from the throne room
   * instead of by editing kingdom.config.json and restarting.
   *
   * Typed at the orchestrator it sets the court-wide default; typed into a member's own
   * pane it sets that member's, which is how the briefer came to sit at 20k
   * while everyone else runs at 80k. Returns the line to show the sovereign, so
   * a mistyped window answers in the throne room rather than being posted to
   * the orchestrator as if it were work.
   */
  #compactCommand(text, name = null) {
    // Whole word only — see #argueCommand: \b matches before a hyphen, so
    // "/compact-the-log" was being parsed as the command plus an argument.
    const m = /^\/(?:autocompact|compact)(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
    if (!m) return null;

    const who = name ?? 'the court';
    const current = this.#recycleThreshold(name ?? this.config.orchestrator.name);
    const arg = (m[1] ?? '').trim();
    // A bare `/autocompact` asks rather than sets — the same shape as every
    // other read-only status command, and it costs nothing to get wrong.
    if (!arg) return this.#compactSay(`Compaction window for ${who}: ${fmtTokens(current)} tokens.`);

    const want = parseWindow(arg);
    if (want.error) return this.#compactSay(want.error);

    let tokens = want.tokens;
    if (want.auto) {
      tokens = autoWindow(this.#contextHistory(name), current);
      if (tokens === null) {
        return this.#compactSay(
          `Not enough uncensored context history to re-derive a window for ${who} — `
          + `keeping ${fmtTokens(current)}. (Compaction truncates the tail it would `
          + `be measured from, so a p90 sitting near the current window proves nothing.)`);
      }
    }

    this.setCompactWindow(name, tokens);
    return this.#compactSay(
      `Compaction window for ${who}: ${fmtTokens(current)} → ${fmtTokens(tokens)} tokens`
      + `${want.auto ? ' (p90 of measured contexts)' : ''}.`);
  }

  /**
   * `/argue should we drop the settle window?` — two models argue it, a third
   * judges, and the verdict lands in the vault.
   *
   * Fire and report, never awaited: this is three to five model calls and
   * holding the throne room open for it would look like a hang. The sovereign
   * gets an acknowledgement now and the verdict when it exists — the same
   * shape the advisor's rewrite already uses.
   */
  #argueCommand(text) {
    // NOT \b after the name: a word boundary sits between "argue" and the
    // hyphen in "/argue-with-me", so \b matched it and swallowed an ordinary
    // message as a command. The name must be the WHOLE word.
    const m = /^\/(?:argue|debate)(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
    if (!m) return null;

    const question = (m[1] ?? '').trim();
    if (!question) {
      return this.#compactSay('Nothing to argue. Try: /argue should the settle window be longer?');
    }

    const panel = pickPanel(this.config);
    if (!panel) {
      return this.#compactSay(
        'The argument court needs two different models to argue and a third to judge, '
        + 'and this kingdom has only one configured. Add models to kingdom.config.json.');
    }

    const who = (s) => `${s.cli}/${s.model}`;
    this.#runArgument(question, panel).catch((e) =>
      this.emit('argued', { question, error: e.message }));

    return this.#compactSay(
      `Arguing: "${question.slice(0, 90)}${question.length > 90 ? '…' : ''}"\n`
      + `${panel.arguers.map(who).join(' vs ')}, judged by ${who(panel.judge)} (${panel.quality}). `
      + `The verdict goes to the vault.`);
  }

  /**
   * @param tell  who learns the verdict. The sovereign's own /argue tells the
   *   orchestrator; a question the COURT put tells whoever put it, and nobody
   *   else. Telling both doubles the notice, and one of the two copies lands
   *   in the orchestrator's context — the scarcest thing in the kingdom — for a
   *   question it never asked.
   */
  async #runArgument(question, panel, { tell = null } = {}) {
    this.emit('argued', { question, stage: 'start', panel });
    // Seam: a test must be able to exercise the vault write and the orchestrator's
    // notice without spawning three real CLIs and spending real money.
    const result = await (this.argueImpl ?? argue)(question, {
      panel,
      cwd: this.#cwd(),
      onProgress: (p) => this.emit('argued', { question, ...p }),
      onTelemetry: (data) => this.#recordAuxCall(data),
    });

    // The vault, not the bus: a verdict is a decision worth having in six
    // months, and the bus is pruned. Written before the orchestrator is told, so the
    // note it is pointed at always exists.
    let path = null;
    if (this.config.vault) {
      const dir = join(this.config.vault, this.config.vaultWriteDir ?? 'Kingdom', 'Decisions');
      mkdirSync(dir, { recursive: true });
      const name = question.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
      path = join(dir, `${name || 'argument'}.md`);
      writeFileSync(path, verdictNote(result, new Date().toISOString().slice(0, 10)));
      mirrorToProject(this.repo, this.config.vault, path);
    }

    // A NOTICE, not a message: the recipient did not ask to be interrupted and
    // does not have to act on it, so it rides along with real traffic instead
    // of buying a full context replay of its own.
    const to = tell ?? this.config.orchestrator.name;
    this.bus.post(CROWN, to,
      (tell
        ? `AWARENESS ONLY — the argument court settled the question you put to it.\n`
        : `AWARENESS ONLY — the argument court settled a question for the sovereign.\n`)
      + `Q: ${question}\n${result.verdict}\n`
      + (path ? `Full argument: ${path}` : ''),
      'notice');

    this.emit('argued', { question, stage: 'done', verdict: result.verdict, path });
    return result;
  }

  #compactSay(message) {
    this.emit('compact', { message });
    return message;
  }

  /** Every context size this member's turns have actually reported. */
  #contextHistory(name) {
    // Filtered in SQL. events() JSON.parses every row it returns, so asking for
    // 100,000 and keeping the turn_ends parsed the entire log to read a handful
    // of integers — the exact waste the `type` parameter was added for, by a
    // caller that did not get the memo.
    return this.#turnEndRows().filter((e) => !name || e.agent === name)
      .map((e) => e.payload?.ctx ?? 0);
  }

  /** Persisted, so the window survives the restart it was set to avoid. */
  setCompactWindow(name, tokens) {
    const target = name ? this.specOf(name) : this.config;
    if (!target) throw new Error(`No such member of the court: ${name}`);
    target.recycleAtTokens = tokens;
    this.#persistConfig();
    return tokens;
  }

  #recycleThreshold(name) {
    const spec = this.specOf(name) ?? {};
    // Cost per turn scales with context, so recycling EARLY is cheaper than
    // letting a member coast to the model's limit. The observed orchestrator reached
    // 227k and replayed it every turn; at 70k the average replay is a third of
    // that, and one handover turn per cycle is far cheaper than the difference.
    return spec.recycleAtTokens
      ?? this.config.recycleAtTokens
      ?? (name === this.config.briefer.name ? 50_000 : 70_000);
  }

  // --- sovereign actions ----------------------------------------------

  /**
   * Change a court member's CLI and/or model from the throne room, persisting
   * it to kingdom.config.json. An awake member is restarted; it resumes its
   * session (and its memory) on the new model, unless the CLI changed — a codex
   * thread id is meaningless to claude, so that starts a fresh session.
   */
  async setModel(name, { cli, model, effort, auto, byAdvisor }) {
    const spec = this.specOf(name);
    if (!spec) throw new Error(`No such member of the court: ${name}`);

    // "Auto" hands this member's model AND effort to the advisor, which picks
    // them together for each task — the sovereign's own Model Guidance couples
    // them (Luna wants max, Terra wants high), so choosing one by hand and the
    // other automatically would be picking along the wrong axis. Selecting Auto
    // in EITHER dropdown therefore sets both. Picking a concrete model clears it.
    if (auto !== undefined) {
      if (auto) spec.auto = true;
      else delete spec.auto;
      this.#persistConfig();
      this.#publishRoster();
      // Turning Auto OFF without naming a replacement must only clear the flag.
      // Falling through would reach `else delete spec.model` below and silently
      // wipe the member's model, restarting it on the CLI default — a config
      // this method persists, so the loss would survive the session.
      if (auto || (!cli && !model)) return { name, auto: Boolean(auto) };
    } else if ((cli || model) && !byAdvisor) {
      // The SOVEREIGN naming a model means "stop choosing for me". The ADVISOR
      // naming one is Auto doing its job, and must not switch itself off —
      // without this distinction Auto worked exactly once, then silently
      // pinned the member to whatever the first task happened to want.
      delete spec.auto;
    }

    const prevCli = spec.cli ?? 'claude';
    if (cli) spec.cli = cli;
    if (model) spec.model = model;
    else delete spec.model; // fall back to that CLI's own default

    // undefined = leave alone (a model-only change); '' = back to the CLI default.
    if (effort !== undefined) {
      if (effort) spec.effort = effort;
      else delete spec.effort;
    }

    // Haiku has no effort levels, so an effort left over from the previous
    // model is meaningless. Switching models via the dropdown used to strand
    // one here — see the sovereign's own Model Guidance.
    if (NO_EFFORT_MODELS.some((m) => (spec.model ?? '').includes(m))) delete spec.effort;
    this.#persistConfig();

    const cliChanged = (spec.cli ?? 'claude') !== prevCli;

    if (this.agents.has(name)) {
      const old = this.agents.get(name);
      const convId = old.conversationId ?? this.#activeConv(name);
      // A CLI switch throws the session away. Take a handover first — losing a
      // member's memory silently is how an orchestrator ended up asking the sovereign
      // what it had been working on.
      //
      // Flagged BEFORE the await: capturing a handover takes up to 120s and the
      // member stays in the roster throughout, so without this the backstop
      // delivers into it, acks, and stop() takes the batch with it.
      old.recycling = true;
      const note = cliChanged ? await this.#captureHandover(old) : null;
      old.stop();
      this.agents.delete(name);
      // Scoped to the ACTIVE conversation only — a model/CLI change while
      // conversation B is open must not silently invalidate conversation A's
      // saved session, which the sovereign would find reset on switching back.
      if (cliChanged) this.bus.set(`session:${name}:${convId}`, '');
      await this.#spawn(name, note || null, convId);
      this.bus.post(CROWN, name,
        `AWARENESS ONLY — TAKE NO ACTION. The sovereign changed your model to ` +
        `${spec.cli ?? 'claude'}${spec.model ? ' / ' + spec.model : ' (default)'}` +
        `${spec.effort ? ' at ' + spec.effort + ' effort' : ''}. ` +
        (cliChanged
          ? 'Your session did not carry over; your predecessor left you a handover.'
          : 'Your memory is intact.'),
        'notice');
    } else if (cliChanged) {
      // Asleep, but its stored session belongs to the OLD cli and would be
      // meaningless (or invalid) to the new one.
      this.bus.set(`session:${name}:${this.#activeConv(name)}`, '');
    }
    this.#publishRoster();
    return { name, cli: spec.cli ?? 'claude', model: spec.model ?? null,
      effort: spec.effort ?? null, cliChanged };
  }

  /** Wake a peasant directly, without waiting for the orchestrator to propose it. */
  async wake(name, { by = 'sovereign', approvalId = null } = {}) {
    if (this.agents.has(name)) return this.agents.get(name);
    this.spawnFailed?.delete(name);   // a sovereign asking again is not the retry storm
    const agent = await this.#spawn(name);
    if (!agent) throw new Error(`Could not wake "${name}".`);
    // `summoned` is the durable history a Set cannot carry: a restart can
    // restore a member, but it must never look like a second sovereign spend.
    this.bus.logEvent(name, 'summoned', { by, approvalId });
    return agent;
  }

  /** Explicit stop: leaves service entirely, unlike an idle sleep. */
  sleep(name, why) {
    this.agents.get(name)?.stop(why);
    this.agents.delete(name);
    this.summoned.delete(name);
    this.bus.set('summoned', JSON.stringify([...this.summoned]));

    // A dismissed member cannot finish what it claimed, and nothing reconciled
    // those two facts. Watched live: "backend" finished task #3 and claimed #5
    // (the CLI integration everything else was waiting on) while #3 was still
    // in review. #3 merged, mergeWork() called sleep() to drop the worktree —
    // and #5 was left active, owned by somebody the court no longer had.
    //
    // It cannot recover on its own. claim_task refuses a task that has an
    // owner, so no other peasant may take it; the orchestrator reads "active"
    // as work in hand and reports progress. The build stopped and the board
    // said it was running.
    //
    // Here rather than in mergeWork because every dismissal has the same hole:
    // dismiss_member and the sovereign's own /sleep orphan a task just as
    // quietly. Released rather than reassigned — the list exists so an idle
    // peasant can claim the next thing, and picking the claimant is the
    // orchestrator's job, not a side effect of a merge.
    const stranded = this.bus.tasks().filter((t) => t.owner === name && t.state !== 'done');
    const strandedLoss = this.#releaseHeldTasks(stranded);
    if (stranded.length) {
      this.bus.post(CROWN, this.config.orchestrator.name,
        `"${name}" left service still holding ${stranded.map((t) => `#${t.id} (${t.title})`).join(', ')}. `
        + `${stranded.length === 1 ? 'It is' : 'They are'} unclaimed again and can be picked up by `
        + 'anyone — assign or summon somebody, because nobody is working on '
        + `${stranded.length === 1 ? 'it' : 'them'} now.${strandedLoss}`, 'notice');
    }

    this.emit('agent', { name, state: 'exited' });
    this.#publishRoster();
  }

  /**
   * Freeze the court without dismissing anyone: nobody on the roster gets a
   * new turn, but nothing is stopped mid-turn and nothing is stood down. Use
   * this when work needs to stop for a beat — a review, a suspected loop, a
   * change the sovereign wants to make first — without paying to re-summon
   * and re-brief the whole crew afterward the way `sleep()` on everyone would.
   */
  pause(why = '') {
    if (this.paused) return { changed: false };
    this.paused = true;
    this.bus.set('paused', '1');
    // Durable, not just an in-memory emit: a browser that reconnects (or a
    // fresh tab) while the court is paused must see WHY, not just that it
    // is — see the sidebar's pause banner and its raise-turn-budget action.
    this.bus.set('pausedWhy', why ?? '');
    // Only a running run pauses: the state table allows nothing else, and a
    // planning run moved to paused would resume straight into running with
    // its plan never approved.
    const run = this.#activeRun();
    if (run?.state === 'running') this.bus.pauseRun(run.id);
    this.emit('paused', { paused: true, why });
    this.bus.post(CROWN, this.config.orchestrator.name,
      `The court is paused${why ? `: ${why}` : ''}. Nobody will be given a new turn until resume_court.`,
      'notice');
    return { changed: true };
  }

  resume() {
    if (!this.paused) return { changed: false };
    this.paused = false;
    this.bus.set('paused', '0');
    const run = this.#activeRun();
    if (run?.state === 'paused') this.bus.resumeRun(run.id);
    this.emit('paused', { paused: false });
    this.bus.post(CROWN, this.config.orchestrator.name, 'The court has resumed.', 'notice');
    return { changed: true };
  }

  /**
   * The court-wide spend ceiling, live. `maxKingdomUsd` in kingdom.config.json
   * only ever took effect at the process that read the file — a court running
   * hot had no lever except a restart, which is itself billed and loses no
   * spend at all in the meantime. 0 clears the ceiling.
   */
  setBudget(capUsd) {
    const cap = Number(capUsd);
    if (!Number.isFinite(cap) || cap < 0) throw new Error('The ceiling must be a number, 0 or more.');
    this.bus.set('maxKingdomUsd', String(cap));
    this.emit('budget', { scope: 'kingdom', cap, changed: true });
    return { cap };
  }

  /** The live ceiling if one has ever been set here, else the config default. */
  #kingdomBudget() {
    const live = this.bus.get('maxKingdomUsd');
    return live != null ? Number(live) : (this.config.maxKingdomUsd ?? 0);
  }

  /**
   * A per-session turn budget, counting every real turn across the whole
   * court — issue #41: the orchestrator "drained usage like crazy" with no
   * ceiling on turns at all, only on dollars, and a court running an unpriced
   * or misconfigured model has no dollar signal until long after the damage.
   * 0 clears the ceiling, the same convention as setBudget()/maxKingdomUsd
   * above. Checked against turnsThisSession(), NOT the lifetime count — see
   * the long comment on the baseline in start() for exactly what "session"
   * means here and why.
   */
  setTurnBudget(cap) {
    const n = Number(cap);
    if (!Number.isFinite(n) || n < 0) throw new Error('The turn budget must be a number, 0 or more.');
    this.bus.set('turnBudget', String(n));
    // An explicitly set budget replaces any "add N turns" extension granted
    // earlier in this session; the sovereign asked for exactly this cap.
    this.bus.set('turnBudgetExtra', '0');
    this.emit('budget', { scope: 'turns', cap: this.sessionTurnCap(), turns: this.turnsThisSession(), changed: true });
    // A cap lowered (or switched on) below what this session has already
    // taken must bite now, not after the next turn_end — another turn, or
    // several concurrent ones, would otherwise overshoot it.
    this.#enforceTurnBudget();
    return { cap: n };
  }

  /** The live turn-budget override if one has ever been set here, else the config default. */
  turnBudget() {
    const live = this.bus.get('turnBudget');
    const raw = live != null ? live : (this.config.turnBudget ?? DEFAULT_TURN_BUDGET);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    // A malformed value must not switch the runaway guard off (NaN is falsy,
    // which sessionTurnCap() reads as "off"). Fall back to the default and
    // say so once, rather than throwing from the per-turn path.
    if (!this.warnedTurnBudget) {
      this.warnedTurnBudget = true;
      if (this.listenerCount('error')) {
        this.emit('error', new Error(`turnBudget ${JSON.stringify(raw)} is not a number 0 or more; `
          + `using the default of ${DEFAULT_TURN_BUDGET} turns.`));
      }
    }
    return DEFAULT_TURN_BUDGET;
  }

  /**
   * The cap this session is actually held to: the configured budget plus any
   * "add N turns" extension the sovereign granted during this session. 0 when
   * the budget is off. The extension resets with the session (see start()),
   * so raising it once never shrinks or grows the budget of a later session.
   */
  sessionTurnCap() {
    const base = this.turnBudget();
    return base ? base + Number(this.bus.get('turnBudgetExtra') ?? 0) : 0;
  }

  /**
   * The lifetime, restart-safe count #countTurns() maintains — every real
   * turn this court has EVER taken, across every restart, same discipline as
   * spentUsd. This is what a court's whole-life history would be measured
   * against; the turn BUDGET never compares against this directly (see
   * turnsThisSession()) — that was the bug this method's sibling exists to
   * fix. Exposed publicly so daemon.js's snapshot can offer it to the UI
   * alongside the session count, per #41's "lifetime turns available if the
   * spend display needs them."
   */
  turnsLifetime() {
    return Number(this.bus.get('turns') ?? 0);
  }

  /**
   * Turns taken since the session baseline was latched (see start()) — what
   * setTurnBudget()'s cap is actually measured against, and what the header
   * shows beside it. Never negative even if a baseline predates a later
   * bus.prune() or a hand-edited bus (defensive floor, not an expected path).
   */
  turnsThisSession() {
    const baseline = Number(this.bus.get('turnBudgetBaseline') ?? 0);
    return Math.max(0, this.turnsLifetime() - baseline);
  }

  /**
   * One raise-and-resume action for the sovereign's "extend it" button: a
   * paused-for-budget court stays paused until BOTH the ceiling is actually
   * raised and delivery is told to continue — two separate calls would leave
   * a window where a still-too-low cap immediately re-pauses on the very next
   * turn with no visible change, which reads as the button doing nothing.
   *
   * `by` is how many more turns to allow from the current session count;
   * the sidebar's button sends 100.
   */
  raiseTurnBudget(by = 100) {
    const n = Number(by);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Raise the turn budget by a positive number of turns.');
    // "N more turns from right now": the session cap becomes current session
    // usage + N. Stored as a session-scoped extension, never written over the
    // configured budget, so the next session starts from the full budget again.
    const extra = Math.max(0, this.turnsThisSession() + n - this.turnBudget());
    this.bus.set('turnBudgetExtra', String(extra));
    const cap = this.sessionTurnCap();
    this.emit('budget', { scope: 'turns', cap, turns: this.turnsThisSession(), changed: true });
    this.resume();
    return { cap };
  }

  /**
   * Checked right after #countTurns() on every completed real turn, court-
   * wide. Pausing (not stopping anyone) matches how maxKingdomUsd degrades —
   * visible, reversible, nothing lost — and reuses the exact mechanism the
   * sovereign already has for a hand-pause: the same `paused` flag, the same
   * notice to the orchestrator, the same resume() to lift it. Idempotent: once
   * paused, #deliver() grants no further turns, so this cannot fire again
   * until the sovereign explicitly resumes (raiseTurnBudget, or resume()
   * without raising the cap, which buys exactly one more turn before this
   * fires again).
   */
  #enforceTurnBudget() {
    const cap = this.sessionTurnCap();
    const turns = this.turnsThisSession();
    if (!cap || turns < cap || this.paused) return;
    this.emit('budget', { scope: 'turns', turns, cap });
    this.pause(`the ${cap}-turn budget for this session was reached (${turns} taken this session) — `
      + 'raise it or the court stays paused');
  }

  /**
   * You speak to the orchestrator. Routed through the BUS, not straight into the
   * process: a goal sent directly leaves no record, so a successor orchestrator had no
   * way to discover what it was supposed to be doing and asked the sovereign
   * to re-explain. Everything the court is told must be reconstructable.
   */
  async command(text, conversationId = null, attachments = []) {
    // Settings are not work. This must precede the advisor: a prompt engineer
    // handed `/autocompact 300k` would rewrite it into a paragraph asking the
    // court to please consider compacting, and bill a turn for it.
    const local = this.#compactCommand(text) ?? this.#argueCommand(text);
    if (local) return { text: local, local: true };

    const convId = conversationId || this.#activeConv(this.config.orchestrator.name);
    const campaign = this.#beginCampaign(text);

    text = this.#skillCommand(text);
    const a = this.advisor();

    // Model selection NEVER delays the order. It only changes members that are
    // asleep — they pick it up when they next wake — so there is nothing to
    // wait for, and the advisor is allowed up to 90 seconds to answer. Awaiting
    // it put a minute and a half between the sovereign pressing enter and the
    // orchestrator hearing anything, which is the single worst thing this system can do.
    if (a.autoModel) this.#autoModelInBackground(a, text);

    if (!a.promptEngineer) {
      this.bus.post('sovereign', this.config.orchestrator.name, text, 'assignment', convId, attachments);
      return { text, campaign };
    }

    // The rewrite DOES have to block: it changes the words the court acts on,
    // so posting first would race the court against its own brief.
    this.emit('advising', { stage: 'start', text });
    const why = [];
    const opts = (job) => ({
      cwd: this.#cwd(),
      priceTable: tableFrom(this.config),
      onFail: (m) => why.push(`${job}: ${m}`),
      onTelemetry: (data) => this.#recordAuxCall(data),
    });
    const advice = await engineerPrompt(a, text, opts('prompt engineer')).catch(() => null);
    const rewritten = advice?.text ?? null;
    if (why.length) {
      this.#warn(`Advisor (${a.model}) gave no advice — ${why.join('; ')}. `
        + 'Your message went through unchanged.');
    }

    const final = rewritten ?? text;

    // The advisor switches the court without asking, in both directions. That
    // is safe because switching shape spends nothing — summoning does, and a
    // summon still raises an approval card exactly as it did before. The mode
    // decides what is POSSIBLE; the approval still decides what is paid for.
    // Queued, not applied: a member mid-turn finishes under the rules it began
    // with. No classification (advisor off, call failed, answer unparseable)
    // simply leaves the court in the shape it was already in.
    // Nothing is reported back from here: queueMode emits its own `mode` event,
    // carrying the previous shape, which is what the toast and its undo need.
    if (advice?.mode) this.queueMode(advice.mode, { why: text.slice(0, 120), by: 'advisor' });

    this.emit('advising', { stage: 'done', text, rewritten });

    // The original is recorded even when it was rewritten: the court acts on
    // the brief, but a successor reading the bus must be able to see what the
    // sovereign actually said, not only the advisor's paraphrase of it.
    if (rewritten && rewritten !== text) {
      this.bus.post('sovereign', this.config.orchestrator.name,
        `${final}\n\n---\nSovereign's original wording (for reference; the brief above is authoritative):\n${text}`,
        'assignment', convId, attachments);
    } else {
      this.bus.post('sovereign', this.config.orchestrator.name, final, 'assignment', convId, attachments);
    }
    return { text: final, rewritten, campaign };
  }

  /**
   * Pick models for this task without anyone waiting on it.
   *
   * Only SLEEPING members are changed: setModel restarts an awake one, and
   * restarting six members every time the sovereign types costs more than a
   * better model choice saves — and it interrupts work already in flight.
   * A sleeping member picks the choice up when it next wakes, which is the
   * only moment the choice actually matters.
   */
  #autoModelInBackground(a, text) {
    const why = [];
    // Kept on the instance so a caller that genuinely needs to know when the
    // picks have landed can await it — chiefly tests, which would otherwise
    // have to poll and race. Nothing in the delivery path waits on this.
    this.autoModelPending = this.#autoModel(a, text, {
      cwd: this.#cwd(),
      priceTable: tableFrom(this.config),
      onFail: (m) => why.push(m),
      onTelemetry: (data) => this.#recordAuxCall(data),
    })
      .then(async (picks) => {
        const applied = [];
        for (const [name, m] of Object.entries(picks ?? {})) {
          const spec = this.specOf(name);
          if (!spec || this.agents.has(name)) continue;
          if (spec.cli === m.cli && spec.model === m.model && spec.effort === m.effort) continue;
          try {
            await this.setModel(name, { ...m, byAdvisor: true });
            applied.push(`${name} -> ${m.model}${m.effort ? '/' + m.effort : ''}`);
          } catch { /* an advisory pick must never break the court */ }
        }
        if (applied.length) this.emit('advising', { stage: 'models', models: applied });
        else if (why.length) {
          this.#warn(`Auto model selection gave no advice — ${why.join('; ')}.`);
        }
      })
      .catch(() => { /* advisory: a failure here changes nothing */ });
  }

  /** Ask the advisor which model each member should run for THIS task. */
  #autoModel(a, goal, opts) {
    const allowAll = [
      ...(this.models().codex ?? []).map((m) => `codex/${m}`),
      ...(this.models().claude ?? []).map((m) => `claude/${m}`),
    ];
    const allowed = a.allow?.length ? a.allow.filter((x) => allowAll.includes(x)) : allowAll;
    // Only members set to Auto. A member the sovereign pinned to a model chose
    // it deliberately, and quietly moving it would make the dropdown a lie.
    // No Auto members means no advisor call at all — the pick would be discarded.
    const members = this.config.peasants.filter((p) => p.auto === true);
    if (!members.length) return Promise.resolve({});
    // Only the roles the advisor may move are relevant. outputEvidence ignores
    // pre-snapshot history instead of guessing which setting produced it.
    const measurements = outputEvidence(this.#turnEndRows(), {
      names: members.map((p) => p.name), table: tableFrom(this.config),
    });
    return pickModels(a, {
      goal,
      // The orchestrator and briefer are the sovereign's own choice of instrument; the
      // selector tunes the workers.
      members: members.map((p) => ({
        name: p.name, title: p.title, description: p.description,
      })),
      allowed,
      efforts: this.efforts().byModel ?? {},
      guidance: a.guidance,   // undefined falls back to the vault's policy
      measurements,
      table: tableFrom(this.config),
    }, opts);
  }

  /**
   * `/design-site fix the settings page` → an order that NAMES the skill.
   *
   * The body is deliberately not inlined: a pasted procedure sits in the
   * member's context for every remaining turn of its life, while a named one
   * is fetched on the turn it is needed and never replayed by the orchestrator.
   * An unrecognised /word is returned untouched — the sovereign is more often
   * typing a path or a flag than a skill.
   */
  #skillCommand(text) {
    const hit = expandSkillCommand(this.config.vault, text, this.config.vaultWriteDir ?? 'Kingdom');
    if (hit) this.emit('skill', { name: hit.name });
    return hit?.text ?? text;
  }

  /** Opening the next order is the completion marker for an open campaign. */
  #beginCampaign(text) {
    const previous = this.bus.campaigns().at(-1);
    const campaign = this.bus.beginCampaign(text);
    if (previous && this.config.vault) {
      this.bus.post(CROWN, this.config.briefer.name,
        `RETROSPECTIVE — campaign #${previous.id} just closed. Review it with campaign_history ` +
        `before proposing zero to three durable memories via remember. Do not turn transient ` +
        `status, secrets, or unverified failures into memory; the sovereign approves every note.`,
        'notice');
    }
    return campaign;
  }

  /** You type into a peasant's pane directly; the orchestrator is told so it stays coherent. */
  speakTo(name, text, conversationId = null, attachments = []) {
    // Before the orchestrator delegation: `/autocompact` in a pane is about THAT
    // member's window, and routing the orchestrator's pane to command() would quietly
    // turn it into the court-wide default.
    const local = this.#compactCommand(text, name) ?? this.#argueCommand(text);
    if (local) return { text: local, local: true };
    text = this.#skillCommand(text);
    if (name === this.config.orchestrator.name) return this.command(text, conversationId, attachments);
    this.#beginCampaign(text);
    // A peasant has no multi-conversation UI, so its pane always stays
    // 'default'. Attachments still travel with that durable assignment.
    this.bus.post('sovereign', name, text, 'assignment', 'default', attachments);
    // Framing matters: an earlier version phrased this as a plain report and
    // the orchestrator obediently carried out the peasant's instruction itself.
    this.bus.post(CROWN, this.config.orchestrator.name,
      `AWARENESS ONLY — THIS IS NOT AN ORDER TO YOU. TAKE NO ACTION.\n` +
      `The sovereign has spoken directly to "${name}". What they said to ${name} ` +
      `was: "${text}"\nYou are told only so you are not surprised by what ` +
      `${name} does next. Do not perform this task yourself and do not reply.`,
      'notice'); // FYI: rides along with real traffic instead of costing its own turn
  }

  async approve(id) {
    const p = this.approvals.get(id);
    if (!p) throw new Error(`No pending approval ${id}`);
    if (p.kind === 'summon') {
      // The bench is the mode's, and this is where that is enforced — not at
      // the summon tool. A proposal can outlive the mode it was made in: the
      // card sits in the corner until the sovereign answers it, and a flip in
      // between would otherwise wake a crew this mode does not have.
      const barred = p.names.filter((n) => !canSummon(this.mode(), n, this.roleOf(n)));
      if (barred.length) {
        this.approvals.delete(id);
        this.bus.set(`resolved:${id}`, 'rejected');
        const why = `${barred.join(', ')} ${barred.length === 1 ? 'is' : 'are'} not on the `
          + `${modeOf(this.mode()).label} bench, so nobody was woken. Propose from this mode's `
          + `crew, or ask the sovereign to switch modes.`;
        this.bus.post(CROWN, this.config.orchestrator.name, why);
        this.emit('resolved', { id, approved: false });
        return;
      }
      // In parallel: each wake is its own git worktree, and they do not touch
      // each other. If one fails, the approval is blocked and only members
      // started by this approval are stood down; an existing standing member
      // remains untouched.
      const beforeAgents = new Set(this.agents.keys());
      const beforeSummoned = new Set(this.summoned);
      const results = await Promise.allSettled(p.names.map((n) =>
        this.wake(n, { by: p.from ?? 'orchestrator', approvalId: id })));
      const failed = results
        .map((r, i) => r.status === 'rejected' ? `${p.names[i]}: ${r.reason?.message ?? r.reason}` : null)
        .filter(Boolean);
      if (failed.length) {
        for (const name of p.names) {
          if (!beforeAgents.has(name) && this.agents.has(name)) {
            this.sleep(name);
            if (beforeSummoned.has(name)) this.summoned.add(name);
          } else if (!beforeSummoned.has(name)) {
            this.summoned.delete(name);
          }
        }
        this.bus.set('summoned', JSON.stringify([...this.summoned]));
        this.#publishRoster();
        this.approvals.delete(id);
        this.bus.set(`resolved:${id}`, 'blocked');
        const message = `The sovereign approved your summons, but it was not completed: ${failed.join('; ')}.`;
        this.bus.post(CROWN, this.config.orchestrator.name, message, 'notice');
        this.emit('resolved', { id, approved: false, blocked: true });
        throw new Error(message);
      }
      this.approvals.delete(id);
      this.bus.set(`resolved:${id}`, 'approved');
      this.bus.post(CROWN, this.config.orchestrator.name,
        `The sovereign approved your summons: ${p.names.join(', ')} are awake. Assign their work.`);
    } else if (p.kind === 'role') {
      // The sovereign approving a role is not validation — they are ruling on
      // whether the court needs it, having read a description an LLM wrote. The
      // NAME becomes a directory under wt/ and a git branch, so a traversal in
      // it reaches renameSync, `git add -A` and `worktree remove --force`.
      // Checked here as well as in propose_role because this is the boundary
      // that actually writes to disk.
      const bad = badRole(p, { taken: this.config.peasants.map((x) => x.name) });
      if (bad) throw new Error(`Cannot create that role: ${bad}`);
      this.config.peasants.push({
        name: p.name, cli: p.cli, model: p.model, prompt: p.prompt, description: p.reason,
      });
      this.#persistConfig();
      this.#publishRoster();
      this.approvals.delete(id);
      this.bus.set(`resolved:${id}`, 'approved');
      this.bus.post(CROWN, this.config.orchestrator.name,
        `The sovereign approved the new role "${p.name}". It is in the roster permanently.`);
    } else if (p.kind === 'merge') {
      // Consumed exactly once, before the awaited merge — not after — or a
      // concurrent reject()/approve() on the same id can still find it while
      // the merge is in flight and race a card whose merge already landed.
      this.approvals.delete(id);
      try {
        await this.merge(p.peasant);
        this.bus.set(`resolved:${id}`, 'approved');
      } catch (e) {
        // this.merge() already posted a notice and emitted 'mergeFailed' for
        // the Changes view; that is per-peasant, transient state. Without a
        // `resolved:${id}` of its own, the card itself never gets a decided
        // outcome — it was already removed from the live map above, so it
        // silently vanishes from "waiting on you" with no historical row at
        // all. Mirror the 'push' branch right below: record a blocked
        // resolution and its message so the card carries a real outcome.
        const message = e.message;
        this.bus.set(`resolved:${id}`, 'blocked');
        this.bus.set(`merge:${id}`, JSON.stringify({ status: 'blocked', message }));
        this.emit('resolved', { id, approved: false, blocked: true });
        return;
      }
    } else if (p.kind === 'push') {
      // A push approval is consumed exactly once. Whether Git succeeds is a
      // separate fact, recorded on the historical card instead of retried.
      this.approvals.delete(id);
      try {
        const out = await pushBase(this.repo, this.base);
        const message = `Pushed ${out.branch} to configured remote ${out.remote}.`;
        this.bus.set(`resolved:${id}`, 'approved');
        this.bus.set(`push:${id}`, JSON.stringify({ status: 'pushed', message, ...out }));
        this.bus.post(CROWN, this.config.orchestrator.name, message, 'notice');
        this.emit('pushed', { id, ...out });
      } catch (e) {
        const message = e.message;
        this.bus.set(`resolved:${id}`, 'blocked');
        this.bus.set(`push:${id}`, JSON.stringify({ status: 'blocked', message }));
        this.bus.post(CROWN, this.config.orchestrator.name,
          `The sovereign approved a push, but it did not happen. ${message}`, 'notice');
        this.emit('pushBlocked', { id, message });
        this.emit('resolved', { id, approved: false, blocked: true });
        return;
      }
    } else if (p.kind === 'memory') {
      if (!this.config.vault) throw new Error('Cannot approve a memory: this kingdom has no vault.');
      if (typeof p.title !== 'string' || !p.title.trim() || typeof p.body !== 'string' || !p.body.trim()) {
        throw new Error('Cannot approve a memory without a title and body.');
      }
      const at = remember(this.config.vault, {
        title: p.title, body: p.body, tags: Array.isArray(p.tags) ? p.tags : [],
        by: p.from ?? 'court', dir: this.config.vaultWriteDir ?? 'Kingdom',
      });
      noteWritten(this.config.vault, join(this.config.vault, at));
      mirrorToProject(this.repo, this.config.vault, join(this.config.vault, at));
      this.approvals.delete(id);
      this.bus.set(`resolved:${id}`, 'approved');
      this.bus.post(CROWN, this.config.orchestrator.name,
        `The sovereign approved memory from campaign #${p.campaign}: ${p.title}`);
    }
    this.emit('resolved', { id, approved: true });
  }

  /** Request one outward push; the next action is always an approval card. */
  requestPush(reason = '', from = this.config.orchestrator.name) {
    this.bus.post(from, null, JSON.stringify({ kind: 'push', reason: String(reason) }), 'approval');
    return { requested: true };
  }

  requestSummon(names, reason = '', from = 'sovereign') {
    const roster = this.#members();
    const error = badSummon({ names, reason }, { roster });
    if (error) return { ok: false, error };
    this.bus.post(from, null, JSON.stringify({ kind: 'summon', names, reason: String(reason) }), 'approval');
    return { ok: true, requested: true };
  }

  reject(id, why = '') {
    const p = this.approvals.get(id);
    if (!p) throw new Error(`No pending approval ${id}`);
    this.approvals.delete(id);
    this.bus.set(`resolved:${id}`, 'rejected');
    this.bus.post(CROWN, this.config.orchestrator.name,
      `The sovereign REJECTED your ${p.kind} proposal. ${why}`);
    this.emit('resolved', { id, approved: false });
  }

  /**
   * A question can come from any role, unlike summon/role/merge which are
   * always the orchestrator's — so the reply goes to whoever actually asked
   * (`p.from`, carried through by #surfaceApprovals), not a hardcoded name.
   */
  answerQuestion(id, answers) {
    const p = this.approvals.get(id);
    if (!p) throw new Error(`No pending question ${id}`);
    if (p.kind !== 'question') throw new Error(`Approval ${id} is not a question`);
    this.approvals.delete(id);
    this.bus.set(`resolved:${id}`, 'answered');
    const text = p.questions.map((q, i) =>
      `${q.question}\n${(answers[i] ?? []).join(', ') || '(no answer)'}`).join('\n\n');
    // CROWN, not p.from: bus.pending() drops rows where sender === reader, so
    // posting as the asker swallowed the answer before delivery (#54).
    this.bus.post(CROWN, p.from, `The sovereign answered:\n\n${text}`);
    this.emit('resolved', { id, approved: true });
  }

  async merge(peasant) {
    // The last gate, and the one that matters. The MCP tool for this is already
    // withheld outside Code and the prompt already says so, but neither of
    // those is a guarantee: the tool list is advisory to a model, and the
    // sovereign's own Merge button reaches this method directly. Cowork
    // promises that nothing lands on the base branch, and a promise
    // enforced only by asking nicely is not one.
    const m = modeOf(this.mode());
    if (!m.merge) {
      const why = `Nothing merges in ${m.label} mode, so "${peasant}"'s work was not merged and `
        + `${this.base} is untouched. The work is on its own branch — switch to Code mode to `
        + `land it, or take what you want from the branch by hand.`;
      this.bus.post(CROWN, this.config.orchestrator.name, why, 'notice');
      this.emit('mergeFailed', { peasant, message: why });
      throw new Error(why);
    }

    let out;
    try {
      out = await mergeWorktree(this.repo, peasant, this.base);
    } catch (e) {
      // Conflicts and dirty trees are expected outcomes, not crashes: tell the
      // orchestrator so it can send the work back, and leave the repo untouched.
      this.bus.post(CROWN, this.config.orchestrator.name,
        `The merge of "${peasant}" did NOT happen and nothing was changed.\n${e.message}`);
      this.emit('mergeFailed', { peasant, message: e.message });
      throw e;
    }

    // Confirmation of something the orchestrator itself asked for, so it rides along
    // rather than buying a turn. The FAILURE path above stays a message on
    // purpose: that one needs a decision (send the work back), this one does not.
    this.bus.post(CROWN, this.config.orchestrator.name,
      `"${peasant}"'s work is merged into ${this.base}.`, 'notice');
    this.emit('merged', { peasant, output: out });

    // Merged work needs no worktree; the branch stays for history.
    this.sleep(peasant);
    await removeWorktree(this.repo, peasant).catch(() => {});
    this.bus.set(`session:${peasant}:${this.#activeConv(peasant)}`, ''); // its next task starts clean
    return out;
  }
}

/**
 * This kingdom's own config, copied from the shipped template the first time.
 *
 * The fallback used to be the app's own kingdom.config.json — the tracked one —
 * and every model change, goal edit, advisor toggle and milestone tick then
 * rewrote it. So the repo carried a 134KB file that produced a diff every
 * session, held one machine's absolute paths (an Obsidian vault on E:), and was
 * shared by every court that never happened to have a local copy: two daemons
 * on two repos read-modify-writing one file, losing each other's edits.
 *
 * Copying once makes the tracked file a template that is only ever READ, and
 * gives each repo its own state. kingdomDir is already gitignored.
 */
export function defaultConfigPath(repo) {
  const local = join(kingdomDir(repo), 'kingdom.config.json');
  const template = join(HERE, '..', 'kingdom.config.json');
  if (existsSync(local)) return local;
  try {
    mkdirSync(dirname(local), { recursive: true });
    copyFileSync(template, local);
    return local;
  } catch {
    return template;   // read-only disk, no template: degrade, never fail to start
  }
}
