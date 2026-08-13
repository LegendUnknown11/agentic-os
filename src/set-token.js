#!/usr/bin/env node
// Store a claude token once; every launch of the kingdom uses it after that.
//
//   npm run token -- --global <token> [<token2> ...]   every repo (usual case)
//   npm run token -- <repo>   <token> [<token2> ...]   this repo only
//   npm run token -- --global --clear
//
// Tokens are written to <repoParent>/.kingdom/<repoName>/tokens.json, which
// lives outside the repo and so can never be committed. Each court member is
// assigned one token, stably, so several tokens spread the rate limit.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { kingdomDir, globalTokenStore } from './worktree.js';

const [repoArg, ...rest] = process.argv.slice(2);
if (!repoArg || (!rest.length && repoArg !== '--global')) {
  console.error('usage: npm run token -- --global <token> [<token2> ...]   (every repo)');
  console.error('       npm run token -- <repo>   <token> [<token2> ...]   (one repo)');
  console.error('       npm run token -- --global --clear');
  process.exit(2);
}

const isGlobal = repoArg === '--global';
const store = isGlobal ? globalTokenStore() : join(kingdomDir(resolve(repoArg)), 'tokens.json');
mkdirSync(dirname(store), { recursive: true });

let current = [];
try {
  current = JSON.parse(readFileSync(store, 'utf8')).claude ?? [];
} catch {}

const clearing = rest.includes('--clear');
const incoming = rest.filter((t) => !t.startsWith('--'));

for (const t of incoming) {
  if (!/^sk-ant-/.test(t)) {
    console.error(`refusing "${t.slice(0, 12)}…" — that is not an sk-ant- token.`);
    process.exit(1);
  }
}

const next = clearing ? [] : [...new Set([...current, ...incoming])];
writeFileSync(store, JSON.stringify({ claude: next }, null, 2));
try {
  chmodSync(store, 0o600); // no-op on most Windows setups, correct on POSIX
} catch {}

// Never echo the values back.
console.log(`${store}\n${next.length} token(s) stored.`);
if (next.length) {
  console.log('The kingdom will use these automatically — no env var needed.');
  console.log('Rotate with: claude auth logout && claude setup-token');
}
