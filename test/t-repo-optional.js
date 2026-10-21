// A repo is now optional, and only Code mode needs one.
//
// Chat and Cowork must both run against nothing but the workspace
// home (stateDir(null)) — no repo, no worktree, no crash. Code mode is the
// one shape that edits a real codebase, so it is refused until a repo is
// attached, live, from inside the app (AgenticOS#attachRepo) rather than on
// the command line.
//   node test/t-repo-optional.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { stateDir, dbPath, worktreePath } from '../src/worktree.js';

process.env.AGENTICOS_CODEX_BIN = process.execPath;
process.env.AGENTICOS_SETTLE_MS = '150';

/* ---------- 1. the workspace home is a fixed, pure fallback -------------- */
a.equal(stateDir(null), join(homedir(), '.agenticos', 'workspace'),
  'no repo falls back to one fixed home, the same shape globalTokenStore uses');
a.equal(dbPath(null), join(stateDir(null), 'agenticos.db'));
a.equal(worktreePath(null, 'coder'), join(stateDir(null), 'wt', 'coder'));

// A live AgenticOS with repo:null still writes real files (its db, at least) —
// sandbox homedir() so that lands in a scratch dir, not this account's real
// ~/.agenticos. os.homedir() reads these env vars at call time on Windows/POSIX
// respectively, so setting them before construction is enough.
const fakeHome = mkdtempSync(join(tmpdir(), 'agenticos-home-'));
const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const workspace = join(fakeHome, '.agenticos', 'workspace');
const configPath = join(workspace, 'agenticos.config.json');
mkdirSync(workspace, { recursive: true });
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  agents: [{ name: 'coder', cli: 'codex', description: 'writes code' }],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  summarizer: { enabled: false },
  mode: 'research',
}));

try {
  /* ---------- 2. Chat/Cowork work with no repo at all -------------------- */
  const k = new AgenticOS(null, configPath);
  k.on('error', () => {});
  await k.start();

  a.equal(k.repo, null);
  a.equal(k.base, null, 'no repo means no base branch to speak of');
  a.equal(k.mode(), 'cowork');
  a.equal(JSON.parse(readFileSync(configPath, 'utf8')).mode, 'cowork', 'legacy mode keys are persisted as Cowork on start');

  /* ---------- 3. Code is refused; the others degrade instead of throwing -- */
  a.throws(() => k.setMode('code'), /needs a repository/i,
    'Code mode has nothing else to edit, so it is refused rather than silently allowed');
  a.equal(k.mode(), 'cowork', 'a refused switch must not change anything');

  const queued = k.queueMode('code', { by: 'advisor' });
  a.equal(queued.changed, false,
    'the advisor classifies in the background — it must degrade like any other advisor miss, not throw');
  a.equal(k.mode(), 'cowork');

  /* ---------- 4. Cowork gets worktrees=true, but skips the worktree ------- */
  await k.wake('coder');
  const coder = k.processes.get('coder');
  a.ok(coder, 'an agent must still spawn with no repo attached');
  a.equal(coder.cwd, stateDir(null),
    'a worktree protects a repo — with none attached there is nothing to isolate');
  a.equal(existsSync(worktreePath(null, 'coder')), false,
    'no git worktree may ever be created with no repo, even in a worktrees:true mode');

  await k.stop();

  /* ---------- 5. attaching a repo makes Code reachable, live, no restart -- */
  const repo = mkdtempSync(join(tmpdir(), 'agenticos-attach-'));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@agenticos');
  git('config', 'user.name', 'agenticos');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const k2 = new AgenticOS(null, configPath);
  k2.on('error', () => {});
  await k2.start();
  a.equal(k2.repo, null);

  await k2.attachRepo(repo);
  a.equal(k2.repo, resolve(repo));
  a.ok(k2.base, 'attachRepo must discover the base branch, same as a boot-time repo would');
  a.equal(existsSync(dbPath(repo)), false,
    'state must NOT migrate into a repo-relative .agenticos dir — it stays at the workspace home');

  /* ---------- 5b. attachRepo must not move the live db out from under the bus */
  a.equal(k2.dbPath, dbPath(null),
    'the db this.bus already opened is fixed at construction — attachRepo must not repoint it');
  a.notEqual(k2.dbPath, dbPath(repo),
    'dbPath(repo) and dbPath(null) differ on this machine, so a stale re-derivation would be caught');

  const r = k2.setMode('code');
  a.equal(r.changed, true, 'Code becomes reachable the instant a repo is attached, no restart');
  a.equal(k2.mode(), 'code');

  await k2.stop();
  try { rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}

  console.log('  no repo: Chat/Cowork run, Code is refused by name, nothing else degrades silently');
  console.log('  a worktrees:true mode skips the worktree entirely when nothing needs isolating');
  console.log('  attachRepo makes Code reachable live, and never migrates workspace state');
  console.log('t-repo-optional.js OK — a repo is optional, and only Code needs one');
} finally {
  if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedEnv.USERPROFILE;
  if (savedEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.HOME;
  try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
}
