// The sovereign's Obsidian vault: readable in full, writable only inside one
// folder so a court of sixteen cannot scatter files through a personal
// knowledge base.
//
// Shared by the MCP server (agents reading it) and the daemon (the throne
// room's vault browser). It lived only in mcp.js, which runs as a separate
// process per agent — a second copy in the daemon would have been a second
// containment check to get wrong.
import {
  readdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync, watch,
  mkdirSync, copyFileSync, realpathSync,
} from 'node:fs';
import { join, resolve, relative, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { kingdomDir } from './worktree.js';

/**
 * Resolve a vault-relative path, or null if it escapes.
 *
 * The check is on the RESOLVED path, not the input string: `a/../../b` looks
 * harmless character by character and is not.
 */
export function insideVault(root, p) {
  if (!root) return null;
  const abs = resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel === '') return abs;                       // the root itself
  if (/^[a-zA-Z]:/.test(rel)) return null;          // a different drive
  // Compare the first PATH SEGMENT, not the first two characters. A plain
  // startsWith('..') also rejects "..foo.md", which is an ordinary filename
  // and not an escape — and Obsidian will happily produce one from a note
  // title. Only a segment that IS "*..*" walks upward.
  return rel.split(/[\\/]/)[0] === '..' ? null : abs;
}

/** Every .md in the vault. Dot-directories are skipped: .obsidian and .trash. */
export function walkVault(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkVault(p, out, depth + 1);
    else if (extname(e.name) === '.md') out.push(p);
  }
  return out;
}

/**
 * The vault, in memory, so a search does not re-read 9.4MB from disk.
 *
 * Measured on the sovereign's real vault — 1,409 notes, 9.4MB — a single
 * searchVault call cost 800-2,600ms, and the Court Instructions tell every
 * member to search before deciding. Each member also runs its OWN mcp.js
 * process, so that cost was paid per member per call.
 *
 * Revalidation is by mtime, and only after REVALIDATE_MS: stat-ing every file
 * is itself ~120ms, so doing it on every keystroke-equivalent would put the
 * floor back. Writers call invalidateVault() so a note the court just recorded
 * is searchable immediately; a note written by ANOTHER process is picked up on
 * the next revalidation.
 */
// Read lazily, not at import: tests need to shorten it, and a constant that
// cannot be shortened means the revalidation path is never actually exercised.
const revalidateMs = () => Number(process.env.KINGDOM_VAULT_REVALIDATE_MS ?? 4000);
// With a working watcher the sweep is not a poll any more, so this is only a
// backstop against a watcher that misses something (network shares, exhausted
// inotify watches). Long, because the watcher is what provides freshness.
const backstopMs = () => Number(process.env.KINGDOM_VAULT_BACKSTOP_MS ?? 120_000);
const corpus = new Map();   // root -> { at, files: Map<path, {mtime, text}> }
const watchers = new Map(); // root -> { ok, dirty, w }

/**
 * Watch the vault instead of re-stat-ing it.
 *
 * Revalidating cost 134ms — a 19ms directory walk plus a 115ms stat of all
 * 1,409 files — and it ran every 4 seconds, so a member searching over a
 * minute paid it a dozen times. A recursive watcher answers the same question
 * for nothing: measured on this vault it fires in 1-2ms for a create, an edit
 * AND a delete, which is also far fresher than a 4s poll.
 *
 * It is an OPTIMISATION, never the whole answer. fs.watch is the least
 * reliable thing in Node — it silently misses events on some filesystems and
 * throws outright on others — so a failed watcher just falls back to the
 * original polling interval, and even a healthy one is backstopped by a full
 * sweep. The watcher can only make the court FASTER, never wronger.
 */
function ensureWatcher(key) {
  try { key = realpathSync.native(resolve(key)); } catch {}
  const had = watchers.get(key);
  if (had) return had;
  const state = { ok: false, dirty: false, bulk: false, changed: new Set(), w: null };
  // The switch exists so the polling path can still be tested. With a healthy
  // watcher the poll never runs, and an untested fallback is the one that will
  // be broken on the machine where fs.watch does not work.
  if (process.env.KINGDOM_VAULT_WATCH === '0') {
    watchers.set(key, state);
    return state;
  }
  try {
    state.w = watch(key, { recursive: true }, (_evt, name) => {
      state.dirty = true;
      // Remember WHICH file, not just that something happened. A member
      // recording a memory changes one note; re-walking and re-stat-ing all
      // 1,409 to discover that costs 134ms, and doing it per write is what
      // made a write-then-search cycle 177ms.
      if (!name) { state.bulk = true; return; }          // no path: fall back to a sweep
      const rel = String(name);
      if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return;  // .obsidian, .trash
      if (extname(rel) !== '.md') return;
      if (state.changed.size > 200) { state.bulk = true; return; }        // a bulk edit; sweep
      state.changed.add(join(key, rel));
    });
    state.w.on('error', () => { state.ok = false; });   // degrade to polling
    state.w.unref?.();                                   // must never hold the process open
    state.ok = true;
  } catch {
    state.ok = false;
  }
  watchers.set(key, state);
  return state;
}

/** Release watchers. Tests need this; long-lived processes never do. */
export function closeVaultWatchers() {
  for (const s of watchers.values()) { try { s.w?.close(); } catch {} }
  watchers.clear();
}

/**
 * A writer telling the cache exactly what it changed.
 *
 * Far better than invalidateVault() for the common case: dropping the whole
 * corpus forces the next search to re-walk and re-stat all 1,409 notes, which
 * measured 177ms per write-then-search cycle. The writer already knows the one
 * path it touched, so update that entry and leave the rest alone — about 1ms.
 *
 * Also closes a race the watcher cannot: a member that writes a memory and
 * searches for it in the same breath may beat the filesystem event.
 */
export function noteWritten(root, abs) {
  const key = resolve(root);
  let c = corpus.get(key);
  if (!c) { try { c = corpus.get(realpathSync.native(key)); } catch {} }
  if (!c) return;                       // nothing cached; the next load reads it anyway
  try {
    c.files.set(abs, { mtime: statSync(abs).mtimeMs, text: readFileSync(abs, 'utf8') });
  } catch {
    c.files.delete(abs);                // it was a delete
  }
}

/**
 * Copy a note the court just wrote into THIS PROJECT's own .kingdom mirror.
 *
 * The vault is shared across every project the sovereign runs a court in —
 * that is deliberate, it is how a decision made here is still visible from
 * another repo next month. But it also means a single project's .kingdom
 * folder, on its own, is missing everything the court has ever learned about
 * it. This keeps a same-shaped copy under kingdomDir(repo)/vault/ so that
 * folder is self-sufficient too, without changing where the real vault lives.
 *
 * No repo, no mirror: Chat/Research/Build can run before any repo is
 * attached, and their state already lives at the single shared workspace
 * home (kingdomDir(null)) — mirroring there would just be writing the
 * sovereign's real homedir on every vault write in every repo-less session
 * and every test that does not set one up, for no project to actually own it.
 *
 * Best-effort otherwise: the vault write already succeeded by the time this
 * runs, so a mirror failure (disk full, permissions) must not be treated as
 * the note itself having failed to save.
 */
export function mirrorToProject(repo, root, abs) {
  if (!root || !repo) return;
  const rel = relative(resolve(root), abs);
  if (!rel || rel.split(/[\\/]/)[0] === '..') return; // outside the vault; nothing to mirror
  try {
    const dest = join(kingdomDir(repo), 'vault', rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
  } catch { /* mirroring is a courtesy copy, not the source of truth */ }
}

/** Drop the cached corpus for a root. The blunt instrument; prefer noteWritten. */
export function invalidateVault(root) {
  if (root) {
    const key = resolve(root);
    corpus.delete(key);
    try { corpus.delete(realpathSync.native(key)); } catch {}
  }
  else corpus.clear();
}

/**
 * A shared on-disk copy of the corpus, so a COLD process does not re-open
 * every note.
 *
 * Measured: reading 1,409 notes individually is 938ms; reading and parsing one
 * 9.7MB index is 43ms — the cost is per-file syscall latency, not bytes. Every
 * member runs its own mcp.js, so each was paying the 938ms separately.
 *
 * It lives in the OS temp directory, never in the vault: the vault is the
 * sovereign's own notes and the court does not scatter machine files through
 * it. It is a CACHE, not a source of truth — every entry is checked against
 * the real mtime before use, so a stale or corrupt index costs a re-read and
 * never a wrong answer.
 */
export const vaultIndexPath = (root) => indexPath(resolve(root));

const indexPath = (key) => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return join(tmpdir(), `kingdom-vault-${(h >>> 0).toString(36)}.json`);
};

function readIndex(key) {
  try {
    const raw = JSON.parse(readFileSync(indexPath(key), 'utf8'));
    if (raw?.v !== 1 || !Array.isArray(raw.files)) return null;
    return new Map(raw.files.map(([p, mtime, text]) => [p, { mtime, text }]));
  } catch {
    return null;   // absent, unreadable or from an older shape: just rebuild
  }
}

// The index exists ONLY to seed a cold process, so it does not need to be
// current — every entry is checked against the real mtime when it is used, so
// a slightly old index costs a few re-reads and never a wrong answer.
// Rewriting it on every change cost 235ms per write-then-search cycle and put
// 48MB on disk for five small notes, because the whole 9.7MB is rewritten each
// time. Throttled, that becomes one write.
const indexWriteMs = () => Number(process.env.KINGDOM_VAULT_INDEX_MS ?? 60_000);
const indexWritten = new Map();   // root -> ts of last write by THIS process

/**
 * The throttle has to be GLOBAL, not per-process.
 *
 * Every member runs its own mcp.js, so a per-process timer lets a court of
 * sixteen write the same 9.7MB index sixteen times a minute — 155MB of churn
 * for a file that only has to be roughly right. The index's own mtime is the
 * shared clock: whoever wrote last, in whatever process, tells everyone else
 * to stand down.
 *
 * A lost race just means two members write nearly the same bytes, which the
 * rename makes harmless. There is nothing here worth a lockfile.
 */
function indexFresh(key, now) {
  try {
    return now - statSync(indexPath(key)).mtimeMs < indexWriteMs();
  } catch {
    return false;   // no index yet: somebody has to be first
  }
}

function writeIndex(key, files) {
  // Write-then-rename so a member reading the index never sees a half-written
  // one — several mcp.js processes can be doing this at the same moment.
  const target = indexPath(key);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    // 0600, because this file is the sovereign's entire vault — every note,
    // body text included, ~9.7MB of it — sitting in the SHARED system tmpdir
    // under a name derived from a non-secret hash of the vault path. Default
    // permissions there are world-readable. rename preserves the mode.
    writeFileSync(tmp, JSON.stringify({
      v: 1, files: [...files].map(([p, { mtime, text }]) => [p, mtime, text]),
    }), { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

function load(root) {
  const resolved = resolve(root);
  let key = resolved;
  try { key = realpathSync.native(resolved); } catch {}
  const now = Date.now();
  const watcher = ensureWatcher(key);
  let c = corpus.get(key) ?? corpus.get(resolved);
  if (c) {
    const age = now - c.at;
    // A healthy watcher means "nothing changed" is known, not guessed, so the
    // cache can be trusted until it says otherwise. Without one, fall back to
    // the original poll.
    if (watcher.ok ? (!watcher.dirty && age < backstopMs()) : age < revalidateMs()) return c.files;
  }
  // A watcher that named the changed files lets us touch only those — one
  // stat and one read each, instead of a 19ms walk plus 115ms of stats to
  // rediscover what it already told us.
  if (c && watcher.ok && !watcher.bulk && watcher.changed.size) {
    const touched = [...watcher.changed];
    watcher.changed.clear();
    watcher.dirty = false;
    for (const f of touched) {
      try {
        const mtime = statSync(f).mtimeMs;
        if (c.files.get(f)?.mtime !== mtime) c.files.set(f, { mtime, text: readFileSync(f, 'utf8') });
      } catch {
        c.files.delete(f);      // removed or renamed away
      }
    }
    // `at` is NOT advanced: the backstop sweep still falls due on schedule, so
    // anything the watcher missed is still caught.
    return c.files;
  }

  // Cleared BEFORE the sweep, not after: a note written while we are reading
  // must leave the flag set so the next call sweeps again, rather than being
  // swallowed by the scan that was already in flight.
  watcher.dirty = false;
  watcher.bulk = false;
  watcher.changed.clear();

  // Seed a cold process from the shared index. The mtime loop below then only
  // re-reads what actually changed, so a stale index is self-correcting.
  const files = c?.files ?? readIndex(key) ?? new Map();
  let changed = !c;
  const seen = new Set();
  for (const f of walkVault(root)) {
    seen.add(f);
    let mtime = 0;
    try { mtime = statSync(f).mtimeMs; } catch { continue; }
    const had = files.get(f);
    if (had && had.mtime === mtime) continue;      // unchanged: keep the text
    changed = true;
    try { files.set(f, { mtime, text: readFileSync(f, 'utf8') }); } catch { files.delete(f); }
  }
  for (const f of files.keys()) {
    if (!seen.has(f)) { files.delete(f); changed = true; }             // deleted notes
  }
  corpus.set(key, { at: now, files });
  // At most one rewrite a minute for the whole court, not one per member.
  if (changed && now - (indexWritten.get(key) ?? 0) >= indexWriteMs() && !indexFresh(key, now)) {
    indexWritten.set(key, now);
    writeIndex(key, files);
  }
  return files;
}

/**
 * Search titles and bodies. Returns matches with the lines that matched, so
 * the caller can show context without reading every file again.
 *
 * A filename match with no line matches still counts — "Model Guidance" is
 * what you searched for even if the phrase never appears in the body.
 */
export function searchVault(root, query, { limit = 40, context = 3 } = {}) {
  if (!root || !query?.trim()) return [];
  const needle = query.toLowerCase();
  const hits = [];
  for (const [f, { mtime, text }] of load(root)) {
    const path = relative(root, f).replace(/\\/g, '/');
    const inName = path.toLowerCase().includes(needle);
    // Cheap reject first: scanning one lowercased string beats splitting every
    // note into lines when the overwhelming majority do not match at all.
    const lines = [];
    let count = 0;
    const lower = text.toLowerCase();
    if (lower.includes(needle)) {
      // Total occurrences, not just the ones shown. A note that discusses the
      // term throughout is a better answer than one that mentions it once in
      // passing, and with 1,400 notes the payload budget only fits a few.
      for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) count++;
      const all = text.split('\n');
      // Track the enclosing heading as we go, so a hit can say WHERE in the
      // note it is. That lets the caller jump straight to vault_read(path,
      // section) instead of fetching the outline first just to find out.
      let head = '';
      for (let i = 0; i < all.length && lines.length < context; i++) {
        const h = /^#{1,6}\s+(.+?)\s*$/.exec(all[i]);
        if (h) { head = h[1]; continue; }
        if (all[i].toLowerCase().includes(needle)) {
          lines.push({ n: i + 1, text: all[i].trim().slice(0, 200), section: head });
        }
      }
    }
    if (!inName && !lines.length) continue;
    hits.push({ path, lines, inName, mtime, hits: count });
  }
  // Filename matches first, then density, then most recently edited. Density
  // matters because the caller has a token budget: a vault of near-duplicate
  // governance notes would otherwise fill it with notes that say the word once.
  hits.sort((a, b) =>
    Number(b.inName) - Number(a.inName) || b.hits - a.hits || b.mtime - a.mtime);
  return hits.slice(0, limit);
}

/** Recently edited notes — the useful default view before anything is typed. */
export function recentNotes(root, limit = 25) {
  if (!root) return [];
  return [...load(root)]
    .map(([f, { mtime }]) => ({ path: relative(root, f).replace(/\\/g, '/'), mtime }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

/**
 * The headings of a note, with the size of each section.
 *
 * 97% of this vault's notes carry two or more headings, and a member usually
 * wants one of them. Reading a p90 note whole costs ~3,000 tokens that then sit
 * in its context for every later turn; one section costs ~320.
 */
export function noteOutline(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) out.push({ level: m[1].length, title: m[2], line: i, chars: 0 });
  }
  for (let i = 0; i < out.length; i++) {
    const end = i + 1 < out.length ? out[i + 1].line : lines.length;
    out[i].chars = lines.slice(out[i].line, end).join('\n').length;
  }
  return out;
}

/**
 * One section of a note by heading, or null if no heading matches.
 * Matching is case-insensitive and partial, because a model quoting a heading
 * back at you will drop punctuation and numbering as often as not.
 */
export function noteSection(text, want) {
  if (!want?.trim()) return null;
  const lines = String(text).split('\n');
  const heads = noteOutline(text);
  const needle = want.toLowerCase().trim();
  const hit = heads.find((h) => h.title.toLowerCase() === needle)
    ?? heads.find((h) => h.title.toLowerCase().includes(needle))
    ?? heads.find((h) => needle.includes(h.title.toLowerCase()));
  if (!hit) return null;
  // Run to the next heading at the SAME level or higher, so asking for a
  // section gets its subsections too rather than stopping at the first "###".
  const start = heads.indexOf(hit);
  let end = lines.length;
  for (let i = start + 1; i < heads.length; i++) {
    if (heads[i].level <= hit.level) { end = heads[i].line; break; }
  }
  return { title: hit.title, text: lines.slice(hit.line, end).join('\n').trim() };
}

export function readNote(root, path, limit = 200_000) {
  const abs = insideVault(root, path);
  if (!abs) return null;
  try {
    // Almost every read follows a search that already pulled this note into
    // memory, so serve it from there when the corpus is warm — but only while
    // its mtime still matches: one stat is cheap, and an edit made outside the
    // court (the sovereign, in Obsidian) must not be read back as the old text.
    const cached = corpus.get(resolve(root))?.files.get(abs);
    const body = cached?.mtime === statSync(abs).mtimeMs ? cached.text : readFileSync(abs, 'utf8');
    return body.length > limit ? `${body.slice(0, limit)}\n\n[truncated]` : body;
  } catch {
    return null;
  }
}
