// Wallpapers and music are the first thing the UI lets the sovereign put on
// disk by name, and the name comes from the browser. So the only interesting
// question is whether a hostile name can escape the assets directory — by
// upload, by fetch, or by delete.
//
//   node test/t-assets.js
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, renameSync } from 'node:fs';
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
    const duplicate = await fetch(`${base}/api/assets?name=${encodeURIComponent('wall paper.png')}`, { method: 'POST', body: Buffer.from('replacement') });
    a.equal(duplicate.status, 409, 'a second upload must not overwrite an existing attachment');

    // Two request handlers can observe a missing filename before either write
    // finishes. The filesystem, not a preceding exists check, must pick one.
    const raced = await Promise.all(['one', 'two'].map((body) =>
      fetch(`${base}/api/assets?name=race.png`, { method: 'POST', body })));
    a.deepEqual(raced.map((r) => r.status).sort(), [200, 409],
      'concurrent uploads with one name must leave exactly one winner');

    const listed = await fetch(`${base}/api/assets`).then((x) => x.json());
    a.deepEqual(listed.assets.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'race.png', kind: 'image' },
      { name: 'wall paper.png', kind: 'image' },
    ]);

    // A missing directory is the normal empty state; a non-directory is a real
    // failure and must remain retryable to the browser.
    const backup = `${ASSETS}.bak`;
    renameSync(ASSETS, backup);
    try {
      const missing = await fetch(`${base}/api/assets`);
      a.equal(missing.status, 200, 'a missing assets directory is an empty state');
      a.deepEqual((await missing.json()).assets, []);
      writeFileSync(ASSETS, 'not a directory');
      const failed = await fetch(`${base}/api/assets`);
      a.equal(failed.status, 500, 'a real assets listing failure must be reported');
      a.equal((await failed.json()).ok, false, 'a real assets listing failure must not masquerade as success');
    } finally {
      if (existsSync(ASSETS)) rmSync(ASSETS, { force: true });
      renameSync(backup, ASSETS);
    }
    console.log('  upload -> list -> serve round-trips, spaces and all');
  }

  /* ---------- 2. only media and documents ---------- */
  {
    for (const bad of ['payload.js', 'x.exe', 'no-extension', '.env', 'archive.zip']) {
      const r = await put(bad, Buffer.from('x'));
      a.equal(r.ok, false, `${bad} must be refused`);
    }
    a.equal((await put('song.mp3', Buffer.from('x'))).kind, 'audio');
    a.equal((await put('notes.txt', Buffer.from('x'))).kind, 'document',
      'a document upload is how the court gets something to read, not just look at or hear');
    a.equal((await put('report.pdf', Buffer.from('x'))).kind, 'document');
    for (const del of ['notes.txt', 'report.pdf']) {
      await fetch(`${base}/api/assets/delete`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: del }),
      });
    }
    console.log('  non-media, non-document names refused; audio and documents both accepted');
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
      '%ZZ.png',
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

    // .json is a supported document extension now (see DOCUMENT in daemon.js),
    // so this can no longer prove refusal — .ini still isn't in any whitelist.
    a.equal((await del('../../../kingdom.config.ini')).ok, false, 'a non-media, non-document name is refused');
    await del('../../kingdom.db');
    a.ok(existsSync(cfg), 'the config survived');
    a.ok(existsSync(join(kingdomDir(repo), 'kingdom.db')), 'the database survived');

    a.equal((await del('wall paper.png')).ok, true);
    a.equal((await fetch(`${base}/assets/${encodeURIComponent('wall paper.png')}`)).status, 404,
      'a deleted asset stops being served');
    a.equal((await del('wall paper.png')).ok, true, 'deleting a missing asset remains idempotent');

    // Missing files remain idempotent, but a real unlink failure must not be success.
    const blocked = join(ASSETS, 'blocked.png');
    mkdirSync(blocked);
    const failed = await fetch(`${base}/api/assets/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'blocked.png' }),
    });
    a.equal(failed.status, 500, 'a real unlink failure must be reported');
    a.equal((await failed.json()).ok, false, 'a real unlink failure must not masquerade as success');
    rmSync(blocked, { recursive: true, force: true });
    console.log('  delete is confined too; the database and config are untouchable');
  }

  /* ---------- 6. bad delete JSON is a client error, not a daemon failure -- */
  {
    await put('recover.png');
    const bad = await fetch(`${base}/api/assets/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    a.equal(bad.status, 400, 'malformed client JSON must not be reported as a server failure');
    a.deepEqual(await bad.json(), { ok: false, error: 'invalid JSON' });
    const deleted = await fetch(`${base}/api/assets/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'recover.png' }),
    });
    a.deepEqual(await deleted.json(), { ok: true }, 'the next valid delete proves the daemon stayed usable');
    console.log('  malformed delete JSON is 400; the next valid request still works');
  }

  /* ---------- 7. the size cap is real ---------- */
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
