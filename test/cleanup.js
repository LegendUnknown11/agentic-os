// Remove a test repo and the team state AgenticOS created for it, and nothing
// else.
//
// An AgenticOS on repo `<tmp>/agenticos-x-abc` keeps its database, worktrees and
// evidence in `<tmp>/.agenticos/agenticos-x-abc` (src/worktree.js stateDir).
// Deleting only the repo left that folder behind, and they piled up in the
// temp dir by the hundred. The opposite mistake was worse: t-electron.js once
// deleted `<tmp>/.agenticos` itself, which every concurrent suite's state (and a
// demo team) lives under. So this deletes exactly one repo's own folder and
// refuses anything that is not one.
import { rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { stateDir } from '../src/worktree.js';

/** The one folder removeRepo may delete for `repo`, or a thrown refusal. */
export function ownStateDir(repo) {
  // stateDir(null) is the workspace home under the user's real homedir.
  // A test that wants it gone sandboxes HOME and deletes that sandbox instead.
  if (!repo) throw new Error('removeRepo needs a repo path; it never deletes the workspace home.');
  const own = stateDir(repo);
  if (basename(dirname(own)) !== '.agenticos' || basename(own) !== basename(resolve(repo))) {
    throw new Error(`refusing to delete ${own}: it is not ${repo}'s own AgenticOS folder`);
  }
  return own;
}

/** Best effort: a cleanup failure must never turn a passing suite red. */
export function removeRepo(...repos) {
  for (const repo of repos) {
    const own = ownStateDir(repo);
    for (const d of [repo, own]) {
      try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch { /* best effort */ }
    }
  }
}
