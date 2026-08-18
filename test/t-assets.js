// Wallpapers and music are the first thing the UI lets the sovereign put on
// disk by name, and the name comes from the browser. So the only interesting
// question is whether a hostile name can escape the assets directory — by
// upload, by fetch, or by delete.
//
//   node test/t-assets.js
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kingdomDir } from '../src/worktree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const repo = mkdtempSync(join(tmpdir(), 'kingdom-assets-'));
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
}));

const PORT = 7911 + (process.pid % 40);
const base = `http://127.0.0.1:${PORT}`;
process.env.KINGDOM_CODEX_BIN = process.execPath;   // stub: never calls an API

const daemon = spawn(process.execPath, [join(HERE, '..', 'src', 'daemon.js'), repo, '--port', String(PORT), '--config', cfg],
  { stdio: 'ignore', env: process.env });

const up = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) return true; } catch {}
    await wait(250);
  }
  return false;
};
a.ok(await up(), 'the daemon must come up');

const ASSETS = join(kingdomDir(repo), 'assets');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const put = (name, body = PNG) =>
  fetch(`${base}/api/assets?name=${encodeURIComponent(name)}`, { method: 'POST', body })
    .then((r) => r.json());

try {
  /* ---------- 1. the ordinary case ---------- */
  {
    const r = await put('wall paper.png');
    a.deepEqual(r, { ok: true, name: 'wall paper.png', kind: 'image' });
    const got = await fetch(`${base}/assets/${encodeURIComponent('wall paper.png')}`);
    a.equal(got.status, 200);
    a.equal(got.headers.get('content-type'), 'image/png');
    a.equal(Buffer.from(await got.arrayBuffer()).length, PNG.length, 'served bytes must match');

    const listed = await fetch(`${base}/api/assets`).then((x) => x.json());
    a.deepEqual(listed.assets, [{ name: 'wall paper.png', kind: 'image' }]);
    console.log('  upload -> list -> serve round-trips, spaces and all');
  }

  /* ---------- 2. only media ---------- */
  {
    for (const bad of ['payload.js', 'notes.txt', 'x.exe', 'no-extension', '.env']) {
      const r = await put(bad, Buffer.from('x'));
      a.equal(r.ok, false, `${bad} must be refused`);
    }
    a.equal((await put('song.mp3', Buffer.from('x'))).kind, 'audio');
    console.log('  non-media names refused; audio accepted');
  }

  /* ---------- 3. a hostile name cannot escape the assets directory ------- */
  {
    const escapes = [
      '../../../../evil.png',
      '..\\..\\evil.png',
      'sub/dir/evil.png',
      'C:\\Windows\\evil.png',
      '....//....//evil.png',
    ];
    for (const name of escapes) {
      const r = await put(name);
      // It may be accepted, but only ever as a flat name INSIDE assets.
      if (r.ok) a.ok(!r.name.includes('/') && !r.name.includes('\\') && !r.name.includes('..'),
        `${name} was stored as ${r.name}`);
    }
    // Nothing may exist outside the assets dir, and nothing inside may nest.
    a.ok(!existsSync(join(kingdomDir(repo), 'evil.png')), 'nothing written beside the database');
    a.ok(!existsSync(join(repo, 'evil.png')), 'nothing written into the repo');
    for (const f of readdirSync(ASSETS, { withFileTypes: true })) {
      a.ok(f.isFile(), `assets must stay flat, found a directory: ${f.name}`);
    }
    console.log(`  ${escapes.length} traversal attempts all landed flat inside assets/`);
  }

  /* ---------- 4. and cannot be READ back out ---------- */
  {
    for (const p of [
      '../../../../Windows/win.ini',
      '..%2f..%2fkingdom.config.json',
      '....//kingdom.db',
      '%2e%2e%5ckingdom.db',
      '../kingdom.db',
    ]) {
      const r = await fetch(`${base}/assets/${p}`);
      a.equal(r.status, 404, `${p} must not be served`);
    }
    console.log('  traversal reads all 404');
  }

  /* ---------- 5. nor deleted ---------- */
  {
    const del = (name) => fetch(`${base}/api/assets/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.json());

    a.equal((await del('../../../kingdom.config.json')).ok, false, 'a non-media name is refused');
    await del('../../kingdom.db');
    a.ok(existsSync(cfg), 'the config survived');
    a.ok(existsSync(join(kingdomDir(repo), 'kingdom.db')), 'the database survived');

    a.equal((await del('wall paper.png')).ok, true);
    a.equal((await fetch(`${base}/assets/${encodeURIComponent('wall paper.png')}`)).status, 404,
      'a deleted asset stops being served');
    console.log('  delete is confined too; the database and config are untouchable');
  }

  /* ---------- 6. the size cap is real ---------- */
  {
    const r = await put('huge.png', Buffer.alloc(81 * 1024 * 1024)).catch(() => ({ ok: false }));
    a.equal(r.ok, false, 'over the cap must be refused rather than filling the disk');
    console.log('  81MB refused at the 80MB cap');
  }

  console.log('t-assets.js OK — uploads stay inside the assets directory, by every route');
} finally {
  daemon.kill();
  await wait(300);
  try { rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  try { rmSync(kingdomDir(repo), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
}
