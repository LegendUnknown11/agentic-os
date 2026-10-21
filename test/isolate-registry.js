// Every suite that spawns a real src/daemon.js process must never let it
// touch the REAL ~/.agenticos/teams.json on the machine running the tests —
// see test/t-registry-isolation.js for the guard that proves this. On the
// user's own machine, `npm test` running while the real app is open
// would otherwise mutate their live registry and influence auto-port
// selection next to real teams.
//
// test/run-all.js sets AGENTICOS_TEAMS_REGISTRY in the env it spawns each
// suite with (a fresh, unique path per suite, so concurrent suites never
// share — and never race over — one file). This module covers the OTHER
// way a suite runs: standalone, `node test/t-x.js`, where nothing upstream
// has set it yet. Every suite that spawns a real daemon.js imports this
// FIRST, before any spawn happens.
//
// A no-op when run-all.js (or anything else) already set the variable —
// this only ever fills in a value nobody provided, never overrides one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.AGENTICOS_TEAMS_REGISTRY) {
  const dir = mkdtempSync(join(tmpdir(), 'agenticos-test-registry-'));
  process.env.AGENTICOS_TEAMS_REGISTRY = join(dir, 'teams.json');
}

// Same reason, for the one-time move of pre-rename state (src/legacy.js): a
// spawned daemon must not move the real home-folder state of whoever runs it.
process.env.AGENTICOS_SKIP_LEGACY_MIGRATION ??= '1';
