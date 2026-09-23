// Target-repository snapshot/restore (Habitable pilot step one — see
// HANDOFF.md). A worker must never touch a target repo's dirty checkout
// without first being able to put it back exactly as found.
//
//   node test/t-snapshot.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotRepo, restoreSnapshot } from '../src/snapshot.js';

const git = (cwd, ...x) => execFileSync('git', x, { cwd, stdio: 'pipe' }).toString();
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

const repo = tmp('kingdom-snap-repo-');
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.email', 'k@kingdom');
git(repo, 'config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'app.js'), 'console.log("v1");\n');
writeFileSync(join(repo, 'keep.txt'), 'will be deleted before the snapshot\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-m', 'init');

/* ---------- dirty the checkout ------------------------------------------
 * tracked edit, tracked deletion, new untracked source (flat and nested),
 * a secret, and a build directory — the acceptance scenario verbatim. */
writeFileSync(join(repo, 'app.js'), 'console.log("v2 - uncommitted");\n');
rmSync(join(repo, 'keep.txt'));
writeFileSync(join(repo, 'feature.js'), 'export const x = 1;\n');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'helper.js'), 'export const helper = () => 2;\n');

writeFileSync(join(repo, '.env'), 'API_KEY=super-secret\n');
mkdirSync(join(repo, 'dist'), { recursive: true });
writeFileSync(join(repo, 'dist', 'bundle.js'), '/* built */\n');

const beforeStatus = git(repo, 'status', '--porcelain');

/* ---------- snapshot ----------------------------------------------------- */
const dest = tmp('kingdom-snap-store-');
const manifest = await snapshotRepo(repo, dest);

a.equal(git(repo, 'status', '--porcelain'), beforeStatus,
  'snapshotRepo must leave the original checkout untouched');

const paths = manifest.files.map((f) => f.path.replace(/\\/g, '/'));
a.ok(paths.includes('app.js'), 'tracked dirty edit must be captured');
a.ok(paths.includes('keep.txt'), 'tracked deletion must be captured');
a.ok(paths.includes('feature.js'), 'untracked source must be captured');
a.ok(paths.includes('src/helper.js'), 'nested untracked source must be captured');

a.ok(!paths.includes('.env'), 'a secret must never enter the manifest');
a.ok(!paths.some((p) => p.startsWith('dist/')), 'build output must never enter the manifest');
a.ok(!existsSync(join(dest, 'files', '.env')), 'nor may the secret\'s bytes reach disk in the snapshot');
a.ok(!existsSync(join(dest, 'files', 'dist')), 'nor the build directory\'s');
a.ok(manifest.excluded.includes('.env') && manifest.excluded.some((p) => p.startsWith('dist/')),
  'what was excluded is recorded, not silently dropped');

/* ---------- mutate everything, captured or not --------------------------- */
writeFileSync(join(repo, 'app.js'), 'console.log("v3 - mutated after snapshot");\n');
writeFileSync(join(repo, 'keep.txt'), 'recreated by the mutation\n');
writeFileSync(join(repo, 'feature.js'), 'export const x = 999;\n');
writeFileSync(join(repo, 'src', 'helper.js'), 'mutated\n');
writeFileSync(join(repo, '.env'), 'API_KEY=rotated\n');
writeFileSync(join(repo, 'dist', 'bundle.js'), '/* rebuilt */\n');

/* ---------- restore -------------------------------------------------------
 * tracked + untracked source come back byte-for-byte; the tracked deletion
 * is reapplied; whatever was never captured is left exactly as the mutation
 * left it, because restore never touched it in the first place. */
restoreSnapshot(repo, dest);

a.equal(readFileSync(join(repo, 'app.js'), 'utf8'), 'console.log("v2 - uncommitted");\n',
  'tracked edit restored byte-for-byte');
a.ok(!existsSync(join(repo, 'keep.txt')),
  'the tracked deletion is restored too — the file the mutation recreated is gone again');
a.equal(readFileSync(join(repo, 'feature.js'), 'utf8'), 'export const x = 1;\n',
  'untracked source restored byte-for-byte');
a.equal(readFileSync(join(repo, 'src', 'helper.js'), 'utf8'), 'export const helper = () => 2;\n',
  'nested untracked source restored byte-for-byte');

a.equal(readFileSync(join(repo, '.env'), 'utf8'), 'API_KEY=rotated\n',
  'restore never touches a secret it never captured');
a.equal(readFileSync(join(repo, 'dist', 'bundle.js'), 'utf8'), '/* rebuilt */\n',
  'restore never touches build output it never captured');

for (const d of [repo, dest]) rmSync(d, { recursive: true, force: true });
console.log('t-snapshot.js OK — dirty tracked and untracked source restore byte-for-byte; secrets and build output are never captured');
