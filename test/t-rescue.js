// A peasant CANNOT commit. Its worktree's .git is a file pointing into the main
// repo, which is outside the codex workspace-write sandbox, so `git add` dies on
// .git/index.lock. That is deliberate — one peasant with write access to the
// shared .git could destroy every other peasant's branch.
//
// The consequence is that the crown committing is the ONLY path from "edited
// files" to "work anyone can see". A peasant that hits the git error, reports a
// blocker instead of calling declare_done, and then goes idle used to strand its
// work in the worktree forever. Seven modified files were sitting exactly like
// that when this was written.
//
//   node test/t-rescue.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, commitAll, worktreePath } from '../src/worktree.js';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-rescue-'));
const repo = join(dir, 'repo');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

execFileSync('git', ['init', '-q', repo, '--initial-branch=main'], { encoding: 'utf8' });
git(repo, 'config', 'user.email', 't@t.t');
git(repo, 'config', 'user.name', 't');
writeFileSync(join(repo, 'a.txt'), 'one\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'init');

const wt = await createWorktree(repo, 'coder', 'main');

/* ---------- the structural fact this all rests on ---------- */
const dotgit = readFileSync(join(wt, '.git'), 'utf8').trim();
a.match(dotgit, /^gitdir: /, "a linked worktree's .git is a file, not a directory");
const gitdir = dotgit.slice('gitdir: '.length);
a.ok(!gitdir.startsWith(wt),
  'the git dir lives OUTSIDE the worktree — this is why a sandboxed peasant cannot commit');
console.log(`  .git -> ${gitdir.replace(dir, '…')}  (outside the workspace)`);

/* ---------- a peasant leaves edits behind and never declares done ---------- */
writeFileSync(join(wt, 'a.txt'), 'one\ntwo\n');
writeFileSync(join(wt, 'new.txt'), 'work nobody asked to be committed\n');

const before = git(wt, 'status', '--porcelain');
a.ok(before.trim().length > 0, 'setup: the worktree should be dirty');

/* ---------- the crown, which is NOT sandboxed, can rescue it ---------- */
const rescued = await commitAll(repo, 'coder', 'WIP: coder slept with uncommitted work');
a.equal(rescued, true, 'the crown must be able to commit what the peasant could not');

a.equal(git(wt, 'status', '--porcelain').trim(), '', 'nothing may be left uncommitted');
const log = git(repo, 'log', '--oneline', 'kingdom/coder', '-1');
a.match(log, /WIP: coder slept/, 'the rescue commit must land on the peasant branch');

// and the content is genuinely recoverable, not an empty commit
const show = git(repo, 'show', '--stat', '--oneline', 'kingdom/coder');
a.match(show, /a\.txt/, 'the modified file must be in the commit');
a.match(show, /new\.txt/, 'the untracked file must be in the commit too');
console.log(`  rescued: ${log.trim()}`);

/* ---------- rescuing a clean worktree must be a no-op, not an empty commit --- */
const again = await commitAll(repo, 'coder', 'WIP: should not happen');
a.equal(again, false, 'a clean worktree must produce no commit at all');
a.equal(git(repo, 'log', '--oneline', 'kingdom/coder', '-1').trim(), log.trim(),
  'and must not move the branch');
console.log('  clean worktree: no empty commit');

/* ---------- the base branch must be untouched throughout ---------- */
a.equal(git(repo, 'rev-parse', 'main').trim(), git(repo, 'rev-parse', 'main').trim());
a.equal(git(repo, 'log', '--oneline', 'main').trim().split('\n').length, 1,
  'rescuing a peasant must never commit to the base branch');
console.log('  base branch untouched');

git(repo, 'worktree', 'remove', '--force', worktreePath(repo, 'coder'));
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
console.log('t-rescue.js OK — idle peasants never strand uncommitted work');
