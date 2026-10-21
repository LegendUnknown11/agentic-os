// A successor must never have to ask the user what was happening.
//
// Real failure: after switching the orchestrator's CLI from the dropdown, the new orchestrator
// replied "I don't have a record of what we were working on... what was the
// task?". Three causes: the CLI switch discarded the session with no handover,
// the user's goal was sent straight to the process so nothing recorded it,
// and a fresh member got no state at all.
//
//   node test/t-onboarding.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { stateDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.AGENTICOS_CODEX_BIN = process.execPath; // stub: never calls an API
process.env.AGENTICOS_SETTLE_MS = '200';

const repo = mkdtempSync(join(tmpdir(), 'agenticos-acc-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  models: { claude: ['haiku'], codex: ['gpt-5.6-luna'] },
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  agents: [{ name: 'coder', cli: 'codex' }],
  // This suite is about onboarding, not advice. Left on, every command() would
  // spawn two real model calls before the goal reached the bus.
  advisor: { promptEngineer: false, autoModel: false },
}));

const neuter = (agent, handover) => {
  agent.sent = [];
  agent.stopped = false;
  agent.send = function (t) {
    this.sent.push(t);
    if (/handover/i.test(t)) {
      setImmediate(() => {
        this.emit('text', handover);
        this.emit('turn_end', { usage: {}, costUsd: 0 });
      });
    }
  };
  agent.stop = function () { this.stopped = true; };
  return agent;
};

const k = new AgenticOS(repo, configPath);
await k.start();
neuter(k.processes.get('orchestrator'), 'Tier 1 merged; coverage run still pending.');

// --- the user's goal must be RECORDED, not just delivered --------
k.command('Ship tier 1 of the Habitable onboarding flow.');
await wait(600);
const recorded = k.bus.history({ limit: 50 }).find((m) => m.sender === 'user');
a.ok(recorded, 'the user\'s goal must be on the bus, not only in the process');
a.match(recorded.body, /tier 1/i);

await k.wake('coder');
neuter(k.processes.get('coder'), 'n/a');
k.bus.post('orchestrator', 'coder', 'Implement the onboarding screens.');
await wait(600);

// --- switching CLI must take a handover before discarding the session -
const before = k.bus.get('session:orchestrator:default');
await k.setModel('orchestrator', { cli: 'claude', model: 'haiku' });

const successor = k.processes.get('orchestrator');
a.ok(successor, 'a successor orchestrator must exist');
a.equal(k.bus.get('session:orchestrator:default') === before, false, 'the old session must be discarded');
a.match(successor.spec.prompt, /HANDOVER FROM YOUR PREDECESSOR/,
  'a CLI switch must capture a handover, not silently wipe memory');
a.match(successor.spec.prompt, /coverage run still pending/i);

// --- and it must be oriented from the bus regardless ------------------
a.match(successor.spec.prompt, /STATE OF THE TEAM AT YOUR ONBOARDING/);
a.match(successor.spec.prompt, /Ship tier 1/i, 'the standing goal must be in the brief');
a.match(successor.spec.prompt, /IN SERVICE:.*coder/s, 'the brief must name the crew');
a.match(successor.spec.prompt, /Do NOT ask the user/i);

// --- the same after a plain restart (no handover available) -----------
await k.stop();
const k2 = new AgenticOS(repo, configPath);
await k2.start();
k2.bus.set('session:orchestrator:default', ''); // simulate an orchestrator with no resumable session
k2.processes.get('orchestrator')?.stop();
k2.processes.delete('orchestrator');
await k2.wake('orchestrator');

const revived = k2.processes.get('orchestrator');
a.match(revived.spec.prompt, /STATE OF THE TEAM AT YOUR ONBOARDING/,
  'an orchestrator with no session must still be oriented');
a.match(revived.spec.prompt, /Ship tier 1/i,
  'the standing goal must survive a restart — this is the actual bug');

/* ---------- the brain: vault instructions + memory reach every member ------ */
// memory.js self-checks its own arithmetic. What matters here is the WIRING:
// that a spawning member is actually handed the user's standing
// instructions and the index of what the team already knows, from the vault,
// without anyone remembering to ask for it.
{
  const { mkdirSync, writeFileSync: write } = await import('node:fs');
  const { remember } = await import('../src/memory.js');

  const vault = join(stateDir(repo), 'vault-for-test');
  mkdirSync(join(vault, 'AgenticOS'), { recursive: true });
  write(join(vault, 'AgenticOS', 'Team Instructions.md'), 'Never push without being asked.\n');
  remember(vault, {
    title: 'flutter test, not dart test',
    body: 'dart test cannot load the bindings.\n\n' + 'TAIL-THAT-MUST-NOT-TRAVEL '.repeat(40),
  });

  k2.config.vault = vault;
  k2.config.vaultWriteDir = 'AgenticOS';

  for (const who of ['orchestrator', 'briefer', 'coder']) {
    const brief = k2.briefFor(who);
    a.match(brief, /STANDING INSTRUCTIONS FROM THE USER/, `${who} must be given the instructions`);
    a.match(brief, /Never push without being asked/, `${who} must get their actual words`);
    a.match(brief, /WHAT THE TEAM ALREADY KNOWS/, `${who} must be given the memory index`);
    a.match(brief, /flutter test, not dart test/, `${who} must see the memory TITLE`);
    // TITLES ONLY. Nothing from a memory body may ride along — it would be
    // replayed on every turn for the life of the member, and the title is
    // required to be the fact itself.
    a.ok(!brief.includes('TAIL-THAT-MUST-NOT-TRAVEL'),
      `${who} must never get a memory body`);
    a.ok(!brief.includes('cannot load the bindings'),
      `${who} must get titles only, not the first line of each memory either`);
  }

  // The goal still lands LAST: it is the one thing that must survive being
  // read after everything above it. Set one here — the earlier part of this
  // file exercises the goal through the BUS, which leaves config.goal unset,
  // so without this the ordering check would silently compare against -1.
  k2.setGoal({ text: 'Ship tier 1' });
  const b = k2.briefFor('orchestrator');
  a.ok(b.includes('STANDING GOAL'), 'sanity: the goal block must actually be present');
  a.ok(b.lastIndexOf('STANDING GOAL') > b.lastIndexOf('WHAT THE TEAM ALREADY KNOWS'),
    'the brain must not push the standing goal out of last place');

  // A RESUMED member never gets a new system prompt — for codex the persona
  // rides only the first turn — so an edit to the instructions would otherwise
  // reach nobody until they recycled. Observed for real: a resumed orchestrator
  // answered from the CLI's own private memory store instead of the team's.
  {
    const { writeFileSync: w2 } = await import('node:fs');
    k2.bus.set('session:coder:default', 'thread-that-already-exists');
    await k2.wake('coder');                       // resumes; records the fingerprint
    const before = k2.bus.pending('coder').length;

    w2(join(vault, 'AgenticOS', 'Team Instructions.md'), 'Never push. And never force-push.\n');
    k2.processes.get('coder')?.stop();
    k2.processes.delete('coder');
    await k2.wake('coder');                       // resumes again, brain has changed

    const mail = k2.bus.pending('coder').slice(before);
    const briefing = mail.find((m) => /standing instructions or the/i.test(m.body));
    a.ok(briefing, 'a resumed member must be handed the changed brain');
    a.match(briefing.body, /never force-push/i, 'and it must carry the NEW words');
    a.equal(briefing.kind, 'notice',
      'as a notice, so it rides along with real traffic instead of buying a turn');

    // Unchanged brain must not re-brief anyone — that would be a replay per wake.
    k2.processes.get('coder')?.stop();
    k2.processes.delete('coder');
    const n = k2.bus.pending('coder').length;
    await k2.wake('coder');
    a.equal(k2.bus.pending('coder').length, n, 'an unchanged brain must say nothing');
  }

  // A team with no vault is unaffected.
  delete k2.config.vault;
  a.ok(!k2.briefFor('coder').includes('STANDING INSTRUCTIONS'),
    'no vault means no brain block, not a crash');
  console.log('  brain: instructions and memory titles reach orchestrator, briefer and agents');
}

// A brand new conversation must not orient itself with a DIFFERENT
// conversation's chat, as if it were "what we were just doing".
//
// Real bug: a fresh Chat-mode conversation, asked to repeat the user's
// last message, recited a completely unrelated conversation's last message
// instead — #orientation() built "RECENT TEAM TRAFFIC"/"STANDING GOAL" from
// bus.history() with no conversation filter at all, so a member spawning
// into a brand new thread was hearing another thread's chat as its own.
{
  // A marker unique to this block — config.goal (set above via setGoal) is
  // ITSELF team-wide by design and also contains "Ship tier 1", so reusing
  // that text here would not isolate what #orientation() is doing from what
  // briefFor()'s separate STANDING GOAL block already, correctly, does.
  //
  // Deliberately NOT neutering the outgoing orchestrator here: switchConversation
  // calls the real live.stop() on it to kill its process before respawning, and
  // neutering that stop() first (as an earlier version of this test did) silently
  // no-ops the real kill — the child process leaks, and the whole suite hangs
  // until run-all.js's 180s timeout kills it.
  k2.bus.post('user', 'orchestrator', 'DEFAULT-THREAD-ONLY: what should we build next?', 'assignment', 'default');
  await k2.switchConversation('orchestrator', 'conv-b');
  const inB = k2.processes.get('orchestrator');
  a.ok(!inB.spec.prompt.includes('DEFAULT-THREAD-ONLY'),
    'a fresh conversation\'s orientation must not include a DIFFERENT conversation\'s chat turns');
  a.match(inB.spec.prompt, /IN SERVICE:.*coder/s,
    'team-wide operational context (the crew) must still reach it — only chat turns are conversation-scoped');
  console.log('  a fresh conversation orients from its own chat, not a sibling conversation\'s');
}

await k2.stop();
for (const d of [repo, stateDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-onboarding.js OK — goals are recorded, handovers taken, successors oriented');
