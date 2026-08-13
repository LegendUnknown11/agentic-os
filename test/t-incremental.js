// Incremental reads. The jester's tools used to default to `since = 0`, so
// every briefing re-injected the whole history — 182k tokens per read on a
// real kingdom. They must now return only what is new.
//
//   node test/t-incremental.js
import { strict as a } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-incr-'));
const db = join(dir, 'kingdom.db');
const bus = new Bus(db);

function call(name, args = {}, agent = 'jester', role = 'jester') {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc, encoding: 'utf8',
    env: { ...process.env, KINGDOM_AGENT: agent, KINGDOM_ROLE: role, KINGDOM_DB: db },
  });
  const reply = r.stdout.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m && m.id === 2);
  a.ok(reply, `no reply for ${name}: ${r.stderr.slice(0, 300)}`);
  return reply.result?.content?.[0]?.text ?? '';
}

for (let i = 0; i < 5; i++) {
  bus.post('coder', 'king', `progress ${i}`);
  bus.logEvent('coder', 'tool', { name: `Edit${i}` });
}

// --- first read sees everything ---------------------------------------
const first = call('read_events');
a.ok(first.includes('Edit0') && first.includes('Edit4'), 'first read must see all events');

// --- second read sees NOTHING (this is the whole point) ---------------
const second = call('read_events');
a.match(second, /Nothing new/i, `second read must be empty, got: ${second.slice(0, 120)}`);

// --- only genuinely new events come back ------------------------------
bus.logEvent('coder', 'tool', { name: 'EditFRESH' });
const third = call('read_events');
a.ok(third.includes('EditFRESH'), 'new events must arrive');
a.ok(!third.includes('Edit0'), 'old events must NOT be re-sent');

// --- the same applies to the message log ------------------------------
const bus1 = call('read_bus');
a.ok(bus1.includes('progress 0'), 'first bus read sees history');
a.match(call('read_bus'), /Nothing new/i, 'second bus read must be empty');

// --- an explicit `since` still allows a deliberate look back ----------
const back = call('read_events', { since: 0 });
a.ok(back.includes('Edit0'), 'explicit since must override the cursor');
// ...and must not disturb where the agent had got to
bus.logEvent('coder', 'tool', { name: 'EditAFTER' });
const after = call('read_events');
a.ok(after.includes('EditAFTER'), 'cursor must still work after a look back');
a.ok(!after.includes('Edit0'), 'a look back must not reset the cursor');

// --- cursors are per agent --------------------------------------------
const kingFirst = call('read_bus', {}, 'king', 'king');
a.ok(kingFirst.includes('progress 0'), "the king's cursor is its own, not the jester's");

// --- the payload is flattened, not raw JSON ---------------------------
a.ok(!first.includes('"payload"'), 'events must be flattened, not raw JSON');

bus.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('t-incremental.js OK — reads are incremental, per-agent, and flattened');
