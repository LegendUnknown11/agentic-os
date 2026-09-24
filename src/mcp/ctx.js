// Everything one MCP process knows about itself, resolved once.
//
// Split out of mcp.js when its TOOLS literal reached 1,200 lines. Every tool
// body closed over these bindings, so they had to become importable before the
// tools could move — and they could move safely BECAUSE all of this is a pure
// read of process.env at import time. There is no async setup here and no
// ordering hazard: a tool module that imports this file gets a fully resolved
// identity or the import itself fails.
//
// Keep it that way. Anything here that starts depending on when it is called
// re-couples every tool module to import order.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Bus } from '../bus.js';
import { insideVault as vaultInside } from '../vault.js';
import { modeName } from '../modes.js';


// Search results are replayed in the member's context on every later turn, so
// the payload is a token budget, not just a display limit.
export const VAULT_SEARCH_BUDGET = 3500;
// Above this a note answers with its headings instead of its body: 97% of the
// vault is sectioned, and a p90 note costs ~3,000 tokens whole vs ~320 a section.
export const NOTE_WHOLE_LIMIT = 5000;

/**
 * Who this server is serving.
 *
 * Normally the env says, because the CLI is told which server to run per
 * member. The Antigravity CLI cannot do that: headless agy reads ONE global
 * mcp_config.json, so a single declaration is shared by the whole court and its
 * env cannot name anybody.
 *
 * What rescues it is that the server inherits the agy process's working
 * directory, which is the member's own worktree. So identity travels by
 * directory: kingdom.js drops `.agents/kingdom-id.json` into each member's
 * workspace and this reads it. Without this, every Antigravity member would
 * post to the bus as the same agent — whoever was configured last.
 */
export function identityFromCwd() {
  for (const dir of [process.cwd(), join(process.cwd(), '..')]) {
    try {
      return JSON.parse(readFileSync(join(dir, '.agents', 'kingdom-id.json'), 'utf8'));
    } catch { /* not this one */ }
  }
  return {};
}

export const ID = process.env.KINGDOM_AGENT ? {} : identityFromCwd();

export const ME = process.env.KINGDOM_AGENT ?? ID.agent ?? 'unknown';
export const ROLE = process.env.KINGDOM_ROLE ?? ID.role ?? 'peasant'; // peasant | briefer | orchestrator
export const REPO = process.env.KINGDOM_REPO ?? ID.repo ?? process.cwd();
// Distinct from REPO above: that one falls back to cwd so diffing/testing
// always has SOME path to work against. Mirroring must not — a fallback here
// would mirror into a random directory's .kingdom instead of correctly
// mirroring nowhere when no repo is attached.
export const MIRROR_REPO = process.env.KINGDOM_REPO || null;
/**
 * There may be no kingdom here at all, and that is a normal state.
 *
 * agy reads ONE GLOBAL mcp_config.json, so this server is launched by EVERY
 * agy session on the machine — including ones opened in directories that have
 * nothing to do with a court. Those have no `.agents/kingdom-id.json` and no
 * KINGDOM_DB, so the db path is undefined.
 *
 * Constructing a Bus on undefined threw ERR_INVALID_ARG_TYPE out of node:path
 * before any handler could run, which killed the transport and surfaced to the
 * sovereign as a stack trace plus `connection closed: calling "initialize":
 * client is closing: EOF`. A crash is the worst possible answer to "you are
 * not in a kingdom": it breaks the client's whole MCP connection over a
 * condition that is not an error.
 *
 * So: serve a valid session with no tools, and say why on stderr.
 */
export const DB = process.env.KINGDOM_DB ?? ID.db;
export const bus = DB ? new Bus(DB) : null;
// Same directory daemon.js schedules and serves workflows from. Derived from
// DB rather than REPO: the kingdom's home directory is fixed for the court's
// life (kingdom.js), but REPO can change live when a repo is attached after
// boot (Kingdom#attachRepo) — using REPO here would silently point at a
// different, empty directory the moment that happens.
export const WORKFLOWS_DIR = DB ? join(dirname(DB), 'workflows') : null;
// Same reasoning, same directory daemon.js uploads into and serves from.
export const ASSETS_DIR = DB ? join(dirname(DB), 'assets') : null;
// Must track daemon.js's DOCUMENT/IMAGE sets — the extensions it will
// actually accept an upload for. Duplicated rather than shared: a handful of
// extensions in a server-only file and matching Sets here are cheaper kept
// in sync by eye than by a new module built to hold them.
export const DOCUMENT_EXT = new Set(['.pdf', '.txt', '.md', '.csv', '.json']);
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
if (!bus) {
  process.stderr.write(
    'kingdom MCP: no court in this directory — starting with no tools.\n'
    + '  Neither KINGDOM_DB nor .agents/kingdom-id.json was found, which is the\n'
    + '  normal state for an agy session outside a kingdom worktree.\n'
    + `  cwd: ${process.cwd()}\n`,
  );
}
export const DIFF_LIMIT = 15_000; // lands in the reader's context permanently
// Every delivered message is replayed into the recipient's context. One 16kb
// paste in a real run cost a full extra turn for content the recipient could
// have read off disk itself.
export const MSG_LIMIT = 4000;

// --- the sovereign's Obsidian vault ----------------------------------
// Readable in full; writes are confined to one folder so five agents cannot
// scatter files through a personal knowledge base.
export const VAULT = process.env.KINGDOM_VAULT || ID.vault || null;
export const VAULT_WRITE_DIR = process.env.KINGDOM_VAULT_DIR || ID.vaultDir || 'Kingdom';
// Containment and traversal live in vault.js so the daemon's vault browser
// enforces exactly the same rule as the agents do.
export const insideVault = (p) => vaultInside(VAULT, p);

export const slug = (s) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);

export function tooBig(body) {
  return body.length <= MSG_LIMIT ? null :
    `Message rejected: ${body.length} characters (limit ${MSG_LIMIT}). Every ` +
    `message is replayed into the recipient's context, so pasting files is ` +
    `expensive. Write it to a file in your worktree and send the PATH — the ` +
    `other peasants' worktrees are siblings at "../<name>/" and they can read ` +
    `yours. Send a summary plus the path instead.`;
}

export const str = (description) => ({ type: 'string', description });

/** Clamp list sizes at the MCP boundary before they reach SQLite or the model context. */
export const boundedLimit = (value, fallback, maximum) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(1, Math.min(maximum, n)) : fallback;
};

// --- who is actually out there ---------------------------------------
// The roster is published to the bus by the orchestrator on every change
// (`kingdom.js` roster()), so it is the one view of the court that every
// member's MCP server shares.
export const stateArray = (key) => {
  try {
    const value = JSON.parse(bus.get(key) ?? '[]');
    return Array.isArray(value) ? value : null;
  } catch { return null; }
};
export const rosterNow = () => stateArray('roster') ?? [];
export const goalNow = () => {
  const raw = bus.get('goal');
  if (!raw) return { goal: null };
  try {
    const goal = JSON.parse(raw);
    return goal && typeof goal === 'object' && !Array.isArray(goal) ? { goal } : { unreadable: true };
  } catch { return { unreadable: true }; }
};

/**
 * The member currently holding an office, by role rather than by name.
 *
 * `declare_done` and `brief_orchestrator` used to post to the literal string "orchestrator".
 * The orchestrator's name is configuration — `kingdom.config.json` has `orchestrator.name`,
 * `roleOf()` compares against it, and `#promptFor` tells every member what it
 * is — and delivery is by recipient (`bus.pending(agent)` matches
 * `recipient = ?`). So renaming the orchestrator sent every declare_done and every
 * briefer briefing to a recipient nobody reads, while the tool still answered
 * "The orchestrator has been notified." Silent, and precisely the failure AGENTS.md
 * rule 4 is about.
 *
 * Falls back to the literal name if the roster has not been published yet:
 * degrading to the old behaviour beats refusing to report work as done.
 */
export const officer = (role, fallback) => rosterNow().find((m) => m.role === role)?.name ?? fallback;

/**
 * Reject a message addressed to somebody who does not exist.
 *
 * `send_message` and `send_back` posted whatever name they were given and
 * answered "Sent to X." unconditionally. A typo, a hallucinated specialist, or
 * a role the sovereign had deleted produced a row that `pending()` could never
 * match for anyone — the message was stored, delivered to no one, and reported
 * as sent. `assign` has always validated; these two never did.
 *
 * An empty roster means the court has not published one yet, and blocking on
 * that would wedge a member for a condition that is not its fault. So: no
 * roster, no check.
 */
export function badRecipient(to) {
  const roster = rosterNow();
  if (!roster.length || roster.some((m) => m.name === to)) return null;
  const q = String(to).toLowerCase();
  const near = roster
    .map((m) => m.name)
    .filter((n) => n.toLowerCase().includes(q) || q.includes(n.toLowerCase()))
    .slice(0, 5);
  return `No member named "${to}" — nothing was sent. `
    + (near.length
      ? `Did you mean: ${near.join(', ')}?`
      : `Call the roster tool for the names that exist.`);
}

/**
 * Incremental reads. These tools defaulted to `since = 0`, so every briefer
 * briefing re-injected the ENTIRE history into its context — measured at 182k
 * tokens per read on a real run. The server now remembers where each agent got
 * to and returns only what is new. An explicit `since` still works for a
 * deliberate look back, and does not disturb the cursor.
 */
export function cursorFor(tool, since) {
  if (since !== undefined) return { from: since, track: false };
  return { from: Number(bus.get(`readcur:${tool}:${ME}`) ?? 0), track: true };
}

export function advance(tool, track, rows) {
  if (!track || !rows.length) return;
  bus.set(`readcur:${tool}:${ME}`, String(Math.max(...rows.map((r) => r.id))));
}

export const nothingNew = (from) =>
  from ? `Nothing new since your last read (id ${from}).` : 'Nothing recorded yet.';

/**
 * What shape the court is in, read fresh every time.
 *
 * NOT captured at module load. codex runs one process per turn, but a claude
 * member is one process for its whole life — so a mode flipped an hour into a
 * session would never reach it, and it would keep holding a merge tool that no
 * longer does anything. The bus is the only channel that crosses into a process
 * the orchestrator does not own, and a get is one indexed row.
 */
export const modeNow = () => modeName(bus?.get('mode'));
