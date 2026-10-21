// The daemon binds 127.0.0.1, but that only keeps the outside world off the
// port — not another tab in the same browser. A POST with content-type:
// text/plain and a JSON string body is a CORS "simple request": no preflight,
// so no header this server could ever send stops it. And the team's own
// agents run unconfined by design (--dangerously-skip-permissions, bypass-
// Permissions, danger-full-access — src/agent.js), so a drive-by POST to
// /api/command from any page the user has open is not a UI bug, it is
// arbitrary code execution on their machine. This pins the two-check gate
// (src/daemon.js's originAllowed() + the content-type requirement) that
// closes it, and that the UI's own same-origin requests still work.
//
//   node test/t-csrf.js
// Never let a daemon this suite spawns touch the real ~/.agenticos/teams.json
// on the machine running the tests — see test/t-registry-isolation.js.
import './isolate-registry.js';
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../src/worktree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const repo = mkdtempSync(join(tmpdir(), 'agenticos-csrf-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const cfg = join(repo, 'agenticos.config.json');
writeFileSync(cfg, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  agents: [],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  summarizer: { enabled: false },
}));

const PORT = 7990 + (process.pid % 30);
const base = `http://127.0.0.1:${PORT}`;
process.env.AGENTICOS_CODEX_BIN = process.execPath;

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
      body: JSON.stringify({ text: 'do something the user never asked for' }),
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

  /* ---------- 6. approve-from-a-phone: refuse to start without a token -- */
  // A daemon told to bind anything but loopback must never fall back to
  // loopback silently, and must never start unauthenticated. Real crypto
  // generation cannot fail in practice, so AGENTICOS_TEST_DISABLE_TOKEN
  // simulates the "no token" case the same way AGENTICOS_CODEX_BIN elsewhere
  // in this suite stubs a real dependency, to prove the refusal path exists.
  {
    const PORT2 = PORT + 1;
    const refusing = spawn(process.execPath,
      [join(HERE, '..', 'src', 'daemon.js'), repo, '--port', String(PORT2), '--config', cfg, '--bind', '0.0.0.0'],
      { stdio: 'ignore', env: { ...process.env, AGENTICOS_TEST_DISABLE_TOKEN: '1' } });
    const exited = await new Promise((res) => {
      refusing.on('exit', (code, signal) => res({ code, signal }));
      setTimeout(() => res(null), 5000);
    });
    a.ok(exited, 'a non-loopback bind with no token must exit, not hang or silently fall back to loopback');
    a.notEqual(exited?.code, 0, 'refusing to start must be a non-zero exit, not a quiet success');
    let cameUp = false;
    try { cameUp = (await fetch(`http://127.0.0.1:${PORT2}/api/ping`)).ok; } catch {}
    a.equal(cameUp, false, 'it must never serve a single request while unauthenticated on a non-loopback bind');
    console.log('  --bind 0.0.0.0 with no token generated: refused to start, never served a request');
  }

  /* ---------- 7. approve-from-a-phone: token auth on a non-loopback bind - */
  // A separate repo/daemon so this doesn't share a SQLite handle with the
  // daemon already running above. AGENTICOS_TEST_FORCE_REMOTE makes every
  // connection classify as non-loopback (deterministically, regardless of
  // what address it actually arrives from), the same way this suite's other
  // AGENTICOS_* vars stub a real condition rather than depend on real network
  // topology or OS-specific loopback-range routing.
  {
    const repo2 = mkdtempSync(join(tmpdir(), 'agenticos-csrf-remote-'));
    const git2 = (...x) => execFileSync('git', x, { cwd: repo2, stdio: 'pipe' });
    git2('init', '-q');
    git2('config', 'user.email', 'k@agenticos');
    git2('config', 'user.name', 'agenticos');
    writeFileSync(join(repo2, 'README.md'), '# t\n');
    git2('add', '-A');
    git2('commit', '-qm', 'init');
    const cfg2 = join(repo2, 'agenticos.config.json');
    writeFileSync(cfg2, JSON.stringify({
      orchestrator: { name: 'orchestrator', cli: 'codex' },
      briefer: { name: 'briefer', cli: 'codex' },
      agents: [],
      rolesSeeded: true,
      advisor: { promptEngineer: false, autoModel: false },
      summarizer: { enabled: false },
    }));

    const PORT3 = PORT + 2;
    const base3 = `http://127.0.0.1:${PORT3}`;
    const remoteDaemon = spawn(process.execPath,
      [join(HERE, '..', 'src', 'daemon.js'), repo2, '--port', String(PORT3), '--config', cfg2, '--bind', '0.0.0.0'],
      { stdio: 'ignore', env: { ...process.env, AGENTICOS_TEST_FORCE_REMOTE: '1' } });

    try {
      // Written before the daemon even calls .listen(), so it settles well
      // before any HTTP request could succeed anyway.
      const tokenFile = join(stateDir(repo2), 'phone-token.txt');
      let token = '';
      for (let i = 0; i < 60 && !token; i++) {
        try { token = readFileSync(tokenFile, 'utf8').trim(); } catch {}
        if (!token) await wait(250);
      }
      a.ok(token.length > 0, 'the token must be retrievable from its own untracked file — it is never printed');

      const up3 = async () => {
        for (let i = 0; i < 60; i++) {
          try {
            if ((await fetch(`${base3}/api/ping`, { headers: { authorization: `Bearer ${token}` } })).ok) return true;
          } catch {}
          await wait(250);
        }
        return false;
      };
      a.ok(await up3(), 'a non-loopback bind WITH a token must come up and serve an authenticated request');

      {
        const r = await fetch(`${base3}/api/approvals`);
        a.equal(r.status, 401, 'an unauthenticated request over a non-loopback connection must be refused');
      }
      {
        const r = await fetch(`${base3}/api/approvals`, { headers: { authorization: 'Bearer not-the-token' } });
        a.equal(r.status, 401, 'the wrong bearer token must be refused');
      }
      {
        const r = await fetch(`${base3}/api/approvals`, { headers: { authorization: `Bearer ${token}` } });
        a.equal(r.status, 200, 'the correct token must be accepted for a read in the phone subset');
        a.equal((await r.json()).ok, true);
      }
      {
        const r = await fetch(`${base3}/api/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: 999999 }),
        });
        a.notEqual(r.status, 401, 'approve must be reachable with a valid token, with no Origin header at all');
        a.notEqual(r.status, 403, 'approve is inside the remote write subset');
      }
      {
        const r = await fetch(`${base3}/api/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ text: 'do something the phone flow was never meant to reach' }),
        });
        a.equal(r.status, 403, 'the full action surface (e.g. command) must stay unreachable even with a valid token');
      }
      {
        const r = await fetch(`${base3}/api/tasks`, { headers: { authorization: `Bearer ${token}` } });
        a.equal(r.status, 403, 'a read outside the approve subset (e.g. tasks) must stay unreachable');
      }
      {
        const r = await fetch(`${base3}/`, { headers: { authorization: `Bearer ${token}` } });
        a.equal(r.status, 403, 'the UI itself must stay unreachable from a remote, token-authenticated request');
      }
      console.log('  non-loopback bind: token retrieved from its untracked file, gates every route to reads + approve/reject/answerQuestion');
    } finally {
      remoteDaemon.kill();
      await wait(300);
      for (const d of [repo2, stateDir(repo2)]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
      }
    }
  }

  console.log('t-csrf.js OK — cross-origin and no-preflight POSTs are refused, same-origin and non-browser callers are not');
} finally {
  daemon.kill();
  await wait(300);
  for (const d of [repo, stateDir(repo)]) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
