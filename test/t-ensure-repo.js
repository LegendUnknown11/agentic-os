// The kingdom creates the repository instead of demanding one.
//
// Every peasant works in a git worktree and every review is a diff, so a folder
// that is not a repo used to be a hard stop: "X is not a git repository." You
// now point the kingdom at any folder. What this pins is the two ways that can
// go wrong — nesting inside someone else's repo, and a base commit that does
// not include what was already there.
//
//   node test/t-ensure-repo.js
import { strict as a } from 'node:assert';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { ensureRepo } from '../src/worktree.js';

const git = (cwd, ...x) => execFileSync('git', x, { cwd, stdio: 'pipe' }).toString();
const tmp = () => mkdtempSync(join(tmpdir(), 'kingdom-repo-'));

/* ---------- a plain folder with files in it ----------------------------- */
const plain = tmp();
writeFileSync(join(plain, 'notes.md'), '# already here\n');
mkdirSync(join(plain, 'sub'));
writeFileSync(join(plain, 'sub', 'deep.txt'), 'nested\n');

const created = [];
const base = await ensureRepo(plain, { onInit: (w) => created.push(w) });

a.ok(existsSync(join(plain, '.git')), 'the folder must now be a repository');
a.equal(base, 'main', 'the base branch must be deterministic, not the machine init.defaultBranch');
a.ok(created.length, 'the sovereign must be told the kingdom created it');

// The base commit must CONTAIN what was already in the folder. An empty base
// would put the entire pre-existing project in every peasant's first diff.
const tracked = git(plain, 'ls-files');
a.match(tracked, /notes\.md/, 'existing files must be in the base commit');
a.match(tracked, /sub\/deep\.txt/, 'including nested ones');
a.equal(git(plain, 'status', '--porcelain').trim(), '', 'and the tree must be clean afterwards');

/* ---------- idempotent -------------------------------------------------- */
const again = [];
a.equal(await ensureRepo(plain, { onInit: (w) => again.push(w) }), 'main');
a.equal(again.length, 0, 'a second call must do nothing at all');
a.equal(git(plain, 'rev-list', '--count', 'HEAD').trim(), '1', 'and must not add a second commit');

/* ---------- an empty folder still gets a usable base -------------------- */
const empty = tmp();
a.equal(await ensureRepo(empty), 'main');
a.equal(git(empty, 'rev-list', '--count', 'HEAD').trim(), '1',
  'a worktree cannot be cut from a repo with no commit — an empty folder needs one too');

/* ---------- a missing folder becomes a usable repository --------------- */
// The headless CLI accepts a path for a brand-new toy project. Git cannot use
// that path as cwd until Kingdom creates it, so this must not surface as the
// misleading `spawn git ENOENT` seen by a sovereign starting fresh work.
const missingParent = tmp();
const missing = join(missingParent, 'new-project');
a.ok(!existsSync(missing), 'the regression needs an actually absent target directory');
a.equal(await ensureRepo(missing), 'main');
a.ok(existsSync(join(missing, '.git')), 'a missing target must be created before Git is invoked');
a.equal(git(missing, 'rev-list', '--count', 'HEAD').trim(), '1',
  'the new target still needs the ordinary usable base commit');

/* ---------- NEVER nest inside an existing repository -------------------- */
// A nested repo silently shadows the outer one: the sovereign's real history
// stops being visible to git, to the court, and to their own editor.
const outer = tmp();
git(outer, 'init', '-b', 'main');
git(outer, 'config', 'user.email', 'k@kingdom');
git(outer, 'config', 'user.name', 'kingdom');
writeFileSync(join(outer, 'README.md'), '# outer\n');
git(outer, 'add', '-A');
git(outer, 'commit', '-m', 'init');
const inner = join(outer, 'packages', 'thing');
mkdirSync(inner, { recursive: true });

await a.rejects(() => ensureRepo(inner), /nested/i,
  'a folder inside a repo must be refused, not quietly turned into a second repo');
a.ok(!existsSync(join(inner, '.git')), 'and nothing may be created on the way to refusing');

/* ---------- an existing repo is left exactly alone ---------------------- */
const touched = [];
a.equal(await ensureRepo(outer, { onInit: (w) => touched.push(w) }), 'main');
a.equal(touched.length, 0);
a.equal(git(outer, 'rev-list', '--count', 'HEAD').trim(), '1', 'no extra commit in a real repo');

/* ---------- the SAME repo reached by another name is not "nested" ------- */
// The nesting check compared path strings. Two names for one directory made it
// reject a repo as nested inside ITSELF: on CI, os.tmpdir() gave the 8.3 short
// form (C:\Users\RUNNER~1\...) while git reported C:/Users/runneradmin/...,
// and 23 suites died on a machine where all 67 passed locally. A junction is
// the portable way to get two names for one directory — Windows allows it
// without elevation, and on POSIX node makes an ordinary dir symlink.
const alias = join(dirname(outer), `${basename(outer)}-alias`);
symlinkSync(outer, alias, 'junction');
a.equal(await ensureRepo(alias), 'main',
  'a second name for a repo is that same repo, not a nested one');
a.equal(git(outer, 'rev-list', '--count', 'HEAD').trim(), '1',
  'and reaching it by the alias must not commit anything');
rmSync(alias, { recursive: true, force: true });

for (const d of [plain, empty, missingParent, outer]) rmSync(d, { recursive: true, force: true });
console.log('t-ensure-repo.js OK — folders become repos, existing history is never nested or touched');
