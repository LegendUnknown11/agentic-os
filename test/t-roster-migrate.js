// A team seeded with the old 107-role roster must upgrade to roster v2 without
// losing anything: no task, message, event or memory, no member with work in
// flight, and no role the user wrote or edited.
//
// The fixture is the real v1 template roster (test/fixtures/roster-v1.json),
// not a hand-made imitation, because the migration decides "untouched" by
// fingerprinting exactly what shipped.
//
//   node test/t-roster-migrate.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgenticOS } from '../src/agenticos.js';
import { Bus } from '../src/bus.js';
import { dbPath, worktreePath } from '../src/worktree.js';
import {
  planRosterMigration, COVERED_BY, NEW_IN_V2, SHIPPED, ROSTER_VERSION,
} from '../src/roster.js';
import { transformText } from '../scripts/rename/transform.mjs';
import { migrateConfig } from '../src/legacy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The fixture is byte-exact v1 data, so it still carries the pre-rename keys;
// a launch renames them (src/legacy.js migrateConfig) before the roster runs.
const v1 = JSON.parse(readFileSync(join(HERE, 'fixtures', 'roster-v1.json'), 'utf8'));
migrateConfig(v1);
const library = JSON.parse(readFileSync(join(HERE, '..', 'roles.json'), 'utf8')).agents;
const renamed = (text) => transformText('roles-library.json', text);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------- every v1 role is classified ---------- */
// A legacy name on neither list would sit on every upgraded team forever with
// nobody having decided it should.
{
  a.equal(v1.agents.length, 107, 'the fixture is the 107-role v1 template');
  for (const p of v1.agents) {
    a.ok(SHIPPED.includes(p.name) || Object.hasOwn(COVERED_BY, p.name),
      `${p.name} is neither on the v2 bench nor mapped to the role that covers it`);
  }
  for (const [old, now] of Object.entries(COVERED_BY)) {
    a.ok(SHIPPED.includes(now), `${old} is mapped to ${now}, which is not on the bench`);
    a.ok(!SHIPPED.includes(old), `${old} is both retired and on the bench`);
  }
  for (const n of NEW_IN_V2) {
    a.ok(!v1.agents.some((p) => p.name === n), `${n} is marked new but v1 shipped it`);
  }
  // roles-library.json keeps every retired body, so nothing written is gone:
  // each is the v1 text exactly as the de-theming codemod rewrites it.
  const kept = JSON.parse(readFileSync(join(HERE, '..', 'roles-library.json'), 'utf8')).agents;
  a.deepEqual(kept.map((r) => r.name).sort(), Object.keys(COVERED_BY).sort(),
    'roles-library.json must hold exactly the retired roles');
  for (const r of kept) {
    const was = v1.agents.find((p) => p.name === r.name);
    a.equal(r.prompt, renamed(was.prompt), `${r.name}'s prompt must be kept verbatim, words renamed`);
    a.equal(r.coveredBy, COVERED_BY[r.name]);
  }
  console.log(`  all ${v1.agents.length} v1 roles classified; ${kept.length} retired bodies kept verbatim`);
}

/* ---------- the pure plan ---------- */
{
  const config = { agentDefaults: v1.agentDefaults, rolesSeeded: true, agents: clone(v1.agents) };
  // The user's hand on three roles: one edited legacy prompt, one chosen
  // model on a bench role, one role of their own.
  config.agents.find((p) => p.name === 'copywriter').prompt = 'MY OWN COPYWRITER';
  config.agents.find((p) => p.name === 'coder').model = 'gpt-5.6-terra';
  config.agents.push({ name: 'my-own', title: 'Mine', description: 'something only this team needs', prompt: 'mine' });

  const busyNow = new Set(['compiler-engineer', 'penetration-tester']);
  const next = planRosterMigration(clone(config), { library, busy: (n) => busyNow.has(n) });
  const names = next.agents.map((p) => p.name);

  a.equal(next.rosterVersion, ROSTER_VERSION);
  for (const n of SHIPPED) a.ok(names.includes(n), `${n} must be on the upgraded bench`);
  a.deepEqual(next.report.added, ['devops-engineer'], 'v1 never shipped devops-engineer, so it is added');
  a.deepEqual(next.rosterRetiring.sort(), ['compiler-engineer', 'penetration-tester'],
    'busy legacy members stay, pending retirement');
  for (const n of busyNow) {
    a.deepEqual(next.agents.find((p) => p.name === n), config.agents.find((p) => p.name === n),
      `${n} has work in flight and must be kept exactly as it was`);
  }
  a.ok(names.includes('copywriter'), 'an edited legacy role is the user\'s and stays');
  a.equal(next.agents.find((p) => p.name === 'copywriter').prompt, 'MY OWN COPYWRITER');
  a.ok(names.includes('my-own'), 'a role the team invented stays');
  a.equal(names.length, SHIPPED.length + 2 + 1 + 1, 'bench + 2 busy + 1 edited + 1 custom');

  // Upgraded in place where untouched; kept where chosen.
  const coder = next.agents.find((p) => p.name === 'coder');
  const shippedCoder = library.find((r) => r.name === 'coder');
  a.equal(coder.prompt, shippedCoder.prompt, 'untouched text is upgraded');
  a.equal(coder.model, 'gpt-5.6-terra', 'a model the user chose is not overwritten');
  const tester = next.agents.find((p) => p.name === 'tester');
  const shippedTester = library.find((r) => r.name === 'tester');
  a.deepEqual([tester.cli, tester.model, tester.effort], [shippedTester.cli, shippedTester.model, shippedTester.effort],
    'an untouched luna/max role moves onto its tier');

  // Retired ones are archived, not deleted.
  const retiredCount = 107 - 17 - busyNow.size - 1; // minus kept names, busy, edited copywriter
  a.equal(next.retiredAgents.length, retiredCount);
  const tax = next.retiredAgents.find((p) => p.name === 'tax-specialist');
  a.equal(tax.retiredFor, 'researcher');
  a.equal(tax.prompt, v1.agents.find((p) => p.name === 'tax-specialist').prompt, 'archived verbatim');

  // A later pass, once the busy pair is idle, retires them and nothing else.
  const later = planRosterMigration({ ...config, ...next, rosterRetiring: next.rosterRetiring }, { library, busy: () => false });
  a.deepEqual(later.report.retired.sort(), ['compiler-engineer', 'penetration-tester']);
  a.deepEqual(later.rosterRetiring, []);
  a.equal(later.retiredAgents.length, retiredCount + 2, 'the archive accumulates, it is not replaced');
  a.deepEqual(later.report.upgraded, [], 'a second pass does not re-upgrade');
  a.equal(planRosterMigration({ ...config, ...later }, { library }), null, 'a current team has nothing to do');

  // A hand-built team that never held operator or build-engineer chose its own
  // bench: it is stamped current and gains nothing.
  const small = planRosterMigration({ rolesSeeded: true, agents: [{ name: 'coder', description: 'mine', prompt: 'mine' }] }, { library });
  a.deepEqual(small.agents.map((p) => p.name), ['coder']);
  a.deepEqual(small.report.added, []);
  a.equal(small.agents[0].prompt, 'mine', 'and its own text is kept');

  // A pending member the user deleted by hand meanwhile is simply dropped from pending.
  const gone = planRosterMigration({
    ...next, agents: next.agents.filter((p) => p.name !== 'compiler-engineer'),
  }, { library, busy: () => true });
  a.deepEqual(gone.rosterRetiring, ['penetration-tester']);
  console.log(`  plan: ${next.report.upgraded.length} upgraded, ${next.retiredAgents.length} archived, 2 kept busy, edits and customs untouched`);
}

/* ---------- a real team, end to end ---------- */
const dir = mkdtempSync(join(tmpdir(), 'agenticos-roster-'));
try {
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo, '--initial-branch=main']);
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  const cfgPath = join(dir, 'agenticos.config.json');
  const read = () => JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({
    agentDefaults: v1.agentDefaults,
    orchestrator: { name: 'orchestrator', cli: 'codex', prompt: 'k' },
    briefer: { name: 'briefer', cli: 'codex', prompt: 'j' },
    agents: v1.agents,
    rolesSeeded: true,
    advisor: { promptEngineer: false, autoModel: false },
    summarizer: { enabled: false },
  }, null, 2));

  // A team mid-flight on the old roster: one member added, one owning an
  // active task, one with an unmerged worktree, one only ever messaged.
  const bus = new Bus(dbPath(repo));
  bus.set('added', JSON.stringify(['compiler-engineer']));
  const taskId = bus.addTask({ title: 'pen test the login', by: 'orchestrator' });
  bus.claimTask('penetration-tester', taskId);
  bus.addTask({ title: 'an unclaimed task', by: 'orchestrator' });
  bus.post('orchestrator', 'tax-specialist', 'what is the VAT rate?');
  bus.post('tax-specialist', 'orchestrator', 'twenty percent');
  bus.logEvent('tax-specialist', 'turn_end', { usage: null });
  const before = {
    messages: bus.db.prepare('select count(*) n from messages').get().n,
    events: bus.db.prepare("select count(*) n from events where type != 'roster_migrated'").get().n,
    tasks: bus.tasks().length,
  };
  bus.close();
  mkdirSync(worktreePath(repo, 'wasm-engineer'), { recursive: true });

  let k = new AgenticOS(repo, cfgPath);
  let cfg = read();
  a.equal(cfg.rosterVersion, ROSTER_VERSION, 'the upgrade is recorded on the config');
  a.deepEqual([...cfg.rosterRetiring].sort(), ['compiler-engineer', 'penetration-tester', 'wasm-engineer'],
    'added, task-owning and worktree-holding members are kept until idle');
  for (const n of cfg.rosterRetiring) a.ok(k.specOf(n), `${n} must still resolve, or its work is stranded`);
  a.equal(k.specOf('tax-specialist'), undefined, 'an idle untouched legacy role is retired');
  a.ok(cfg.retiredAgents.some((p) => p.name === 'tax-specialist'), 'and archived on the config');
  for (const n of SHIPPED) a.ok(k.specOf(n), `${n} must be on the bench`);
  a.equal(k.specOf('tester').effort, library.find((r) => r.name === 'tester').effort);

  // Nothing on the bus was touched; the migration is recorded as one event.
  const after = {
    messages: k.bus.db.prepare('select count(*) n from messages').get().n,
    events: k.bus.db.prepare("select count(*) n from events where type != 'roster_migrated'").get().n,
    tasks: k.bus.tasks().length,
  };
  a.deepEqual(after, before, 'no message, event or task may be lost');
  a.equal(k.bus.task(taskId).owner, 'penetration-tester', 'the in-flight task keeps its owner');
  const logged = k.bus.events({ type: 'roster_migrated' });
  a.equal(logged.length, 1, 'the upgrade leaves one audit event');
  a.deepEqual([...logged[0].payload.pending].sort(), [...cfg.rosterRetiring].sort(),
    'the audit event names who is still pending');
  a.ok(logged[0].payload.retired.includes('tax-specialist'), 'and who was retired');

  // Second launch while still busy: nothing changes.
  k.bus.close();
  const snapshot = read();
  k = new AgenticOS(repo, cfgPath);
  a.deepEqual(read(), snapshot, 'still busy: a relaunch changes nothing');

  // start() restores the saved crew only for names it still knows: the
  // added legacy member must come back into service, not silently vanish.
  // (start() also releases a task held by anybody not in service back to the
  // pool, with a notice; that is the existing orphan rule, not the migration,
  // and it keeps the task, so penetration-tester is idle after it.)
  await k.start();
  a.ok(k.added.has('compiler-engineer'), 'the added legacy member is still in service after start()');
  a.ok(k.bus.task(taskId), 'the in-flight task still exists after start()');
  await k.stop();

  // The work finishes: task done, crew removed, worktree merged away.
  const b2 = new Bus(dbPath(repo));
  b2.updateTask(taskId, { state: 'done' });
  b2.set('added', '[]');
  b2.close();
  rmSync(worktreePath(repo, 'wasm-engineer'), { recursive: true, force: true });

  k = new AgenticOS(repo, cfgPath);
  cfg = read();
  a.equal(cfg.rosterRetiring, undefined, 'nothing left pending');
  for (const n of ['compiler-engineer', 'penetration-tester', 'wasm-engineer']) {
    a.equal(k.specOf(n), undefined, `${n} retires once idle`);
    a.ok(cfg.retiredAgents.some((p) => p.name === n && p.retiredFor === COVERED_BY[n]), `${n} is archived`);
  }
  a.equal(cfg.agents.length, SHIPPED.length, 'an untouched v1 team ends on exactly the v2 bench');
  k.bus.close();

  // And a third launch is a no-op.
  const settled = read();
  k = new AgenticOS(repo, cfgPath);
  a.deepEqual(read(), settled, 'a settled team is never rewritten');
  k.bus.close();
  console.log('  real team: busy members kept until idle, then retired; bus untouched; idempotent');
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

console.log('t-roster-migrate.js OK — an old team upgrades to roster v2 and loses nothing');
