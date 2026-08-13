// The merge path, without spending a single token: worktree -> edit ->
// auto-commit -> diff -> test discovery -> merge onto the base branch.
//   node test/t-merge.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRepo, behindBase, commitAll, conflictsWith, createWorktree, diffOf, mergeWorktree,
  removeWorktree, runTests, statOf, worktreePath,
} from '../src/worktree.js';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-merge-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'math.js'), 'export const add = (a,b) => a+b;\n');
writeFileSync(join(repo, 'package.json'), JSON.stringify({
  name: 'demo', type: 'module',
  scripts: { test: 'node -e "import(\'./math.js\').then(m=>{if(m.subtract(7,3)!==4)process.exit(1)})"' },
}));
git('add', '-A');
git('commit', '-qm', 'init');

const base = await assertRepo(repo);
a.equal(base, execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).toString().trim());

const wt = await createWorktree(repo, 'coder', base);
a.ok(wt.includes('coder'));
a.equal(await createWorktree(repo, 'coder', base), wt, 'createWorktree must be idempotent');

// The peasant edits but does NOT commit — the common case.
writeFileSync(join(wt, 'math.js'), 'export const add = (a,b) => a+b;\nexport const subtract = (a,b) => a-b;\n');

// Before auto-commit the branch diff is empty; this is the bug commitAll fixes.
a.equal((await diffOf(repo, 'coder', base)).trim(), '', 'uncommitted work is invisible to a branch diff');

a.equal(await commitAll(repo, 'coder', 'add subtract'), true);
a.equal(await commitAll(repo, 'coder', 'nothing left'), false, 'clean tree must not error');

const diff = await diffOf(repo, 'coder', base);
a.ok(diff.includes('subtract'), 'diff must show the work after auto-commit');
a.ok((await statOf(repo, 'coder', base)).includes('math.js'));

const tests = await runTests(worktreePath(repo, 'coder'));
a.equal(tests.ran, true, 'npm test must be discovered from package.json');
a.equal(tests.ok, true, `tests should pass in the worktree: ${tests.output}`);

// A conflicting peasant must be refused WITHOUT touching the repo -----
const wt2 = await createWorktree(repo, 'rival', base);
writeFileSync(join(wt2, 'math.js'), 'export const add = (a,b) => a+b;\nexport const subtract = (a,b) => (a)-(b);\n');
await commitAll(repo, 'rival', 'rival subtract');
a.ok((await conflictsWith(repo, 'rival', base)).length === 0, 'no conflict against untouched base yet');

await mergeWorktree(repo, 'coder', base);
a.ok(readFileSync(join(repo, 'math.js'), 'utf8').includes('subtract'), 'work must land on the base branch');

// Now base has coder's version, so rival genuinely conflicts.
const clash = await conflictsWith(repo, 'rival', base);
a.ok(clash.length > 0, 'rival must be detected as conflicting');
a.ok(clash.some((f) => f.includes('math.js')), `conflict should name math.js, got ${clash}`);

const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
await a.rejects(() => mergeWorktree(repo, 'rival', base), /conflicts with/i,
  'a conflicting merge must be refused');
const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
a.equal(headAfter, headBefore, 'a refused merge must not move HEAD');
a.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim(), '',
  'a refused merge must leave a CLEAN tree — no conflict markers, no half-merge');

// A dirty base must be refused before anything is attempted ------------
writeFileSync(join(repo, 'scratch.txt'), 'uncommitted\n');
await a.rejects(() => mergeWorktree(repo, 'rival', base), /uncommitted changes/i,
  'must refuse to merge into a dirty tree');
rmSync(join(repo, 'scratch.txt'));

// Worktrees are removable after merge (the cleanup path) ---------------
await removeWorktree(repo, 'coder');
a.equal(existsSync(worktreePath(repo, 'coder')), false, 'merged worktree must be removed');

// A directory that is not a live worktree must be REBUILT, not handed over.
// `wt/tester` was found in the wild as a plain folder: existsSync passed, so
// the peasant got a cwd where nothing it wrote could ever be committed.
{
  const dead = worktreePath(repo, 'ghost');
  mkdirSync(dead, { recursive: true });
  writeFileSync(join(dead, 'stray.txt'), 'not a worktree\n');
  const rebuilt = await createWorktree(repo, 'ghost', base);
  a.equal(rebuilt, dead, 'the path must be reused');
  a.ok(existsSync(join(dead, '.git')), 'a dead directory must be rebuilt as a real worktree');
  a.equal(await commitAll(repo, 'ghost', 'proof it is committable'), false, 'and start clean');
  // The real `wt/tester` held three documents the tester had written and could
  // never commit. Repairing the state must not destroy the work being rescued.
  a.ok(existsSync(join(`${dead}.orphan`, 'stray.txt')),
    'whatever was stranded in the dead directory must be moved aside, not deleted');
}

// A reused worktree must not silently be left behind the base branch.
{
  const wt3 = await createWorktree(repo, 'drifter', base);
  writeFileSync(join(repo, 'moved-on.txt'), 'base advanced\n');
  git('add', '-A');
  git('commit', '-qm', 'base advances');

  a.equal(await behindBase(repo, 'drifter', base), 1, 'the stale worktree must be detectable');
  await createWorktree(repo, 'drifter', base);   // reuse: clean, no work of its own
  a.equal(await behindBase(repo, 'drifter', base), 0, 'a clean idle worktree must be caught up');
  a.ok(existsSync(join(wt3, 'moved-on.txt')), 'and the new commit must actually be in its checkout');

  // ...but a branch holding unmerged work is left exactly as it is.
  writeFileSync(join(wt3, 'mine.txt'), 'my unmerged work\n');
  await commitAll(repo, 'drifter', 'work of its own');
  writeFileSync(join(repo, 'moved-again.txt'), 'base advanced again\n');
  git('add', '-A');
  git('commit', '-qm', 'base advances again');
  await createWorktree(repo, 'drifter', base);
  a.equal(await behindBase(repo, 'drifter', base), 1,
    'a branch with unmerged work must be reported behind, never rewritten');
  a.ok(existsSync(join(wt3, 'mine.txt')), 'and its work must survive untouched');
}

// A project with no tests must report unverified, never "passed".
const bare = mkdtempSync(join(tmpdir(), 'kingdom-bare-'));
const none = await runTests(bare);
a.equal(none.ran, false);
a.equal(none.ok, false, 'no tests must never report ok');

for (const d of [repo, bare]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-merge.js OK — worktree, auto-commit, diff, test discovery, merge');
