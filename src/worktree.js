// Git worktree isolation: one branch + one checkout per peasant, so two
// peasants editing the same file cannot corrupt each other. Kingdom state
// lives OUTSIDE the target repo (a sibling .kingdom dir) — nesting worktrees
// inside the main checkout makes git status noisy and confuses file tools.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, realpathSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Token store shared by every repo. Per-repo stores override it.
 * KINGDOM_TOKEN_STORE relocates it (an encrypted volume, or test isolation).
 */
export const globalTokenStore = () =>
  process.env.KINGDOM_TOKEN_STORE ?? join(homedir(), '.kingdom', 'tokens.json');

const exec = promisify(execFile);

const git = (cwd, ...args) => exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true });

// Measured locally on 2026-08-21: five bare-repo pushes took 254.5–312.6ms
// (285.5ms mean). This is a failure bound, not a latency target: it exists so
// an auth prompt or unreachable remote ends as a blocked approval instead of a wedged court.
const pushTimeout = () => {
  const ms = Number(process.env.KINGDOM_PUSH_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(ms) && ms > 0 ? ms : 30_000;
};

/**
 * Push only the checked-out base branch through Git's already-configured
 * upstream. It accepts no remote, refspec or force option from the court.
 */
export async function pushBase(repo, base) {
  if (!repo || !base) throw new Error('This court has no base repository to push.');
  const branch = (await git(repo, 'branch', '--show-current')).stdout.trim();
  if (branch !== base) throw new Error(`Base branch changed from ${base} to ${branch || '(detached)'}; nothing was pushed.`);

  const readConfig = async (key) => {
    try { return (await git(repo, 'config', '--get', key)).stdout.trim(); } catch { return ''; }
  };
  const remote = await readConfig(`branch.${branch}.remote`);
  const merge = await readConfig(`branch.${branch}.merge`);
  if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) {
    throw new Error(`Branch ${branch} has no configured remote tracking branch; nothing was pushed.`);
  }

  const timeout = pushTimeout();
  try {
    const out = await exec('git', ['-c', 'credential.interactive=false', 'push'], {
      cwd: repo,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    });
    return { remote, branch, output: `${out.stdout}\n${out.stderr}`.trim() };
  } catch (e) {
    if (e.killed || e.signal) throw new Error(`Push timed out after ${timeout}ms; nothing was assumed to have landed.`);
    const detail = `${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`.trim();
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(detail)) {
      throw new Error(`Configured upstream ${remote}/${branch} has diverged; plain push was refused and nothing was changed.`);
    }
    throw new Error(`Push to configured upstream ${remote}/${branch} failed: ${detail || 'git returned no detail'}`);
  }
}

/**
 * Where this repo's kingdom lives: <repoParent>/.kingdom/<repoName>/
 *
 * No repo yet (Chat/Research/Build can run before Code mode ever attaches
 * one) falls back to a single fixed workspace home, same shape as
 * globalTokenStore's homedir fallback above. Goal, roster, vault and research
 * notes are workspace-level, not repo-level, so this state stays put even
 * after a repo is later attached — see Kingdom#attachRepo.
 */
export function kingdomDir(repo) {
  if (!repo) return join(homedir(), '.kingdom', 'workspace');
  const r = resolve(repo);
  return join(dirname(r), '.kingdom', basename(r));
}

export const dbPath = (repo) => join(kingdomDir(repo), 'kingdom.db');
export const worktreePath = (repo, peasant) => join(kingdomDir(repo), 'wt', peasant);
const branchOf = (peasant) => `kingdom/${peasant}`;

const safeRunId = (runId) => {
  const value = String(runId ?? '').trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('Run ids may contain only letters, numbers, dots, underscores, and hyphens.');
  }
  return value;
};

/** A run branch lives beside peasant worktrees, so integration never touches the sovereign's checkout. */
export const runBranch = (runId) => `kingdom/run/${safeRunId(runId)}`;
export const runWorktreePath = (repo, runId) => join(kingdomDir(repo), 'runs', safeRunId(runId));

/** The commit actually checked by a test run. Keeping this separate from a branch name makes evidence portable. */
export async function revisionOf(dir, ref = 'HEAD') {
  return (await git(dir, 'rev-parse', ref)).stdout.trim();
}

export async function assertRepo(repo) {
  if (!existsSync(join(repo, '.git'))) throw new Error(`${repo} is not a git repository.`);
  try {
    const { stdout } = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    return stdout.trim(); // the base branch the kingdom works against
  } catch (e) {
    if (/ambiguous argument ['"]?HEAD|unknown revision ['"]?HEAD/i.test(e.stderr ?? '')) {
      throw new Error(`${repo} has no commit yet. Create an initial commit before launching the kingdom.`);
    }
    throw e;
  }
}

/**
 * Same contract as assertRepo, but MAKES the repository instead of refusing.
 *
 * The court's whole review loop is git — worktree per peasant, diff against
 * base, merge on approval — so "work without a repo" would mean a second,
 * weaker court. Creating the repo gets the same result with one mechanism: you
 * point the kingdom at any folder and it becomes reviewable.
 *
 * Two things it will NOT do. It never initialises inside an existing
 * repository, because a nested repo silently shadows the outer one and the
 * sovereign's real history stops being visible to anything. And it commits the
 * folder's CURRENT contents as the base rather than an empty tree, or every
 * peasant's first diff would contain the entire existing project.
 */
// resolve() normalises separators and `..`, but NOT Windows 8.3 short names:
// os.tmpdir() returns C:\Users\RUNNER~1\... on any account whose name is over
// 8 chars, while git always reports the long form. Comparing those two strings
// called a directory nested inside ITSELF — 23 suites failed on CI while every
// one of them passed locally, where the dev account name is short enough to get
// no 8.3 alias. realpath canonicalises short names AND casing; it needs the
// path to exist, so fall back to resolve() when it does not.
const canonicalPath = (p) => {
  try { return realpathSync.native(p); } catch { return resolve(p); }
};

export async function ensureRepo(repo, { onInit } = {}) {
  // execFile uses cwd before it starts `git`, so an absent project directory
  // surfaces as `spawn git ENOENT` even when Git itself is installed. The CLI
  // deliberately accepts a new toy-project path; make that path real before
  // asking Git whether it is already a repository.
  mkdirSync(repo, { recursive: true });
  let top = null;
  try {
    top = (await git(repo, 'rev-parse', '--show-toplevel')).stdout.trim();
  } catch { /* not a repo, or git absent — both handled below */ }

  if (top && canonicalPath(top) !== canonicalPath(repo)) {
    throw new Error(
      `${repo} is inside the git repository at ${top}. Refusing to create a `
      + `nested repository — point the kingdom at ${top} instead, or move this `
      + `folder outside it.`);
  }

  if (!top) {
    // -b main: git's default branch name is a global setting that may be
    // anything, and the base branch is written into every peasant's branch.
    await git(repo, 'init', '-b', 'main');
    onInit?.('created a git repository');
  }

  try {
    return (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  } catch (e) {
    if (!/ambiguous argument|unknown revision/i.test(e.stderr ?? '')) throw e;
  }

  // No commit yet. A worktree cannot be cut from nothing, so make the base.
  await git(repo, 'add', '-A').catch(() => {});
  try {
    await git(repo, 'commit', '-m', 'kingdom: base commit');
  } catch (e) {
    // Two ordinary reasons this fails, and both are ours to fix rather than
    // report: an empty folder has nothing to commit, and a machine with no
    // global git identity cannot author one.
    if (/Please tell me who you are|user\.(name|email)/i.test((e.stderr ?? '') + (e.stdout ?? ''))) {
      await git(repo, 'config', 'user.email', 'kingdom@localhost');
      await git(repo, 'config', 'user.name', 'Kingdom');
    }
    await git(repo, 'commit', '--allow-empty', '-m', 'kingdom: base commit')
      .catch(async () => { await git(repo, 'commit', '-m', 'kingdom: base commit'); });
  }
  onInit?.('wrote the base commit');
  return (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
}

/**
 * Reuse a live worktree at `path`, caught up to base where that is safe.
 * Returns false when there is none to reuse.
 *
 * A directory git does not recognise is MOVED ASIDE, never deleted. The real
 * `wt/tester` found in the wild held three documents the tester had written —
 * stranded, because the folder was not a worktree so nothing could ever
 * commit them. Deleting to repair the state would have destroyed exactly the
 * work the repair exists to rescue.
 */
async function reuseWorktree(repo, path, branch, base) {
  if (!existsSync(path)) return false;
  try {
    await git(path, 'rev-parse', '--git-dir');
    await catchUp(repo, path, branch, base);
    return true;
  } catch {
    let aside = `${path}.orphan`;
    for (let n = 2; existsSync(aside); n++) aside = `${path}.orphan-${n}`;
    renameSync(path, aside);
    await git(repo, 'worktree', 'prune').catch(() => {});
    return false;
  }
}

/**
 * Idempotent: reuses the worktree if this peasant already has one.
 *
 * "Has one" means a LIVE worktree, not merely a directory. A leftover folder —
 * a `git worktree remove` that failed, a copy, an interrupted run — passes
 * existsSync and is silently handed to the peasant, whose work can then never
 * be committed, diffed or merged. Found exactly that in the wild
 * (`wt/tester`), so a directory that git does not recognise is rebuilt.
 */
export async function createWorktree(repo, peasant, base) {
  const path = worktreePath(repo, peasant);
  const branch = branchOf(peasant);
  if (await reuseWorktree(repo, path, branch, base)) return path;

  const { stdout } = await git(repo, 'branch', '--list', branch);
  try {
    if (stdout.trim()) {
      await git(repo, 'worktree', 'add', path, branch);
      // A worktree re-cut from a branch lands on that branch's TIP, which is
      // wherever the member last left it — and after a merge that is the past.
      // mergeWork removes the worktree, and `git worktree remove` deletes the
      // directory, so the next summon finds nothing on disk and never takes the
      // reuse path above. catchUp lived only on that path, so the one member
      // most likely to need current code — one being brought back for a second
      // task — was the one member guaranteed not to get it.
      //
      // Watched live: "coder" wrote lib/format.js, it merged, and coder was
      // re-summoned to integrate all four modules into a CLI. Its worktree came
      // back seven commits behind master holding only its own format.js. It
      // wrote a CLI importing ./lib/parse, which was not there, burned a full
      // turn, and the whole thing was rejected.
      //
      // Same call, same guard: catchUp refuses a dirty tree or a branch with
      // commits of its own, so a member with unmerged work is still never
      // rewritten under it.
      await catchUp(repo, path, branch, base);
    } else await git(repo, 'worktree', 'add', '-b', branch, path, base);
  } catch (e) {
    // Belt and braces against a racing caller: if the worktree now exists,
    // that is the outcome we wanted anyway.
    if (existsSync(path)) return path;
    throw e;
  }
  return path;
}

/**
 * Create the single integration checkout owned by an improvement run.
 * Reusing it is safe: catchUp only fast-forwards a clean branch with no run
 * commits of its own, so a restart cannot rewrite preserved integration work.
 */
export async function createRunWorktree(repo, runId, base) {
  const path = runWorktreePath(repo, runId);
  const branch = runBranch(runId);
  mkdirSync(dirname(path), { recursive: true });
  if (await reuseWorktree(repo, path, branch, base)) return path;
  const { stdout } = await git(repo, 'branch', '--list', branch);
  try {
    if (stdout.trim()) await git(repo, 'worktree', 'add', path, branch);
    else await git(repo, 'worktree', 'add', '-b', branch, path, base);
  } catch (e) {
    if (existsSync(path)) return path;
    throw e;
  }
  return path;
}

/**
 * How many commits of `base` a reused worktree is missing.
 *
 * A worktree is reused wherever it was left, which can be days and several
 * merges behind. Observed: the architect surveyed the app at `fb23d9f` and
 * reported on it while `main` had moved to `5f00564` — a whole review of the
 * wrong code, with nothing anywhere saying so.
 */
export async function behindBase(repo, peasant, base) {
  try {
    const { stdout } = await git(repo, 'rev-list', '--count', `${branchOf(peasant)}..${base}`);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0; // no branch yet: it will be cut from base anyway
  }
}

/**
 * Bring a reused worktree up to base, but ONLY when there is nothing to lose:
 * a clean tree with no commits of its own. A branch holding unmerged work is
 * left exactly as it is — the caller warns instead. Silently rewriting a
 * peasant's branch to catch it up would destroy work nobody asked to discard.
 */
async function catchUp(repo, path, branch, base) {
  const [{ stdout: dirty }, { stdout: ahead }] = await Promise.all([
    git(path, 'status', '--porcelain'),
    git(repo, 'rev-list', '--count', `${base}..${branch}`),
  ]);
  if (dirty.trim() || Number(ahead.trim())) return false;
  await git(path, 'merge', '--ff-only', base).catch(() => {});
  return true;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * On Windows, a directory that was extremely recently a child process's cwd
 * (a test run inside the worktree, say) can stay locked for a few ticks after
 * that process exits — the OS reports "Permission denied" even though
 * nothing is using the path anymore. Retrying briefly clears it. Anything
 * else — a real lock that never clears, or an unrelated failure — must still
 * surface after the budget runs out, or this stops being a retry and starts
 * being a silence.
 */
export async function retryTransient(fn, { attempts = 5, delayMs = 150 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !/permission denied|operation not permitted/i.test(e.stderr ?? e.message ?? '')) throw e;
      await delay(delayMs * attempt);
    }
  }
}

export async function removeWorktree(repo, peasant) {
  const path = worktreePath(repo, peasant);
  if (!existsSync(path)) return;
  await retryTransient(() => git(repo, 'worktree', 'remove', '--force', path));
}

/**
 * Commit whatever the peasant left lying in its worktree. Peasants edit files
 * but routinely forget to commit, and `diff base...branch` only sees commits —
 * so without this the orchestrator reviews an empty diff and the merge is a no-op.
 * Idempotent: a clean tree is not an error.
 */
export async function commitAll(repo, peasant, message) {
  const path = worktreePath(repo, peasant);
  await git(path, 'add', '-A');
  try {
    await git(path, 'commit', '-m', message);
    return true;
  } catch {
    return false; // nothing staged
  }
}

/** Unified diff of a peasant's branch against the base. */
export async function diffOf(repo, peasant, base, file = null) {
  const args = ['diff', `${base}...${branchOf(peasant)}`];
  if (file) args.push('--', file);
  const { stdout } = await git(repo, ...args);
  return stdout;
}

export async function statOf(repo, peasant, base) {
  const { stdout } = await git(repo, 'diff', '--stat', `${base}...${branchOf(peasant)}`);
  return stdout;
}

/**
 * Would merging this peasant conflict? Answered WITHOUT touching the working
 * tree — `merge-tree --write-tree` computes the merge in memory (git 2.38+).
 * Returns the conflicted paths, empty when clean.
 */
export const conflictsWith = (repo, peasant, base) => conflictsBetween(repo, base, branchOf(peasant));

/** The same in-memory check for two arbitrary refs. */
export async function conflictsBetween(repo, left, right) {
  try {
    await git(repo, 'merge-tree', '--write-tree', '--name-only', left, right);
    return []; // exit 0 = merges cleanly
  } catch (e) {
    // exit 1 = conflicts. stdout is: <tree-oid>\n<conflicted paths>\n\n<messages>
    const lines = String(e.stdout ?? '').split('\n').slice(1);
    const end = lines.indexOf('');
    const paths = (end === -1 ? lines : lines.slice(0, end)).map((s) => s.trim()).filter(Boolean);
    if (paths.length) return paths;
    if (e.code === 1) return ['(conflict, paths unavailable)'];
    throw e; // a real git failure, not a conflict
  }
}

/**
 * Integrate one accepted peasant branch into a run branch. The target is a
 * dedicated worktree, so a run can recover and review without changing the
 * original checkout. Duplicate integrations are harmless at the Git level
 * because the source is already an ancestor of the target.
 */
export async function mergeIntoRun(repo, peasant, runId, { expectedRevision = null } = {}) {
  const path = runWorktreePath(repo, runId);
  const source = branchOf(peasant);
  const actual = await revisionOf(repo, source);
  if (expectedRevision && actual !== expectedRevision) {
    throw new Error(
      `Refusing stale integration for "${peasant}": expected ${expectedRevision}, found ${actual}.`);
  }
  const { stdout: dirty } = await git(path, 'status', '--porcelain');
  if (dirty.trim()) throw new Error(`Refusing integration: run ${runId} has uncommitted changes.`);
  const target = (await git(path, 'branch', '--show-current')).stdout.trim();
  const conflicts = await conflictsBetween(repo, target, source);
  if (conflicts.length) {
    throw new Error(
      `"${peasant}" conflicts with run ${runId} in:\n  ${conflicts.join('\n  ')}\n`
      + 'Nothing was changed. Resolve the conflict on the run branch before retrying.');
  }
  try {
    const { stdout } = await git(path, 'merge', '--no-ff', source, '-m',
      `kingdom: integrate ${peasant} into run ${runId}`);
    return { output: stdout, branch: target, revision: await revisionOf(path) };
  } catch (e) {
    await git(path, 'merge', '--abort').catch(() => {});
    throw new Error(`Run integration failed and was rolled back cleanly: ${e.message}`);
  }
}

/**
 * Merge a peasant onto the base branch, or change nothing at all.
 *
 * An earlier version ran `checkout base && merge`, which on a conflict left the
 * user's REAL branch sitting in a half-merged state with conflict markers.
 * Parallel peasants touching one file is the normal case here, so that had to
 * become impossible: conflicts are detected in memory first, a dirty tree is
 * refused outright, and any surprise mid-merge is rolled back.
 */
export async function mergeWorktree(repo, peasant, base) {
  const { stdout: dirty } = await git(repo, 'status', '--porcelain');
  if (dirty.trim()) {
    throw new Error(
      `Refusing to merge: ${base} has uncommitted changes. Commit or stash them first.`
    );
  }

  const conflicts = await conflictsWith(repo, peasant, base);
  if (conflicts.length) {
    throw new Error(
      `"${peasant}" conflicts with ${base} in:\n  ${conflicts.join('\n  ')}\n` +
      `Nothing was changed. Send it back to ${peasant} to rebase on ${base}.`
    );
  }

  return mergeOntoBase(repo, base, branchOf(peasant), `kingdom: merge work of ${peasant}`, 'Merge');
}

/**
 * Check out base and merge `branch` into it, or change nothing: any failure
 * mid-merge is aborted and the original branch restored.
 */
async function mergeOntoBase(repo, base, branch, message, what) {
  const { stdout: was } = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const original = was.trim();
  await git(repo, 'checkout', base);
  try {
    return (await git(repo, 'merge', '--no-ff', branch, '-m', message)).stdout;
  } catch (e) {
    // Never leave the repo mid-merge.
    await git(repo, 'merge', '--abort').catch(() => {});
    if (original && original !== base) await git(repo, 'checkout', original).catch(() => {});
    throw new Error(`${what} failed and was rolled back cleanly: ${e.message}`);
  }
}

/** Apply a reviewed run branch through the same clean-tree and conflict checks as a member merge. */
export async function mergeRunBranch(repo, runId, base) {
  const branch = runBranch(runId);
  const { stdout: dirty } = await git(repo, 'status', '--porcelain');
  if (dirty.trim()) throw new Error(`Refusing to apply run ${runId}: ${base} has uncommitted changes.`);
  const conflicts = await conflictsBetween(repo, base, branch);
  if (conflicts.length) throw new Error(`Run ${runId} conflicts with ${base} in:\n  ${conflicts.join('\n  ')}\nNothing was changed.`);
  // Merge into base explicitly, the same way mergeWorktree does — the only
  // safety check above this compares commit hashes, which stays unchanged if
  // something merely checks out a different branch at the same commit.
  const output = await mergeOntoBase(repo, base, branch, `kingdom: apply reviewed run ${runId}`, `Applying run ${runId}`);
  return { output, revision: await revisionOf(repo) };
}

/**
 * Does this look like a project `node --test` can run? A test/ directory
 * holding JavaScript, or a *.test.js beside the code. Deliberately a shallow
 * look: the question is which runner to use, and a directory scan that walks
 * the tree costs more than the answer is worth.
 */
function nodeTests(dir) {
  const js = /\.(?:c|m)?js$/;
  const names = (d) => { try { return readdirSync(d); } catch { return []; } };
  if (names(join(dir, 'test')).some((f) => js.test(f))) return true;
  if (names(join(dir, 'tests')).some((f) => js.test(f))) return true;
  return names(dir).some((f) => /\.test\.(?:c|m)?js$/.test(f));
}

/**
 * The project's own verification command, discovered rather than configured.
 * Returns null when the project has no tests — the caller must treat that as
 * "unverified", never as "passed".
 */
export function testCommand(dir) {
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {};
      if (scripts.test) return ['npm', ['test', '--silent']];
      if (scripts.build) return ['npm', ['run', 'build', '--silent']];
    } catch {}
  }
  // Node's own runner, for the case the package.json branch above cannot
  // answer: a repo with no package.json at all, or one whose package.json has
  // no test script. Both are ordinary for a stdlib-only Node project, and both
  // used to fall all the way through to null.
  //
  // This is the Flutter bug directly below, in the ecosystem this application
  // is itself written in. Watched live: a peasant wrote lib/select.js and
  // test/select.test.js, called declare_done, and the crown reported
  // `{ran: false, ok: false, output: 'No test/build command found in this
  // project.'}` — for a repository whose only content was tests and the code
  // they cover. The orchestrator is told to treat that as UNVERIFIED and
  // send_back, so four correct implementations were about to be bounced for
  // having no tests, in a directory full of them.
  //
  // Bare `node --test`, not a path: that is Node's own default glob
  // (**/*.test.?(c|m)js, **/test/**, ...), so it finds root-level tests as well
  // as test/, and stays whatever the installed Node says it is.
  if (nodeTests(dir)) return ['node', ['--test']];

  // Flutter before Dart: a Flutter project has a pubspec too, and `dart test`
  // cannot load the Flutter test bindings. Without this every peasant in a
  // Flutter repo is reported to the orchestrator as "TESTS: NONE FOUND" — the court
  // reviews and merges work that was never verified, in a repo that has a
  // full test suite sitting right there.
  if (existsSync(join(dir, 'pubspec.yaml'))) {
    const flutter = existsSync(join(dir, 'android')) || existsSync(join(dir, 'ios'))
      || /^\s+flutter:/m.test(readFileSync(join(dir, 'pubspec.yaml'), 'utf8'));
    return flutter ? ['flutter', ['test']] : ['dart', ['test']];
  }
  if (existsSync(join(dir, 'Cargo.toml'))) return ['cargo', ['test']];
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'pytest.ini')))
    return ['pytest', ['-q']];
  if (existsSync(join(dir, 'go.mod'))) return ['go', ['test', './...']];
  return null;
}

export async function runTests(dir, { revision = null } = {}) {
  const cmd = testCommand(dir);
  let checkedRevision = null;
  try { checkedRevision = await revisionOf(dir); } catch {}
  if (!cmd) return {
    ran: false, ok: false, stale: false, revision: checkedRevision,
    output: 'No test/build command found in this project.',
  };
  // npm/cargo/pytest are .cmd shims on Windows and need a shell. Node warns
  // (DEP0190) when args ride beside shell:true, because it only concatenates
  // them — so on Windows the command goes as one string. Every part is a fixed
  // literal from testCommand(), never input, so there is nothing to escape.
  const win = process.platform === 'win32';
  const [file, args] = win ? [[cmd[0], ...cmd[1]].join(' '), []] : cmd;
  let passed, output;
  try {
    const { stdout, stderr } = await exec(file, args, {
      cwd: dir,
      shell: win,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      windowsHide: true,
    });
    passed = true;
    output = stdout + stderr;
  } catch (e) {
    passed = false;
    output = (e.stdout ?? '') + (e.stderr ?? e.message);
  }
  const after = await revisionOf(dir).catch(() => checkedRevision);
  const stale = Boolean(revision && after !== revision);
  return {
    ran: true, ok: passed && !stale, stale, revision: after,
    output: output.slice(-8000) + (stale
      ? `\nVerification invalidated: HEAD changed from ${revision} to ${after}.`
      : ''),
  };
}
