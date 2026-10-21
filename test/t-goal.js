// The standing goal: the one thing the court knows that survives a restart.
//
// Everything else is a message (consumed) or a transcript (recycled away). If
// the goal does not reach every member's prompt, or does not survive a restart,
// it is worth nothing — those are the two failures pinned here, plus the one
// that would corrupt state: two writers racing on agenticos.config.json.
//
//   node test/t-goal.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/agenticos.js';
import { kingdomDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.KINGDOM_CODEX_BIN = process.execPath;
process.env.KINGDOM_SETTLE_MS = '150';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-goal-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const cfg = join(repo, 'agenticos.config.json');
writeFileSync(cfg, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex', description: 'writes code' }],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  summarizer: { enabled: false },
}));

try {
  const k = new Kingdom(repo, cfg);
  k.on('error', () => {});
  await k.start();

  /* ---------- 1. no goal is a normal state ---------- */
  a.equal(k.goal(), null, 'a court with no goal must not invent one');
  a.ok(!k.briefFor('coder').includes('STANDING GOAL'),
    'no goal means no goal section in the prompt');

  /* ---------- 2. setting it reaches EVERY member's prompt ---------- */
  const goals = [];
  k.on('goal', (g) => goals.push(g));
  const g = k.setGoal({ text: 'Ship Habitable Tier 2 with green tests.' });

  a.equal(g.text, 'Ship Habitable Tier 2 with green tests.');
  a.ok(g.setAt, 'a goal is stamped when it is set');
  a.equal(goals.length, 1, 'the change is announced exactly once');

  for (const who of ['orchestrator', 'briefer', 'coder']) {
    const brief = k.briefFor(who);
    a.ok(brief.includes('STANDING GOAL'), `${who} must be told the goal`);
    a.ok(brief.includes('Ship Habitable Tier 2'), `${who} must be told what it IS`);
  }
  // Last, not buried: recency is what keeps it true after a long prompt.
  a.ok(k.briefFor('coder').lastIndexOf('STANDING GOAL')
    > k.briefFor('coder').indexOf('writes code'),
    'the goal comes after the persona, not before it');

  // And the court is TOLD, on the bus, so a successor can discover it.
  const said = k.bus.history({ limit: 20 }).filter((m) => m.sender === 'sovereign');
  a.ok(said.some((m) => m.body.includes('STANDING GOAL')),
    'the goal must be recorded on the bus, not only injected into prompts');

  /* ---------- 3. milestones ---------- */
  k.setGoal({ milestones: [{ text: 'schema migration', done: false }, 'flutter gates'] });
  const g2 = k.goal();
  a.equal(g2.milestones.length, 2);
  a.deepEqual(g2.milestones[1], { text: 'flutter gates', done: false },
    'a bare string milestone is normalised to an object');
  a.ok(k.briefFor('coder').includes('Still open:'), 'open milestones are listed');

  k.setMilestone(0, true);
  const g3 = k.goal();
  a.equal(g3.milestones[0].done, true);
  const brief = k.briefFor('coder');
  a.ok(brief.includes('Already done: schema migration'), 'done milestones are separated from open');
  a.ok(!brief.includes('- schema migration'), 'a finished milestone is not still "open"');

  /* ---------- 4. the orchestrator's claim, through the bus ---------- */
  // The MCP server cannot write the config — the orchestrator owns it, and two
  // writers would lose updates. The orchestrator posts a claim; the orchestrator applies.
  const reached = [];
  k.on('milestone', (m) => reached.push(m));
  k.bus.post('orchestrator', 'orchestrator', JSON.stringify({ index: 1, evidence: 'tests green' }), 'milestone');
  await wait(600);

  a.equal(reached.length, 1, 'the claim must be applied exactly once');
  a.equal(reached[0].text, 'flutter gates');
  a.equal(reached[0].by, 'orchestrator');
  a.equal(k.goal().milestones[1].done, true, 'and it must actually land in the config');

  // A second tick must NOT re-apply it.
  await wait(400);
  a.equal(reached.length, 1, 'the cursor must stop a claim being applied twice');

  // A malformed claim changes nothing rather than throwing.
  k.bus.post('orchestrator', 'orchestrator', 'not json', 'milestone');
  k.bus.post('orchestrator', 'orchestrator', JSON.stringify({ index: 99 }), 'milestone');
  await wait(500);
  a.equal(reached.length, 1, 'garbage and out-of-range claims are ignored');
  await k.stop();

  /* ---------- 5. it survives a restart — the whole point ---------- */
  const k2 = new Kingdom(repo, cfg);
  k2.on('error', () => {});
  await k2.start();
  const back = k2.goal();
  a.equal(back.text, 'Ship Habitable Tier 2 with green tests.', 'the goal outlives the process');
  a.equal(back.milestones.filter((m) => m.done).length, 2, 'and so does the progress');
  a.ok(k2.briefFor('orchestrator').includes('Ship Habitable Tier 2'),
    'a restarted court still knows what it is for');
  // The bus copy is what the MCP tools read; it must be refreshed on start.
  a.match(k2.bus.get('goal') ?? '', /Habitable Tier 2/,
    'the bus copy must be republished on start or the tools see a stale goal');

  /* ---------- 6. clearing ---------- */
  a.equal(k2.setGoal({ text: null }), null);
  a.equal(k2.goal(), null);
  a.ok(!k2.briefFor('orchestrator').includes('STANDING GOAL'));
  a.equal(JSON.parse(readFileSync(cfg, 'utf8')).goal, undefined,
    'a cleared goal is removed from the config, not left as an empty husk');
  await k2.stop();

  console.log('  goal reaches every prompt, last, and is recorded on the bus');
  console.log('  milestones normalise, split open/done, and survive a restart');
  console.log('  the orchestrator claims through the bus; the orchestrator applies once');
  console.log('t-goal.js OK — the court remembers what it is for');
} finally {
  for (const d of [repo, kingdomDir(repo)]) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
