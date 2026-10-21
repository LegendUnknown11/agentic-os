// test/cleanup.js deletes a repo and its own AgenticOS folder, never a sibling's
// and never the shared `.agenticos` parent.
//
//   node test/t-cleanup.js
import { strict as a } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { stateDir } from '../src/worktree.js';
import { ownStateDir, removeRepo } from './cleanup.js';

// A private parent, so this suite's own `.agenticos` is not the shared temp one.
const parent = mkdtempSync(join(tmpdir(), 'agenticos-cleanup-'));
const repo = join(parent, 'mine');
const sibling = join(parent, 'theirs');
mkdirSync(repo);
mkdirSync(sibling);
writeFileSync(join(repo, 'README.md'), '# mine\n');

// A real AgenticOS creates the folder this helper exists to remove.
const k = new AgenticOS(repo, join(repo, 'agenticos.config.json'));
k.bus.set('probe', '1');
k.bus.close();
a.ok(existsSync(join(stateDir(repo), 'agenticos.db')), 'an AgenticOS keeps its db beside the repo, not in it');
mkdirSync(stateDir(sibling), { recursive: true });
writeFileSync(join(stateDir(sibling), 'agenticos.db'), 'another suite');

removeRepo(repo);
a.equal(existsSync(repo), false, 'the repo is removed');
a.equal(existsSync(stateDir(repo)), false, 'and so is its own AgenticOS folder');
a.ok(existsSync(join(stateDir(sibling), 'agenticos.db')), "a sibling repo's AgenticOS state is untouched");
a.ok(existsSync(join(parent, '.agenticos')), 'the shared .agenticos parent is never deleted');

a.throws(() => removeRepo(null), /never deletes the workspace home/);
a.throws(() => ownStateDir(''), /never deletes the workspace home/);
removeRepo(join(parent, 'never-existed'));   // nothing there: no throw

rmSync(parent, { recursive: true, force: true });
console.log('t-cleanup.js OK — a suite removes its own repo and AgenticOS folder, never a sibling or the shared parent');
