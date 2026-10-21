// The team registry (src/teams.js): more than one repository open at once
// (issue #42) depends on this file being honest about which daemons are
// actually still alive, and on two daemons launched at nearly the same
// instant never trampling each other's write.
//   node test/t-teams.js
import { strict as a } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  registerTeam, unregisterTeam, listTeams, findTeamForRepo,
  firstFreePort, TeamConflictError, registryPath, rowKey, keepLive,
} from '../src/teams.js';

const dir = mkdtempSync(join(tmpdir(), 'teams-test-'));
process.env.AGENTICOS_TEAMS_REGISTRY = join(dir, 'teams.json');
a.equal(registryPath(), process.env.AGENTICOS_TEAMS_REGISTRY, 'registryPath must honour the override, same as tokens.json does');

function stubTeam(port, repo) {
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
check((await listTeams()).length === 0, 'a fresh registry lists no teams');

// --- register, then find it -------------------------------------------------
const s1 = await stubTeam(19101, '/repo/one');
await registerTeam({ repo: '/repo/one', port: 19101, pid: process.pid });
{
  const teams = await listTeams();
  check(teams.length === 1, 'one registered, live team is listed');
  check(findTeamForRepo(teams, '/repo/one')?.port === 19101, 'the registered repo resolves to its port');
}

// --- a second repo on a different port coexists -----------------------------
const s2 = await stubTeam(19102, '/repo/two');
await registerTeam({ repo: '/repo/two', port: 19102, pid: process.pid });
check((await listTeams()).length === 2, 'two live teams for two different repos both survive');

// --- the same repo cannot claim a second port -------------------------------
{
  let err = null;
  try { await registerTeam({ repo: '/repo/one', port: 19103, pid: process.pid }); }
  catch (e) { err = e; }
  check(err instanceof TeamConflictError, 'a live repo refuses a second, different port');
  check(err?.existing?.port === 19101, 'the refusal names the port already serving that repo');
}

// --- killing the process behind an entry (dead pid) prunes it silently -----
s1.close();
await unregisterTeam({ port: 19101, pid: process.pid }); // simulate a clean exit for repo/one first
{
  const teams = await listTeams();
  check(teams.length === 1 && findTeamForRepo(teams, '/repo/one') === null, 'a shut-down team disappears from the listing');
  check(findTeamForRepo(teams, '/repo/two')?.port === 19102, 'the still-live neighbour is unaffected');
}

// --- a port that no longer answers /api/ping (crash, not clean exit) also prunes,
// even though the pid may still exist (e.g. reused by an unrelated process) --
{
  // Fake a crash: the registry still names the port, but nothing is listening.
  const raw = JSON.parse(readFileSync(process.env.AGENTICOS_TEAMS_REGISTRY, 'utf8'));
  raw.teams.push({ repo: '/repo/crashed', port: 19199, pid: process.pid, startedAt: new Date().toISOString() });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.AGENTICOS_TEAMS_REGISTRY, JSON.stringify(raw, null, 2));
  const teams = await listTeams();
  check(findTeamForRepo(teams, '/repo/crashed') === null, 'an entry whose port answers nothing is pruned even with a live pid');
  check(findTeamForRepo(teams, '/repo/two')?.port === 19102, 'pruning one dead entry leaves the real one alone');
}

// --- now that repo/one is free again, registering it back must not conflict.
// listTeams() re-verifies every row by real ping, so the re-registration
// needs a real listener behind it, same as any other entry in this file.
const s1b = await stubTeam(19101, '/repo/one');
// A different, provably LIVE pid: pid+1 was alive only when some unrelated
// process happened to hold it, so this passed or failed by luck of the pool.
await registerTeam({ repo: '/repo/one', port: 19101, pid: process.ppid });
check((await listTeams()).length === 2, 'a repo can be re-registered after its old team is gone');
s1b.close();

// --- port picker skips both a registered port and one that fails a real bind
{
  const busy = await stubTeam(19104, '/other');
  const teams = [{ repo: '/x', port: 19102 }]; // 19102 still live from above
  const port = await firstFreePort(19102, teams);
  check(port !== 19102 && port !== 19104, `firstFreePort must skip occupied ports, got ${port}`);
  busy.close();
}

// --- two "launches" racing to register DIFFERENT repos must both land ------
{
  const before = Date.now();
  const [ra, rb] = await Promise.all([
    registerTeam({ repo: '/race/a', port: 19201, pid: 1001 }),
    registerTeam({ repo: '/race/b', port: 19202, pid: 1002 }),
  ]);
  check(ra.port === 19201 && rb.port === 19202, 'two concurrent registrations for different repos both succeed');
  const teams = await listTeams();
  // both entries answer nothing real, so listTeams (which re-verifies) prunes
  // them again — the point of this check is only that the WRITE itself was
  // never corrupted by the race, which the parse succeeding already proves.
  check(Array.isArray(teams), 'the registry file stayed valid JSON after a concurrent write race');
  void before;
}

// --- the lock is never held across pings ------------------------------------
// Several live-but-unresponsive teams used to be pinged one after another
// INSIDE the lock; four at 1.5s each outlast the 5s stale threshold, so a
// second process could steal a lock that was still in use. The pings now run
// in parallel before the lock is taken.
{
  const hung = [];
  const rows = [];
  for (const port of [19401, 19402, 19403, 19404]) {
    hung.push(await new Promise((r) => { const srv = createServer(() => { /* never answers */ }); srv.listen(port, '127.0.0.1', () => r(srv)); }));
    rows.push({ repo: `/hung/${port}`, port, pid: process.pid, startedAt: new Date().toISOString() });
  }
  writeFileSync(registryPath(), JSON.stringify({ teams: rows }));
  const started = Date.now();
  const listing = listTeams();
  await new Promise((r) => setTimeout(r, 400));
  check(!existsSync(`${registryPath()}.lock`), 'the registry lock is not held while teams are being pinged');
  const after = await listing;
  const elapsed = Date.now() - started;
  check(elapsed < 4000, `four unresponsive teams are pinged in parallel, not in series (${elapsed}ms)`);
  check(after.length === 0, 'unresponsive teams are pruned');
  for (const srv of hung) { srv.closeAllConnections?.(); srv.close(); }
}

// --- one checkout reached through an alias is still ONE repository ---------
// A symlink (or on Windows a junction, 8.3 name or different casing) must not
// let a second team claim a checkout that already has one.
{
  const real = mkdtempSync(join(tmpdir(), 'teams-alias-real-'));
  const alias = join(dir, 'alias-link');
  symlinkSync(real, alias, 'junction');
  const s3 = await stubTeam(19301, real);
  await registerTeam({ repo: real, port: 19301, pid: process.pid });
  let refused = null;
  try { await registerTeam({ repo: alias, port: 19302, pid: process.pid }); } catch (e) { refused = e; }
  check(refused instanceof TeamConflictError, 'a symlinked path to an already-served checkout is refused as the same repository');
  check(findTeamForRepo(await listTeams(), alias)?.port === 19301, 'looking a team up through an alias finds the team serving the real path');
  await unregisterTeam({ port: 19301, pid: process.pid });
  s3.close();
  rmSync(real, { recursive: true, force: true });
}

// --- a verdict applies only to the exact claim it was pinged for ------------
// A live attach (or its rollback) rewrites a row's repo while its port and
// pid stay the same. If that lands between the unlocked ping and the locked
// reread, the old claim's verdict must not decide the new claim's fate.
{
  const pinged = { port: 19401, pid: 4242, repo: '/repo/old' };
  const rewritten = { port: 19401, pid: 4242, repo: '/repo/new' };
  const dead = new Map([[rowKey(pinged), false]]);
  check(keepLive([rewritten], dead).length === 1, 'a claim rewritten after the ping is kept, not dropped on the old claim\'s dead verdict');
  check(keepLive([pinged], dead).length === 0, 'the exact claim that was pinged dead is still dropped');
  const alive = new Map([[rowKey(pinged), true]]);
  check(keepLive([rewritten], alive).length === 1 && rowKey(rewritten) !== rowKey(pinged), 'an alive verdict is keyed to the claim it was pinged for, not reused for a rewritten one');
}

s2.close();
mkdirSync(dir, { recursive: true }); // no-op if still there; keep for tmp cleanup ordering
rmSync(dir, { recursive: true, force: true });
delete process.env.AGENTICOS_TEAMS_REGISTRY;

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
