// An agent that goes quiet with claimable work is stopped, not finished.
//
// The team's idle sleep is a cost control: a member nobody has spoken to in
// five minutes is stopped, and revives on its next message. But "nobody has
// spoken to it" and "there is nothing for it to do" are different facts, and
// the sleep only checked the first. An agent that ended a turn having done
// nothing, with unclaimed tasks sitting on the shared list, was put to sleep —
// the exact failure agent teams document as "agents stopping early" and answer
// with a TeammateIdle hook whose exit code 2 means "here is feedback, keep
// working". The team's equivalent is to spend one message before spending a
// whole respawn.
//
// Its own process because IDLE_SLEEP_MS is read once at module load, so the
// env has to be set before agenticos.js is imported — hence the dynamic import
// below rather than a section inside t-batching.js.
//
//   node test/t-idle-nudge.js
import { strict as a } from 'node:assert';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRepo } from './cleanup.js';

process.env.AGENTICOS_IDLE_SLEEP_MS = '300';
process.env.AGENTICOS_SETTLE_MS = '200';
process.env.AGENTICOS_CODEX_BIN = process.execPath;
const { AgenticOS } = await import('../src/agenticos.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (fn()) return true;
    await wait(50);
  }
  return fn();
};

const repo = mkdtempSync(join(tmpdir(), 'agenticos-nudge-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  agents: [{ name: 'coder', cli: 'codex' }],
}));

class FakeAgent extends EventEmitter {
  constructor() { super(); this.sent = []; this.busy = false; this.stopped = false; }
  send(t) { this.sent.push(t); }
  stop() { this.stopped = true; }
}

const k = new AgenticOS(repo, configPath);
// Sleeping an agent runs #rescueWork, which commits its worktree. These are
// stand-in agents with no worktree, so that git call fails — an unhandled
// 'error' on an EventEmitter takes the process down, and it is not what this
// suite is about.
k.on('error', () => {});
await k.start();
const mail = () => k.bus.history({ limit: 500 }).filter((m) => m.recipient === 'coder');

try {
  /* ---------- 1. work on the list: nudged, not slept ---------- */
  {
    k.bus.addTask({ title: 'the thing nobody claimed', detail: 'still open', by: 'orchestrator' });
    const coder = new FakeAgent();
    k.processes.set('coder', coder);
    k.added.add('coder');
    k.lastActive.set('coder', Date.now() - 5000);   // long past the 300ms threshold

    a.ok(await until(() => mail().some((m) => /claim_task/.test(m.body))),
      'an agent going quiet with an unclaimed task must be told to claim it');
    a.ok(k.processes.has('coder'), 'and must NOT have been slept in the same pass');
    a.equal(coder.stopped, false);
    console.log('  quiet with work on the list: nudged once, still awake');
  }

  /* ---------- 2. nudged ONCE, not poked forever ---------- */
  {
    // The nudge itself moves lastActive when it lands, but an agent that
    // ignores it must eventually sleep rather than collect a message every
    // tick for the rest of the session.
    const before = mail().filter((m) => /claim_task/.test(m.body)).length;
    k.lastActive.set('coder', Date.now() - 5000);
    await wait(1500);
    const after = mail().filter((m) => /claim_task/.test(m.body)).length;
    a.equal(after, before, 'an agent that ignores the nudge must not be nudged again');
    a.ok(await until(() => !k.processes.has('coder')),
      'it must fall asleep on the next pass instead of being poked forever');
    console.log('  ignored nudge: one message, then it sleeps as before');
  }

  /* ---------- 3. nothing to claim: the old behaviour, untouched ---------- */
  {
    // Every task claimed, so there is genuinely nothing to pick up. The sleep
    // is a cost control and must still fire — a nudge that fires on an empty
    // list would keep the whole team awake for nothing.
    for (const t of k.bus.availableTasks()) k.bus.claimTask('refactoring-engineer', t.id);
    a.equal(k.bus.availableTasks().length, 0);

    const coder = new FakeAgent();
    k.processes.set('coder', coder);
    const before = mail().length;
    k.lastActive.set('coder', Date.now() - 5000);

    a.ok(await until(() => !k.processes.has('coder')), 'with nothing to claim it must sleep');
    a.equal(mail().length, before, 'and must not have been sent anything first');
    console.log('  nothing to claim: slept, silently, exactly as before');
  }

  console.log('t-idle-nudge.js OK — an agent with work waiting is nudged once, then sleeps like any other');
} finally {
  await k.stop();
  removeRepo(repo);
}
