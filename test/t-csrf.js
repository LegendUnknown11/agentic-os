// The daemon binds 127.0.0.1, but that only keeps the outside world off the
// port — not another tab in the same browser. A POST with content-type:
// text/plain and a JSON string body is a CORS "simple request": no preflight,
// so no header this server could ever send stops it. And the court's own
// agents run unconfined by design (--dangerously-skip-permissions, bypass-
// Permissions, danger-full-access — src/agent.js), so a drive-by POST to
// /api/command from any page the user has open is not a UI bug, it is
// arbitrary code execution on their machine. This pins the two-check gate
// (src/daemon.js's originAllowed() + the content-type requirement) that
// closes it, and that the UI's own same-origin requests still work.
//
//   node test/t-csrf.js
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kingdomDir } from '../src/worktree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const repo = mkdtempSync(join(tmpdir(), 'kingdom-csrf-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const cfg = join(repo, 'kingdom.config.json');
writeFileSync(cfg, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  summarizer: { enabled: false },
}));

const PORT = 7990 + (process.pid % 30);
const base = `http://127.0.0.1:${PORT}`;
process.env.KINGDOM_CODEX_BIN = process.execPath;

const daemon = spawn(process.execPath,
  [join(HERE, '..', 'src', 'daemon.js'), repo, '--port', String(PORT), '--config', cfg],
  { stdio: 'ignore', env: process.env });

const up = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) return true; } catch {}
    await wait(250);
  }
  return false;
};
a.ok(await up(), 'the daemon must come up');

try {
  /* ---------- 1. a same-origin JSON POST, exactly what the UI sends ------ */
  {
    const r = await fetch(`${base}/api/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ text: 'ship it' }),
    });
    a.equal(r.status, 200, 'the UI\'s own same-origin requests must keep working');
    a.equal((await r.json()).ok, true);
    console.log('  same-origin JSON POST: unaffected');
  }

  /* ---------- 2. no Origin header at all (curl, the test suite, tools) --- */
  {
    const r = await fetch(`${base}/api/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'still shipping' }),
    });
    a.equal(r.status, 200, 'a non-browser caller sends no Origin and must not be blocked');
    console.log('  no Origin header (non-browser caller): unaffected');
  }

  /* ---------- 3. a foreign Origin is rejected outright ------------------- */
  {
    const r = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ text: 'do something the sovereign never asked for' }),
    });
    a.equal(r.status, 403, 'a cross-origin POST must be refused, not routed');
    a.equal((await r.json()).ok, false);
    console.log('  cross-origin POST (Origin: evil.example): rejected with 403');
  }

  /* ---------- 4. the no-preflight vector: JSON body, non-JSON content-type */
  {
    // This is the actual attack: a fetch with content-type: text/plain (or
    // any of the CORS-safelisted values) sends no preflight at all, so the
    // browser lets it through before this server ever gets a say — UNLESS
    // the server itself refuses anything that isn't declared application/json.
    const r = await fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({}),
    });
    a.equal(r.status, 415, 'a JSON action posted as text/plain (the no-preflight vector) must be refused');
    console.log('  JSON body sent as text/plain (no-preflight vector): rejected with 415');
  }

  /* ---------- 5. asset upload and transcribe keep their raw content-types  */
  {
    const r = await fetch(`${base}/api/assets?name=test.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: base },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    a.equal(r.status, 200, 'the raw-body upload route must not be caught by the JSON content-type gate');
    const j = await r.json();
    a.equal(j.ok, true);
    await fetch(`${base}/api/assets/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name: 'test.png' }),
    });
    console.log('  raw-body routes (asset upload) keep their own content-type, unaffected by the JSON gate');
  }

  console.log('t-csrf.js OK — cross-origin and no-preflight POSTs are refused, same-origin and non-browser callers are not');
} finally {
  daemon.kill();
  await wait(300);
  for (const d of [repo, kingdomDir(repo)]) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
