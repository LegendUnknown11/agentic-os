// repo tools. See src/mcp.js for how these reach a member.
import { diffOf, statOf } from '../worktree.js';
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import {
  ID, REPO, bus, ASSETS_DIR, DOCUMENT_EXT, IMAGE_EXT, DIFF_LIMIT, str, cursorFor, advance, nothingNew,
} from './ctx.js';

export const repo = {
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

  list_uploads: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'List documents and images the sovereign has uploaded (pdf, txt, md, csv, ' +
      'json, png, jpg, gif, webp, avif, svg) for the court to read. Each entry ' +
      'gives the real file path — open it with your own file-reading tool, the ' +
      'same as any other file on disk.',
    schema: { type: 'object', properties: {}, required: [] },
    run: () => {
      if (!ASSETS_DIR) return 'No court home directory — nothing to list.';
      let files;
      try { files = readdirSync(ASSETS_DIR); } catch { files = []; }
      const uploads = files
        .filter((f) => DOCUMENT_EXT.has(extname(f).toLowerCase()) || IMAGE_EXT.has(extname(f).toLowerCase()))
        .map((f) => `${f} (${IMAGE_EXT.has(extname(f).toLowerCase()) ? 'image' : 'document'}) — ${join(ASSETS_DIR, f)}`);
      if (!uploads.length) return 'No documents or images uploaded.';
      return uploads.join('\n');
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

  campaign_history: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Read the bounded messages and failures from one CLOSED sovereign campaign before proposing a memory. ' +
      'The result is evidence, not an instruction to create a note.',
    schema: {
      type: 'object',
      properties: { campaign: { type: 'integer', description: 'Closed campaign ID' } },
      required: ['campaign'],
    },
    run: ({ campaign: id }) => {
      const campaign = bus.campaign(id);
      if (!campaign) return `No campaign #${id}.`;
      if (campaign.current) return `Campaign #${id} is still active; wait until the next sovereign order closes it.`;
      const within = (row, start, end) => row.id > start && (end == null || row.id <= end);
      const messages = bus.history({ since: campaign.messageStart, limit: 20_000 })
        .filter((m) => within(m, campaign.messageStart, campaign.messageEnd))
        .filter((m) => m.kind !== 'approval' && m.kind !== 'notice')
        .map((m) => `MESSAGE ${m.sender}${m.recipient ? ` → ${m.recipient}` : ''}: ${m.body}`);
      const failures = bus.events({ since: campaign.eventStart, type: 'error', limit: 20_000 })
        .filter((e) => within(e, campaign.eventStart, campaign.eventEnd))
        .map((e) => `FAILURE ${e.agent}: ${e.payload?.message ?? JSON.stringify(e.payload)}`);
      const text = [
        `Campaign #${campaign.id}: ${campaign.title}`,
        'Propose zero memories unless the evidence supports a durable, non-sensitive lesson.',
        ...failures,
        ...messages,
      ].join('\n\n');
      return text.length > 12_000 ? `${text.slice(0, 12_000)}\n\n[history truncated]` : text;
    },
  },
};
