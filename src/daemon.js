#!/usr/bin/env node
// Runs the kingdom and serves the throne room over HTTP + SSE.
//
//   node src/daemon.js <repo> [--port 7777] [--config path]
//
// Deliberately its own process rather than living inside Electron: the
// orchestrator needs Node 24's node:sqlite, and this way closing the window
// does not kill the court.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kingdom, defaultConfigPath } from './kingdom.js';
import { kingdomDir, worktreePath, diffOf, statOf } from './worktree.js';
import { searchVault, recentNotes, readNote } from './vault.js';
import { Speech } from './stt.js';
import { deltaOf, totalsOf } from './usage.js';
import { readApproval } from './approval.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'ui');

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.indexOf(n) !== -1 ? argv[argv.indexOf(n) + 1] : d);
const repo = resolve(argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--port'
  && argv[argv.indexOf(a) - 1] !== '--config') ?? '.');
const port = Number(flag('--port', 7777));
const configPath = flag('--config', defaultConfigPath(repo));

const kingdom = new Kingdom(repo, configPath);
const speech = new Speech(process.env.KINGDOM_SPEECHBIRD ?? kingdom.config.speechbird);
const clients = new Set();
let ready = false;

function push(type, data) {
  // envelope type last: it must never be clobbered by a field of the same name
  const line = `data: ${JSON.stringify({ ...data, type })}\n\n`;
  for (const res of clients) res.write(line);
}

for (const ev of ['agent', 'event', 'delivered', 'approval', 'verified', 'merged', 'recycled', 'resolved', 'started', 'failure', 'roster', 'failover', 'mergeFailed', 'spend', 'budget', 'limited', 'advising', 'advisor', 'summarizer', 'goal', 'milestone', 'compact', 'argued']) {
  kingdom.on(ev, (d) => push(ev, d ?? {}));
}
kingdom.on('error', (e) => push('error', { message: e.message }));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

// Backgrounds and music the sovereign uploads. Kept beside the database, i.e.
// OUTSIDE the target repo — a wallpaper must never turn up in a diff.
const ASSETS = join(kingdomDir(repo), 'assets');
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const AUDIO = new Set(['.mp3', '.m4a', '.ogg', '.opus', '.wav', '.flac']);
const VIDEO = new Set(['.webm', '.mp4']);

/**
 * Filenames arrive from the browser, so they are untrusted input. Keep the stem
 * and the extension, drop everything else — no separators, no `..`, no leading
 * dot. A name that survives this cannot escape the assets directory.
 */
function safeAsset(name) {
  const ext = extname(String(name ?? '')).toLowerCase();
  if (!IMAGE.has(ext) && !AUDIO.has(ext) && !VIDEO.has(ext)) return null;
  const stem = basename(String(name), ext).replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 80);
  return `${stem || 'upload'}${ext}`;
}

const kindOf = (f) => {
  const e = extname(f).toLowerCase();
  return IMAGE.has(e) ? 'image' : AUDIO.has(e) ? 'audio' : VIDEO.has(e) ? 'video' : null;
};

const ACTIONS = {
  // NOT awaited: with the advisor on, this runs a model call before the message
  // reaches the bus, and holding the POST open for that would look like a hung
  // UI. Progress and failure both arrive on the stream as `advising`.
  command: (b) => { kingdom.command(b.text).catch((e) => push('error', { message: e.message })); },
  speak: (b) => kingdom.speakTo(b.name, b.text),
  advisor: (b) => kingdom.setAdvisor(b),
  summarizer: (b) => kingdom.setSummarizer(b),
  goal: (b) => kingdom.setGoal(b),
  milestone: (b) => kingdom.setMilestone(Number(b.index), Boolean(b.done)),
  wake: (b) => kingdom.wake(b.name),
  sleep: (b) => kingdom.sleep(b.name),
  approve: (b) => kingdom.approve(Number(b.id)),
  reject: (b) => kingdom.reject(Number(b.id), b.why ?? ''),
  merge: (b) => kingdom.merge(b.peasant),
  model: (b) => kingdom.setModel(b.name, {
    cli: b.cli, model: b.model, effort: b.effort, auto: b.auto,
  }),
  domainModel: (b) => kingdom.setDomainModel(b.domain, {
    cli: b.cli, model: b.model, effort: b.effort, auto: b.auto,
  }),
  clearSpend: (b) => kingdom.clearSpend(b.name ?? null),
  // Answer first, then go: the caller must not get a dead socket for a
  // shutdown that actually worked.
  shutdown: () => { setTimeout(() => shutdown(0), 150); },
};

/**
 * What the court has actually cost.
 *
 * The one thing that makes this non-trivial: codex reports `usage` in
 * `turn.completed` CUMULATIVELY PER THREAD, not per turn. It climbs all session
 * and resets when the session restarts. Summing it across turns counts every
 * earlier turn again — measured on a real run, that turned 65M input tokens
 * into an apparent 420M. So take DELTAS, and treat a drop as a new thread.
 */
function metrics() {
  // Filtered in SQL, not after the fact. `events()` JSON.parses every row it
  // returns, so pulling all 20,000 retained events to keep the turn_ends meant
  // parsing the whole log — on every /api/metrics, which the throne room polls
  // every 5s while the cost panel is open (ui/panels.js).
  const rows = kingdom.bus.events({ limit: 100_000, type: 'turn_end' });
  const prev = new Map();
  const by = new Map();

  for (const ev of rows) {
    let p;
    try { p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload; } catch { continue; }
    const u = p?.usage ?? {};
    // Via usage.js, like ctx.js and kingdom.js. This was a THIRD hand-rolled
    // copy of the rule and it had drifted the same way the first one did: it
    // knew codex's and Anthropic's names for the cache read but not agy's, so
    // the throne room's cost panel scored the king — the one member on agy —
    // as having replayed nothing at all.
    // The delta rule now lives in usage.js beside the cache rule, because this
    // was the ONLY copy of it: ctx.js and kingdom.js summed raw and reported a
    // 25% overcount on real data. Same class of drift as the cache-field names.
    const d = deltaOf(prev.get(ev.agent), u);
    prev.set(ev.agent, totalsOf(u));

    const m = by.get(ev.agent) ?? { name: ev.agent, turns: 0, in: 0, out: 0, cached: 0, ctx: 0, first: ev.ts };
    m.turns++;
    m.in += d.in;
    m.out += d.out;
    m.cached += d.cached;
    m.ctx = p?.ctx ?? m.ctx;                     // latest, not a sum
    m.last = ev.ts;
    by.set(ev.agent, m);
  }

  const members = [...by.values()].map((m) => ({
    ...m,
    role: kingdom.roleOf(m.name),
    perTurn: m.turns ? Math.round(m.in / m.turns) : 0,
    spent: Number(kingdom.bus.get(`spent:${m.name}`) ?? 0),
    awake: kingdom.agents.has(m.name),
  })).sort((a, b) => b.in - a.in);

  const total = members.reduce((t, m) => ({
    turns: t.turns + m.turns, in: t.in + m.in, out: t.out + m.out, cached: t.cached + m.cached,
  }), { turns: 0, in: 0, out: 0, cached: 0 });

  return {
    members,
    total,
    spent: Number(kingdom.bus.get('spentUsd') ?? 0),
    cap: kingdom.config.maxKingdomUsd ?? 0,
    perMemberCap: kingdom.config.maxBudgetUsd ?? 0,
    messages: kingdom.bus.countMessages(),   // count(*), not "load every body and take .length"
  };
}

/** Ends the court for real. The window closing no longer does this. */
async function shutdown(code = 0) {
  speech.stop();
  await kingdom.stop();
  process.exit(code);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // How a launching window discovers whether a court is already up, and which
  // repo it is serving — attaching to the wrong repo would be silent and bad.
  if (url.pathname === '/api/ping') {
    return res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: ready, starting: !ready, repo, base: kingdom.base, pid: process.pid }));
  }

  if (url.pathname === '/stream') {
    if (!ready) return res.writeHead(503).end('starting');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    clients.add(res);
    // Snapshot so a late-joining window is not staring at an empty room.
    res.write(`data: ${JSON.stringify({
      type: 'snapshot',
      repo,
      base: kingdom.base,
      roster: JSON.parse(kingdom.bus.get('roster') ?? '[]'),
      models: kingdom.models(),
      efforts: kingdom.efforts(),
      advisor: kingdom.advisor(),
      domains: kingdom.domains(),
      // Names and descriptions only — this is the `/` menu, and the bodies are
      // what the court fetches on demand. Sent in the snapshot rather than as
      // its own endpoint because it is a few hundred bytes the UI needs before
      // the first keystroke.
      skills: kingdom.skills(),
      summarizer: kingdom.summarizer(),
      goal: kingdom.goal(),
      // tail: this is a window repainting itself, so it wants the LAST 400/200,
      // not the first. Without it a reload showed the opening of the session and
      // nothing that had happened since.
      events: kingdom.bus.events({ limit: 400, tail: true }),
      messages: kingdom.bus.history({ limit: 200, tail: true }),
      approvals: [...kingdom.approvals].map(([id, p]) => ({ id, ...p })),
    })}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  // ---- what the sovereign has been asked, and what they answered -------
  // Pending AND decided. Approvals used to exist only while unanswered, so
  // with an empty queue there was no sign the feature existed at all, and no
  // record of what had already been agreed to.
  if (url.pathname === '/api/approvals') {
    // An approval whose body will not parse used to come through as `{}` —
    // an entry with an id, a sender, and no `kind`. The throne room renders
    // one with `TITLES[a.kind] ?? a.kind.toUpperCase()` (`ui/app.js`), so an
    // undefined kind threw, and the throw took the whole approvals pass with
    // it: one unreadable row and the sovereign stopped being shown ANY of
    // them, including the ones still waiting on a decision. Drop what cannot
    // be rendered, and say on stderr that it was dropped — a bad row must
    // cost its own line and nothing else.
    const rows = [];
    for (const m of kingdom.bus.history({ limit: 2000, tail: true })) {
      if (m.kind !== 'approval') continue;
      const p = readApproval(m.body);
      if (!p) {
        process.stderr.write(`daemon: approval #${m.id} from ${m.sender} is unreadable — skipped\n`);
        continue;
      }
      rows.push({
        id: m.id, ts: m.ts, from: m.sender, ...p,
        resolved: kingdom.bus.get(`resolved:${m.id}`) ?? null,
      });
    }
    rows.reverse();
    return res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, approvals: rows, pending: [...kingdom.approvals.keys()] }));
  }

  // ---- the shared task list --------------------------------------------
  // The one question the panels could not answer: what is still outstanding.
  // Approvals show what the sovereign must decide and the chronicle shows what
  // was said, but an assignment nobody acted on appeared in neither.
  if (url.pathname === '/api/tasks') {
    const tasks = kingdom.bus.tasks();
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ok: true,
      tasks,
      open: tasks.filter((t) => t.state !== 'done').length,
      available: kingdom.bus.availableTasks().length,
    }));
  }

  // ---- the chronicle: everything that happened, in order ---------------
  // The bus panel shows messages; a member's panel shows one transcript. There
  // was no view of the court as a whole over time, and no way to find which of
  // sixteen members said a thing. This is both.
  if (url.pathname === '/api/chronicle') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200));
    const kinds = new Set((url.searchParams.get('kinds') ?? 'summary,message,error,done')
      .split(',').filter(Boolean));

    const rows = [];

    // Summaries and errors — one line per turn, which is the readable layer.
    if (kinds.has('summary') || kinds.has('error')) {
      for (const e of kingdom.bus.events({ limit: 20_000, tail: true })) {
        if (e.type !== 'summary' && e.type !== 'error') continue;
        if (!kinds.has(e.type)) continue;
        let p;
        try { p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload; } catch { continue; }
        const text = p?.text ?? p?.message ?? '';
        if (!text) continue;
        rows.push({ id: `e${e.id}`, ts: e.ts, who: e.agent, kind: e.type, text });
      }
    }

    if (kinds.has('message') || kinds.has('done')) {
      for (const m of kingdom.bus.history({ limit: 20_000, tail: true })) {
        const kind = m.kind === 'done' ? 'done' : 'message';
        if (!kinds.has(kind)) continue;
        // Approvals and notices are machinery, not narrative.
        if (m.kind === 'approval' || m.kind === 'notice' || m.kind === 'milestone') continue;
        rows.push({
          id: `m${m.id}`, ts: m.ts, who: m.sender, to: m.recipient ?? null,
          kind, text: m.body,
        });
      }
    }

    // A name matches BOTH directions. Searching "tester" and being shown only
    // what the tester said — not what was said to them — is half an answer,
    // and the half you usually wanted is the conversation.
    const hits = q
      ? rows.filter((r) => r.text.toLowerCase().includes(q)
        || r.who.toLowerCase().includes(q)
        || (r.to ?? '').toLowerCase().includes(q))
      : rows;
    hits.sort((a, b) => b.ts - a.ts);

    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ok: true,
      query: q,
      total: hits.length,
      // Bodies can be enormous; the chronicle is for scanning, and the member's
      // own panel is where you go for the whole thing.
      rows: hits.slice(0, limit).map((r) => ({
        ...r,
        text: r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text,
      })),
    }));
  }

  // ---- what the court cost --------------------------------------------
  // Turn counts, REAL token totals and context per member.
  if (url.pathname === '/api/metrics') {
    return res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, ...metrics() }));
  }

  // ---- a peasant's work, before you merge it ---------------------------
  if (url.pathname === '/api/diff') {
    const peasant = url.searchParams.get('peasant');
    const send = (code, o) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    // roleOf is a CLASSIFIER, not a membership test — it answers "peasant" for
    // any name that is not the king or the jester, including one that does not
    // exist. specOf is the question actually being asked here.
    if (!peasant || !kingdom.specOf(peasant) || kingdom.roleOf(peasant) !== 'peasant') {
      return send(400, { ok: false, error: `"${peasant}" is not a peasant of this court.` });
    }
    if (!existsSync(worktreePath(repo, peasant))) {
      return send(200, { ok: true, peasant, none: true, reason: 'This member has no worktree yet.' });
    }
    try {
      const file = url.searchParams.get('file');
      const [stat, diff] = await Promise.all([
        statOf(repo, peasant, kingdom.base),
        diffOf(repo, peasant, kingdom.base, file),
      ]);
      // The diff is the expensive part, and an enormous one helps nobody read
      // it — the panel offers per-file diffs for anything past this.
      const CAP = 120_000;
      return send(200, {
        ok: true, peasant, base: kingdom.base, stat,
        diff: diff.length > CAP ? `${diff.slice(0, CAP)}\n\n[truncated — open a single file to see the rest]` : diff,
        truncated: diff.length > CAP,
      });
    } catch (e) {
      return send(502, { ok: false, error: e.message });
    }
  }

  // ---- the sovereign's vault, from the throne room ---------------------
  if (url.pathname === '/api/vault') {
    const send = (code, o) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    const root = kingdom.config.vault || null;
    if (!root) return send(200, { ok: true, configured: false, notes: [] });

    const path = url.searchParams.get('path');
    if (path) {
      const body = readNote(root, path);
      // readNote returns null both for "escaped the vault" and "no such note".
      // The browser does not need to be told which.
      return body === null
        ? send(404, { ok: false, error: 'No such note.' })
        : send(200, { ok: true, path, body });
    }
    const q = url.searchParams.get('q');
    return send(200, {
      ok: true, configured: true, query: q ?? '',
      notes: q?.trim() ? searchVault(root, q) : recentNotes(root),
    });
  }

  // ---- backgrounds and music -------------------------------------------
  // GET  /api/assets            list what has been uploaded
  // POST /api/assets?name=x.jpg store a file (raw body)
  // POST /api/assets/delete     remove one  {name}
  // GET  /assets/<file>         serve it
  if (url.pathname === '/api/assets' || url.pathname === '/api/assets/delete') {
    const send = (code, o) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));

    if (req.method === 'GET') {
      try {
        const files = (await readdir(ASSETS)).filter(kindOf);
        return send(200, { ok: true, assets: files.map((f) => ({ name: f, kind: kindOf(f) })) });
      } catch {
        return send(200, { ok: true, assets: [] });   // nothing uploaded yet
      }
    }
    if (req.method !== 'POST') return res.writeHead(405).end();

    if (url.pathname.endsWith('/delete')) {
      let body = '';
      for await (const c of req) body += c;
      const name = safeAsset(JSON.parse(body || '{}').name);
      if (!name) return send(400, { ok: false, error: 'not a media file' });
      try { await unlink(join(ASSETS, name)); } catch {}
      return send(200, { ok: true });
    }

    const name = safeAsset(url.searchParams.get('name'));
    if (!name) return send(400, { ok: false, error: 'unsupported file type' });
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      // A wallpaper or a track, not a video library. Refuse rather than fill
      // the disk silently.
      if (size > 80 * 1024 * 1024) { req.destroy(); return send(413, { ok: false, error: 'over 80MB' }); }
      chunks.push(c);
    }
    await mkdir(ASSETS, { recursive: true });
    await writeFile(join(ASSETS, name), Buffer.concat(chunks));
    return send(200, { ok: true, name, kind: kindOf(name) });
  }

  if (url.pathname.startsWith('/assets/')) {
    const name = safeAsset(decodeURIComponent(url.pathname.slice(8)));
    if (!name) return res.writeHead(404).end();
    try {
      const buf = await readFile(join(ASSETS, name));
      return res.writeHead(200, {
        'content-type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      }).end(buf);
    } catch {
      return res.writeHead(404).end();
    }
  }

  // Dictation, via SpeechBird's local Whisper. Nothing leaves the machine.
  if (url.pathname === '/api/transcribe') {
    const send = (code, o) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));

    // The UI asks first, so it can fall back to the browser recogniser rather
    // than record a clip nothing can transcribe.
    if (req.method === 'GET') return send(200, { ok: true, available: speech.available() });
    if (req.method !== 'POST') return res.writeHead(405).end();

    if (!speech.available()) {
      return send(400, { ok: false, error: 'SpeechBird not found. Set "speechbird" in '
        + 'kingdom.config.json to the folder holding its .venv.' });
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    // audio/webm;codecs=opus -> webm
    const ext = (req.headers['content-type'] ?? '').split(';')[0].split('/')[1] || 'webm';
    try {
      return send(200, { ok: true, text: await speech.transcribe(Buffer.concat(chunks), ext) });
    } catch (e) {
      return send(502, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const action = ACTIONS[url.pathname.slice(5)];
    if (!action) return res.writeHead(404).end();
    let body = '';
    for await (const c of req) body += c;
    try {
      await action(body ? JSON.parse(body) : {});
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // static
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const buf = await readFile(join(PUBLIC, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/plain' }).end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', async () => {
  try {
    await kingdom.start();
    ready = true;
    console.log(`throne room: http://127.0.0.1:${port}  (repo: ${repo})`);
  } catch (e) {
    console.error(e?.stack ?? e);
    process.exitCode = 1;
    process.exit();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
