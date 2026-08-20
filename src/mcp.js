#!/usr/bin/env node
// The kingdom's MCP server. One instance is spawned per agent by its CLI, with
// KINGDOM_AGENT / KINGDOM_ROLE / KINGDOM_DB in the environment. The toolset it
// advertises depends on the role, so a peasant simply cannot see `summon`.
//
// It writes straight to the SQLite bus (WAL, multi-process safe). The
// orchestrator polls for new rows rather than being called back — one less
// moving part than a socket, and a 300ms poll on a local db is free.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { Bus } from './bus.js';
import { diffOf, statOf } from './worktree.js';
import { listWorkflows, saveWorkflow, deleteWorkflow, runWorkflow, logRun } from './workflows.js';
import {
  insideVault as vaultInside, walkVault, invalidateVault, noteWritten, searchVault, noteOutline, noteSection,
  mirrorToProject,
} from './vault.js';
import { remember } from './memory.js';
import { badRole, badQuestions } from './approval.js';
import { composeSkill, listSkills, slugSkill, SKILLS_DIR } from './skills.js';
import { modeName, modeOf, toolAllowed, MODE_NAMES } from './modes.js';

// Search results are replayed in the member's context on every later turn, so
// the payload is a token budget, not just a display limit.
const VAULT_SEARCH_BUDGET = 3500;
// Above this a note answers with its headings instead of its body: 97% of the
// vault is sectioned, and a p90 note costs ~3,000 tokens whole vs ~320 a section.
const NOTE_WHOLE_LIMIT = 5000;

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
function identityFromCwd() {
  for (const dir of [process.cwd(), join(process.cwd(), '..')]) {
    try {
      return JSON.parse(readFileSync(join(dir, '.agents', 'kingdom-id.json'), 'utf8'));
    } catch { /* not this one */ }
  }
  return {};
}

const ID = process.env.KINGDOM_AGENT ? {} : identityFromCwd();

const ME = process.env.KINGDOM_AGENT ?? ID.agent ?? 'unknown';
const ROLE = process.env.KINGDOM_ROLE ?? ID.role ?? 'peasant'; // peasant | briefer | orchestrator
const REPO = process.env.KINGDOM_REPO ?? ID.repo ?? process.cwd();
// Distinct from REPO above: that one falls back to cwd so diffing/testing
// always has SOME path to work against. Mirroring must not — a fallback here
// would mirror into a random directory's .kingdom instead of correctly
// mirroring nowhere when no repo is attached.
const MIRROR_REPO = process.env.KINGDOM_REPO || null;
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
const DB = process.env.KINGDOM_DB ?? ID.db;
const bus = DB ? new Bus(DB) : null;
// Same directory daemon.js schedules and serves workflows from. Derived from
// DB rather than REPO: the kingdom's home directory is fixed for the court's
// life (kingdom.js), but REPO can change live when a repo is attached after
// boot (Kingdom#attachRepo) — using REPO here would silently point at a
// different, empty directory the moment that happens.
const WORKFLOWS_DIR = DB ? join(dirname(DB), 'workflows') : null;
// Same reasoning, same directory daemon.js uploads into and serves from.
const ASSETS_DIR = DB ? join(dirname(DB), 'assets') : null;
// Must track daemon.js's DOCUMENT set — the extensions it will actually
// accept an upload for. Duplicated rather than shared: five extensions in a
// server-only file and a five-extension Set here are cheaper kept in sync by
// eye than by a new module built to hold one constant.
const DOCUMENT_EXT = new Set(['.pdf', '.txt', '.md', '.csv', '.json']);
if (!bus) {
  process.stderr.write(
    'kingdom MCP: no court in this directory — starting with no tools.\n'
    + '  Neither KINGDOM_DB nor .agents/kingdom-id.json was found, which is the\n'
    + '  normal state for an agy session outside a kingdom worktree.\n'
    + `  cwd: ${process.cwd()}\n`,
  );
}
const DIFF_LIMIT = 15_000; // lands in the reader's context permanently
// Every delivered message is replayed into the recipient's context. One 16kb
// paste in a real run cost a full extra turn for content the recipient could
// have read off disk itself.
const MSG_LIMIT = 4000;

// --- the sovereign's Obsidian vault ----------------------------------
// Readable in full; writes are confined to one folder so five agents cannot
// scatter files through a personal knowledge base.
const VAULT = process.env.KINGDOM_VAULT || ID.vault || null;
const VAULT_WRITE_DIR = process.env.KINGDOM_VAULT_DIR || ID.vaultDir || 'Kingdom';
// Containment and traversal live in vault.js so the daemon's vault browser
// enforces exactly the same rule as the agents do.
const insideVault = (p) => vaultInside(VAULT, p);

const slug = (s) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);

function tooBig(body) {
  return body.length <= MSG_LIMIT ? null :
    `Message rejected: ${body.length} characters (limit ${MSG_LIMIT}). Every ` +
    `message is replayed into the recipient's context, so pasting files is ` +
    `expensive. Write it to a file in your worktree and send the PATH — the ` +
    `other peasants' worktrees are siblings at "../<name>/" and they can read ` +
    `yours. Send a summary plus the path instead.`;
}

const str = (description) => ({ type: 'string', description });

// --- who is actually out there ---------------------------------------
// The roster is published to the bus by the orchestrator on every change
// (`kingdom.js` roster()), so it is the one view of the court that every
// member's MCP server shares.
const rosterNow = () => {
  try {
    const r = JSON.parse(bus.get('roster') ?? '[]');
    return Array.isArray(r) ? r : [];
  } catch { return []; }
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
const officer = (role, fallback) => rosterNow().find((m) => m.role === role)?.name ?? fallback;

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
function badRecipient(to) {
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
function cursorFor(tool, since) {
  if (since !== undefined) return { from: since, track: false };
  return { from: Number(bus.get(`readcur:${tool}:${ME}`) ?? 0), track: true };
}

function advance(tool, track, rows) {
  if (!track || !rows.length) return;
  bus.set(`readcur:${tool}:${ME}`, String(Math.max(...rows.map((r) => r.id))));
}

const nothingNew = (from) =>
  from ? `Nothing new since your last read (id ${from}).` : 'Nothing recorded yet.';

const TOOLS = {
  send_message: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Message another member directly by name. Prefer this over waiting on the orchestrator.',
    schema: {
      type: 'object',
      properties: { to: str('Recipient name, e.g. "coder"'), body: str('What to say') },
      required: ['to', 'body'],
    },
    run: ({ to, body }) => {
      const err = tooBig(body) ?? badRecipient(to);
      if (err) return err;
      bus.post(ME, to, body);
      return `Sent to ${to}.`;
    },
  },

  broadcast: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Say something to every member of the court at once. EXPENSIVE — it ' +
      'costs every recipient a turn, so prefer send_message to the one or two ' +
      'members who actually need to know.',
    schema: { type: 'object', properties: { body: str('What to say') }, required: ['body'] },
    run: ({ body }) => {
      const err = tooBig(body);
      if (err) return err;
      bus.post(ME, null, body);
      return 'Broadcast sent to everyone.';
    },
  },

  roster: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description: 'Who is in the court, their role, and whether they are awake.',
    schema: { type: 'object', properties: {} },
    run: () => JSON.parse(bus.get('roster') ?? '[]'),
  },

  declare_done: {
    roles: ['peasant'],
    description:
      'Declare your task complete. Tests run automatically and the orchestrator reviews your diff.',
    schema: {
      type: 'object',
      properties: { summary: str('What you changed and why') },
      required: ['summary'],
    },
    run: ({ summary }) => {
      const held = bus.tasks().filter((t) => t.owner === ME && t.state !== 'done');
      if (held.length > 1) {
        return `You still hold ${held.map((t) => `#${t.id}`).join(' and ')}. Call finish_task for the completed one before declaring done.`;
      }
      if (held[0]?.state === 'planning') {
        return `Task #${held[0].id} still needs an approved plan. Call submit_plan and wait for the orchestrator.`;
      }
      if (held[0]) bus.updateTask(held[0].id, { state: 'done', doneTs: Date.now() });
      const orchestrator = officer('orchestrator', 'orchestrator');
      bus.post(ME, orchestrator, summary, 'done');
      return `Declared done${held[0] ? `; task #${held[0].id} closed` : ''}. ${orchestrator} has been notified; await review.`;
    },
  },

  read_bus: {
    roles: ['briefer', 'orchestrator'],
    description:
      'New messages since you last looked. Orchestrator: prefer the briefer briefings.',
    schema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Look back from this id instead of where you left off' },
        limit: { type: 'number', description: 'Max rows (default 60)' },
      },
    },
    run: ({ since, limit = 60 }) => {
      const { from, track } = cursorFor('bus', since);
      const rows = bus.history({ since: from, limit });
      advance('bus', track, rows);
      if (!rows.length) return nothingNew(from);
      return rows.map((m) =>
        `#${m.id} ${m.sender}->${m.recipient ?? '*'} [${m.kind}] ` +
        m.body.replace(/\s+/g, ' ').slice(0, 300)).join('\n');
    },
  },

  recall: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Search everything said or done in this court, all history, not just ' +
      'recent turns: agent text, tool calls, summaries, and messages.',
    schema: {
      type: 'object',
      properties: {
        query: str('Words to look for, e.g. "auth bug" or a file name'),
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
    run: ({ query, limit = 20 }) => {
      const hits = bus.recall(query, { limit });
      if (!hits.length) return `Nothing recalled for "${query}".`;
      return hits.map((h) =>
        `[${new Date(h.ts).toISOString()}] ${h.who} (${h.kind}): ` +
        String(h.text).replace(/\s+/g, ' ').slice(0, 200)).join('\n');
    },
  },

  list_uploads: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'List documents the sovereign has uploaded (pdf, txt, md, csv, json) for ' +
      'the court to read. Each entry gives the real file path — open it with ' +
      'your own file-reading tool, the same as any other file on disk.',
    schema: { type: 'object', properties: {}, required: [] },
    run: () => {
      if (!ASSETS_DIR) return 'No court home directory — nothing to list.';
      let files;
      try { files = readdirSync(ASSETS_DIR); } catch { files = []; }
      const docs = files.filter((f) => DOCUMENT_EXT.has(extname(f).toLowerCase()));
      if (!docs.length) return 'No documents uploaded.';
      return docs.map((f) => `${f} — ${join(ASSETS_DIR, f)}`).join('\n');
    },
  },

  read_events: {
    roles: ['briefer'],
    description:
      'What the peasants have DONE since you last looked (not what they say).',
    schema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Look back from this id instead of where you left off' },
        agent: str('Restrict to one agent (optional)'),
        limit: { type: 'number', description: 'Max rows (default 120)' },
      },
    },
    // Raw payloads land in the briefer's context verbatim, so flatten each event
    // to one short line — and only ever return what is new.
    run: ({ since, agent = null, limit = 120 }) => {
      const { from, track } = cursorFor('events', since);
      const rows = bus.events({ since: from, agent, limit });
      advance('events', track, rows);
      if (!rows.length) return nothingNew(from);
      return rows.map((e) => {
        const p = e.payload ?? {};
        const gist = String(p.text ?? p.name ?? p.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
        return `#${e.id} ${e.agent} ${e.type}${gist ? ': ' + gist : ''}`;
      }).join('\n');
    },
  },

  brief_orchestrator: {
    roles: ['briefer'],
    description:
      'Brief the orchestrator in plain language. Flag anything blocked, looping or contradictory.',
    schema: { type: 'object', properties: { summary: str('The briefing') }, required: ['summary'] },
    run: ({ summary }) => {
      bus.post(ME, officer('orchestrator', 'orchestrator'), summary, 'brief');
      return 'Briefing delivered.';
    },
  },

  vault_search: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Search the sovereign\'s notes (models, conventions, past decisions). ' +
      'Check BEFORE choosing a model, library or approach. To cite a hit when ' +
      'answering the sovereign, link it as [title](vault:path) — spaces as %20 ' +
      '— and it renders as a click-through to the real note, not a dead link.',
    schema: {
      type: 'object',
      properties: { query: str('Words to look for, e.g. "effort levels" or "pricing"') },
      required: ['query'],
    },
    run: ({ query }) => {
      if (!VAULT) return 'No vault is configured for this kingdom.';
      // Was a second, uncached copy of searchVault: it re-read all 1,409 notes
      // (9.4MB) on EVERY call — measured 1,250ms and ~1,300 tokens a search,
      // with nothing shared between calls in the same process. Going through
      // vault.js gets the cached corpus (15ms warm), ranks filename matches
      // first and then most-recently-edited, and truncates long lines.
      const hits = searchVault(VAULT, query, { limit: 12, context: 3 });
      if (!hits.length) return `Nothing in the vault matches "${query}".`;

      // A budget, because this lands in the member's context and is replayed on
      // every turn afterwards. Better to return the best few and say what was
      // withheld than to spend 1,300 tokens proving the vault is large.
      const out = [];
      let used = 0;
      for (const h of hits) {
        // Name the section each hit sits in, so the reader can go straight to
        // vault_read(path, section:"…") instead of pulling the whole note.
        const secs = [...new Set(h.lines.map((l) => l.section).filter(Boolean))];
        const block = `### ${h.path}${secs.length ? `  §${secs.join(' §')}` : ''}\n`
          + (h.lines.length ? h.lines.map((l) => `${l.n}: ${l.text}`).join('\n') : '(filename match)');
        if (used + block.length > VAULT_SEARCH_BUDGET && out.length) break;
        used += block.length + 2;
        out.push(block);
      }
      const more = hits.length - out.length;
      return out.join('\n\n')
        + (more > 0 ? `\n\n[${more} more match${more > 1 ? 'es' : ''} — narrow the query, `
          + `or vault_read a path above]` : '');
    },
  },

  skill: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Load one of the court\'s named procedures in full — the steps, not the '
      + 'summary. Your prompt lists what exists; this is how you get the body. '
      + 'Load one when it applies to the task in front of you, not to browse: a '
      + 'skill you did not need costs exactly as much as one you did. A combo '
      + 'brings its parts with it in a single call.',
    schema: {
      type: 'object',
      properties: { name: str('e.g. "root-cause", "design:a11y", "design-site"') },
      required: ['name'],
    },
    run: ({ name }) => {
      const s = composeSkill(VAULT, name);
      if (!s) {
        const near = listSkills(VAULT).map((x) => x.name);
        return `No skill named "${name}". The court has: ${near.join(', ')}`;
      }
      return `# skill: ${s.name}\n${s.description ? `_${s.description}_\n` : ''}`
        + `${s.parts.length ? `_combo — includes ${s.parts.join(', ')}_\n` : ''}\n${s.text}`;
    },
  },

  skill_save: {
    roles: ['orchestrator', 'briefer', 'peasant'],
    description:
      'Write a new named procedure into the court skill set, or replace one. A '
      + 'skill is a METHOD followed the same way every time — not knowledge '
      + '(that is remember) and not a standing rule (those are the sovereign '
      + 'Court Instructions). Write one when you have just worked out how to do '
      + 'something the court will do again, and the steps mattered.',
    schema: {
      type: 'object',
      properties: {
        name: str('Lowercase kebab, e.g. "ship-migration". One colon makes it a pack: "design:a11y".'),
        description: str('One line: WHEN to reach for this. It is the only part every member carries.'),
        body: str('Markdown. The steps, in the order they are actually done.'),
      },
      required: ['name', 'description', 'body'],
    },
    run: ({ name, description, body }) => {
      if (!VAULT) return 'No vault is configured for this kingdom, and skills live in it.';
      const slugged = slugSkill(name);
      if (!slugged) return `"${name}" leaves nothing usable as a skill name. Nothing was written.`;

      // Under Kingdom/Skills/ because that is where skills.js reads them from,
      // and NOT through vault_write: that tool puts the note in the folder the
      // MODE chooses and strips '/' out of the title, so no member could ever
      // land a file here. A court told it may extend itself, in a Build mode
      // whose own blurb says "skills, notes, instructions", could not write one.
      const dir = join(VAULT, VAULT_WRITE_DIR, SKILLS_DIR);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${slugged}.md`);
      const replaced = existsSync(file);

      // Frontmatter first: skills.js reads name and description out of it, and
      // a skill without them is invisible to the index every member carries.
      writeFileSync(file,
        `---\nname: ${slugged}\ndescription: ${String(description).replace(/\r?\n/g, ' ').trim()}\n---\n`
        + `# ${slugged}\n${body}\n`);
      noteWritten(VAULT, file);
      mirrorToProject(MIRROR_REPO, VAULT, file);

      // A shipped skill of the same name is now shadowed — the vault wins on a
      // collision by design, but silently overriding one is not a thing to
      // discover later.
      const shadows = !replaced
        && listSkills(VAULT).some((s) => s.name === slugged && s.source === 'builtin');

      return `Saved ${VAULT_WRITE_DIR}/${SKILLS_DIR}/${slugged}.md.`
        + (replaced ? ' It replaced the previous version.' : '')
        + (shadows ? ' It now overrides the skill the court ships under that name.' : '')
        + ` You can load it right now with skill("${slugged}"); everyone else picks it up `
        + 'in their index when they next start.';
    },
  },

  vault_read: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Read a vault note by the path vault_search gave. Small notes come back '
      + 'whole. For a LARGE note you get its headings and are asked which one you '
      + 'want — pass "section" to get just that part. Everything you read stays in '
      + 'your context for the rest of your life, so read the section, not the note.',
    schema: {
      type: 'object',
      properties: {
        path: str('e.g. "References/Model Guidance.md"'),
        section: str('Optional heading to read, e.g. "Effort levels". Partial matches work.'),
      },
      required: ['path'],
    },
    run: ({ path, section }) => {
      if (!VAULT) return 'No vault is configured for this kingdom.';
      const abs = insideVault(path);
      if (!abs || !existsSync(abs)) return `No such note: ${path}`;
      const body = readFileSync(abs, 'utf8');

      // The escape hatch has to be checked BEFORE the heading lookup, or "*"
      // is treated as a heading nobody has and the member can never opt out.
      const whole = () => (body.length > 20000 ? `${body.slice(0, 20000)}\n[truncated]` : body);
      if (section === '*') return whole();

      if (section) {
        const hit = noteSection(body, section);
        if (hit) return `# ${path} — ${hit.title}\n\n${hit.text}`;
        const names = noteOutline(body).map((h) => h.title);
        return `No section matching "${section}" in ${path}.`
          + (names.length ? ` It has: ${names.join(' | ')}` : ' It has no headings.');
      }

      // 97% of this vault's notes are sectioned, and a p90 note costs ~3,000
      // tokens read whole against ~320 for one section — for the rest of the
      // member's session, on every turn. So a large note answers with its shape
      // and lets the member ask for the part it actually needs.
      if (body.length > NOTE_WHOLE_LIMIT) {
        const outline = noteOutline(body).filter((h) => h.level <= 3);
        if (outline.length >= 2) {
          return `${path} is ${body.length} characters — too much to put in your context whole.\n\n`
            + `Sections:\n${outline.map((h) => `  ${'  '.repeat(h.level - 1)}${h.title}  (${h.chars} chars)`).join('\n')}\n\n`
            + `Call vault_read again with section:"<heading>" for the part you need. `
            + `Pass section:"*" if you genuinely need the whole note.`;
        }
      }
      // Small, or large but unsectioned — there is nothing better to offer.
      return whole();
    },
  },

  vault_write: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      `Record something DURABLE in the sovereign's vault — a decision and its ` +
      `reasoning, a gotcha discovered the hard way, a convention worth keeping. ` +
      `Not a progress update and not chatter; those belong on the bus. Notes are ` +
      `visible to the whole court and to future sessions. Use [[wikilinks]] to ` +
      `connect to existing notes.`,
    schema: {
      type: 'object',
      properties: {
        title: str('Short note title; becomes the filename'),
        body: str('Markdown. Use [[wikilinks]] to related notes.'),
        links: { type: 'array', items: { type: 'string' }, description: 'Notes to link (optional)' },
        append: { type: 'boolean', description: 'Append to an existing note rather than replace' },
      },
      required: ['title', 'body'],
    },
    run: ({ title, body, links = [], append = false }) => {
      if (!VAULT) return 'No vault is configured for this kingdom.';
      // The FOLDER is the mode's, not a slug the model has to spell right.
      // modeBlock() tells the model its note "goes under Research/" — that was
      // a promise the tool had no way to keep, so a real research turn wrote
      // straight into Kingdom/ instead of Kingdom/Research/ and nobody was
      // told it happened. slug() also strips '/', so even a model that tried
      // to type "Research/Title" as the title would have landed flat anyway.
      const writeSub = modeOf(modeNow()).vaultDir;
      // Two forms on purpose: `join()` for the real path (OS-correct
      // separators), a literal '/' for anything shown back to a member — every
      // other vault path in this file and in modeBlock() is written with '/'.
      const writeDirRel = writeSub ? `${VAULT_WRITE_DIR}/${writeSub}` : VAULT_WRITE_DIR;
      const dir = writeSub ? join(VAULT, VAULT_WRITE_DIR, writeSub) : join(VAULT, VAULT_WRITE_DIR);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${slug(title)}.md`);
      const linkLine = links.length ? `\nRelated: ${links.map((l) => `[[${l}]]`).join(' ')}\n` : '';
      const stamp = new Date().toISOString().slice(0, 10);

      // The search corpus is cached, so a note written here would not be
      // findable until the cache revalidated. Drop it: what the court just
      // recorded must be searchable by the very next call.
      if (append && existsSync(file)) {
        writeFileSync(file, readFileSync(file, 'utf8') + `\n\n---\n*${ME} · ${stamp}*\n${body}${linkLine}`);
        noteWritten(VAULT, file);
        mirrorToProject(MIRROR_REPO, VAULT, file);
        return `Appended to ${writeDirRel}/${slug(title)}.md`;
      }
      writeFileSync(file, `*Recorded by ${ME} · ${stamp}*\n\n${body}${linkLine}`);
      noteWritten(VAULT, file);
      mirrorToProject(MIRROR_REPO, VAULT, file);
      return `Saved to ${writeDirRel}/${slug(title)}.md`;
    },
  },

  remember: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      `Record ONE durable fact the court should not have to learn twice — a ` +
      `gotcha found the hard way, a convention, a decision and its reasoning, ` +
      `a tool that does not behave as documented. Every member is given the ` +
      `TITLES of all memories on every spawn, so a good title is the whole ` +
      `point: write it as the fact itself ("flutter test, not dart test, for ` +
      `Flutter repos"), never as a topic ("testing notes"). NOT for progress, ` +
      `status, or anything true only today — that is what the bus is for.`,
    schema: {
      type: 'object',
      properties: {
        title: str('The fact itself, in one line. This is what every member sees.'),
        body: str('Why it is true and what to do about it. Keep it short.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['title', 'body'],
    },
    run: ({ title, body, tags = [] }) => {
      if (!VAULT) return 'No vault is configured for this kingdom, so there is nowhere to remember.';
      try {
        const at = remember(VAULT, { title, body, tags, by: ME, dir: VAULT_WRITE_DIR });
        noteWritten(VAULT, join(VAULT, at));   // searchable by the next call
        mirrorToProject(MIRROR_REPO, VAULT, join(VAULT, at));
        return `Remembered: ${at}`;
      } catch (e) {
        return `Could not remember that: ${e.message}`;
      }
    },
  },

  read_diff: {
    roles: ['orchestrator', 'briefer'],
    description:
      'Read a peasant\'s ACTUAL changes against the base branch. Call this when ' +
      'the briefer\'s digest is vague, surprising, or claims something you want ' +
      'to confirm before merging — do not approve a merge on a summary alone if ' +
      'anything looks off. Omit "file" for the whole diff, or name one file to ' +
      'inspect it closely without pulling everything into your context.',
    schema: {
      type: 'object',
      properties: {
        peasant: str('Whose branch to inspect'),
        file: str('A single path to limit the diff to (optional)'),
      },
      required: ['peasant'],
    },
    run: async ({ peasant, file }) => {
      const base = bus.get('base');
      if (!base) return 'The base branch is unknown; the kingdom may not be fully started.';
      const [stat, diff] = await Promise.all([
        statOf(REPO, peasant, base),
        diffOf(REPO, peasant, base, file ?? null),
      ]);
      if (!diff.trim()) return `"${peasant}" has no committed changes against ${base}.`;
      const body = diff.length > DIFF_LIMIT
        ? diff.slice(0, DIFF_LIMIT) + `\n[truncated at ${DIFF_LIMIT} chars — name a single file to see more]`
        : diff;
      return `FILES CHANGED:\n${stat}\n\nDIFF${file ? ` (${file})` : ''}:\n${body}`;
    },
  },

  assign: {
    roles: ['orchestrator'],
    description: 'Assign a task. Be specific about scope and done-criteria.',
    schema: {
      type: 'object',
      properties: { to: str('Peasant name'), task: str('The assignment') },
      required: ['to', 'task'],
    },
    run: ({ to, task }) => {
      const target = JSON.parse(bus.get('roster') ?? '[]').find((member) => member.name === to);
      const summoned = JSON.parse(bus.get('summoned') ?? '[]');
      if (target?.role === 'peasant' && !summoned.includes(to)) {
        return `Cannot assign to ${to}: peasant is not summoned.`;
      }
      bus.post(ME, to, task, 'assignment');
      return `Assigned to ${to}.`;
    },
  },

  // --- the shared task list --------------------------------------------
  // An assignment is a message: it is sent, and then it is gone. Nothing could
  // answer "what is still outstanding", so an assignment a peasant dropped on
  // the floor left no trace anywhere. These four put the work itself on the
  // bus, where the sovereign can see it and an idle member can pick it up.

  add_task: {
    roles: ['orchestrator'],
    description:
      'Put a unit of work on the shared list. Size it so it has ONE clear deliverable — a function, '
      + 'a test file, a review. Too small and the coordination costs more than the work; too large and '
      + 'nobody checks in until it has gone wrong. Use needs for real ordering only: a task waits until '
      + 'everything it needs is done, so a false dependency idles a peasant for nothing.',
    schema: {
      type: 'object',
      properties: {
        title: str('The deliverable, in one line'),
        detail: str('Scope, constraints, and how you will know it is done'),
        needs: {
          type: 'array', items: { type: 'integer' }, maxItems: 20,
          description: 'Task ids that must finish first (optional)',
        },
        require_plan: {
          type: 'boolean',
          description: 'For risky work: the peasant must submit a plan and have it approved before it may finish',
        },
      },
      required: ['title', 'detail'],
    },
    run: ({ title, detail, needs = [], require_plan = false }) => {
      const known = new Set(bus.tasks().map((t) => t.id));
      const missing = needs.filter((n) => !known.has(Number(n)));
      if (missing.length) return `No such task: ${missing.map((n) => `#${n}`).join(', ')}. Nothing was added.`;
      // Capped, because the `tasks` tool's output goes in front of the WHOLE
      // court, on every listing, for as long as the task is open. One verbose
      // orchestrator turn would otherwise put an unbounded string in everyone's
      // context — the same thing memory.js:74 and skills.js:175 cap.
      title = String(title).slice(0, 200);
      detail = String(detail).slice(0, 2000);
      const id = bus.addTask({ title, detail, needs, needsPlan: require_plan, by: ME });
      return `Task #${id} added${needs.length ? `, waiting on ${needs.map((n) => `#${n}`).join(', ')}` : ''}.`;
    },
  },

  tasks: {
    roles: ['orchestrator', 'briefer', 'peasant'],
    description: 'The shared task list: what is outstanding, who holds it, and what is blocked.',
    schema: { type: 'object', properties: {}, required: [] },
    run: () => {
      const all = bus.tasks();
      if (!all.length) return 'The task list is empty.';
      const line = (t) => {
        const who = t.owner ? ` [${t.owner}]` : '';
        const wait = t.blockedBy.length ? ` (waits on ${t.blockedBy.map((n) => `#${n}`).join(', ')})` : '';
        return `#${t.id} ${t.state}${who} ${t.title}${wait}`;
      };
      const open = all.filter((t) => t.state !== 'done');
      const done = all.filter((t) => t.state === 'done');
      return [
        ...(open.length ? ['OPEN', ...open.map(line)] : ['Nothing is outstanding.']),
        ...(done.length ? ['', `DONE (${done.length})`, ...done.map(line)] : []),
      ].join('\n');
    },
  },

  claim_task: {
    roles: ['peasant'],
    description:
      'Take a task off the list. Omit id to take the next available one. Claiming is atomic — if two of '
      + 'you ask at once exactly one gets it, and the other is told who holds it.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Which task (optional)' } },
      required: [],
    },
    run: ({ id = null }) => {
      const r = bus.claimTask(ME, id);
      if (!r.ok) return r.why;
      const t = r.task;
      return t.state === 'planning'
        ? `Claimed #${t.id}: ${t.title}\n\n${t.detail}\n\nThis task requires an approved plan. `
          + `Investigate, then call submit_plan — do NOT change any file until the orchestrator approves it.`
        : `Claimed #${t.id}: ${t.title}\n\n${t.detail}`;
    },
  },

  finish_task: {
    roles: ['peasant'],
    description: 'Mark your task done. Only its owner may, and only once its plan is approved.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Which task' }, summary: str('What you delivered') },
      required: ['id', 'summary'],
    },
    run: ({ id, summary }) => {
      const t = bus.tasks().find((x) => x.id === Number(id));
      if (!t) return `No task #${id}.`;
      if (t.owner !== ME) return `Task #${id} is ${t.owner ?? 'unclaimed'}, not yours.`;
      if (t.state === 'done') return `Task #${id} is already done.`;
      // The plan gate is enforced HERE rather than by asking nicely in the
      // prompt: a member cannot close a risky task by deciding its plan was
      // fine. This is the one boundary the orchestrator actually controls.
      if (t.state === 'planning') {
        return `Task #${id} still needs an approved plan. Call submit_plan and wait for the orchestrator.`;
      }
      bus.updateTask(id, { state: 'done', doneTs: Date.now() });
      const orchestrator = officer('orchestrator', 'orchestrator');
      bus.post(ME, orchestrator, `Task #${id} (${t.title}) done. ${summary}`, 'done');
      const left = bus.tasks().filter((x) => x.state !== 'done').length;
      return `Task #${id} closed. ${left ? `${left} still open — claim_task for the next.` : 'The list is clear.'}`;
    },
  },

  submit_plan: {
    roles: ['peasant'],
    description:
      'Send the orchestrator your approach for a task that requires approval. You stay read-only until it is approved.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Which task' }, plan: str('What you intend to do, and why') },
      required: ['id', 'plan'],
    },
    run: ({ id, plan }) => {
      const t = bus.tasks().find((x) => x.id === Number(id));
      if (!t) return `No task #${id}.`;
      if (t.owner !== ME) return `Task #${id} is not yours.`;
      if (t.state !== 'planning') return `Task #${id} is ${t.state} — it does not need a plan.`;
      bus.updateTask(id, { plan });
      bus.post(ME, officer('orchestrator', 'orchestrator'), `Plan for task #${id} (${t.title}):\n\n${plan}`, 'plan');
      return `Plan sent for #${id}. Do not edit anything until the orchestrator approves it.`;
    },
  },

  rule_on_plan: {
    roles: ['orchestrator'],
    description:
      'Approve or reject a peasant\'s plan. Rejecting keeps them read-only and hands back your notes, so say '
      + 'what would make it acceptable rather than only what is wrong.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Which task' },
        approve: { type: 'boolean', description: 'true to let the work begin' },
        notes: str('Your reasoning, or what must change'),
      },
      required: ['id', 'approve', 'notes'],
    },
    run: ({ id, approve, notes }) => {
      const t = bus.tasks().find((x) => x.id === Number(id));
      if (!t) return `No task #${id}.`;
      if (t.state !== 'planning') return `Task #${id} is ${t.state} — there is no plan pending on it.`;
      if (!t.plan) return `Task #${id} has not submitted a plan yet.`;
      if (approve) bus.updateTask(id, { state: 'active' });
      bus.post(ME, t.owner,
        approve ? `Plan approved for #${id}. Begin. ${notes}`
          : `Plan rejected for #${id}. Revise and submit again — you remain read-only. ${notes}`,
        'assignment');
      return approve ? `#${id} approved; ${t.owner} may begin.` : `#${id} sent back to ${t.owner}.`;
    },
  },

  summon: {
    roles: ['orchestrator'],
    description:
      'Propose the crew to wake. The sovereign approves it and reads your reasoning. Wake the fewest that can do the job.',
    schema: {
      type: 'object',
      properties: {
        names: {
          type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 32,
          uniqueItems: true, description: 'Roster names to wake (up to 32 unique names)',
        },
        reason: str('Why these ones'),
      },
      required: ['names', 'reason'],
    },
    run: ({ names, reason }) => {
      if (!Array.isArray(names) || !names.length) {
        return 'Summon rejected: names must be a non-empty array.';
      }
      if (names.length > 32) {
        return 'Summon rejected: too many names (maximum 32).';
      }
      if (names.some((name) => typeof name !== 'string' || !name.trim())) {
        return 'Summon rejected: names must be non-empty strings.';
      }
      const duplicate = names.find((name, i) => names.indexOf(name) !== i);
      if (duplicate !== undefined) {
        return `Summon rejected: duplicate name: ${duplicate}.`;
      }
      const roster = JSON.parse(bus.get('roster') ?? '[]');
      const known = new Set(roster.map((member) => member.name));
      const unknown = names.filter((name) => !known.has(name));
      if (unknown.length) {
        return `Summon rejected: unknown roster names: ${unknown.join(', ')}.`;
      }
      bus.post(ME, null, JSON.stringify({ kind: 'summon', names, reason }), 'approval');
      return 'Proposal sent to the sovereign. Wait for approval before assigning work.';
    },
  },

  goal: {
    roles: ['orchestrator', 'briefer', 'peasant'],
    description:
      'The court\'s standing goal and its milestones. Read it when you are '
      + 'unsure whether a piece of work is worth doing.',
    schema: { type: 'object', properties: {} },
    run: () => {
      const raw = bus.get('goal');
      if (!raw) return 'No standing goal. The court works on whatever the sovereign last asked.';
      const g = JSON.parse(raw);
      return `GOAL: ${g.text}\n`
        + (g.milestones ?? []).map((m, i) => `  ${i}. [${m.done ? 'x' : ' '}] ${m.text}`).join('\n');
    },
  },

  milestone_done: {
    // The orchestrator judges completion — it is the one that reviews the work. A
    // peasant marking its own milestone done is the same failure as a peasant
    // declaring its own tests passed.
    roles: ['orchestrator'],
    description:
      'Mark one of the standing goal\'s milestones finished, by its index from '
      + 'the goal tool. Only do this once you have SEEN the evidence.',
    schema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Milestone index, as shown by the goal tool' },
        evidence: str('What convinced you it is done — a diff, a test result, a merge'),
      },
      required: ['index', 'evidence'],
    },
    run: ({ index, evidence }) => {
      const raw = bus.get('goal');
      if (!raw) return 'There is no standing goal.';
      const g = JSON.parse(raw);
      if (!g.milestones?.[index]) return `No milestone at index ${index}.`;
      // Written to the bus, not to the config: the orchestrator owns the config
      // and watches this key, so there is one writer and no lost update.
      bus.post(ME, 'orchestrator', JSON.stringify({ index, evidence }), 'milestone');
      return `Recorded milestone ${index} ("${g.milestones[index].text}") as done.`;
    },
  },

  propose_role: {
    roles: ['orchestrator'],
    description:
      'Propose a brand-new kind of peasant to add to the roster permanently. ' +
      'Requires the sovereign\'s approval.',
    schema: {
      type: 'object',
      properties: {
        name: str('Short lowercase name, e.g. "security-auditor"'),
        prompt: str('The system prompt defining this role'),
        cli: str('"claude" or "codex"'),
        model: str('Model name (optional)'),
        reason: str('Why the kingdom needs it'),
      },
      required: ['name', 'prompt', 'cli', 'reason'],
    },
    run: (spec) => {
      // Refused HERE as well as at approve(), because the orchestrator can act on this
      // answer — a rejection at the approval boundary is a card the sovereign
      // has to read and dismiss, hours later, with no way to tell the orchestrator why.
      const err = badRole(spec, { taken: rosterNow().map((m) => m.name) });
      if (err) return `${err} Nothing was proposed.`;
      bus.post(ME, null, JSON.stringify({ kind: 'role', ...spec }), 'approval');
      return 'Role proposed. Await the sovereign\'s decision.';
    },
  },

  ask_question: {
    roles: ['orchestrator', 'briefer', 'peasant'],
    description:
      'Ask the sovereign one or more structured, multiple-choice questions when you are blocked ' +
      'on a decision only they can make. Returns immediately — the answer arrives later as a bus ' +
      'message. Do not use for anything you can reasonably decide yourself.',
    schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: str('The full question'),
              header: str('Very short label, under 12 chars, e.g. "Auth method"'),
              multiSelect: { type: 'boolean', description: 'Allow picking more than one option' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: str('Short choice text'),
                    description: str('What this choice means'),
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'header', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    run: ({ questions }) => {
      const err = badQuestions({ questions });
      if (err) return `${err} Nothing was asked.`;
      bus.post(ME, null, JSON.stringify({ kind: 'question', questions }), 'approval');
      return 'Question(s) posted to the sovereign. Their answer will arrive as a bus message — '
        + 'continue other work or end your turn.';
    },
  },

  argue: {
    // The orchestrator only. This is three to five one-shot model calls across two
    // vendors, and it is the orchestrator that owns contested decisions — the same
    // reason summon and propose_role are its alone. A peasant that wants a
    // question settled asks the orchestrator for one.
    roles: ['orchestrator'],
    description:
      'Put a genuinely contested question to the argument court: two different '
      + 'models argue it and a third judges. Returns immediately — the verdict '
      + 'arrives later as a message. Use it where asking two members would just '
      + 'produce one opinion twice; not for anything you can settle yourself.',
    schema: {
      type: 'object',
      properties: {
        question: str('The question, stated so it could honestly be answered either way'),
      },
      required: ['question'],
    },
    run: ({ question }) => {
      const q = String(question ?? '').trim();
      if (!q) return 'Nothing was argued: the question is empty.';
      // The same 4,000-char ceiling the bus puts on a message. A debate is not
      // a document, and argue.js trims each side to 6,000 anyway.
      if (q.length > 4000) {
        return `Nothing was argued: the question is ${q.length} chars, and the limit is 4000. State it shorter.`;
      }
      bus.post(ME, null, JSON.stringify({ question: q }), 'argue');
      return 'Sent to the argument court. The verdict arrives later as a message — '
        + 'do not wait on it, carry on with something else.';
    },
  },
  set_mode: {
    // The orchestrator only. A mode decides who may be summoned, what tools exist and
    // where notes land — it is the shape of the whole court, not one member.
    roles: ['orchestrator'],
    description:
      'Change what shape the court is in. Do this when the work in front of you '
      + 'is plainly a different KIND of work than the mode allows — a coding job '
      + 'asked for in Chat, a question that wants a research note. Says so to '
      + 'everyone. Code needs a repository attached and comes back refused if '
      + 'there is none, so do not promise the sovereign a switch you have not made yet.',
    schema: {
      type: 'object',
      properties: {
        mode: str(`One of: ${MODE_NAMES.join(', ')}`),
        why: str('One line the rest of the court will read. Optional.'),
      },
      required: ['mode'],
    },
    run: ({ mode, why }) => {
      // Checked against the real list, NOT through modeName(): that falls back
      // to DEFAULT_MODE for anything it does not recognise, so a typo would
      // quietly put the whole court into Code mode.
      if (!MODE_NAMES.includes(mode)) {
        return `No such mode: "${mode}". The court has: ${MODE_NAMES.join(', ')}. Nothing changed.`;
      }
      if (mode === modeNow()) return `The court is already in ${modeOf(mode).label} mode.`;
      bus.post(ME, null, JSON.stringify({ op: 'mode', mode, why: why ?? '' }), 'control');
      return 'Asked for the switch. It lands within a second and everyone is told; '
        + 'if it is refused you get a message saying why, so carry on rather than waiting on it.';
    },
  },

  wake_member: {
    roles: ['orchestrator'],
    description:
      'Wake a member that is on the roster but asleep, so it can pick work up '
      + 'again. This is not summoning: it adds nobody, it only restarts someone '
      + 'the sovereign already approved.',
    schema: {
      type: 'object',
      properties: { name: str('A name already on the roster') },
      required: ['name'],
    },
    run: ({ name }) => {
      const known = rosterNow().map((x) => x.name);
      if (!known.includes(name)) {
        return `Nobody on the roster is called "${name}". The court has: ${known.join(', ')}.`;
      }
      bus.post(ME, null, JSON.stringify({ op: 'wake', name }), 'control');
      return `Waking ${name}. You get a message when it is up.`;
    },
  },

  dismiss_member: {
    roles: ['orchestrator'],
    description:
      'Stand a member down when its work is genuinely finished. This is the '
      + 'one cost lever you hold: an idle member still costs a full context '
      + 'replay every time it wakes. It leaves the roster and must be summoned '
      + 'again — with the sovereign approving — to come back, so do not use it '
      + 'to park somebody for a minute.',
    schema: {
      type: 'object',
      properties: {
        name: str('A member currently on the roster'),
        why: str('One line for the record. Optional.'),
      },
      required: ['name'],
    },
    run: ({ name }) => {
      if (name === ME) return 'You cannot stand yourself down. Ask the sovereign.';
      const known = rosterNow().map((x) => x.name);
      if (!known.includes(name)) {
        return `Nobody on the roster is called "${name}". The court has: ${known.join(', ')}.`;
      }
      bus.post(ME, null, JSON.stringify({ op: 'sleep', name }), 'control');
      return `Standing ${name} down.`;
    },
  },

  set_model: {
    roles: ['orchestrator'],
    description:
      'Move a member onto a different model or effort level. Use it when the '
      + 'work and the model are plainly mismatched in either direction — a '
      + 'reasoning model grinding through a rename, or a small one out of its '
      + 'depth. Changing the CLI throws that member session away, so say why in '
      + 'the same breath.',
    schema: {
      type: 'object',
      properties: {
        name: str('A member on the roster'),
        cli: str('claude, codex or agy. Optional — leave it out to keep the current one.'),
        model: str('Model name. Optional — leave it out for that CLI default.'),
        effort: str('Reasoning effort, where the model has one. Optional.'),
      },
      required: ['name'],
    },
    run: ({ name, cli, model, effort }) => {
      const known = rosterNow().map((x) => x.name);
      if (!known.includes(name)) {
        return `Nobody on the roster is called "${name}". The court has: ${known.join(', ')}.`;
      }
      if (!cli && !model && !effort) return 'Nothing to change: name a cli, a model or an effort.';
      bus.post(ME, null, JSON.stringify({ op: 'model', name, cli, model, effort }), 'control');
      return `Asked to move ${name}. You get a message with what it ended up on.`;
    },
  },

  request_merge: {
    roles: ['orchestrator'],
    description:
      'You have reviewed a peasant\'s work and judge it fit. This surfaces a ' +
      'Merge button to the sovereign, who has the final word.',
    schema: {
      type: 'object',
      properties: { peasant: str('Whose worktree'), verdict: str('Your review, for the sovereign') },
      required: ['peasant', 'verdict'],
    },
    run: ({ peasant, verdict }) => {
      bus.post(ME, null, JSON.stringify({ kind: 'merge', peasant, verdict }), 'approval');
      return 'Merge proposed to the sovereign.';
    },
  },

  send_back: {
    roles: ['orchestrator'],
    description: 'Reject a peasant\'s work and send it back with notes on what to fix.',
    schema: {
      type: 'object',
      properties: { peasant: str('Whose work'), notes: str('What must change') },
      required: ['peasant', 'notes'],
    },
    run: ({ peasant, notes }) => {
      const err = badRecipient(peasant);
      if (err) return err;
      bus.post(ME, peasant, `Your work was sent back. ${notes}`, 'assignment');
      return `Sent back to ${peasant}.`;
    },
  },

  // --- automate mode: the orchestrator builds workflows instead of a crew ---

  workflow_list: {
    roles: ['orchestrator'],
    description: 'List every saved automation, with its trigger and node count.',
    schema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const all = await listWorkflows(WORKFLOWS_DIR);
      if (!all.length) return 'No automations saved yet.';
      return all.map((w) =>
        `${w.id} "${w.name}" — trigger:${w.trigger?.type ?? 'manual'}, ${w.nodes?.length ?? 0} nodes` +
        (w.enabled === false ? ' (disabled)' : '')).join('\n');
    },
  },

  workflow_get: {
    roles: ['orchestrator'],
    description: 'Read one automation\'s full node graph and trigger, to edit or debug it.',
    schema: { type: 'object', properties: { id: str('Workflow id') }, required: ['id'] },
    run: async ({ id }) => {
      const wf = (await listWorkflows(WORKFLOWS_DIR)).find((w) => w.id === id);
      return wf ? JSON.stringify(wf, null, 2) : `No workflow "${id}".`;
    },
  },

  workflow_save: {
    roles: ['orchestrator'],
    description:
      'Create or overwrite an automation. Omit id to create a new one; pass an ' +
      'existing id to edit it in place. See the mode instructions for the node ' +
      'and trigger vocabulary.',
    schema: {
      type: 'object',
      properties: {
        id: str('Existing workflow id to overwrite (optional — a new one is generated if omitted)'),
        name: str('Short human name'),
        nodes: {
          type: 'array',
          description: 'The node graph, first entry is the start node',
          items: { type: 'object' },
        },
        trigger: {
          type: 'object',
          description: '{type: "manual"|"interval"|"webhook"|"bus", ...its own config}',
        },
        enabled: { type: 'boolean', description: 'Default true; set false to save without scheduling it' },
      },
      required: ['name', 'nodes', 'trigger'],
    },
    run: async ({ id, name, nodes, trigger, enabled }) => {
      const wf = { id: id || `wf-${Date.now()}`, name, nodes, trigger, ...(enabled === undefined ? {} : { enabled }) };
      await saveWorkflow(WORKFLOWS_DIR, wf);
      return `Saved ${wf.id} "${wf.name}" (trigger: ${wf.trigger?.type}, ${wf.nodes.length} nodes).`;
    },
  },

  workflow_delete: {
    roles: ['orchestrator'],
    description: 'Delete an automation permanently.',
    schema: { type: 'object', properties: { id: str('Workflow id') }, required: ['id'] },
    run: async ({ id }) => {
      await deleteWorkflow(WORKFLOWS_DIR, id);
      return `Deleted ${id}.`;
    },
  },

  workflow_run: {
    roles: ['orchestrator'],
    description: 'Run an automation now, regardless of its trigger, and report what actually happened.',
    schema: { type: 'object', properties: { id: str('Workflow id') }, required: ['id'] },
    run: async ({ id }) => {
      const wf = (await listWorkflows(WORKFLOWS_DIR)).find((w) => w.id === id);
      if (!wf) return `No workflow "${id}".`;
      const result = await runWorkflow(wf, { bus });
      if (bus) logRun(bus, wf, result);
      const lines = result.steps.map((s) => `  ${s.ok ? 'ok' : 'FAIL'} ${s.id}${s.error ? `: ${s.error}` : ''}`);
      return `${result.ok ? 'Succeeded' : 'Failed'} (${result.steps.length} steps):\n${lines.join('\n')}`;
    },
  },
};

/**
 * What shape the court is in, read fresh every time.
 *
 * NOT captured at module load. codex runs one process per turn, but a claude
 * member is one process for its whole life — so a mode flipped an hour into a
 * session would never reach it, and it would keep holding a merge tool that no
 * longer does anything. The bus is the only channel that crosses into a process
 * the orchestrator does not own, and a get is one indexed row.
 */
const modeNow = () => modeName(bus?.get('mode'));

const visible = () =>
  Object.entries(TOOLS).filter(([name, t]) =>
    t.roles.includes(ROLE) && toolAllowed(modeNow(), name));

const server = new Server(
  { name: 'kingdom', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  // No court here means no court tools — an empty list, not a broken server.
  tools: bus ? visible().map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.schema,
  })) : [],
}));

/**
 * Observation masking: never hand a member the same bytes twice.
 *
 * 93% of this court's input tokens are replayed context, so a member that
 * reads a note on turn 3 and again on turn 9 pays for that note on every turn
 * from 3 onward, twice over from 9. The literature on long-horizon tool-using
 * agents finds the same thing and answers it by dropping stale observations
 * from the history (JetBrains measured masking at 50%+ cheaper than an
 * unmanaged agent, and BETTER at the task than LLM summarisation). We cannot
 * edit a CLI's own history — but we own the moment a payload is created, and a
 * payload never created is never replayed.
 *
 * This masks only on a byte-for-byte match, so it can never hide a change: if
 * the note was edited the hash differs and the new text goes through in full.
 *
 * MASK ONCE, THEN RELENT. The hash is deleted as it is used, so a member that
 * asks a third time — because it compacted, or genuinely lost the text — gets
 * the real thing without needing a flag, a schema change, or any idea that
 * masking exists. Self-healing beats correct-in-theory here: the failure this
 * guards against is a member unable to see something it needs.
 *
 * Persisted on the bus rather than in memory because codex runs one process
 * per TURN — an in-memory ledger would forget between the two turns that
 * matter. Cleared when a member is recycled: the successor has a new context
 * and has genuinely not seen any of it.
 */
const MASKABLE = new Set(['vault_read', 'vault_search', 'skill', 'diff', 'stat', 'read_file']);
const MASK_MIN = 400;    // below this the placeholder costs about what the payload does
const MASK_KEEP = 60;

const digest = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}.${s.length}`;   // length too: 32 bits alone collide
};

function alreadyServed(name, text) {
  // KINGDOM_MASK=0 turns it off: this is the one mechanism here that can make
  // a member see LESS than it asked for, so it needs a switch that does not
  // require a code change to reach — and A/B measuring it needs one too.
  if (process.env.KINGDOM_MASK === '0') return false;
  if (!MASKABLE.has(name) || text.length < MASK_MIN) return false;
  let seen;
  try { seen = JSON.parse(bus.get(`served:${ME}`) || '[]'); } catch { seen = []; }
  if (!Array.isArray(seen)) seen = [];
  const key = digest(text);
  const at = seen.indexOf(key);
  if (at >= 0) seen.splice(at, 1);        // used up: ask again and you get it
  else seen.push(key);
  bus.set(`served:${ME}`, JSON.stringify(seen.slice(-MASK_KEEP)));
  return at >= 0;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // Belt and braces: with no bus we advertise no tools, so nothing should get
  // here — but a client that calls a tool it was never offered must get an
  // answer, not an exception that takes the transport down with it.
  if (!bus) {
    return {
      isError: true,
      content: [{ type: 'text', text:
        'There is no kingdom in this directory, so the court tools are unavailable. '
        + 'Start a kingdom here, or run this from a member\'s worktree.' }],
    };
  }
  const tool = TOOLS[req.params.name];
  if (!tool || !tool.roles.includes(ROLE)) {
    return { isError: true, content: [{ type: 'text', text: `No such tool for ${ROLE}.` }] };
  }
  // The list above is a hint; THIS is the enforcement. A long-lived member holds
  // the tool list it was given at connect, so after a flip it will reach for a
  // tool this mode has withheld — and it must be told why, in a sentence it can
  // act on, rather than have the call quietly succeed.
  if (!toolAllowed(modeNow(), req.params.name)) {
    return { isError: true, content: [{ type: 'text', text:
      `"${req.params.name}" is not available in ${modeOf(modeNow()).label} mode, so nothing `
      + `happened. ${modeOf(modeNow()).blurb}` }] };
  }
  try {
    const out = await tool.run(req.params.arguments ?? {});
    let text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    if (alreadyServed(req.params.name, text)) {
      text = `[unchanged — this is byte-for-byte what ${req.params.name} already gave you `
        + `earlier in this session (${text.length} characters), so it is not repeated here. `
        + `Scroll back to it. If you truly no longer have it, call again and you will get it in full.]`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Failed: ${e.message}` }] };
  }
});

// Deliberately NOT pre-warming the vault corpus here. It was tried: reading
// 9.4MB in parallel is 2.7x faster than serially (821ms -> 305ms), so warming
// at startup looked free. Measured through this server it was a REGRESSION —
// 1,423ms -> 1,809ms for five searches — because a search that arrives before
// the warm finishes does its own synchronous load and the two contend for the
// same disk. The cache alone already turns a warm search into 15ms.
await server.connect(new StdioServerTransport());
