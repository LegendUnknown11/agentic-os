// Guard for the teams-registry test isolation itself (see
// test/isolate-registry.js and test/run-all.js's REGISTRY_SESSION_DIR):
// proves that a real daemon spawned the way this suite harness spawns one
// never touches the REAL ~/.agenticos/teams.json on the machine running the
// tests, and that a suite run standalone (`node test/t-x.js`, no run-all.js
// wrapper) gets an isolated path too, on its own.
//
// This is the one suite in this repository that is ALLOWED to look at the
// real homedir() — every assertion below only ever checks that it is
// UNCHANGED, never writes to it on purpose.
//   node test/t-registry-isolation.js
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, '..', 'src', 'daemon.js');
const REAL_REGISTRY = join(homedir(), '.agenticos', 'teams.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const snapshot = () => (existsSync(REAL_REGISTRY) ? readFileSync(REAL_REGISTRY, 'utf8') : null);
const before = snapshot();

// --- 1. a daemon spawned the way test/run-all.js spawns one (AGENTICOS_
// TEAMS_REGISTRY set in its env, no HOME override at all — the real
// machine home stays the real machine home, which is the whole point: this
// proves the isolation itself, not a HOME override hiding the real path) --
let daemon;
const isolatedDir = mkdtempSync(join(tmpdir(), 'agenticos-isolation-guard-'));
const isolatedRegistry = join(isolatedDir, 'teams.json');
try {
  daemon = spawn(process.execPath, [DAEMON], {
    stdio: 'ignore',
    // Its own port range, clear of the other daemon-spawning suites.
    env: { ...process.env, AGENTICOS_TEAMS_REGISTRY: isolatedRegistry, AGENTICOS_BASE_PORT: '17977' },
  });

  const deadline = Date.now() + 20_000;
  let up = false;
  // No fixed port is passed, so this races real teams already on 7777 on
  // this very machine (including ones this same test run started) — that is
  // fine, the daemon will simply pick the next free one; this suite only
  // cares about WHERE its registry writes land, never which port it gets.
  while (Date.now() < deadline) {
    try {
      if (existsSync(isolatedRegistry)) { up = true; break; }
    } catch { /* not written yet */ }
    await wait(200);
  }
  a.ok(up, 'a daemon given an isolated AGENTICOS_TEAMS_REGISTRY must write its registration there');

  const isolatedRows = JSON.parse(readFileSync(isolatedRegistry, 'utf8')).teams;
  a.ok(isolatedRows.length >= 1, 'the isolated registry must actually contain this daemon\'s row');

  a.equal(snapshot(), before, 'the REAL ~/.agenticos/teams.json must be byte-for-byte unchanged by a daemon given an isolated registry path');
} finally {
  try { daemon?.kill('SIGKILL'); } catch {}
  await wait(300);
  rmSync(isolatedDir, { recursive: true, force: true });
}

a.equal(snapshot(), before, 'the real registry must still be unchanged after the isolated daemon is torn down');

// --- 2. a suite run STANDALONE (no run-all.js wrapper, nothing has set
// AGENTICOS_TEAMS_REGISTRY yet) must isolate itself via test/isolate-registry.js
{
  const probeDir = mkdtempSync(join(tmpdir(), 'agenticos-isolation-probe-'));
  const probeScript = join(probeDir, 'probe.mjs');
  writeFileSync(probeScript,
    `import '${pathToFileURL(join(HERE, 'isolate-registry.js')).href}';\n`
    + `console.log(process.env.AGENTICOS_TEAMS_REGISTRY ?? '');\n`);
  // Explicitly strip AGENTICOS_TEAMS_REGISTRY from this probe's own env, so it
  // sees exactly what a fresh `node test/t-x.js` invocation would.
  const strippedEnv = { ...process.env };
  delete strippedEnv.AGENTICOS_TEAMS_REGISTRY;
  const out = execFileSync(process.execPath, [probeScript], { env: strippedEnv }).toString().trim();
  a.ok(out.length > 0, 'a standalone run must end up with SOME AGENTICOS_TEAMS_REGISTRY set');
  a.ok(!out.includes(join(homedir(), '.agenticos')), 'the standalone fallback must never point at the real ~/.agenticos directory');
  a.ok(out.startsWith(tmpdir()) || out.includes(tmpdir()), 'the standalone fallback must isolate into a temp directory');
  rmSync(probeDir, { recursive: true, force: true });
}

// --- 3. the standalone helper must be a no-op when something upstream
// (test/run-all.js) already set the variable — it must never override it --
{
  const probeDir = mkdtempSync(join(tmpdir(), 'agenticos-isolation-probe2-'));
  const probeScript = join(probeDir, 'probe.mjs');
  writeFileSync(probeScript,
    `import '${pathToFileURL(join(HERE, 'isolate-registry.js')).href}';\n`
    + `console.log(process.env.AGENTICOS_TEAMS_REGISTRY ?? '');\n`);
  const presetPath = join(probeDir, 'preset-teams.json');
  const out = execFileSync(process.execPath, [probeScript], {
    env: { ...process.env, AGENTICOS_TEAMS_REGISTRY: presetPath },
  }).toString().trim();
  a.equal(out, presetPath, 'the standalone fallback must never override a value already set by the caller (test/run-all.js\'s own injection)');
  rmSync(probeDir, { recursive: true, force: true });
}

console.log('t-registry-isolation.js OK — a daemon under test never touches the real ~/.agenticos/teams.json, whether run through run-all.js or standalone');
