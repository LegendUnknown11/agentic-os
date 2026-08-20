// The shared task list, driven through the real MCP servers.
//
// The court could not answer "what is still outstanding". The orchestrator assigned by
// message, and a message is sent and then gone: an assignment a peasant never
// acted on left no trace in any queue, count, or panel. This exercises the list
// end to end through three separate MCP processes — one orchestrator, two peasants —
// because the race that matters (two members claiming one task) only exists
// across processes, and a single-process test would prove nothing about it.
//
//   node test/t-tasks.js
import { strict as a } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from '../src/bus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kingdom-tasks-'));
const db = join(dir, 'bus.db');

const seed = new Bus(db);
seed.set('roster', JSON.stringify([
  { name: 'sovereign-regent', role: 'orchestrator' },
  { name: 'coder', role: 'peasant' },
  { name: 'refactoring-engineer', role: 'peasant' },
]));
seed.close();

/** One MCP server process, speaking the same jsonrpc a real member speaks. */
function member(name, role) {
  const child = spawn(process.execPath, [join(HERE, '..', 'src', 'mcp.js')], {
    cwd: join(HERE, '..'),
    env: { ...process.env, KINGDOM_AGENT: name, KINGDOM_ROLE: role, KINGDOM_DB: db },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  const waiting = [];
  const fail = (e) => { while (waiting.length) waiting.shift().reject(e); };
  child.on('error', fail);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { waiting.shift()?.resolve(JSON.parse(line)); } catch (e) { fail(e); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  });
  return {
    child,
    async start() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      return this;
    },
    async tools() {
      return (await rpc('tools/list', {})).result.tools.map((t) => t.name);
    },
    async call(tool, args = {}) {
      const r = await rpc('tools/call', { name: tool, arguments: args });
      return r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
    },
  };
}

const orchestrator = await member('sovereign-regent', 'orchestrator').start();
const coder = await member('coder', 'peasant').start();
const refactoringEngineer = await member('refactoring-engineer', 'peasant').start();

try {
  /* ---------- 1. the tools reach the right roles ---------- */
  {
    const k = await orchestrator.tools(), c = await coder.tools();
    a.ok(k.includes('add_task') && k.includes('rule_on_plan') && k.includes('close_task'),
      'the orchestrator stocks the list, rules on plans, and can reconcile an unowned stale task');
    a.ok(!k.includes('claim_task'), 'and does not claim work — an orchestrator that codes stops coordinating');
    a.ok(c.includes('claim_task') && c.includes('declare_done') && c.includes('finish_task') && c.includes('submit_plan'));
    a.ok(!c.includes('add_task'), 'a peasant does not write its own assignments');
    a.ok(k.includes('tasks') && c.includes('tasks'), 'but the LIST is shared, so both must see it');
    console.log('  tools: orchestrator stocks and rules, peasants claim, both read the same list');
  }

  /* ---------- 2. tasks, and dependencies that actually block ---------- */
  {
    a.match(await orchestrator.call('add_task', { title: 'write the parser', detail: 'src/parse.js' }), /#1 added/);
    a.match(await orchestrator.call('add_task', { title: 'test the parser', detail: 'a failing case first', needs: [1] }),
      /#2 added, waiting on #1/);
    a.match(await orchestrator.call('add_task', { title: 'drop the old table', detail: 'irreversible', require_plan: true }),
      /#3 added/);

    a.match(await orchestrator.call('add_task', { title: 'x', detail: 'y', needs: [99] }), /No such task: #99/,
      'a dependency on a task that does not exist must be refused, not stored as permanently blocked');
    a.ok(!(await orchestrator.call('tasks')).includes(' x'), 'and the refused task must not be on the list');
    console.log('  add_task: dependencies validated, a bad one refused rather than stored');
  }

  /* ---------- 3. two processes, one task: exactly one wins ---------- */
  {
    // Both ask for "the next available" at the same instant. This is the race
    // agent teams handle with a file lock; here it is one `begin immediate`
    // transaction, and the point of the test is that the loser is TOLD, not
    // silently handed the same work.
    const [one, two] = await Promise.all([coder.call('claim_task'), refactoringEngineer.call('claim_task')]);
    const claimed = [one, two].filter((t) => t.includes('Claimed #1'));
    a.equal(claimed.length, 1, `exactly one member may hold task #1, got:\n${one}\n---\n${two}`);
    const loser = [one, two].find((t) => !t.includes('Claimed #1'));
    a.ok(/already/.test(loser) || /Claimed #3/.test(loser),
      `the loser must be told, or given different work — got: ${loser}`);
    console.log('  claim: two processes raced for one task and exactly one got it');
  }

  /* ---------- 4. a blocked task cannot be claimed, and says why ---------- */
  {
    const r = await refactoringEngineer.call('claim_task', { id: 2 });
    a.match(r, /waits on #1/, 'the refusal must name the blocker, or the member cannot act on it');
    console.log('  blocked: #2 refused, and the refusal names what it waits for');
  }

  /* ---------- 5. the plan gate is enforced, not requested ---------- */
  {
    const held = (await orchestrator.call('tasks')).includes('#3 planning');
    if (!held) await refactoringEngineer.call('claim_task', { id: 3 });
    const owner = (await orchestrator.call('tasks')).match(/#3 planning \[([\w-]+)\]/)?.[1];
    a.ok(owner, 'a task that requires a plan must be claimed into planning, not into work');

    const worker = owner === 'coder' ? coder : refactoringEngineer;
    a.match(await worker.call('finish_task', { id: 3, summary: 'done, trust me' }),
      /still needs an approved plan/,
      'a member must not be able to close a risky task by deciding its own plan was fine');
    a.ok(!(await orchestrator.call('tasks')).includes('#3 done'));

    a.match(await orchestrator.call('rule_on_plan', { id: 3, approve: true, notes: 'go' }), /has not submitted a plan/,
      'and the orchestrator must not be able to approve a plan that was never written');

    a.match(await worker.call('submit_plan', { id: 3, plan: 'back it up first, then drop' }), /Plan sent/);
    a.match(await orchestrator.call('rule_on_plan', { id: 3, approve: false, notes: 'name the backup path' }),
      /sent back to/);
    a.match(await worker.call('finish_task', { id: 3, summary: 'still done' }), /still needs an approved plan/,
      'rejection must leave the gate CLOSED — that is the whole point of rejecting');

    await orchestrator.call('rule_on_plan', { id: 3, approve: true, notes: 'better' });
    a.match(await worker.call('finish_task', { id: 3, summary: 'dropped, backup at /tmp' }), /closed/);
    console.log('  plan gate: cannot self-approve, cannot approve nothing, rejection keeps it shut');
  }

  /* ---------- 6. ownership, and unblocking without anyone updating it ---------- */
  {
    // Which of the two won section 3's race is genuinely undecided, so read
    // the owner rather than assuming it. An earlier draft of this test assumed
    // coder and passed until the scheduler handed the task to refactoringEngineer instead.
    const holder = (await orchestrator.call('tasks')).match(/#1 active \[([\w-]+)\]/)?.[1];
    a.ok(holder, 'task #1 must still be held by whoever won the race');
    const [owner, other] = holder === 'coder' ? [coder, refactoringEngineer] : [refactoringEngineer, coder];

    a.match(await other.call('finish_task', { id: 1, summary: 'not mine' }), /not yours/,
      'only the owner may close a task');

    await owner.call('finish_task', { id: 1, summary: 'parser written' });
    a.match(await other.call('claim_task', { id: 2 }), /Claimed #2/,
      'finishing #1 must unblock #2 with nobody having to go and update it');

    const bus = new Bus(db);
    const done = bus.tasks().filter((t) => t.state === 'done').map((t) => t.id);
    a.deepEqual(done.sort(), [1, 3]);
    a.equal(bus.availableTasks().length, 0, 'and nothing is left unclaimed');
    // finish_task reports to whoever holds the office, not to the literal
    // string "orchestrator" — this court's orchestrator is named sovereign-regent.
    const reports = bus.history({ limit: 200 }).filter((m) => m.kind === 'done');
    a.ok(reports.length >= 2 && reports.every((m) => m.recipient === 'sovereign-regent'),
      `completions must reach the orchestrator by office, got ${JSON.stringify(reports.map((m) => m.recipient))}`);
    bus.close();
    // Section 7 pins declare_done for coder. The race above deliberately gives
    // #2 to either worker, so close it before that focused one-task scenario.
    await other.call('finish_task', { id: 2, summary: 'parser tests written' });
    console.log('  ownership honoured, dependents unblocked, completions reached the orchestrator by office');
  }

  /* ---------- 7. declaring done must not leave a claimed review active ----- */
  {
    a.match(await orchestrator.call('add_task', { title: 'review the candidate', detail: 'read-only final gate' }), /#4 added/);
    a.match(await coder.call('claim_task', { id: 4 }), /Claimed #4/);
    a.match(await coder.call('declare_done', { summary: 'candidate approved after tests' }), /Declared done/);

    const bus = new Bus(db);
    const review = bus.task(4);
    a.equal(review.state, 'done',
      'declare_done must close a member\'s sole active task instead of leaving the board falsely in progress');
    a.equal(review.owner, 'coder', 'closing the task must preserve its accountable owner');
    bus.close();

    a.match(await orchestrator.call('add_task', { title: 'review alpha', detail: 'first independent check' }), /#5 added/);
    a.match(await orchestrator.call('add_task', { title: 'review beta', detail: 'second independent check' }), /#6 added/);
    await coder.call('claim_task', { id: 5 });
    await coder.call('claim_task', { id: 6 });
    a.match(await coder.call('declare_done', { summary: 'one review is ready' }), /still hold #5 and #6/,
      'declare_done must not guess which of several active tasks it should close');
    const ambiguous = new Bus(db);
    a.equal(ambiguous.task(5).state, 'active');
    a.equal(ambiguous.task(6).state, 'active');
    ambiguous.close();
    console.log('  declare_done closes its sole active task, so review completion clears the board');
  }

  /* ---------- 8. stale unowned work has an auditable closure ----------- */
  {
    a.match(await orchestrator.call('add_task', {
      title: 'superseded planning task', detail: 'the replacement implementation already merged', require_plan: true,
    }), /#7 added/);
    a.match(await orchestrator.call('close_task', {
      id: 7, summary: 'Superseded by the verified replacement task.',
    }), /Task #7 closed/,
    'the orchestrator must be able to close an unowned stale task without guessing at an active owner');
    const bus = new Bus(db);
    const stale = bus.task(7);
    a.equal(stale.state, 'done', 'a reconciled task must stop keeping the board open');
    a.equal(stale.owner, null, 'reconciliation must preserve that nobody owns the stale task');
    a.ok(stale.done_ts, 'the closure needs a durable timestamp');
    bus.close();
    a.match(await orchestrator.call('close_task', { id: 5, summary: 'do not steal work' }), /still owned/,
      'an orchestrator may not close a task a member still owns');
    console.log('  unowned stale tasks close audibly; active work is never guessed away');
  }

  console.log('t-tasks.js OK — a shared list two processes cannot both claim, with a plan gate that holds');
} finally {
  // Wait for the processes to actually go before deleting the db they have
  // open: on Windows a killed child still holds the file for a moment, and
  // rmSync throws EPERM on the WAL. Cleaning a temp directory is not what this
  // suite is testing, so a failure to do so must not fail it.
  await Promise.all([orchestrator, coder, refactoringEngineer].map((m) => new Promise((done) => {
    m.child.once('exit', done);
    m.child.kill();
  })));
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
}
