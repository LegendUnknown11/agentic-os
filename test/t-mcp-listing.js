// Exercise the real handlers with a fake transport and counted storage reads.
import { strict as a } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { modeOf, toolAllowed } from '../src/modes.js';

const source = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8')
  .replace(/^#!.*\r?\n/, '')
  .replace(/^import[\s\S]*?from '[^']+';\r?$/gm, '');
const handlers = new Map();
let mode = 'code', modeReads = 0, schemaReads = 0, runs = 0;
const tool = (roles) => ({
  roles, description: 'A test tool with a stable description.',
  get schema() {
    schemaReads++;
    return { type: 'object', properties: {
      description: { type: 'string', description: 'A '.repeat(100) },
    }, required: [] };
  },
  run: async () => { runs++; return 'ok'; },
});
const comms = {
  send_message: tool(['agent']),
  request_merge: tool(['agent']),
  add: tool(['orchestrator']),
};
const context = {
  Server: class {
    setRequestHandler(schema, handler) { handlers.set(schema, handler); }
    async connect() {}
  },
  StdioServerTransport: class {},
  CallToolRequestSchema: 'call', ListToolsRequestSchema: 'list',
  modeOf, toolAllowed, modeNow: () => { modeReads++; return mode; },
  bus: {}, ME: 'coder', ROLE: 'agent', comms,
  memory: {}, repo: {}, tasks: {}, approvals: {}, control: {}, workflows: {},
  process: { env: { AGENTICOS_MASK: '0' } },
};
await runInNewContext(`(async () => { ${source}\n })()`, context);
const list = handlers.get('list');
const call = (name) => handlers.get('call')({ params: { name } });
const names = (result) => Array.from(result.tools, (t) => t.name);
const readsAtStartup = schemaReads;
a.equal(readsAtStartup, 2, 'hidden roles do not pay schema compaction costs');
modeReads = 0;
const first = await list();
a.deepEqual(names(first), ['send_message', 'request_merge']);
a.equal(first.tools[0].inputSchema.properties.description.type, 'string',
  'an input named description remains a schema object, not a compacted string');
a.ok(first.tools[0].inputSchema.properties.description.description.length <= 72,
  'schema description text is still compacted');
a.equal(modeReads, 1, 'one mode read per list, independent of tool count');
const second = await list();
a.equal(schemaReads, readsAtStartup, 'repeated lists never rebuild schemas');
a.equal(second.tools[0], first.tools[0], 'static descriptors are reused');
mode = 'cowork';
a.deepEqual(names(await list()), ['send_message'], 'mode changes still filter a live server');
modeReads = 0;
const denied = await call('request_merge');
a.equal(denied.isError, true);
a.match(denied.content[0].text, /Cowork/);
a.equal(modeReads, 1, 'denial uses one coherent mode snapshot');
a.equal(runs, 0, 'a previously listed tool cannot bypass a new mode');
a.equal((await call('add')).isError, true, 'role gates still apply');
a.equal((await call('send_message')).content[0].text, 'ok');
a.equal(runs, 1);
context.bus = null;
modeReads = schemaReads = 0;
await runInNewContext(`(async () => { ${source}\n })()`, context);
a.deepEqual(names(await handlers.get('list')()), []);
a.equal(schemaReads, 0, 'a server outside a team does not build tool schemas');
a.equal(modeReads, 0);
a.equal((await call('send_message')).isError, true);
console.log('MCP lists read mode once, reuse schemas, and retain live role/mode gates');

