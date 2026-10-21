// Regression test for "database is locked".
//
// The team runs one MCP server process per agent, all writing to the same
// bus. Without `pragma busy_timeout` the second concurrent writer fails
// immediately instead of queueing — which is exactly what killed a
// propose_role call in a live session.
//
//   node test/t-concurrent.js
import { strict as a } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';

const WRITERS = 8;
const PER_WRITER = 40;

const dir = mkdtempSync(join(tmpdir(), 'agenticos-conc-'));
const db = join(dir, 'agenticos.db');
// A file:// URL, not a Windows path — ESM import of "E:\..." is a hard error.
const busPath = new URL('../src/bus.js', import.meta.url).href;

// Each child is a stand-in for one agent's MCP server: open the same db and
// hammer it. They start simultaneously to maximise contention.
const child = (id) => `
import { Bus } from ${JSON.stringify(busPath)};
const b = new Bus(${JSON.stringify(db)});
for (let i = 0; i < ${PER_WRITER}; i++) {
  b.post('agent${id}', null, 'msg ' + i);
  b.logEvent('agent${id}', 'tool', { n: i });
  b.set('cursor:agent${id}', String(i));
}
`;

const results = await Promise.all(
  Array.from({ length: WRITERS }, (_, id) =>
    new Promise((res) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', child(id)],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => res({ code, err }));
    })
  )
);

const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.error(failed[0].err.split('\n').slice(0, 6).join('\n'));
  a.fail(`${failed.length}/${WRITERS} concurrent writers failed — bus is not multi-process safe`);
}
for (const r of results) {
  a.ok(!/database is locked|SQLITE_BUSY/i.test(r.err), `lock contention leaked: ${r.err.slice(0, 200)}`);
}

const bus = new Bus(db);
const total = bus.db.prepare('select count(*) c from messages').get().c;
a.equal(total, WRITERS * PER_WRITER, `every write must land (got ${total})`);
a.equal(bus.db.prepare('select count(*) c from events').get().c, WRITERS * PER_WRITER);

// Ids must be unique and gapless — proof nothing was silently dropped.
const ids = bus.db.prepare('select id from messages order by id').all().map((r) => r.id);
a.equal(new Set(ids).size, ids.length, 'duplicate message ids');
a.equal(ids[ids.length - 1] - ids[0] + 1, ids.length, 'gap in message ids');

bus.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`t-concurrent.js OK — ${WRITERS} processes × ${PER_WRITER} writes, no lock errors`);
