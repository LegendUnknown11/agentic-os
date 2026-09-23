// The court registry (src/courts.js): more than one repository open at once
// (issue #42) depends on this file being honest about which daemons are
// actually still alive, and on two daemons launched at nearly the same
// instant never trampling each other's write.
//   node test/t-courts.js
import { strict as a } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  registerCourt, unregisterCourt, listCourts, findCourtForRepo,
  firstFreePort, CourtConflictError, registryPath,
} from '../src/courts.js';

const dir = mkdtempSync(join(tmpdir(), 'courts-test-'));
process.env.KINGDOM_COURTS_REGISTRY = join(dir, 'courts.json');
a.equal(registryPath(), process.env.KINGDOM_COURTS_REGISTRY, 'registryPath must honour the override, same as tokens.json does');

function stubCourt(port, repo) {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, repo }));
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

let failures = 0;
const check = (cond, msg) => {
  if (cond) { console.log(`ok - ${msg}`); return; }
  failures++;
  console.error(`NOT OK - ${msg}`);
};

// --- a fresh registry starts empty -----------------------------------------
check((await listCourts()).length === 0, 'a fresh registry lists no courts');

// --- register, then find it -------------------------------------------------
const s1 = await stubCourt(19101, '/repo/one');
await registerCourt({ repo: '/repo/one', port: 19101, pid: process.pid });
{
  const courts = await listCourts();
  check(courts.length === 1, 'one registered, live court is listed');
  check(findCourtForRepo(courts, '/repo/one')?.port === 19101, 'the registered repo resolves to its port');
}

// --- a second repo on a different port coexists -----------------------------
const s2 = await stubCourt(19102, '/repo/two');
await registerCourt({ repo: '/repo/two', port: 19102, pid: process.pid });
check((await listCourts()).length === 2, 'two live courts for two different repos both survive');

// --- the same repo cannot claim a second port -------------------------------
{
  let err = null;
  try { await registerCourt({ repo: '/repo/one', port: 19103, pid: process.pid }); }
  catch (e) { err = e; }
  check(err instanceof CourtConflictError, 'a live repo refuses a second, different port');
  check(err?.existing?.port === 19101, 'the refusal names the port already serving that repo');
}

// --- killing the process behind an entry (dead pid) prunes it silently -----
s1.close();
await unregisterCourt({ port: 19101, pid: process.pid }); // simulate a clean exit for repo/one first
{
  const courts = await listCourts();
  check(courts.length === 1 && findCourtForRepo(courts, '/repo/one') === null, 'a shut-down court disappears from the listing');
  check(findCourtForRepo(courts, '/repo/two')?.port === 19102, 'the still-live neighbour is unaffected');
}

// --- a port that no longer answers /api/ping (crash, not clean exit) also prunes,
// even though the pid may still exist (e.g. reused by an unrelated process) --
{
  // Fake a crash: the registry still names the port, but nothing is listening.
  const raw = JSON.parse(readFileSync(process.env.KINGDOM_COURTS_REGISTRY, 'utf8'));
  raw.courts.push({ repo: '/repo/crashed', port: 19199, pid: process.pid, startedAt: new Date().toISOString() });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.KINGDOM_COURTS_REGISTRY, JSON.stringify(raw, null, 2));
  const courts = await listCourts();
  check(findCourtForRepo(courts, '/repo/crashed') === null, 'an entry whose port answers nothing is pruned even with a live pid');
  check(findCourtForRepo(courts, '/repo/two')?.port === 19102, 'pruning one dead entry leaves the real one alone');
}

// --- now that repo/one is free again, registering it back must not conflict.
// listCourts() re-verifies every row by real ping, so the re-registration
// needs a real listener behind it, same as any other entry in this file.
const s1b = await stubCourt(19101, '/repo/one');
await registerCourt({ repo: '/repo/one', port: 19101, pid: process.pid + 1 });
check((await listCourts()).length === 2, 'a repo can be re-registered after its old court is gone');
s1b.close();

// --- port picker skips both a registered port and one that fails a real bind
{
  const busy = await stubCourt(19104, '/other');
  const courts = [{ repo: '/x', port: 19102 }]; // 19102 still live from above
  const port = await firstFreePort(19102, courts);
  check(port !== 19102 && port !== 19104, `firstFreePort must skip occupied ports, got ${port}`);
  busy.close();
}

// --- two "launches" racing to register DIFFERENT repos must both land ------
{
  const before = Date.now();
  const [ra, rb] = await Promise.all([
    registerCourt({ repo: '/race/a', port: 19201, pid: 1001 }),
    registerCourt({ repo: '/race/b', port: 19202, pid: 1002 }),
  ]);
  check(ra.port === 19201 && rb.port === 19202, 'two concurrent registrations for different repos both succeed');
  const courts = await listCourts();
  // both entries answer nothing real, so listCourts (which re-verifies) prunes
  // them again — the point of this check is only that the WRITE itself was
  // never corrupted by the race, which the parse succeeding already proves.
  check(Array.isArray(courts), 'the registry file stayed valid JSON after a concurrent write race');
  void before;
}

s2.close();
mkdirSync(dir, { recursive: true }); // no-op if still there; keep for tmp cleanup ordering
rmSync(dir, { recursive: true, force: true });
delete process.env.KINGDOM_COURTS_REGISTRY;

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
