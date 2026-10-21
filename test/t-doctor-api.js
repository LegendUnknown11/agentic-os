// src/doctor.js used to be a script: every probe ran at import time and ended
// in process.exit(). runDoctor() is the same probes with the process-level
// side effects pulled out, so src/daemon.js can expose them at GET
// /api/doctor — the first screen a freshly installed app shows, since there
// is no terminal it can assume the user opens. This pins two things: the
// exported function's shape survives the refactor unchanged, and the daemon
// route actually serves it.
//
//   node test/t-doctor-api.js
// Never let a daemon this suite spawns touch the real ~/.kingdom/courts.json
// on the machine running the tests — see test/t-registry-isolation.js.
import './isolate-registry.js';
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kingdomDir } from '../src/worktree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'kingdom-doctor-'));

// One stub answers for both claude and codex: branch on which status
// subcommand each CLI's doctor probe actually sends.
const STUB = join(dir, 'cli-stub.js');
writeFileSync(STUB, `
const argv = process.argv.slice(2);
if (argv.includes('auth') && argv.includes('status')) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'stub' }));
} else if (argv.includes('login') && argv.includes('status')) {
  process.stdout.write('Logged in using Stub Account');
} else {
  process.stdout.write('OK');
}
`);
process.env.KINGDOM_CLAUDE_BIN = STUB;
process.env.KINGDOM_CODEX_BIN = STUB;
for (const cli of ['AGY', 'OPENCODE', 'CURSOR']) process.env[`KINGDOM_${cli}_BIN`] = STUB;
for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[key];

/* ---------- 1. runDoctor() returns a structured report, not printed lines */
{
  const { runDoctor } = await import('../src/doctor.js');
  const report = await runDoctor({});
  a.ok(Array.isArray(report.checks), 'checks must be an array of {level, message}');
  a.ok(report.checks.length > 0, 'a real machine always produces at least the node/git checks');
  for (const c of report.checks) {
    a.ok(['ok', 'warn', 'fail'].includes(c.level), `unexpected level: ${c.level}`);
    a.equal(typeof c.message, 'string');
    a.doesNotMatch(c.message, /\x1b\[/, 'messages must be plain text — colour is the CLI printer\'s job, not the data');
  }
  a.equal(report.failures, report.checks.filter((c) => c.level === 'fail').length);
  a.equal(report.ready, report.failures === 0, 'ready is exactly "no blocking failures"');
  a.ok(report.checks.some((c) => /claude: authentication status confirmed/.test(c.message)),
    'the stubbed claude CLI must be reported as logged in');
  a.ok(report.checks.some((c) => /codex: authentication status confirmed/.test(c.message)),
    'the stubbed codex CLI must be reported as logged in');
  console.log('  runDoctor(): structured checks, no ANSI, ready matches failure count');
}

/* ---------- 2. GET /api/doctor serves the same report over the daemon --- */
{
  const repo = mkdtempSync(join(tmpdir(), 'kingdom-doctor-repo-'));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const cfg = join(repo, 'agenticos.config.json');
  writeFileSync(cfg, JSON.stringify({
    orchestrator: { name: 'orchestrator', cli: 'claude' },
    briefer: { name: 'briefer', cli: 'claude' },
    peasants: [],
    rolesSeeded: true,
    advisor: { promptEngineer: false, autoModel: false },
    summarizer: { enabled: false },
  }));

  const PORT = 8020 + (process.pid % 30);
  const base = `http://127.0.0.1:${PORT}`;
  const daemon = spawn(process.execPath,
    [join(HERE, '..', 'src', 'daemon.js'), repo, '--port', String(PORT), '--config', cfg],
    { stdio: 'ignore', env: process.env });

  try {
    const up = async () => {
      for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`${base}/api/ping`)).ok) return true; } catch {}
        await wait(250);
      }
      return false;
    };
    a.ok(await up(), 'the daemon must come up');

    const r = await fetch(`${base}/api/doctor`);
    a.equal(r.status, 200);
    const report = await r.json();
    a.ok(Array.isArray(report.checks));
    a.equal(typeof report.ready, 'boolean');
    a.ok(report.checks.some((c) => /claude: authentication status confirmed/.test(c.message)),
      'the daemon route must run the real probes, not a canned response');
    console.log('  GET /api/doctor: serves the same structured report as a running daemon');
  } finally {
    daemon.kill();
    await wait(300);
    for (const d of [repo, kingdomDir(repo)]) {
      try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
    }
  }
}

rmSync(dir, { recursive: true, force: true });

/* ---------- 3. every probe spawn is hidden on Windows ------------------- */
// Doctor's probes ran right after startup and fired one spawn per installed
// CLI (agy models, then one PROBES entry each) — on Windows, a spawn without
// windowsHide flashes a console window, so a freshly started app looked like
// several terminals popping open unprompted. Source-checked because the
// property lives on the spawn() options object, not on anything the child
// process handle exposes back.
{
  const source = readFileSync(join(HERE, '..', 'src', 'cli-detection.js'), 'utf8');
  a.match(source, /windowsHide:\s*true/);
  a.doesNotMatch(source, /reply with|readFileSync|setup-token/,
    'detection must not call a model or read token files');
  const doctor = readFileSync(join(HERE, '..', 'src', 'doctor.js'), 'utf8');
  a.doesNotMatch(doctor, /reply with the single word|spawn\(/,
    'doctor runs on every app boot; it must never send a model prompt');
  a.doesNotMatch(doctor, /writeFileSync|mkdirSync/, 'a GET must not create files');
  console.log('  every doctor CLI probe spawn sets windowsHide: true; doctor sends no prompt');
}

/* ---------- 4. absent, logged-out and env-token CLIs, via injected detection */
{
  const { runDoctor } = await import('../src/doctor.js');
  const fake = (table) => async (cli) => table[cli] ?? { installed: false, available: false, authenticated: null, reason: 'not installed' };
  const resolved = { command: '/fake/bin', prefixArgs: [] };
  // Only claude + codex configured (template fallback). Optional CLIs absent.
  let report = await runDoctor({ detect: fake({
    claude: { installed: true, available: true, authenticated: true, reason: 'authentication status confirmed (quota unverified)', resolved },
    codex: { installed: true, available: true, authenticated: true, reason: 'authentication status confirmed (quota unverified)', resolved },
  }) });
  for (const cli of ['agy', 'opencode', 'cursor']) {
    a.ok(!report.checks.some((c) => c.message.startsWith(`${cli}:`)),
      `an absent, unconfigured ${cli} is not a finding`);
  }
  a.ok(!report.checks.some((c) => /freebuff/i.test(c.message)), 'freebuff was dropped');

  // A configured CLI that is missing or logged out blocks readiness.
  report = await runDoctor({ detect: fake({
    claude: { installed: true, available: true, authenticated: false, reason: 'not authenticated', resolved },
  }) });
  const claudeFail = report.checks.find((c) => c.message.startsWith('claude:'));
  a.equal(claudeFail.level, 'fail');
  a.match(claudeFail.message, /desktop app does NOT log in the CLI/, 'logged-out claude keeps its fix-it guidance');
  const codexFail = report.checks.find((c) => c.message.startsWith('codex:'));
  a.equal(codexFail.level, 'fail', 'a configured but missing CLI fails');
  a.equal(report.ready, false);
  a.ok(report.failures >= 2);

  // Installed optional CLI with unknown status is a warning, never a failure.
  report = await runDoctor({ detect: fake({
    claude: { installed: true, available: true, authenticated: null, reason: 'auth supplied via CLAUDE_CODE_OAUTH_TOKEN (value not shown; validity unverified)', resolved },
    codex: { installed: true, available: true, authenticated: true, reason: 'authentication status confirmed (quota unverified)', resolved },
    opencode: { installed: true, available: true, authenticated: null, reason: 'authentication status unavailable', resolved },
  }) });
  a.equal(report.checks.find((c) => c.message.startsWith('claude:')).level, 'warn',
    'an env token is reported as supplied, not proven');
  const oc = report.checks.find((c) => c.message.startsWith('opencode:'));
  a.equal(oc.level, 'warn');
  a.match(oc.message, /optional, not configured/);
  // Not report.ready: the node and toolchain checks depend on the host machine.
  a.ok(!report.checks.some((c) => c.level === 'fail' && /^(claude|codex|opencode):/.test(c.message)),
    'unverified status does not block readiness');
  console.log('  absent optional CLIs are silent; configured missing/logged-out CLIs fail; unknown status warns');
}

console.log('t-doctor-api.js OK — runDoctor() is a pure structured probe, and the daemon serves it live');
