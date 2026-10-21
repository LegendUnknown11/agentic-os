// Remote control (src/remote.js): steer a run from a phone over Tailscale.
//
// Turning the switch on starts a SECOND listener; every request on it is
// remote by construction and must present the token minted by that "on".
// This pins the whole contract against a real daemon:
//   - the switch is loopback-only, and its status never carries the token
//   - the phone page loads without a token, every API route needs one
//   - a valid token reaches the Steer surface and nothing else
//   - re-minting kills the old token, and "off" closes the listener
//   - /api/remote/state carries the user<->orchestrator thread only
//
// The listener binds 127.0.0.1 here: it is an address of this machine, and
// the classification is by listener, not by source IP, so it exercises the
// same gate a Tailscale bind does. No test seam is needed for it.
//
//   node test/t-remote.js
import './isolate-registry.js';
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../src/worktree.js';
import { isTailscale, interfaces, tailscaleAddress, steerGate } from '../src/remote.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- pure parts: address detection and the gate ----------------- */
a.equal(isTailscale('100.64.0.1'), true);
a.equal(isTailscale('100.127.255.254'), true);
a.equal(isTailscale('100.63.0.1'), false, 'below the CGNAT block');
a.equal(isTailscale('100.128.0.1'), false, 'above the CGNAT block');
a.equal(isTailscale('192.168.1.5'), false);
const fakeIfaces = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  eth0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
  tailscale0: [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
};
a.equal(tailscaleAddress(fakeIfaces), '100.101.102.103');
a.equal(interfaces(fakeIfaces)[0].address, '100.101.102.103', 'Tailscale is listed first');
a.equal(interfaces(fakeIfaces).length, 3, 'IPv6 is not offered');
a.equal(tailscaleAddress({ lo: fakeIfaces.lo }), null);
a.equal(steerGate('GET', '/remote', false), 'page');
a.equal(steerGate('GET', '/fonts/Inter.woff2', false), 'page');
a.equal(steerGate('GET', '/fonts/../daemon.js', false).status, 401, 'no path escapes the page allowlist');
a.equal(steerGate('GET', '/fonts/..', false).status, 401, 'a dot-name is not a font');
a.equal(steerGate('GET', '/api/remote/state', false).status, 401);
a.equal(steerGate('GET', '/api/remote/state', true), 'authorized');
a.equal(steerGate('POST', '/api/runPause', true), 'authorized');
a.equal(steerGate('POST', '/api/command', true).status, 403);
a.equal(steerGate('GET', '/api/remote', true).status, 403);
console.log('  address detection and the Steer gate: pure checks pass');

/* ---------- the vendored QR encoder (ui/qr.js) ------------------------- */
// Golden matrices. These two were decoded back to their exact text by an
// independent decoder (jsQR 1.4.0) on 2026-10-21, along with 34 more samples
// spanning versions 1-10; the repo carries no decoder, so the hashes pin that
// verified output against any later edit to the encoder.
{
  const { qrMatrix } = await import('../ui/qr.js');
  const { createHash } = await import('node:crypto');
  const digest = (m) => createHash('sha256').update(m.map((r) => r.map(Number).join('')).join('\n')).digest('hex');
  const link = qrMatrix(`http://100.101.102.103:54321/remote#t=${'a1'.repeat(32)}`);
  a.equal(link.length, 41, 'a Tailscale link with its token fits version 6');
  a.equal(digest(link), '70b48d6557b233d13929d962a729f2cedcb0a7c7dda9b8f0db45b62e0e645a48');
  a.equal(digest(qrMatrix('hi')), '81240590f3a630b03aa70a8aaf521ec30c4911af3307da27eeb2126afcb5b39a');
  a.throws(() => qrMatrix('x'.repeat(300)), /too long/);
  console.log('  QR encoder: golden matrices unchanged');
}

/* ---------- a real daemon ---------------------------------------------- */
const repo = mkdtempSync(join(tmpdir(), 'agenticos-remote-'));
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

const PORT = 8060 + (process.pid % 30);
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

const local = (path, body) => fetch(`${base}${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body),
});
const tokenOf = (url) => new URL(url).hash.replace(/^#t=/, '');
const refused = async (url) => {
  try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return false; } catch { return true; }
};

try {
  /* ---------- 1. off by default; status carries no token --------------- */
  {
    const s = await (await local('/api/remote')).json();
    a.equal(s.on, false, 'remote control must be off until the user turns it on');
    a.equal(s.url, undefined);
    a.ok(Array.isArray(s.interfaces));
    console.log('  off by default; GET /api/remote carries no url or token');
  }

  /* ---------- 2. bad addresses are refused, nothing is opened ---------- */
  {
    const r = await local('/api/remote/switch', { on: true, bind: '203.0.113.7' });
    a.equal(r.status, 400, 'an address that is not this machine\'s must be refused');
    a.equal((await (await local('/api/remote')).json()).on, false);
    const s = await (await local('/api/remote')).json();
    if (!s.tailscale) {
      const r2 = await local('/api/remote/switch', { on: true });
      a.equal(r2.status, 409, 'with no Tailscale and no chosen address, turning on must say why');
      a.equal((await r2.json()).reason, 'no-tailscale');
    }
    console.log('  foreign address: 400; no Tailscale and no address: 409 with a reason');
  }

  /* ---------- 3. on: a url with the token in the fragment -------------- */
  const first = await (await local('/api/remote/switch', { on: true, bind: '127.0.0.1' })).json();
  a.equal(first.ok, true);
  a.equal(first.on, true);
  a.equal(first.bind, '127.0.0.1');
  a.ok(first.port > 0 && first.port !== PORT, 'a second listener, not the loopback one');
  a.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/remote#t=[0-9a-f]{64}$/);
  const r1 = `http://127.0.0.1:${first.port}`;
  const t1 = tokenOf(first.url);
  const auth = (t) => ({ authorization: `Bearer ${t}` });
  const rpost = (path, body, t) => fetch(`${r1}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth(t) }, body: JSON.stringify(body),
  });
  {
    const s = await (await local('/api/remote')).json();
    a.equal(s.on, true);
    a.equal(s.url, undefined, 'the token is handed out on the "on" answer only');
    a.ok(!JSON.stringify(s).includes(t1), 'status must never carry the token');
    console.log('  on: second listener, token only in the url fragment of the "on" answer');
  }

  /* ---------- 4. the phone page loads without a token ------------------ */
  {
    const page = await fetch(`${r1}/remote`);
    a.equal(page.status, 200);
    a.match(await page.text(), /remote\.js/);
    a.equal((await fetch(`${r1}/remote.js`)).status, 200);
    a.equal((await fetch(`${r1}/app.css`)).status, 200);
    console.log('  the phone page and its script/style load with no token');
  }

  /* ---------- 5. every API route needs the token ----------------------- */
  {
    for (const p of ['/api/ping', '/api/approvals', '/api/remote/state']) {
      a.equal((await fetch(`${r1}${p}`)).status, 401, `${p} must need the token`);
      a.equal((await fetch(`${r1}${p}`, { headers: auth('0'.repeat(64)) })).status, 401, `${p} must refuse a wrong token`);
    }
    a.equal((await rpost('/api/remote/message', { text: 'x' }, 'nope')).status, 401);
    console.log('  no token or a wrong token: 401 on every API route');
  }

  /* ---------- 6. the Steer surface is reachable ------------------------ */
  {
    a.equal((await fetch(`${r1}/api/ping`, { headers: auth(t1) })).status, 200);
    a.equal((await fetch(`${r1}/api/approvals`, { headers: auth(t1) })).status, 200);
    const st = await (await fetch(`${r1}/api/remote/state`, { headers: auth(t1) })).json();
    a.equal(st.ok, true);
    for (const k of ['cursor', 'messages', 'approvals', 'run', 'paused', 'spend']) a.ok(k in st, `state carries ${k}`);

    const msg = await rpost('/api/remote/message', { text: 'status from the phone, please' }, t1);
    a.equal(msg.status, 200, 'a message to the orchestrator is part of Steer');
    a.equal((await rpost('/api/remote/message', { text: '   ' }, t1)).status, 400, 'an empty message is refused');
    let seen = null;
    for (let i = 0; i < 20 && !seen; i++) {
      const s = await (await fetch(`${r1}/api/remote/state`, { headers: auth(t1) })).json();
      seen = s.messages.find((m) => m.body === 'status from the phone, please');
      if (!seen) await wait(150);
    }
    a.ok(seen, 'the phone\'s message shows in its own thread');
    a.equal(seen.from, 'user');
    const after = await (await fetch(`${r1}/api/remote/state?since=${seen.id}`, { headers: auth(t1) })).json();
    a.ok(!after.messages.some((m) => m.id <= seen.id), '`since` returns only newer messages');

    for (const p of ['/api/runPause', '/api/run/resume']) {
      const r = await rpost(p, {}, t1);
      a.ok(![401, 403, 404].includes(r.status), `${p} must reach its action (got ${r.status})`);
    }
    console.log('  Steer: ping, approvals, state, message, pause/resume all reachable with the token');
  }

  /* ---------- 7. everything else stays shut, token or not -------------- */
  {
    for (const p of ['/', '/index.html', '/main.js', '/stream', '/api/remote', '/api/log', '/api/tasks', '/api/diff', '/api/metrics', '/assets/x.png']) {
      a.equal((await fetch(`${r1}${p}`, { headers: auth(t1) })).status, 403, `GET ${p} must stay unreachable remotely`);
    }
    for (const p of ['/api/command', '/api/remote/switch', '/api/attachRepo', '/api/shutdown', '/api/mode', '/api/run/apply', '/api/workflows', '/api/speak']) {
      a.equal((await rpost(p, { on: false }, t1)).status, 403, `POST ${p} must stay unreachable remotely`);
    }
    a.equal((await (await local('/api/remote')).json()).on, true, 'a remote request cannot flip the switch');
    console.log('  outside Steer: 403 for the UI, stream, switch, command, repo, shutdown and the rest');
  }

  /* ---------- 8. re-mint: the old token dies --------------------------- */
  const second = await (await local('/api/remote/switch', { on: true, bind: '127.0.0.1', port: first.port })).json();
  {
    const t2 = tokenOf(second.url);
    a.notEqual(t2, t1, 'every "on" mints a new token');
    a.equal(second.port, first.port, 'a chosen port is honoured');
    a.equal((await fetch(`${r1}/api/ping`, { headers: auth(t1) })).status, 401, 'the old token must be refused after a re-mint');
    a.equal((await fetch(`${r1}/api/ping`, { headers: auth(t2) })).status, 200, 'the new token works');
    console.log('  re-mint: old token refused, new token accepted');
  }

  /* ---------- 9. off: the listener is closed --------------------------- */
  {
    const off = await (await local('/api/remote/switch', { on: false })).json();
    a.equal(off.on, false);
    a.equal(off.port, null);
    a.ok(await refused(`${r1}/api/ping`), 'the remote listener must be closed when the switch is off');
    a.equal((await fetch(`${base}/api/ping`)).status, 200, 'the loopback server is untouched');
    console.log('  off: listener closed, loopback server unaffected');
  }

  console.log('t-remote.js OK — remote control gates every route to Steer, re-mints and closes cleanly');
} finally {
  daemon.kill();
  await wait(300);
  for (const d of [repo, stateDir(repo)]) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
