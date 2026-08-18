// The standing court. roles.json is a SEED, not a live merge — the dangerous
// version of this feature is one where deleting a role you do not want
// resurrects it on the next launch, forever.
//
//   node test/t-roles.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kingdom } from '../src/kingdom.js';
import { MODES } from '../src/modes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kingdom-roles-'));
const repo = join(dir, 'repo');
execFileSync('git', ['init', '-q', repo, '--initial-branch=main']);
execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
writeFileSync(join(repo, 'a.txt'), 'x\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

const cfgPath = join(dir, 'kingdom.config.json');
const base = {
  peasantDefaults: { cli: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
  orchestrator: { name: 'orchestrator', cli: 'codex', prompt: 'k' },
  briefer: { name: 'briefer', cli: 'codex', prompt: 'j' },
  peasants: [{ name: 'coder', cli: 'claude', model: 'opus', prompt: 'MY OWN CODER' }],
};
const write = (o) => writeFileSync(cfgPath, JSON.stringify(o, null, 2));
const read = () => JSON.parse(readFileSync(cfgPath, 'utf8'));
const library = JSON.parse(readFileSync(join(HERE, '..', 'roles.json'), 'utf8')).peasants;

/* ---------- the library is coherent ---------- */
a.ok(library.length >= 10, `a kingdom needs a real bench, got ${library.length}`);
const names = library.map((r) => r.name);
a.equal(new Set(names).size, names.length, 'duplicate role names');
for (const r of library) {
  a.ok(r.name && /^[a-z][a-z-]*$/.test(r.name), `bad role name: ${r.name}`);
  a.ok(r.description?.length > 30, `${r.name} needs a description the orchestrator can choose from`);
  a.ok(r.prompt?.length > 80, `${r.name} needs a real prompt`);
  a.ok(r.title, `${r.name} needs a court title`);
}
console.log(`  library: ${library.length} specialists — ${names.join(', ')}`);

/* ---------- every mode's crew is drawn from that library ---------- */
// A typo in a crew list is not a crash: canSummon just refuses everybody with
// that name, so the mode quietly offers a bench one member short and the orchestrator
// is told "not on the Research bench" about a role that was meant to be on it.
for (const [mode, m] of Object.entries(MODES)) {
  if (m.crew === 'all') continue;
  for (const n of m.crew) {
    a.ok(names.includes(n), `${mode}'s crew names "${n}", which no role in roles.json provides`);
  }
}
console.log('  every mode crews from roles that actually exist');

/* ---------- first run seeds ---------- */
write(base);
let k = new Kingdom(repo, cfgPath);
let cfg = read();
a.equal(cfg.rolesSeeded, true, 'seeding must be recorded');
a.equal(cfg.peasants.length, library.length, 'every library role should be present exactly once');

// the sovereign's own entry must WIN over the library's
const coder = cfg.peasants.find((p) => p.name === 'coder');
a.equal(coder.prompt, 'MY OWN CODER', 'a configured role must not be overwritten by the library');
a.equal(coder.model, 'opus', 'nor its model');

// library roles inherit peasantDefaults
const refactoringEngineer = cfg.peasants.find((p) => p.name === 'refactoring-engineer');
a.equal(refactoringEngineer.cli, 'codex', 'library roles take the court default cli');
a.equal(refactoringEngineer.model, 'gpt-5.6-luna', 'and the default model');
a.ok(refactoringEngineer.prompt.length > 80, 'and keep their own prompt');
console.log(`  seeded ${cfg.peasants.length}; coder kept the sovereign's prompt`);
k.bus.close();

/* ---------- second run changes nothing ---------- */
k = new Kingdom(repo, cfgPath);
a.deepEqual(read(), cfg, 'a second launch must not touch the config');
k.bus.close();
console.log('  second launch: no change');

/* ---------- a deleted role STAYS deleted ---------- */
cfg = read();
cfg.peasants = cfg.peasants.filter((p) => p.name !== 'strategist');
write(cfg);
k = new Kingdom(repo, cfgPath);
a.equal(read().peasants.find((p) => p.name === 'strategist'), undefined,
  'a role the sovereign deleted must not come back');
k.bus.close();
console.log('  deleted role stayed deleted');

/* ---------- the orchestrator is told what each specialist is for ---------- */
k = new Kingdom(repo, cfgPath);
const prompt = k.briefFor('orchestrator');
for (const n of ['refactoring-engineer', 'architect', 'fact-checker', 'devops-engineer']) {
  a.ok(prompt.includes(n), `the orchestrator's brief must name ${n}`);
}
a.ok(prompt.includes('Master of Works'), 'court titles should reach the orchestrator');
a.ok(/refactor/i.test(prompt), "and enough detail to pick the refactoring-engineer over the coder");
k.bus.close();
console.log('  orchestrator briefed on the whole bench');

/* ---------- the build doctrine reaches EVERY worker, not 14 copies ---------- */
// One block on the shared peasant prompt, so a role added later cannot start
// out exempt from it. The orchestrator gets the enforcement half instead: it judges
// the work, so it is the one that must refuse an untested done-report.
{
  k = new Kingdom(repo, cfgPath);
  const workers = read().peasants.map((p) => p.name);
  a.ok(workers.length >= 3, 'sanity: there should be a bench to check');
  for (const n of workers) {
    const b = k.briefFor(n);
    a.match(b, /TESTS ARE PART OF THE WORK/, `${n} must be told to ship tests`);
    a.match(b, /SMALL, INDEPENDENT MODULES/, `${n} must be told to keep modules small`);
    a.match(b, /SMALLEST THING THAT WORKS/, `${n} must be told to iterate in slices`);
    a.match(b, /NO FAKE COMPLETION/, `${n} must be told not to fake done`);
  }
  const orchestrator = k.briefFor('orchestrator');
  a.match(orchestrator, /UNVERIFIED/, 'the orchestrator must be told an untested done-report is unverified');
  a.match(orchestrator, /send_back/, 'and what to do about it');
  a.ok(!/TESTS ARE PART OF THE WORK/.test(orchestrator),
    'but the orchestrator does not write code, so it gets the enforcement half only');
  k.bus.close();
  console.log(`  build doctrine on all ${workers.length} workers; orchestrator enforces it`);
}

/* ---------- domain presets move a whole side of the stack at once ---------- */
{
  k = new Kingdom(repo, cfgPath);
  await k.start();

  const d = k.domains();
  a.ok(d.frontend.length && d.backend.length, 'both domains must have members');
  for (const n of d.frontend) a.ok(!d.backend.includes(n), `${n} must not be in both domains`);
  // Cross-cutting roles follow the work, not a layer; sweeping them with a
  // layer choice puts a reviewer on a model nobody chose for it.
  for (const n of ['tester', 'reviewer', 'fact-checker']) {
    a.ok(!d.frontend.includes(n) && !d.backend.includes(n), `${n} must be in neither domain`);
  }

  // Snapshot the other side FIRST: this fixture already pins coder to
  // claude/opus, so "is not opus" would pass for the wrong reason. The property
  // that matters is that the sweep did not touch it at all.
  const before = Object.fromEntries(d.frontend.map((n) =>
    [n, `${k.specOf(n).cli}:${k.specOf(n).model}:${k.specOf(n).effort}`]));

  const r = await k.setDomainModel('backend', { cli: 'claude', model: 'opus' });
  a.deepEqual(r.applied, d.backend, 'every backend member must be moved');
  for (const n of d.backend) {
    a.equal(k.specOf(n).cli, 'claude', `${n} must be on the new CLI`);
    a.equal(k.specOf(n).model, 'opus');
  }
  // ...and the other side is untouched, which is the whole point of a domain.
  for (const n of d.frontend) {
    a.equal(`${k.specOf(n).cli}:${k.specOf(n).model}:${k.specOf(n).effort}`, before[n],
      `${n} must not be swept by the other domain`);
  }

  // Auto sweeps too, and clears any pinned model on those members.
  await k.setDomainModel('frontend', { auto: true });
  for (const n of d.frontend) a.equal(k.specOf(n).auto, true, `${n} must be handed to the advisor`);

  // Picking a concrete model again takes it back off Auto.
  await k.setDomainModel('frontend', { cli: 'codex', model: 'gpt-5.6-luna' });
  for (const n of d.frontend) {
    a.equal(k.specOf(n).auto, undefined, `${n} must come off Auto when pinned`);
  }

  // Turning Auto OFF must clear the flag and NOTHING else. The model-change
  // path below it deletes spec.model whenever no model is named, so falling
  // through would wipe a member's model as a side effect of untoggling a
  // checkbox — and setModel persists the config, so the loss would stick.
  await k.setDomainModel('frontend', { auto: true });
  const pinned = Object.fromEntries(d.frontend.map((n) =>
    [n, `${k.specOf(n).cli}:${k.specOf(n).model}`]));
  for (const n of d.frontend) await k.setModel(n, { auto: false });
  for (const n of d.frontend) {
    a.equal(k.specOf(n).auto, undefined, `${n} must come off Auto`);
    a.equal(`${k.specOf(n).cli}:${k.specOf(n).model}`, pinned[n],
      `${n} must keep the model it had — clearing Auto is not a reset`);
  }

  // Auto must survive the advisor acting on it. The advisor applies its pick
  // through setModel, and a pick names a model — so without a byAdvisor marker
  // the "sovereign chose a model, stop choosing for me" rule fires on Auto's
  // own output and switches it off after a single task.
  await k.setDomainModel('frontend', { auto: true });
  for (const n of d.frontend) {
    await k.setModel(n, { cli: 'codex', model: 'gpt-5.6-luna', effort: 'max', byAdvisor: true });
    a.equal(k.specOf(n).auto, true, `${n} must STAY on Auto when the advisor picks for it`);
    a.equal(k.specOf(n).model, 'gpt-5.6-luna', 'and the pick must actually apply');
  }
  // ...but the sovereign naming one still takes it off Auto.
  await k.setModel(d.frontend[0], { cli: 'codex', model: 'gpt-5.6-terra' });
  a.equal(k.specOf(d.frontend[0]).auto, undefined, 'the sovereign overrides Auto');

  await a.rejects(() => k.setDomainModel('sideways', { cli: 'codex' }), /No such domain/);
  await k.stop();
  console.log(`  domain sweep: backend=${d.backend.length}, frontend=${d.frontend.length}, auto round-trips`);
}

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
console.log('t-roles.js OK — standing court seeds once and obeys the sovereign');
