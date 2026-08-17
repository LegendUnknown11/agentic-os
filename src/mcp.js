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
import { join, resolve, relative, extname } from 'node:path';
import { Bus } from './bus.js';
import { diffOf, statOf } from './worktree.js';
import {
  insideVault as vaultInside, walkVault, invalidateVault, noteWritten, searchVault, noteOutline, noteSection,
} from './vault.js';
import { remember } from './memory.js';
import { composeSkill, listSkills } from './skills.js';

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
const ROLE = process.env.KINGDOM_ROLE ?? ID.role ?? 'peasant'; // peasant | jester | king
const REPO = process.env.KINGDOM_REPO ?? ID.repo ?? process.cwd();
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
 * `declare_done` and `brief_king` used to post to the literal string "king".
 * The king's name is configuration — `kingdom.config.json` has `king.name`,
 * `roleOf()` compares against it, and `#promptFor` tells every member what it
 * is — and delivery is by recipient (`bus.pending(agent)` matches
 * `recipient = ?`). So renaming the king sent every declare_done and every
 * jester briefing to a recipient nobody reads, while the tool still answered
 * "The king has been notified." Silent, and precisely the failure AGENTS.md
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
 * Incremental reads. These tools defaulted to `since = 0`, so every jester
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
    roles: ['peasant', 'jester', 'king'],
    description:
      'Message another member directly by name. Prefer this over waiting on the king.',
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
    roles: ['peasant', 'jester', 'king'],
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
    roles: ['peasant', 'jester', 'king'],
    description: 'Who is in the court, their role, and whether they are awake.',
    schema: { type: 'object', properties: {} },
    run: () => JSON.parse(bus.get('roster') ?? '[]'),
  },

  declare_done: {
    roles: ['peasant'],
    description:
      'Declare your task complete. Tests run automatically and the king reviews your diff.',
    schema: {
      type: 'object',
      properties: { summary: str('What you changed and why') },
      required: ['summary'],
    },
    run: ({ summary }) => {
      const king = officer('king', 'king');
      bus.post(ME, king, summary, 'done');
      return `Declared done. ${king} has been notified; await review.`;
    },
  },

  read_bus: {
    roles: ['jester', 'king'],
    description:
      'New messages since you last looked. King: prefer the jester briefings.',
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

  read_events: {
    roles: ['jester'],
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
    // Raw payloads land in the jester's context verbatim, so flatten each event
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

  brief_king: {
    roles: ['jester'],
    description:
      'Brief the king in plain language. Flag anything blocked, looping or contradictory.',
    schema: { type: 'object', properties: { summary: str('The briefing') }, required: ['summary'] },
    run: ({ summary }) => {
      bus.post(ME, officer('king', 'king'), summary, 'brief');
      return 'Briefing delivered.';
    },
  },

  vault_search: {
    roles: ['peasant', 'jester', 'king'],
    description:
      'Search the sovereign\'s notes (models, conventions, past decisions). ' +
      'Check BEFORE choosing a model, library or approach.',
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
    roles: ['peasant', 'jester', 'king'],
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

  vault_read: {
    roles: ['peasant', 'jester', 'king'],
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
    roles: ['peasant', 'jester', 'king'],
    description:
      `Record something DURABLE in the sovereign's vault — a decision and its ` +
      `reasoning, a gotcha discovered the hard way, a convention worth keeping. ` +
      `Not a progress update and not chatter; those belong on the bus. Notes go ` +
      `under "${VAULT_WRITE_DIR}/" and are visible to the whole court and to ` +
      `future sessions. Use [[wikilinks]] to connect to existing notes.`,
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
      const dir = join(VAULT, VAULT_WRITE_DIR);
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
        return `Appended to ${VAULT_WRITE_DIR}/${slug(title)}.md`;
      }
      writeFileSync(file, `*Recorded by ${ME} · ${stamp}*\n\n${body}${linkLine}`);
      noteWritten(VAULT, file);
      return `Saved to ${VAULT_WRITE_DIR}/${slug(title)}.md`;
    },
  },

  remember: {
    roles: ['peasant', 'jester', 'king'],
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
        return `Remembered: ${at}`;
      } catch (e) {
        return `Could not remember that: ${e.message}`;
      }
    },
  },

  read_diff: {
    roles: ['king', 'jester'],
    description:
      'Read a peasant\'s ACTUAL changes against the base branch. Call this when ' +
      'the jester\'s digest is vague, surprising, or claims something you want ' +
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
    roles: ['king'],
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

  summon: {
    roles: ['king'],
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
    roles: ['king', 'jester', 'peasant'],
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
    // The king judges completion — it is the one that reviews the work. A
    // peasant marking its own milestone done is the same failure as a peasant
    // declaring its own tests passed.
    roles: ['king'],
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
    roles: ['king'],
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
      bus.post(ME, null, JSON.stringify({ kind: 'role', ...spec }), 'approval');
      return 'Role proposed. Await the sovereign\'s decision.';
    },
  },

  request_merge: {
    roles: ['king'],
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
    roles: ['king'],
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
};

const visible = Object.entries(TOOLS).filter(([, t]) => t.roles.includes(ROLE));

const server = new Server(
  { name: 'kingdom', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  // No court here means no court tools — an empty list, not a broken server.
  tools: bus ? visible.map(([name, t]) => ({
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
