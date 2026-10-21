// rename-keep: this module names the Kingdom-era words on purpose.
//
// The one-time move from the app's Kingdom-era names to its plain ones
// (docs/RENAME.md, "2026-10-21 revision": migrate once, do not orphan). Every
// function here is idempotent and conservative:
//
//  - nothing is ever overwritten. When an old and a new copy both exist the
//    new one wins, the old one is left exactly where it is, and that is said
//    out loud through `warn`;
//  - a move that fails (a file held open by an older copy of the app on
//    Windows) leaves everything in place and the old location keeps working;
//  - each step is a no-op once done, so running on every launch is safe.
//
// scripts/rename/ excludes this file, so the codemod never rewrites it, and
// test/t-legacy-migrate.js plants every legacy shape it reads.
import { existsSync, renameSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** The old names, in one place. */
export const LEGACY = Object.freeze({
  dir: '.kingdom',
  db: 'kingdom.db',
  config: 'kingdom.config.json',
  registry: 'courts.json',
  registryKey: 'courts',
  envPrefix: 'KINGDOM_',
  branchPrefix: 'kingdom/',
  userData: 'kingdom',
  prefsKey: 'kd.prefs',
  mcpServer: 'kingdom',
  vaultDir: 'Kingdom',
});

/** The names they became. */
export const CURRENT = Object.freeze({
  dir: '.agenticos',
  db: 'agenticos.db',
  config: 'agenticos.config.json',
  registry: 'teams.json',
  envPrefix: 'AGENTICOS_',
  branchPrefix: 'agenticos/',
});

/** Set by test/run-all.js so a suite run on a developer's machine never moves their real ~/.kingdom. */
export const SKIP_ENV = 'AGENTICOS_SKIP_LEGACY_MIGRATION';

const once = new Set();
/** The default warning: once per message per process, on stderr (stdout is MCP's protocol channel). */
export function warnOnce(message) {
  if (once.has(message)) return;
  once.add(message);
  console.warn(`[agenticos] ${message}`);
}

/* ------------------------------------------------------------- env vars */

/** KINGDOM_COURTS_REGISTRY -> AGENTICOS_TEAMS_REGISTRY, KINGDOM_DB -> AGENTICOS_DB. */
export function currentEnvName(legacyName) {
  return CURRENT.envPrefix + legacyName.slice(LEGACY.envPrefix.length).replace(/(^|_)COURTS(?=_|$)/g, '$1TEAMS');
}

/**
 * Read every KINGDOM_* variable as a fallback for its AGENTICOS_* name: copied
 * across when the new one is unset, ignored (and said so) when both are set.
 * One warning per process, naming each variable, so the user can rename them.
 */
export function applyLegacyEnv(env = process.env, warn = warnOnce) {
  const used = [];
  const ignored = [];
  for (const k of Object.keys(env)) {
    if (!k.startsWith(LEGACY.envPrefix)) continue;
    const now = currentEnvName(k);
    if (env[now] === undefined) {
      env[now] = env[k];
      used.push(`${k} -> ${now}`);
    } else if (env[now] !== env[k]) ignored.push(`${k} (${now} is set and wins)`);
  }
  if (used.length) warn(`read legacy environment variable(s): ${used.join(', ')}. Rename them; the old names are a fallback only.`);
  if (ignored.length) warn(`ignored legacy environment variable(s): ${ignored.join(', ')}.`);
  return { used, ignored };
}

/* ------------------------------------------------------------ the disk */

/**
 * Move `from` to `to` unless `to` already exists. Returns 'none' (nothing to
 * move), 'moved', 'both' (new wins, old left alone) or 'failed' (old kept).
 */
export function moveOnce(from, to, warn = warnOnce, what = 'state') {
  if (!existsSync(from)) return 'none';
  if (existsSync(to)) {
    warn(`${what}: both ${from} and ${to} exist. Using ${to}; ${from} was left untouched.`);
    return 'both';
  }
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return 'moved';
  } catch (e) {
    warn(`${what}: could not move ${from} to ${to} (${e.code ?? e.message}). Still using the old location; `
      + 'close any older copy of the app and start again to finish the move.');
    return 'failed';
  }
}

const removeIfEmpty = (dir) => {
  try { if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir); } catch { /* not ours to force */ }
};

/**
 * Inside one state directory: kingdom.db (with its -wal and -shm, which hold
 * committed pages SQLite has not checkpointed yet, so they move with it or
 * not at all) and kingdom.config.json take their new names.
 */
export function renameStateFiles(dir, warn = warnOnce) {
  const out = { db: 'none', config: 'none' };
  if (!dir || !existsSync(dir)) return out;
  const parts = ['', '-wal', '-shm'];
  const legacyDb = join(dir, LEGACY.db);
  const currentDb = join(dir, CURRENT.db);
  if (existsSync(legacyDb)) {
    if (parts.some((p) => existsSync(currentDb + p))) {
      warn(`database: both ${legacyDb} and ${currentDb} exist. Using ${currentDb}; the old one was left untouched.`);
      out.db = 'both';
    } else {
      const done = [];
      try {
        // The journal files first and the database last: if anything fails,
        // what was moved goes back, and the old name still opens whole.
        for (const p of ['-wal', '-shm', '']) {
          if (!existsSync(legacyDb + p)) continue;
          renameSync(legacyDb + p, currentDb + p);
          done.push(p);
        }
        out.db = 'moved';
      } catch (e) {
        for (const p of done) { try { renameSync(currentDb + p, legacyDb + p); } catch { /* best effort */ } }
        warn(`database: could not rename ${legacyDb} (${e.code ?? e.message}); still using it under its old name.`);
        out.db = 'failed';
      }
    }
  }
  out.config = moveOnce(join(dir, LEGACY.config), join(dir, CURRENT.config), warn, 'config');
  return out;
}

/** Old file name when only the old one exists (a move that failed), else the new one. */
export function stateFile(dir, current, legacy) {
  const now = join(dir, current);
  const old = join(dir, legacy);
  return !existsSync(now) && existsSync(old) ? old : now;
}

const isWorktree = (p) => { try { return statSync(join(p, '.git')).isFile(); } catch { return false; } };

/**
 * A moved state directory carries agent and run worktrees (wt/<name>,
 * runs/<id>) whose registration in the repository still names the old path.
 * `git worktree repair <new paths>` rewrites both directions of the link.
 */
export function repairWorktrees(repo, dir, warn = warnOnce) {
  const paths = [];
  for (const sub of ['wt', 'runs']) {
    const root = join(dir, sub);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) if (isWorktree(join(root, name))) paths.push(join(root, name));
  }
  if (!paths.length || !existsSync(join(repo, '.git'))) return paths.length ? [] : paths;
  try {
    execFileSync('git', ['worktree', 'repair', ...paths], { cwd: repo, stdio: 'pipe', windowsHide: true });
    return paths;
  } catch (e) {
    warn(`worktrees under ${dir} moved but git could not re-link them (${String(e.stderr ?? e.message).trim()}). `
      + `Run "git worktree repair" in ${repo}.`);
    return [];
  }
}

/** Where a repo's pre-rename state lived: <parent>/.kingdom/<name>. */
export const legacyStateDir = (repo) => {
  const r = resolve(repo);
  return join(dirname(r), LEGACY.dir, basename(r));
};

/**
 * <parent>/.kingdom/<repo>/ -> <parent>/.agenticos/<repo>/, its db and
 * config renamed, its worktrees re-linked. Returns the directory to use: the
 * new one, or the old one if it could not be moved.
 */
export function migrateRepoState(repo, { warn = warnOnce } = {}) {
  const r = resolve(repo);
  const from = legacyStateDir(r);
  const to = join(dirname(r), CURRENT.dir, basename(r));
  const status = moveOnce(from, to, warn, `state for ${r}`);
  const dir = status === 'failed' ? from : to;
  const files = renameStateFiles(dir, warn);
  const repaired = status === 'moved' ? repairWorktrees(r, to, warn) : [];
  if (status === 'moved') removeIfEmpty(dirname(from));
  return { status, from, to, dir, files, repaired };
}

/**
 * ~/.kingdom -> ~/.agenticos: the team registry (courts.json -> teams.json),
 * the global token store, the repo-less workspace, and the state of any repo
 * that sits directly in the home folder. When both exist, each entry the new
 * folder lacks is moved across and each clash is left in the old one.
 */
export function migrateHome(home, { warn = warnOnce } = {}) {
  const from = join(home, LEGACY.dir);
  const to = join(home, CURRENT.dir);
  const report = { status: 'none', moved: [], clashes: [], repaired: [] };
  if (existsSync(from)) {
    if (!existsSync(to)) report.status = moveOnce(from, to, warn, 'home');
    else {
      report.status = 'merged';
      for (const name of readdirSync(from)) {
        const target = join(to, name === LEGACY.registry ? CURRENT.registry : name);
        if (existsSync(target)) report.clashes.push(name);
        else {
          try { renameSync(join(from, name), target); report.moved.push(name); }
          catch (e) { report.clashes.push(name); warn(`home: could not move ${join(from, name)} (${e.code ?? e.message}).`); }
        }
      }
      if (report.clashes.length) {
        warn(`home: ${from} and ${to} both exist. Kept the new copy of ${report.clashes.join(', ')}; the old copies are still in ${from}.`);
      }
      removeIfEmpty(from);
    }
  }
  if (report.status === 'failed') return report;
  const reg = moveOnce(join(to, LEGACY.registry), join(to, CURRENT.registry), warn, 'team registry');
  if (reg === 'moved') report.moved.push(LEGACY.registry);
  renameStateFiles(join(to, 'workspace'), warn);
  // A repo directly under the home folder kept its state in ~/.kingdom/<repo>.
  if (report.status === 'moved' || report.moved.length) {
    for (const name of existsSync(to) ? readdirSync(to) : []) {
      const dir = join(to, name);
      if (name === 'workspace' || !existsSync(join(home, name, '.git'))) continue;
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      renameStateFiles(dir, warn);
      report.repaired.push(...repairWorktrees(join(home, name), dir, warn));
    }
  }
  return report;
}

/**
 * Electron keeps pet.json and daemon.log in userData, which is named after
 * package.json's name: `kingdom` before the rename, `agenticos` after.
 */
export function migrateUserData(appData, userData, { warn = warnOnce } = {}) {
  const from = join(appData, LEGACY.userData);
  if (resolve(from) === resolve(userData)) return 'none';
  return moveOnce(from, userData, warn, 'app data');
}

/* ------------------------------------------------------------ the config */

const fingerprint = (r) => createHash('sha256')
  .update(`${r?.title ?? ''}\n${r?.description ?? ''}\n${r?.prompt ?? ''}`, 'utf8')
  .digest('hex').slice(0, 16);

/**
 * sha256-16 of `title\ndescription\nprompt` for the orchestrator, briefer and
 * every agent exactly as shipped immediately before the rename (the 18-role
 * roster v2 in kingdom.config.json and roles.json at origin/functionality).
 * A team entry that still matches was never edited, so it takes the renamed
 * shipped text; one that does not is the user's and is left alone.
 */
export const PRE_RENAME_FINGERPRINTS = Object.freeze({
  orchestrator: ['e3f69b9705dac0af'],
  briefer: ['26c292aa61a97f17'],
  researcher: ['6484e40a05e1482e'],
  strategist: ['57ab042ea0cd947a'],
  architect: ['7303f46ce389bebd'],
  coder: ['51ebffc13001673b'],
  'refactoring-engineer': ['f7a3499ee66731aa'],
  frontend: ['3decc133b5e61183'],
  designer: ['6e7d0999dfe45010'],
  backend: ['717a64fcbec9e688'],
  dba: ['717fd9bf0e111a3e'],
  tester: ['d9db191c4cf179fb'],
  reviewer: ['3d80a65f4d994e10'],
  debugger: ['a8c9edb7bfc4c346'],
  'fact-checker': ['ca9c45ea0ec17676'],
  defendant: ['026e53e07672d3b1'],
  critic: ['7a20b4c4427b4af1'],
  auditor: ['975ec1189bf1cf4d'],
  'devops-engineer': ['2c8a4d2f1ea0d384'],
  writer: ['97656d9f82893fc8'],
});

const CONFIG_KEYS = [
  ['peasants', 'agents'],
  ['peasantDefaults', 'agentDefaults'],
  ['retiredPeasants', 'retiredAgents'],
  ['maxKingdomUsd', 'maxTotalUsd'],
];

/** MCP tool names a hand-edited prompt might still tell a model to call. */
const LEGACY_TOOLS = /\b(summon|summon_member|dismiss_member|wake_member|pause_court|resume_court)\b/;

/**
 * Rename a config's Kingdom-era keys in place, and refresh any shipped text
 * the user never edited. Pure apart from mutating `config`.
 *
 * @param shipped { orchestrator, briefer, agents: [...] } as shipped now
 * @returns { changed, report: { keys, refreshed, conflicts, legacyToolsIn } }
 */
export function migrateConfig(config, shipped = {}) {
  const report = { keys: [], refreshed: [], conflicts: [], legacyToolsIn: [] };
  if (!config || typeof config !== 'object') return { changed: false, report };
  let legacy = false;
  for (const [old, now] of CONFIG_KEYS) {
    if (!Object.hasOwn(config, old)) continue;
    legacy = true;
    if (Object.hasOwn(config, now)) report.conflicts.push(old);
    else { config[now] = config[old]; report.keys.push(`${old} -> ${now}`); }
    if (!report.conflicts.includes(old)) delete config[old];
  }
  // Memory and skills were written under <vault>/Kingdom while that was the
  // default; a legacy config that never named a folder keeps reading it.
  if (legacy && config.vaultWriteDir === undefined) {
    config.vaultWriteDir = LEGACY.vaultDir;
    report.keys.push(`vaultWriteDir = ${LEGACY.vaultDir} (where its notes already are)`);
  }
  const refresh = (entry, now) => {
    if (!entry || !now || entry.name !== now.name) return;
    if (!(PRE_RENAME_FINGERPRINTS[entry.name] ?? []).includes(fingerprint(entry))) {
      if (LEGACY_TOOLS.test(entry.prompt ?? '')) report.legacyToolsIn.push(entry.name);
      return;
    }
    const before = fingerprint(entry);
    for (const k of ['title', 'description', 'prompt']) {
      if (now[k] === undefined) delete entry[k];
      else entry[k] = now[k];
    }
    if (fingerprint(entry) !== before) report.refreshed.push(entry.name);
  };
  refresh(config.orchestrator, shipped.orchestrator);
  refresh(config.briefer, shipped.briefer);
  const byName = new Map((shipped.agents ?? []).map((r) => [r.name, r]));
  for (const a of Array.isArray(config.agents) ? config.agents : []) refresh(a, byName.get(a?.name));
  const changed = report.keys.length + report.refreshed.length > 0;
  return { changed, report };
}

/* ------------------------------------------------------------ the bus */

const RENAMED_SENDERS = [['sovereign', 'user'], ['crown', 'system']];
const RENAMED_STATE_KEYS = [['summoned', 'added'], ['maxKingdomUsd', 'maxTotalUsd']];

/** Rename object keys (deep) and an approval's `kind`; returns [value, changed]. */
function renameJson(value) {
  let changed = false;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const key = k === 'peasant' && !Object.hasOwn(v, 'agent') ? 'agent' : k;
      if (key !== k) changed = true;
      // An approval record carries its payload as JSON text in `body`.
      const inner = key === 'body' && typeof x === 'string' ? renameJsonText(x) : null;
      if (inner != null) changed = true;
      out[key] = inner ?? walk(x);
    }
    if (out.kind === 'summon') { out.kind = 'add'; changed = true; }
    for (const f of ['sender', 'recipient', 'from', 'by']) {
      const hit = RENAMED_SENDERS.find(([old]) => out[f] === old);
      if (hit) { out[f] = hit[1]; changed = true; }
    }
    return out;
  };
  return [walk(value), changed];
}

const renameJsonText = (text) => {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const [next, changed] = renameJson(parsed);
  return changed ? JSON.stringify(next) : null;
};

/**
 * One database's stored Kingdom-era words: the human's sender name
 * (sovereign -> user), the system's (crown -> system), the `summoned` event
 * and state key, the team spend ceiling's state key, approval payloads
 * (kind summon -> add, peasant -> agent) and agent-keyed JSON on events and
 * runs. Run inside src/bus.js's migration transaction as schema:rename:v1.
 * Message and event text is never rewritten: it is the record.
 */
export function migrateBusRows(db) {
  const report = { rows: 0, stateKeys: [], conflicts: [] };
  const run = (sql, ...args) => { report.rows += Number(db.prepare(sql).run(...args).changes ?? 0); };
  // A very old database can lack a column a later schema added; skip what is not there.
  const cols = new Map();
  const has = (table, col) => {
    if (!cols.has(table)) cols.set(table, new Set(db.prepare(`pragma table_info(${table})`).all().map((c) => c.name)));
    return cols.get(table).has(col);
  };
  const rename = (table, col, now, old) => { if (has(table, col)) run(`update ${table} set ${col} = ? where ${col} = ?`, now, old); };
  for (const [old, now] of RENAMED_SENDERS) {
    for (const [table, col] of [
      ['messages', 'sender'], ['messages', 'recipient'], ['events', 'agent'], ['conversations', 'member'],
      ['tasks', 'by'], ['tasks', 'owner'], ['my_tasks', 'by'], ['run_spend', 'agent'], ['spend_ledger', 'agent'], ['runs', 'lead'],
    ]) rename(table, col, now, old);
  }
  if (has('events', 'type')) run("update events set type = 'added' where type = 'summoned'");

  let textChanged = false;
  for (const row of db.prepare("select id, body from messages where kind = 'approval'").all()) {
    const next = renameJsonText(row.body);
    if (next != null) { db.prepare('update messages set body = ? where id = ?').run(next, row.id); report.rows++; textChanged = true; }
  }
  let eventsChanged = false;
  for (const row of db.prepare("select id, payload from events where payload like '%\"peasant\"%' or payload like '%\"summon\"%' or payload like '%\"sovereign\"%' or payload like '%\"crown\"%'").all()) {
    const next = renameJsonText(row.payload);
    if (next != null) { db.prepare('update events set payload = ? where id = ?').run(next, row.id); report.rows++; eventsChanged = true; }
  }
  for (const col of ['recovery_history', 'verification_evidence', 'approved_plan']) {
    if (!has('runs', col)) continue;
    for (const row of db.prepare(`select id, ${col} as v from runs where ${col} like '%"peasant"%'`).all()) {
      const next = renameJsonText(row.v);
      if (next != null) { db.prepare(`update runs set ${col} = ? where id = ?`).run(next, row.id); report.rows++; }
    }
  }

  const get = (k) => db.prepare('select v from state where k = ?').get(k)?.v;
  const set = (k, v) => db.prepare('insert into state (k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, v);
  const del = (k) => db.prepare('delete from state where k = ?').run(k);
  const renameKey = (old, now) => {
    const v = get(old);
    if (v === undefined) return;
    if (get(now) !== undefined) { report.conflicts.push(old); return; }
    set(now, v); del(old); report.stateKeys.push(`${old} -> ${now}`);
  };
  for (const [old, now] of RENAMED_STATE_KEYS) renameKey(old, now);
  // Per-member keys (`session:<name>:...`, `readcur:<name>`) for the renamed senders.
  for (const { k } of db.prepare("select k from state where k like '%sovereign%' or k like '%crown%'").all()) {
    const parts = k.split(':');
    const next = parts.map((p) => RENAMED_SENDERS.find(([old]) => old === p)?.[1] ?? p).join(':');
    if (next !== k) renameKey(k, next);
  }
  for (const { k, v } of db.prepare("select k, v from state where k like 'approval:%'").all()) {
    const next = renameJsonText(v);
    if (next != null) { set(k, next); report.rows++; }
  }
  // External-content FTS indexes hold the old text of any row rewritten
  // above; rebuild so a later delete trigger does not corrupt them.
  if (textChanged) db.exec("insert into messages_fts(messages_fts) values ('rebuild')");
  if (eventsChanged) db.exec("insert into events_fts(events_fts) values ('rebuild')");
  return report;
}

/* ------------------------------------------------------------ branches */

/** Branch names a pre-rename worktree may still be on; they keep working. */
export const legacyBranch = (name) => `${LEGACY.branchPrefix}${name}`;
export const legacyRunBranch = (runId) => `${LEGACY.branchPrefix}run/${runId}`;

/* ------------------------------------------------------------ MCP configs */

/** Our own MCP server entry under its old key, in a config another tool owns. */
export const legacyMcpKey = LEGACY.mcpServer;
