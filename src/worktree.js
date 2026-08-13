// Git worktree isolation: one branch + one checkout per peasant, so two
// peasants editing the same file cannot corrupt each other. Kingdom state
// lives OUTSIDE the target repo (a sibling .kingdom dir) — nesting worktrees
// inside the main checkout makes git status noisy and confuses file tools.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Token store shared by every repo. Per-repo stores override it.
 * KINGDOM_TOKEN_STORE relocates it (an encrypted volume, or test isolation).
 */
export const globalTokenStore = () =>
  process.env.KINGDOM_TOKEN_STORE ?? join(homedir(), '.kingdom', 'tokens.json');

const exec = promisify(execFile);

const git = (cwd, ...args) => exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });

/** Where this repo's kingdom lives: <repoParent>/.kingdom/<repoName>/ */
export function kingdomDir(repo) {
  const r = resolve(repo);
  return join(dirname(r), '.kingdom', basename(r));
}

export const dbPath = (repo) => join(kingdomDir(repo), 'kingdom.db');
export const worktreePath = (repo, peasant) => join(kingdomDir(repo), 'wt', peasant);
const branchOf = (peasant) => `kingdom/${peasant}`;

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
export async function ensureRepo(repo, { onInit } = {}) {
  let top = null;
  try {
    top = (await git(repo, 'rev-parse', '--show-toplevel')).stdout.trim();
  } catch { /* not a repo, or git absent — both handled below */ }

  if (top && resolve(top) !== resolve(repo)) {
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
  if (existsSync(path)) {
    try {
      await git(path, 'rev-parse', '--git-dir');
      await catchUp(repo, path, branch, base);
      return path;
    } catch {
      // MOVED ASIDE, never deleted. The real `wt/tester` found in the wild held
      // three documents the tester had written — stranded, because the folder
      // was not a worktree so nothing could ever commit them. Deleting to
      // repair the state would have destroyed exactly the work the repair
      // exists to rescue.
      let aside = `${path}.orphan`;
      for (let n = 2; existsSync(aside); n++) aside = `${path}.orphan-${n}`;
      renameSync(path, aside);
      await git(repo, 'worktree', 'prune').catch(() => {});
    }
  }

  const { stdout } = await git(repo, 'branch', '--list', branch);
  try {
    if (stdout.trim()) await git(repo, 'worktree', 'add', path, branch);
    else await git(repo, 'worktree', 'add', '-b', branch, path, base);
  } catch (e) {
    // Belt and braces against a racing caller: if the worktree now exists,
    // that is the outcome we wanted anyway.
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

export async function removeWorktree(repo, peasant) {
  const path = worktreePath(repo, peasant);
  if (!existsSync(path)) return;
  await git(repo, 'worktree', 'remove', '--force', path);
}

/**
 * Commit whatever the peasant left lying in its worktree. Peasants edit files
 * but routinely forget to commit, and `diff base...branch` only sees commits —
 * so without this the king reviews an empty diff and the merge is a no-op.
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
export async function conflictsWith(repo, peasant, base) {
  try {
    await git(repo, 'merge-tree', '--write-tree', '--name-only', base, branchOf(peasant));
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

  const { stdout: was } = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const original = was.trim();
  await git(repo, 'checkout', base);
  try {
    const { stdout } = await git(repo, 'merge', '--no-ff', branchOf(peasant), '-m',
      `kingdom: merge work of ${peasant}`);
    return stdout;
  } catch (e) {
    // Never leave the repo mid-merge.
    await git(repo, 'merge', '--abort').catch(() => {});
    if (original && original !== base) await git(repo, 'checkout', original).catch(() => {});
    throw new Error(`Merge failed and was rolled back cleanly: ${e.message}`);
  }
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
  // Flutter before Dart: a Flutter project has a pubspec too, and `dart test`
  // cannot load the Flutter test bindings. Without this every peasant in a
  // Flutter repo is reported to the king as "TESTS: NONE FOUND" — the court
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

export async function runTests(dir) {
  const cmd = testCommand(dir);
  if (!cmd) return { ran: false, ok: false, output: 'No test/build command found in this project.' };
  try {
    const { stdout, stderr } = await exec(cmd[0], cmd[1], {
      cwd: dir,
      shell: process.platform === 'win32', // npm/cargo/pytest are shims on Windows
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    return { ran: true, ok: true, output: (stdout + stderr).slice(-8000) };
  } catch (e) {
    return { ran: true, ok: false, output: ((e.stdout ?? '') + (e.stderr ?? e.message)).slice(-8000) };
  }
}
