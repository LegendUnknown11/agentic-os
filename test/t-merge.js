// The merge path, without spending a single token: worktree -> edit ->
// auto-commit -> diff -> test discovery -> merge onto the base branch.
//   node test/t-merge.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRepo, behindBase, commitAll, conflictsWith, createWorktree, createRunWorktree, diffOf,
  mergeIntoRun, mergeRunBranch, mergeWorktree, removeWorktree, retryTransient, revisionOf, runTests,
  statOf, testCommand, worktreePath,
} from '../src/worktree.js';
import { removeRepo } from './cleanup.js';

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

/* ---------- run integration stays in its own checkout ------------------ */
const runWorker = await createWorktree(repo, 'run-worker', base);
writeFileSync(join(runWorker, 'run-only.txt'), 'accepted by the run\n');
a.equal(await commitAll(repo, 'run-worker', 'run worker change'), true);
const sourceRevision = await revisionOf(runWorker);
const runWt = await createRunWorktree(repo, 'run-1', base);
a.equal(await revisionOf(runWt), await revisionOf(repo), 'a new run starts at the base revision');
const integrated = await mergeIntoRun(repo, 'run-worker', 'run-1', { expectedRevision: sourceRevision });
a.ok(integrated.revision, 'integration must report the resulting run revision');
a.ok(readFileSync(join(runWt, 'run-only.txt'), 'utf8').includes('accepted'));
a.equal(readFileSync(join(repo, 'math.js'), 'utf8').includes('subtract'), false,
  'run integration must not touch the original checkout');
await a.rejects(() => mergeIntoRun(repo, 'run-worker', 'run-1', { expectedRevision: 'stale' }), /stale integration/i);

// Something else has the checkout on a different branch at the same commit
// when Final Apply runs — a stale UI tab, a manual `git checkout -b`. Only a
// commit-hash comparison guards Final Apply, so this must not silently land
// the run on whatever happens to be checked out.
execFileSync('git', ['checkout', '-b', 'decoy'], { cwd: repo });
const appliedRun = await mergeRunBranch(repo, 'run-1', base);
a.ok(appliedRun.revision, 'applying a reviewed run records the new source revision');
a.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).toString().trim(), base,
  'applying a run must check out base explicitly, not merge onto whatever branch happens to be checked out');
a.ok(readFileSync(join(repo, 'run-only.txt'), 'utf8').includes('accepted'),
  'the reviewed run delta reaches the source only through its run branch');
a.ok(execFileSync('git', ['show', `${base}:run-only.txt`], { cwd: repo }).toString().includes('accepted'),
  'the delta must land on base itself, not a branch that merely happened to be checked out');

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
a.ok(tests.revision, 'verification evidence must identify the checked revision');
const stale = await runTests(worktreePath(repo, 'coder'), { revision: 'stale-revision' });
a.equal(stale.ok, false, 'evidence for a different revision must not pass');
a.equal(stale.stale, true, 'revision mismatch must be visible as stale evidence');

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

// ...and a worktree RE-CUT after a merge must be current too, which is the
// case the reuse test above cannot reach. mergeWork removes the worktree and
// `git worktree remove` deletes the directory, so the next summon finds nothing
// on disk, skips the reuse path entirely, and lands on the branch's own tip —
// wherever the member left it before its work was merged.
//
// Watched live: "coder" wrote lib/format.js, it merged, and coder was brought
// back to integrate all four modules into one CLI. Its worktree returned seven
// commits behind master holding only its own format.js. It wrote a CLI
// importing ./lib/parse, which was not there, and lost the whole turn. The
// member most likely to need current code — one on its second task — was the
// one guaranteed not to get it.
{
  const wt4 = await createWorktree(repo, 'returner', base);
  writeFileSync(join(wt4, 'first-task.txt'), 'the work it was summoned for\n');
  await commitAll(repo, 'returner', 'first task');
  await mergeWorktree(repo, 'returner', base);
  await removeWorktree(repo, 'returner');
  a.equal(existsSync(wt4), false,
    'sanity: the merge removes the checkout — that is why the next summon cannot reuse it');

  // Everybody else keeps working while it is away. This is the code it will be
  // asked to build on.
  writeFileSync(join(repo, 'somebody-elses.txt'), 'merged while it was asleep\n');
  git('add', '-A');
  git('commit', '-qm', 'the rest of the court moves on');

  const again = await createWorktree(repo, 'returner', base);
  a.equal(await behindBase(repo, 'returner', base), 0,
    'a worktree re-cut after a merge must be caught up to base, not left on the branch tip');
  a.ok(existsSync(join(again, 'somebody-elses.txt')),
    'the work it has to build on must actually be in its checkout — a task to integrate '
    + 'code it cannot see is one it cannot do');
  a.ok(existsSync(join(again, 'first-task.txt')), 'and its own merged work is still there');

  // The guard still holds: unmerged work is never rewritten under a member.
  writeFileSync(join(again, 'not-merged.txt'), 'still mine\n');
  await commitAll(repo, 'returner', 'second task, not merged');
  writeFileSync(join(repo, 'later.txt'), 'base advances again\n');
  git('add', '-A');
  git('commit', '-qm', 'base advances once more');
  await removeWorktree(repo, 'returner');
  const third = await createWorktree(repo, 'returner', base);
  a.equal(await behindBase(repo, 'returner', base), 1,
    'a re-cut branch that still holds unmerged work must be reported behind, never rewritten');
  a.ok(existsSync(join(third, 'not-merged.txt')), 'and that work must survive the re-cut');

  console.log('  a worktree re-cut after a merge comes back current, unless it holds unmerged work');
}

// A project with no tests must report unverified, never "passed".
const bare = mkdtempSync(join(tmpdir(), 'kingdom-bare-'));
const none = await runTests(bare);
a.equal(none.ran, false);
a.equal(none.ok, false, 'no tests must never report ok');

// A stdlib-only Node project has no package.json and no test script, and used
// to be reported as having no tests at all — in a directory whose entire
// content was tests and the code they cover. Watched live: a peasant wrote
// lib/select.js and test/select.test.js, called declare_done, and the crown
// answered "No test/build command found in this project." The orchestrator is
// told an unverified done-report must be sent back, so four correct
// implementations were one turn away from being bounced for missing the tests
// they had written.
//
// Same shape as the Flutter case beside it in testCommand(), in the ecosystem
// this application is itself written in.
{
  const nodeOnly = mkdtempSync(join(tmpdir(), 'kingdom-nodetest-'));
  mkdirSync(join(nodeOnly, 'test'));
  writeFileSync(join(nodeOnly, 'lib.js'), 'module.exports.two = () => 2;\n');
  writeFileSync(join(nodeOnly, 'test', 'lib.test.js'),
    "const a=require('node:assert');const t=require('node:test');\n"
    + "t('two is two', () => a.equal(require('../lib.js').two(), 2));\n");

  a.deepEqual(testCommand(nodeOnly), ['node', ['--test']],
    'a Node project with tests and no package.json must be runnable, not "no tests found"');
  const ran = await runTests(nodeOnly);
  a.equal(ran.ran, true, 'and the command must actually run');
  a.equal(ran.ok, true, `and pass. Output: ${ran.output.slice(0, 300)}`);

  // A failing test must still fail — a detector that always says ok is worse
  // than none, because the court merges on it.
  writeFileSync(join(nodeOnly, 'test', 'lib.test.js'),
    "const a=require('node:assert');const t=require('node:test');\n"
    + "t('two is three', () => a.equal(require('../lib.js').two(), 3));\n");
  const failed = await runTests(nodeOnly);
  a.equal(failed.ran, true);
  a.equal(failed.ok, false, 'a broken test must come back not-ok, or the gate is decorative');

  // package.json still wins: a project that declares its own runner gets it.
  writeFileSync(join(nodeOnly, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'echo mine' } }));
  a.deepEqual(testCommand(nodeOnly), ['npm', ['test', '--silent']],
    "a project's own test script must outrank the fallback");

  // And a directory with no JavaScript tests must stay null, not guess.
  const notNode = mkdtempSync(join(tmpdir(), 'kingdom-notnode-'));
  mkdirSync(join(notNode, 'test'));
  writeFileSync(join(notNode, 'test', 'thing.py'), 'pass\n');
  a.equal(testCommand(notNode), null, 'a test/ dir of Python must not summon node --test');

  for (const d of [nodeOnly, notNode]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log('  node --test found for a stdlib-only project; package.json still wins');
}

// Windows worktree cleanup: `git worktree remove --force` can transiently
// fail with "Permission denied" for a directory that was extremely recently
// a child process's cwd — even after that process exited and nothing else
// holds the path. It surfaced live as `wt/bob` refusing to delete right
// after a court-run test finished inside it. removeWorktree must ride that
// out, but a genuine failure (the lock never clears, or an unrelated error)
// must still reach the caller — swallowing it would just trade a crash for
// a court that thinks a worktree is gone when it is not.
{
  const denied = () => {
    const e = new Error("Command failed: git worktree remove --force x\nerror: failed to delete 'x': Permission denied\n");
    e.stderr = "error: failed to delete 'x': Permission denied\n";
    throw e;
  };

  let calls = 0;
  const clearsOnThirdTry = async () => { calls += 1; return calls < 3 ? denied() : 'removed'; };
  a.equal(await retryTransient(clearsOnThirdTry, { delayMs: 1 }), 'removed',
    'a transient permission error must be retried until it clears');
  a.equal(calls, 3, 'retryTransient must stop retrying the moment the operation succeeds');

  let stuckCalls = 0;
  const neverClears = async () => { stuckCalls += 1; denied(); };
  await a.rejects(() => retryTransient(neverClears, { attempts: 4, delayMs: 1 }), /permission denied/i,
    'a permission error that never clears must still reach the caller, not hang forever');
  a.equal(stuckCalls, 4, 'retryTransient must give up after its attempt budget, not retry unboundedly');

  let genuineCalls = 0;
  const genuineFailure = async () => { genuineCalls += 1; throw new Error('fatal: not a working tree'); };
  await a.rejects(() => retryTransient(genuineFailure, { attempts: 5, delayMs: 1 }), /not a working tree/,
    'an error unrelated to the OS lock must not be retried at all');
  a.equal(genuineCalls, 1, 'a real failure must surface on the first attempt, never masked by retrying');

  console.log('  removeWorktree rides out a transient permission error but never swallows a real one');
}

removeRepo(repo);
try { rmSync(bare, { recursive: true, force: true }); } catch {}
console.log('t-merge.js OK — worktree, auto-commit, diff, test discovery, merge');
