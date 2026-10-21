// test/cleanup.js deletes a repo and its own kingdom folder, never a sibling's
// and never the shared `.kingdom` parent.
//
//   node test/t-cleanup.js
import { strict as a } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/agenticos.js';
import { kingdomDir } from '../src/worktree.js';
import { ownKingdomDir, removeRepo } from './cleanup.js';

// A private parent, so this suite's own `.kingdom` is not the shared temp one.
const parent = mkdtempSync(join(tmpdir(), 'kingdom-cleanup-'));
const repo = join(parent, 'mine');
const sibling = join(parent, 'theirs');
mkdirSync(repo);
mkdirSync(sibling);
writeFileSync(join(repo, 'README.md'), '# mine\n');

// A real Kingdom creates the folder this helper exists to remove.
const k = new Kingdom(repo, join(repo, 'agenticos.config.json'));
k.bus.set('probe', '1');
k.bus.close();
a.ok(existsSync(join(kingdomDir(repo), 'kingdom.db')), 'a Kingdom keeps its db beside the repo, not in it');
mkdirSync(kingdomDir(sibling), { recursive: true });
writeFileSync(join(kingdomDir(sibling), 'kingdom.db'), 'another suite');

removeRepo(repo);
a.equal(existsSync(repo), false, 'the repo is removed');
a.equal(existsSync(kingdomDir(repo)), false, 'and so is its own kingdom folder');
a.ok(existsSync(join(kingdomDir(sibling), 'kingdom.db')), "a sibling repo's kingdom state is untouched");
a.ok(existsSync(join(parent, '.kingdom')), 'the shared .kingdom parent is never deleted');

a.throws(() => removeRepo(null), /never deletes the workspace home/);
a.throws(() => ownKingdomDir(''), /never deletes the workspace home/);
removeRepo(join(parent, 'never-existed'));   // nothing there: no throw

rmSync(parent, { recursive: true, force: true });
console.log('t-cleanup.js OK — a suite removes its own repo and kingdom folder, never a sibling or the shared parent');
