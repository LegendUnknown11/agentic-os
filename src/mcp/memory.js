// memory tools. See src/mcp.js for how these reach a member.
import { composeSkill, listSkills, slugSkill, SKILLS_DIR } from '../skills.js';
import { modeOf } from '../modes.js';
import { searchVault, noteWritten, mirrorToProject, noteOutline, noteSection } from '../vault.js';
import { remember } from '../memory.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  VAULT_SEARCH_BUDGET, NOTE_WHOLE_LIMIT, ID, ME, MIRROR_REPO, bus, VAULT, VAULT_WRITE_DIR, insideVault, slug, str, modeNow,
  boundedLimit,
} from './ctx.js';

export const memory = {
  recall: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Search everything said or done in this court, all history, not just ' +
      'recent turns: agent text, tool calls, summaries, and messages.',
    schema: {
      type: 'object',
      properties: {
        query: str('Words to look for, e.g. "auth bug" or a file name'),
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
    run: ({ query, limit = 20 }) => {
      const hits = bus.recall(query, { limit: boundedLimit(limit, 20, 50) });
      if (!hits.length) return `Nothing recalled for "${query}".`;
      return hits.map((h) =>
        `[${new Date(h.ts).toISOString()}] ${h.who} (${h.kind}): ` +
        String(h.text).replace(/\s+/g, ' ').slice(0, 200)).join('\n');
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
      `Propose ONE durable fact the court should not have to learn twice, from a ` +
      `CLOSED sovereign campaign. The sovereign must approve it before it becomes ` +
      `memory. Use campaign_history first; preserve the evidence and never turn a ` +
      `transient status, secret, or unverified failure into a durable instruction. ` +
      `At most three proposals may come from one campaign. A good title is the fact ` +
      `itself ("flutter test, not dart test, for Flutter repos"), never a topic. ` +
      `NOT for progress, status, or anything true only today — that is what the bus is for.`,
    schema: {
      type: 'object',
      properties: {
        campaign: { type: 'integer', description: 'Closed campaign ID from campaign_history' },
        title: str('The fact itself, in one line. This is what every member sees.'),
        body: str('Why it is true and what to do about it. Keep it short.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['campaign', 'title', 'body'],
    },
    run: ({ campaign: id, title, body, tags = [] }) => {
      if (!VAULT) return 'No vault is configured for this kingdom, so there is nowhere to remember.';
      if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
        return 'A memory proposal needs a non-empty title and body.';
      }
      const campaign = bus.campaign(id);
      if (!campaign) return `No campaign #${id}. Call campaign_history with a real closed campaign ID.`;
      if (campaign.current) return `Campaign #${id} is still active. Memories are proposed only after it closes.`;
      if (!bus.takeMemoryProposal(campaign.id)) {
        return `Campaign #${campaign.id} already has its maximum of three memory proposals.`;
      }
      bus.post(ME, null, JSON.stringify({
        kind: 'memory', campaign: campaign.id, title, body, tags,
        // Existing approval cards deliberately render a named subject and a
        // verdict. Keeping those aliases means this policy change does not
        // need a second renderer or a brittle special case in the throne room.
        peasant: title,
        verdict: `Campaign #${campaign.id} — proposed by ${ME}\n\n${body}`,
      }), 'approval');
      return `Memory proposal for campaign #${campaign.id} sent to the sovereign. Nothing was written yet.`;
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
};
