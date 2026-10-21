#!/usr/bin/env node
// rename-keep (this file names the old words in its help text)
//
// The Kingdom-era -> plain-word codemod. The map is scripts/rename/map.mjs;
// docs/RENAME.md is the contract it implements.
//
//   node scripts/rename/rename.mjs [--dry] [--mv] [--report] [path-prefix ...]
//
//   --dry     count what would change, write nothing
//   --mv      also apply FILE_RENAMES with `git mv` (after the text pass)
//   --report  list every changed line (old -> new) on stdout
//   --paths-only  apply only PATH_RULES (references to renamed files)
//   prefixes  limit the pass to tracked files under these paths (default: all)
//
// Re-runnable: every rule maps an old word to a new one that no rule matches,
// so a second run changes nothing. Phase 0 (Agent -> AgentProcess) runs only
// while src/agent.js still declares `class Agent`, because afterwards the
// word "Agent" is the role and must not be rewritten again.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './map.mjs';
import { transformLine, excluded } from './transform.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const MV = argv.includes('--mv');
const REPORT = argv.includes('--report');
const PATHS_ONLY = argv.includes('--paths-only');
const prefixes = argv.filter((a) => !a.startsWith('--'));

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

function phase0Applies() {
  const { file, has } = M.PHASE0_GUARD;
  const p = resolve(ROOT, file);
  return existsSync(p) && has.test(readFileSync(p, 'utf8'));
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

const files = git('ls-files', '-z').split('\0').filter(Boolean)
  .filter((f) => !prefixes.length || prefixes.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`)));

const phase0 = !PATHS_ONLY && phase0Applies();
let changedFiles = 0;
let changedLines = 0;
for (const f of files) {
  const abs = resolve(ROOT, f);
  if (!existsSync(abs)) continue;
  if (f === M.LOCKFILE && PATHS_ONLY) continue;
  if (f === M.LOCKFILE) {
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    let n = 0;
    const next = lines.map((l) => {
      let s = l;
      for (const [re, to] of M.LOCKFILE_RULES) s = s.replace(re, to);
      if (s !== l) n++;
      return s;
    });
    if (n) {
      changedFiles++; changedLines += n;
      if (!DRY) writeFileSync(abs, next.join('\n'));
      console.error(`${String(n).padStart(5)}  ${f}`);
    }
    continue;
  }
  if (excluded(f)) continue;
  const buf = readFileSync(abs);
  if (isBinary(buf)) continue;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  let n = 0;
  const next = lines.map((l, i) => {
    const s = transformLine(f, l, { phase0, pathsOnly: PATHS_ONLY });
    if (s !== l) {
      n++;
      if (REPORT) console.log(`${f}:${i + 1}\n  - ${l.trim()}\n  + ${s.trim()}`);
    }
    return s;
  });
  if (!n) continue;
  changedFiles++;
  changedLines += n;
  if (!DRY) writeFileSync(abs, next.join('\n'));
  console.error(`${String(n).padStart(5)}  ${f}`);
}
console.error(`${DRY ? 'would change' : 'changed'} ${changedLines} lines in ${changedFiles} files${phase0 ? ' (phase 0 applied)' : ''}`);

if (MV && !DRY) {
  for (const [from, to] of M.FILE_RENAMES) {
    if (!existsSync(resolve(ROOT, from))) continue;
    git('mv', from, to);
    console.error(`git mv ${from} ${to}`);
  }
}
