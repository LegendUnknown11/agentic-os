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
import { modeName, modeOf, toolAllowed } from './modes.js';
import { bus, ME, ROLE, modeNow } from './mcp/ctx.js';
import { comms } from './mcp/comms.js';
import { memory } from './mcp/memory.js';
import { repo } from './mcp/repo.js';
import { tasks } from './mcp/tasks.js';
import { approvals } from './mcp/approvals.js';
import { control } from './mcp/control.js';
import { workflows } from './mcp/workflows.js';

// The toolset, assembled from one module per domain.
//
// This was a single 1,200-line object literal. It is spread rather than
// nested so the two consumers below are unchanged: `visible()` still filters
// a flat map by role and mode, and dispatch is still TOOLS[name].
const TOOLS = {
  ...comms,
  ...memory,
  ...repo,
  ...tasks,
  ...approvals,
  ...control,
  ...workflows,
};


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
