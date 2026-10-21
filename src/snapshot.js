// A target-repository snapshot: the working-tree backup a run needs before it
// touches someone else's checkout (the Habitable pilot's step one — see
// HANDOFF.md). Captures tracked dirty work (git status territory) and
// untracked SOURCE files, skips credentials/build output/caches/identity, and
// never mutates the checkout it reads from — snapshotRepo issues no git
// command that writes anything. restoreSnapshot reverses it exactly,
// including a tracked file the snapshot found already deleted.
import {
  mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { assertRepo, revisionOf, git } from './worktree.js';


/*
 * What never enters a snapshot, regardless of the target repo's own
 * .gitignore: credentials, build output, caches, per-machine identity. `git
 * status` already hides anything THAT repo ignores, so this is the
 * belt-and-braces layer for a secret or a build directory that exists but was
 * never added to that .gitignore — the exact case the acceptance suite
 * drives. Only applied to untracked paths: a tracked file is one the repo's
 * own history already chose to keep, and that choice is not this module's to
 * second-guess.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', 'target', '__pycache__', '.venv', 'venv',
  '.dart_tool', '.gradle',
]);
const EXCLUDED_FILE = /^(\.env(\..+)?|.*\.credentials\.json|tokens?\.json|.*secrets?\.json|.*\.(pem|key|p12|keystore)|id_rsa.*|google-services\.json|local\.properties)$/i;

function isExcluded(relPath) {
  const parts = relPath.split('/');
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return true;
  return EXCLUDED_FILE.test(parts[parts.length - 1]);
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all` as {code, path} pairs.
 * -z null-terminates instead of newline-escaping, so a filename with a space
 * or a quote parses the same as any other. --untracked-files=all lists every
 * individual untracked file rather than collapsing a whole new directory into
 * one line — without it an untracked `src/` shows up as one entry, "src/",
 * and this module never sees the files inside it to decide about.
 */
function parseStatus(raw) {
  const tokens = raw.split('\0').filter((t) => t.length);
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const code = tok.slice(0, 2);
    const path = tok.slice(3);
    // A rename/copy carries the old path as a second NUL-terminated token
    // right after the new one; skip it — snapshotting cares what the file at
    // the new path holds now, not where it used to live.
    if (code[0] === 'R' || code[0] === 'C') i++;
    entries.push({ code, path });
  }
  return entries;
}

/** Sort porcelain entries into what the snapshot keeps and what it skips. */
function classify(entries) {
  const files = new Map(); // relPath -> 'tracked' | 'untracked' | 'tracked-deleted'
  const excluded = [];
  for (const { code, path } of entries) {
    if (code === '??') {
      if (isExcluded(path)) excluded.push(path);
      else files.set(path, 'untracked');
    } else if (code[0] === 'D' || code[1] === 'D') {
      files.set(path, 'tracked-deleted');
    } else {
      files.set(path, 'tracked');
    }
  }
  return { files, excluded };
}

/**
 * Copy the repo's current dirty state into destDir. Read-only against repo:
 * `git status` and file reads, nothing that writes to the working tree, the
 * index, or history.
 */
export async function snapshotRepo(repo, destDir) {
  await assertRepo(repo); // same "not a git repository" / "no commit yet" guard every other entry point uses
  const baseRevision = await revisionOf(repo);
  const { stdout } = await git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const { files, excluded } = classify(parseStatus(stdout));

  const filesDir = join(destDir, 'files');
  const manifestFiles = [];
  for (const [rel, kind] of files) {
    if (kind === 'tracked-deleted') { manifestFiles.push({ path: rel, kind }); continue; }
    const dst = join(filesDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(repo, rel), dst); // byte-for-byte; no text/encoding assumption
    manifestFiles.push({ path: rel, kind });
  }

  const manifest = {
    v: 1,
    baseRevision,
    createdTs: Date.now(),
    files: manifestFiles,
    excluded, // record of what was seen and deliberately left out, for audit
  };
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Put a snapshot's files back. Pure filesystem replay against the manifest —
 * no git involved, so it works whether or not the checkout in between still
 * resembles the one that was snapshotted.
 */
export function restoreSnapshot(repo, destDir) {
  const manifest = JSON.parse(readFileSync(join(destDir, 'manifest.json'), 'utf8'));
  const filesDir = join(destDir, 'files');
  let restored = 0;
  let removed = 0;
  for (const { path, kind } of manifest.files) {
    const target = join(repo, path);
    if (kind === 'tracked-deleted') {
      rmSync(target, { force: true }); // the snapshot found it gone; reverse whatever recreated it
      removed++;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(filesDir, path), target);
    restored++;
  }
  return { restored, removed, baseRevision: manifest.baseRevision };
}
