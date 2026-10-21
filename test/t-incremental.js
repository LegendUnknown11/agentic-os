// Incremental reads. The briefer's tools used to default to `since = 0`, so
// every briefing re-injected the whole history — 182k tokens per read on a
// real agenticos. They must now return only what is new.
//
//   node test/t-incremental.js
import { strict as a } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';

const dir = mkdtempSync(join(tmpdir(), 'agenticos-incr-'));
const db = join(dir, 'agenticos.db');
const bus = new Bus(db);

function call(name, args = {}, agent = 'briefer', role = 'briefer') {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc, encoding: 'utf8',
    env: { ...process.env, AGENTICOS_AGENT: agent, AGENTICOS_ROLE: role, AGENTICOS_DB: db },
  });
  const reply = r.stdout.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m && m.id === 2);
  a.ok(reply, `no reply for ${name}: ${r.stderr.slice(0, 300)}`);
  return reply.result?.content?.[0]?.text ?? '';
}

for (let i = 0; i < 5; i++) {
  bus.post('coder', 'orchestrator', `progress ${i}`);
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
const orchestratorFirst = call('read_bus', {}, 'orchestrator', 'orchestrator');
a.ok(orchestratorFirst.includes('progress 0'), "the orchestrator's cursor is its own, not the briefer's");

// --- the payload is flattened, not raw JSON ---------------------------
a.ok(!first.includes('"payload"'), 'events must be flattened, not raw JSON');

// --- a limit cuts from the OLD end for a cursor read, the NEW end for a
//     snapshot ---------------------------------------------------------
// The dashboard repaints itself from the daemon's snapshot, so `limit` there
// means "the last N". It was cutting the other way, which meant a reload
// replayed the opening of a session and nothing since — indistinguishable, from
// the user's chair, from messages not being saved at all.
for (let i = 0; i < 60; i++) {
  bus.post('coder', 'orchestrator', `line ${i}`);
  bus.logEvent('coder', 'tool', { name: `Tool${i}` });
}

const tailMsgs = bus.history({ limit: 10, tail: true }).map((m) => m.body);
a.equal(tailMsgs.at(-1), 'line 59', 'a tail read must end at the newest message');
a.equal(tailMsgs.length, 10);
a.ok(!tailMsgs.includes('progress 0'), 'a tail read must not return the oldest rows');
a.deepEqual([...tailMsgs].sort((x, y) => Number(x.split(' ')[1]) - Number(y.split(' ')[1])),
  tailMsgs, 'a tail read must still come back oldest-first, ready to append');

const tailEvts = bus.events({ limit: 10, tail: true });
a.equal(tailEvts.at(-1).payload.name, 'Tool59', 'a tail read of events must end at the newest');
a.equal(tailEvts.length, 10);

// ...and the default is unchanged, because a cursor reader that jumped to the
// newest rows would silently skip everything between.
a.equal(bus.history({ limit: 10 })[0].body, 'progress 0',
  'without tail, a limit must still cut from the new end and keep the oldest');
a.equal(bus.history({ since: 0, limit: 3, tail: false }).length, 3);
// The two agree whenever the limit is not actually reached.
a.deepEqual(bus.history({ limit: 100_000 }), bus.history({ limit: 100_000, tail: true }),
  'tail changes which rows are dropped, never their order or content');
// `agent` and `type` still compose with it.
a.equal(bus.history({ limit: 5, tail: true, agent: 'coder' }).at(-1).body, 'line 59');
a.equal(bus.events({ limit: 5, tail: true, type: 'tool' }).at(-1).payload.name, 'Tool59');

// Structured attachment references must survive the bus round-trip separately
// from the display text, so a reload can render real asset links.
const attached = [{ name: 'notes.txt', kind: 'document' }, { name: 'diagram.png', kind: 'image' }];
const attachedId = bus.post('user', 'orchestrator', 'read these', 'assignment', 'attachments', attached);
a.deepEqual(bus.history({ since: attachedId - 1 }).at(-1).attachments, attached,
  'message attachments must persist as structured metadata');

// Existing teams have no attachments column; opening one must migrate it and
// make old rows readable with an empty list rather than dropping the transcript.
const legacyDir = mkdtempSync(join(tmpdir(), 'agenticos-attachments-legacy-'));
const legacyPath = join(legacyDir, 'agenticos.db');
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`create table messages (id integer primary key autoincrement, ts integer not null, sender text not null, recipient text, kind text not null, body text not null);
  create table events (id integer primary key autoincrement, ts integer not null, agent text not null, type text not null, payload text not null);
  create table state (k text primary key, v text not null);`);
legacy.prepare('insert into messages (ts,sender,recipient,kind,body) values (?,?,?,?,?)')
  .run(Date.now(), 'user', 'orchestrator', 'assignment', 'before migration');
legacy.close();
const migrated = new Bus(legacyPath);
a.deepEqual(migrated.history().at(-1).attachments, [],
  'pre-attachment messages must migrate to an empty attachment list');
a.ok(migrated.db.prepare('pragma table_info(messages)').all().some((column) => column.name === 'attachments'),
  'the migration must add messages.attachments');
migrated.close();
try { rmSync(legacyDir, { recursive: true, force: true }); } catch {}

bus.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('t-incremental.js OK — reads are incremental, per-agent, and flattened');
