// The one-time move from the Kingdom-era names (src/legacy.js, docs/RENAME.md).
//
//   node test/t-legacy-migrate.js
//
// Plants every legacy shape a real user has on disk — a .kingdom state folder
// with kingdom.db, kingdom.config.json and a live agent worktree on a
// kingdom/<name> branch, a ~/.kingdom home with courts.json and tokens.json,
// an Electron userData folder named kingdom, KINGDOM_* variables — and proves
// each one moves once, keeps its data, keeps working, and is never overwritten
// when a new copy already exists. Fakes and temp folders only: nothing here
// touches the real home folder, and it removes only what it created.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  LEGACY, CURRENT, applyLegacyEnv, currentEnvName, migrateRepoState, migrateHome,
  migrateUserData, renameStateFiles, migrateConfig, migrateBusRows, SKIP_ENV,
} from '../src/legacy.js';
import { Bus } from '../src/bus.js';
import { branchFor, statOf } from '../src/worktree.js';
import { removeRepo } from './cleanup.js';

const a = assert;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// realpath: macOS's tmpdir is a symlink, and git reports resolved paths.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agenticos-legacy-')));
const warnings = [];
const warn = (m) => warnings.push(m);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const repos = [];
// One spelling of a path, to compare what git prints with what join() built.
// On Windows git prints forward slashes and long names, while the runner's
// temp dir comes back as an 8.3 short name (RUNNER~1); realpath.native
// expands that, and the drive letter's case is not significant.
// A path that no longer exists (a stale, unrepaired entry) keeps its own
// spelling, so it reads as "not there" rather than throwing.
const canonical = (p) => {
  let real = p;
  try { real = realpathSync.native(p); } catch { /* stale entry */ }
  real = real.replace(/\\/g, '/');
  return process.platform === 'win32' ? real.toLowerCase() : real;
};
const worktreePaths = (repo) => git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/)
  .filter((l) => l.startsWith('worktree ')).map((l) => canonical(l.slice('worktree '.length)));

function makeRepo(parent, name) {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '--initial-branch=main');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  repos.push(repo);
  return repo;
}

/** A database as a pre-rename build left it: rows under the old names, no rename flag. */
function plantLegacyDb(path) {
  const bus = new Bus(path);
  bus.post('sovereign', 'orchestrator', 'build the parser please');
  bus.post('crown', 'orchestrator', 'AWARENESS: an approval landed', 'notice');
  bus.post('orchestrator', 'sovereign', 'on it');
  const summon = bus.post('orchestrator', null, JSON.stringify({ kind: 'summon', names: ['coder'], reason: 'parser' }), 'approval');
  const merge = bus.post('orchestrator', null, JSON.stringify({ kind: 'merge', peasant: 'coder', verdict: 'fine' }), 'approval');
  bus.logEvent('coder', 'summoned', { by: 'orchestrator', approvalId: summon });
  bus.logEvent('crown', 'roster_migrated', { version: 2 });
  bus.logEvent('orchestrator', 'merged', { peasant: 'coder' });
  bus.set('summoned', JSON.stringify(['coder']));
  bus.set('maxKingdomUsd', '25');
  bus.set('readcur:sovereign', '3');
  bus.addMyTask({ title: 'call the bank', by: 'sovereign' });
  bus.db.prepare("delete from state where k = 'schema:rename:v1'").run();
  bus.close();
  return { summon, merge };
}

try {
  /* ---------- 1. environment variables ---------- */
  {
    a.equal(currentEnvName('KINGDOM_DB'), 'AGENTICOS_DB');
    a.equal(currentEnvName('KINGDOM_COURTS_REGISTRY'), 'AGENTICOS_TEAMS_REGISTRY');
    a.equal(currentEnvName('KINGDOM_CODEX_BIN'), 'AGENTICOS_CODEX_BIN');
    const env = { KINGDOM_PORT: '7801', KINGDOM_COURTS_REGISTRY: '/r.json', KINGDOM_MODE: 'chat', AGENTICOS_MODE: 'code', PATH: '/bin' };
    const seen = [];
    const out = applyLegacyEnv(env, (m) => seen.push(m));
    a.equal(env.AGENTICOS_PORT, '7801', 'an old variable is read when the new one is unset');
    a.equal(env.AGENTICOS_TEAMS_REGISTRY, '/r.json', 'courts -> teams inside the name too');
    a.equal(env.AGENTICOS_MODE, 'code', 'the new name wins when both are set');
    a.equal(env.KINGDOM_PORT, '7801', 'the old variable is left as it was');
    a.equal(out.used.length, 2);
    a.equal(out.ignored.length, 1);
    a.equal(seen.length, 2, 'one warning for what was read, one for what was ignored — not one per variable');
    a.match(seen[0], /KINGDOM_PORT -> AGENTICOS_PORT/);
    const again = applyLegacyEnv(env, (m) => seen.push(m));
    a.equal(again.used.length, 0, 'a second pass reads nothing new');
    console.log('  env: KINGDOM_* read as a fallback with one warning; the new name wins');
  }

  /* ---------- 2. a repo's state folder, its db, its config, its worktree ---------- */
  const parent = join(root, 'projects');
  const repo = makeRepo(parent, 'app');
  const legacyDir = join(parent, LEGACY.dir, 'app');
  mkdirSync(legacyDir, { recursive: true });
  const { summon, merge } = plantLegacyDb(join(legacyDir, LEGACY.db));
  const legacyConfig = readFileSync(join(HERE, 'fixtures', 'config-pre-rename.json'), 'utf8');
  const edited = JSON.parse(legacyConfig);
  edited.peasants.find((p) => p.name === 'tester').prompt = 'Mine. Use summon_member when stuck.';
  writeFileSync(join(legacyDir, LEGACY.config), JSON.stringify(edited, null, 2));
  // A live worktree cut before the rename, on the old branch prefix, with work in it.
  const oldWt = join(legacyDir, 'wt', 'coder');
  git(repo, 'worktree', 'add', '-q', '-b', `${LEGACY.branchPrefix}coder`, oldWt, 'main');
  writeFileSync(join(oldWt, 'parser.js'), 'export const parse = (s) => s.trim();\n');
  git(oldWt, 'add', '-A');
  git(oldWt, 'commit', '-qm', 'parser');
  // A sibling repo under the same .kingdom parent, not opened yet.
  const sibling = makeRepo(parent, 'other');
  mkdirSync(join(parent, LEGACY.dir, 'other'), { recursive: true });
  writeFileSync(join(parent, LEGACY.dir, 'other', 'marker'), 'x');

  const r = migrateRepoState(repo, { warn });
  const newDir = join(parent, CURRENT.dir, 'app');
  a.equal(r.status, 'moved');
  a.equal(r.dir, newDir);
  a.equal(existsSync(legacyDir), false, 'the old folder is gone');
  a.equal(existsSync(join(newDir, CURRENT.db)), true, 'kingdom.db -> agenticos.db');
  a.equal(existsSync(join(newDir, LEGACY.db)), false);
  a.equal(existsSync(join(newDir, CURRENT.config)), true, 'kingdom.config.json -> agenticos.config.json');
  a.equal(existsSync(join(parent, LEGACY.dir, 'other', 'marker')), true, 'a sibling repo is not moved until it is opened');
  a.equal(r.repaired.length, 1, 'the agent worktree was re-linked');
  const newWt = join(newDir, 'wt', 'coder');
  a.ok(worktreePaths(repo).includes(canonical(newWt)), 'git knows the worktree at its new path');
  a.equal(git(newWt, 'status', '--porcelain'), '', 'and the moved worktree is a working checkout');
  a.equal(await branchFor(repo, 'coder'), `${LEGACY.branchPrefix}coder`, 'an existing old branch keeps being used');
  a.equal(await branchFor(repo, 'tester'), 'agenticos/tester', 'a new agent gets the new prefix');
  a.match(await statOf(repo, 'coder', 'main'), /parser\.js/, 'the old branch still diffs against base');
  a.equal(migrateRepoState(repo, { warn }).status, 'none', 'idempotent: nothing left to move');
  console.log('  state: .kingdom/<repo> -> .agenticos/<repo>, db and config renamed, worktree re-linked, old branch kept');

  /* ---------- 3. the database's stored names ---------- */
  {
    const bus = new Bus(join(newDir, CURRENT.db));
    const msgs = bus.history({ limit: 100 });
    a.ok(msgs.some((m) => m.sender === 'user' && m.body === 'build the parser please'), 'sovereign -> user as a sender');
    a.ok(msgs.some((m) => m.recipient === 'user'), 'and as a recipient');
    a.ok(msgs.some((m) => m.sender === 'system'), 'crown -> system');
    a.ok(!msgs.some((m) => ['sovereign', 'crown'].includes(m.sender) || ['sovereign', 'crown'].includes(m.recipient)));
    const record = (id) => JSON.parse(JSON.parse(bus.get(`approval:${id}`)).body);
    a.equal(record(summon).kind, 'add', 'an approval payload: kind summon -> add');
    const m = record(merge);
    a.equal(m.agent, 'coder', 'and peasant -> agent');
    a.equal('peasant' in m, false);
    a.equal(JSON.parse(msgs.find((x) => x.id === merge).body).agent, 'coder', 'the approval message body too');
    a.equal(bus.events({ type: 'added' }).length, 1, 'the summoned event -> added');
    a.equal(bus.events({ type: 'summoned' }).length, 0);
    a.equal(bus.events({ agent: 'system' }).length, 1);
    a.equal(bus.events({ type: 'merged' })[0].payload.agent, 'coder', 'event payloads are keyed by agent');
    a.equal(bus.get('added'), JSON.stringify(['coder']), 'state key summoned -> added');
    a.equal(bus.get('summoned'), undefined);
    a.equal(bus.get('maxTotalUsd'), '25', 'maxKingdomUsd -> maxTotalUsd');
    a.equal(bus.get('readcur:user'), '3', 'per-member keys follow the renamed sender');
    a.equal(bus.myTasks()[0].by, 'user');
    // Rewritten text with an external-content FTS index: a rebuild keeps it whole.
    a.equal(bus.db.prepare("select count(*) n from messages_fts where messages_fts match 'please'").get().n, 1);
    bus.db.exec("insert into messages_fts(messages_fts) values ('integrity-check')");
    bus.db.exec("insert into events_fts(events_fts) values ('integrity-check')");
    bus.close();
    // Once, and never again: the flag is set.
    const again = new DatabaseSync(join(newDir, CURRENT.db));
    a.equal(again.prepare("select v from state where k = 'schema:rename:v1'").get()?.v, '1');
    a.equal(migrateBusRows(again).rows, 0, 'a second pass over migrated rows changes nothing');
    again.close();
    console.log('  db: senders, approvals, events, state keys and payloads renamed; FTS intact; once only');
  }

  /* ---------- 4. the config: keys, untouched shipped text, edited text ---------- */
  {
    const cfg = JSON.parse(readFileSync(join(newDir, CURRENT.config), 'utf8'));
    const template = JSON.parse(readFileSync(join(ROOT, 'agenticos.config.json'), 'utf8'));
    const roles = JSON.parse(readFileSync(join(ROOT, 'roles.json'), 'utf8')).agents;
    const { changed, report } = migrateConfig(cfg, { orchestrator: template.orchestrator, briefer: template.briefer, agents: roles });
    a.equal(changed, true);
    for (const old of ['peasants', 'peasantDefaults']) a.equal(old in cfg, false, `${old} is renamed`);
    a.equal(cfg.agents.length, 18);
    a.deepEqual(cfg.agentDefaults, edited.peasantDefaults);
    a.equal(cfg.vaultWriteDir, 'Kingdom', 'the vault folder the notes are already in is kept');
    a.equal(cfg.orchestrator.description, template.orchestrator.description, 'untouched shipped text takes the new words');
    a.ok(report.refreshed.includes('orchestrator') && report.refreshed.includes('briefer'));
    a.equal(cfg.agents.find((p) => p.name === 'tester').prompt, 'Mine. Use summon_member when stuck.', 'an edited prompt is the user\'s and stays');
    a.deepEqual(report.legacyToolsIn, ['tester'], 'and its old tool name is reported, not rewritten');
    a.equal(migrateConfig(cfg, { orchestrator: template.orchestrator }).changed, false, 'idempotent');
    // Both names present: the new one wins and the old one stays in the file.
    const both = { peasants: [{ name: 'x' }], agents: [{ name: 'y' }] };
    const b = migrateConfig(both);
    a.deepEqual(both.agents, [{ name: 'y' }]);
    a.deepEqual(both.peasants, [{ name: 'x' }]);
    a.deepEqual(b.report.conflicts, ['peasants']);
    console.log('  config: keys renamed, untouched shipped text refreshed, edits kept and reported');
  }

  /* ---------- 4b. the real launch path: AgenticOS reads and persists it ---------- */
  {
    const { AgenticOS } = await import('../src/agenticos.js');
    const cfgPath = join(newDir, CURRENT.config);
    const k = new AgenticOS(repo, cfgPath);
    a.equal(k.config.agents.length, 18);
    const disk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    a.equal('peasants' in disk, false, 'the renamed config is written back');
    a.equal(disk.agents.length, 18);
    a.ok(k.bus.events({ type: 'config_renamed' }).length === 1, 'and the rename is on the record');
    k.bus.close();
    console.log('  launch: AgenticOS renames a legacy config before anything reads it');
  }

  /* ---------- 5. never overwrite: new and old both exist ---------- */
  {
    const p2 = join(root, 'both');
    const r2 = makeRepo(p2, 'svc');
    mkdirSync(join(p2, LEGACY.dir, 'svc'), { recursive: true });
    writeFileSync(join(p2, LEGACY.dir, 'svc', LEGACY.db), 'old');
    mkdirSync(join(p2, CURRENT.dir, 'svc'), { recursive: true });
    writeFileSync(join(p2, CURRENT.dir, 'svc', 'keep'), 'new');
    warnings.length = 0;
    const res = migrateRepoState(r2, { warn });
    a.equal(res.status, 'both');
    a.equal(res.dir, join(p2, CURRENT.dir, 'svc'), 'the new folder is used');
    a.equal(readFileSync(join(p2, LEGACY.dir, 'svc', LEGACY.db), 'utf8'), 'old', 'the old one is untouched');
    a.ok(warnings.some((w) => /both .* exist/.test(w)), 'and that is said out loud');
    // Inside one folder: the database moves with its journal files, or not at all.
    const d = join(root, 'files');
    mkdirSync(d);
    for (const s of ['', '-wal', '-shm']) writeFileSync(join(d, LEGACY.db + s), s || 'db');
    a.equal(renameStateFiles(d, warn).db, 'moved');
    for (const s of ['', '-wal', '-shm']) a.ok(existsSync(join(d, CURRENT.db + s)) && !existsSync(join(d, LEGACY.db + s)), `${s || 'db'} moved`);
    writeFileSync(join(d, LEGACY.db), 'stale');
    a.equal(renameStateFiles(d, warn).db, 'both', 'a new db is never replaced by an old one');
    a.equal(readFileSync(join(d, CURRENT.db), 'utf8'), 'db');
    console.log('  conflicts: an existing new copy wins, the old one is kept, a warning says so');
  }

  /* ---------- 6. the home folder: registry, tokens, workspace ---------- */
  {
    const home = join(root, 'home');
    const old = join(home, LEGACY.dir);
    mkdirSync(join(old, 'workspace'), { recursive: true });
    writeFileSync(join(old, LEGACY.registry), JSON.stringify({ [LEGACY.registryKey]: [{ repo: '/x', port: 7777, pid: 1 }] }));
    writeFileSync(join(old, 'tokens.json'), '{"tokens":["t"]}');
    writeFileSync(join(old, 'workspace', LEGACY.config), '{"peasants":[]}');
    const rep = migrateHome(home, { warn });
    a.equal(rep.status, 'moved');
    const neu = join(home, CURRENT.dir);
    a.equal(existsSync(old), false);
    a.equal(existsSync(join(neu, CURRENT.registry)), true, 'courts.json -> teams.json');
    a.equal(existsSync(join(neu, 'tokens.json')), true);
    a.equal(existsSync(join(neu, 'workspace', CURRENT.config)), true, 'the repo-less workspace config is renamed');
    // teams.js reads a registry still keyed by the old name.
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const { listTeams } = await import('./src/teams.js'); const fs = await import('node:fs');"
      + " const raw = JSON.parse(fs.readFileSync(process.env.AGENTICOS_TEAMS_REGISTRY, 'utf8'));"
      + " console.log(Object.keys(raw)[0], typeof listTeams);"],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTICOS_TEAMS_REGISTRY: join(neu, CURRENT.registry) } });
    a.match(out, /courts function/, 'the moved registry keeps its rows under the old key, which teams.js reads');
    // Both homes: what the new one lacks moves across, a clash stays put.
    mkdirSync(old);
    writeFileSync(join(old, 'tokens.json'), '{"tokens":["old"]}');
    writeFileSync(join(old, 'extra.json'), '{}');
    warnings.length = 0;
    const merged = migrateHome(home, { warn });
    a.equal(merged.status, 'merged');
    a.deepEqual(merged.moved, ['extra.json']);
    a.deepEqual(merged.clashes, ['tokens.json']);
    a.equal(readFileSync(join(neu, 'tokens.json'), 'utf8'), '{"tokens":["t"]}', 'the new token store is never replaced');
    a.equal(readFileSync(join(old, 'tokens.json'), 'utf8'), '{"tokens":["old"]}', 'the old one is kept');
    a.ok(warnings.some((w) => /tokens\.json/.test(w)));
    console.log('  home: ~/.kingdom -> ~/.agenticos, courts.json -> teams.json; a clash keeps both');
  }

  /* ---------- 7. Electron userData ---------- */
  {
    const appData = join(root, 'appdata');
    mkdirSync(join(appData, LEGACY.userData), { recursive: true });
    writeFileSync(join(appData, LEGACY.userData, 'pet.json'), '{"x":1}');
    a.equal(migrateUserData(appData, join(appData, 'agenticos'), { warn }), 'moved');
    a.equal(readFileSync(join(appData, 'agenticos', 'pet.json'), 'utf8'), '{"x":1}', 'the pet keeps its place');
    a.equal(migrateUserData(appData, join(appData, 'agenticos'), { warn }), 'none');
    console.log('  electron: userData kingdom -> agenticos');
    const startup = readFileSync(join(ROOT, 'electron', 'main.js'), 'utf8').split('const PORT')[0];
    a.doesNotMatch(startup, /getPath\(['"]userData['"]\)/,
      'reading Electron userData eagerly creates the destination before migration');
  }

  /* ---------- 8. entry points: the boot module and the lazy per-repo move ---------- */
  {
    const home = join(root, 'home2');
    mkdirSync(join(home, LEGACY.dir), { recursive: true });
    writeFileSync(join(home, LEGACY.dir, 'tokens.json'), '{}');
    const p3 = join(root, 'lazy');
    const r3 = makeRepo(p3, 'web');
    mkdirSync(join(p3, LEGACY.dir, 'web'), { recursive: true });
    plantLegacyDb(join(p3, LEGACY.dir, 'web', LEGACY.db));
    const env = { ...process.env, HOME: home, USERPROFILE: home, KINGDOM_SETTLE_MS: '5' };
    delete env[SKIP_ENV];
    delete env.AGENTICOS_SETTLE_MS;
    const script = "await import('./src/legacy-boot.js');"
      + " const w = await import('./src/worktree.js');"
      + ` console.log(process.env.AGENTICOS_SETTLE_MS, w.stateDir(${JSON.stringify(r3)}), w.dbPath(${JSON.stringify(r3)}));`;
    const res = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const [settle, dir, db] = res.trim().split(' ');
    a.equal(settle, '5', 'the boot module reads KINGDOM_* before anything else runs');
    a.equal(dir, join(p3, CURRENT.dir, 'web'), 'stateDir moves a repo\'s old state the first time it is asked');
    a.equal(db, join(p3, CURRENT.dir, 'web', CURRENT.db));
    a.equal(existsSync(join(home, CURRENT.dir, 'tokens.json')), true, 'the boot module moved the home folder');
    // With the skip flag (what test/run-all.js sets), nothing moves.
    const p4 = join(root, 'skip');
    const r4 = makeRepo(p4, 'cli');
    mkdirSync(join(p4, LEGACY.dir, 'cli'), { recursive: true });
    execFileSync(process.execPath, ['--input-type=module', '-e', `const w = await import('./src/worktree.js'); w.stateDir(${JSON.stringify(r4)});`],
      { cwd: ROOT, env: { ...env, [SKIP_ENV]: '1' }, stdio: 'pipe' });
    a.equal(existsSync(join(p4, LEGACY.dir, 'cli')), true, 'the skip flag leaves old state where it is');
    console.log('  boot: env fallback first, home moved, a repo\'s state moved lazily on first use; skip flag honoured');
  }

  console.log('t-legacy-migrate.js OK — pre-rename state, config, data, branches and env all carry over, once, never overwritten');
} finally {
  try { removeRepo(...repos.filter((r) => existsSync(r))); } catch { /* a refusal must not mask a failure */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
