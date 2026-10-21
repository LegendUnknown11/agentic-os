// Approval requests are durable bus records, not transient UI events.
//
//   node test/t-approvals.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS, SYSTEM } from '../src/agenticos.js';
import { Bus } from '../src/bus.js';
import { stateDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'agenticos-approvals-'));
const repo = join(dir, 'repo');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['config', 'user.email', 'k@agenticos'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'agenticos'], { cwd: repo });
writeFileSync(join(repo, 'README.md'), '# approvals\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

const configPath = join(dir, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  agents: [{ name: 'designer', cli: 'codex' }],
  rolesSeeded: true,
}));

const k = new AgenticOS(repo, configPath);
const seen = [];
k.on('approval', (p) => seen.push(p));
a.match(k.briefFor('orchestrator'), /call the add_agent tool immediately/,
  'the orchestrator must create an approval record through the tool, not prose');
a.deepEqual(k.requestAdd(['designer'], 'design probe'), { ok: true, requested: true },
  'the Team page must create the same durable add approval as the MCP tool');
await k.start();

a.ok(k.approvals.size, 'a pending approval must survive startup');
a.ok(seen.some((p) => p.kind === 'add' && p.names[0] === 'designer'),
  'startup must surface a pending approval');

k.bus.post('orchestrator', null,
  JSON.stringify({ kind: 'add', names: ['designer'], reason: 'second probe' }), 'approval');
await wait(700);
a.equal(k.approvals.size, 2, 'new approval must be picked up by the delivery loop');

/* ---- the orchestrator must be TOLD its add request was approved -------------------- */
// Watched live, on the shipped default configuration: an add of five was
// approved, five agents woke in five worktrees, "The user approved your
// adds ... Assign their work." was written to the bus — and the orchestrator
// never moved. Four minutes later all five idle-slept, having been handed
// nothing. The team paid for a crew and then stalled.
//
// bus.pending() drops rows where sender = the reader, which is correct: nobody
// is handed their own outbound mail back. But the system posted these notices as
// the ROLE "orchestrator" to the orchestrator's NAME, and the default name is
// "orchestrator" — so the guard ate every one of them. Twenty call sites, all
// of them the system telling the orchestrator something, all silent out of the box.
//
// Asserted through the real approve() path, with a default-named orchestrator,
// because it is the collision that is the bug: a fixture that renames the orchestrator
// passes either way and proves nothing.
{
  a.equal(k.config.orchestrator.name, 'orchestrator',
    'this test is ABOUT the default name — renaming the fixture would hide the bug');

  const id = [...k.approvals.keys()][0];
  await k.approve(id);

  const inbox = k.bus.pending('orchestrator').map((m) => m.body);
  a.ok(inbox.some((b) => /approved your request to add agents/.test(b)),
    'an approved add must be DELIVERABLE to the orchestrator, not merely written '
    + `to the log. Its inbox held: ${JSON.stringify(inbox).slice(0, 200)}`);
  a.ok(k.bus.history({ limit: 50 }).some((m) => m.sender === SYSTEM),
    'and it must come from the system, which is nobody, so no member ever filters it');

  // The guard itself must survive: a member still never re-reads its own post.
  k.bus.post('orchestrator', 'orchestrator', 'talking to myself');
  a.ok(!k.bus.pending('orchestrator').some((m) => m.body === 'talking to myself'),
    'a member must still not be handed its own outbound message back');

  console.log('  an approved add reaches the orchestrator; self-posts still filtered');
}

await k.wake('designer');
// Approval records must outlive the bounded transcript, not merely a clean stop.
k.bus.prune({ keepMessages: 0 });
const pendingId = [...k.approvals.keys()][0];
a.ok(k.bus.approvals().some((p) => p.id === pendingId),
  'the approval payload remains in durable state after message pruning');
await k.stop();
const k2 = new AgenticOS(repo, configPath);
await k2.start();
a.ok(k2.approvals.has(pendingId), 'a pruned pending approval survives restart');
const roster = JSON.parse(k2.bus.get('roster'));
const designer = roster.find((r) => r.name === 'designer');
a.equal(designer.added, true, 'a woken member stays in the standing crew');
a.equal(designer.awake, false, 'a standing member may restore asleep after restart');

// A failed sibling must not leave a half-approved crew or a still-pending card.
{
  const started = [];
  k2.config.agents.push({ name: 'tester', cli: 'codex' });
  k2.added.delete('designer');
  k2.bus.set('added', JSON.stringify([...k2.added]));
  k2.approvals.set(901, { kind: 'add', names: ['designer', 'tester'], from: 'orchestrator' });
  const originalWake = k2.wake;
  k2.wake = async (name) => {
    if (name === 'tester') throw new Error('worktree unavailable');
    k2.processes.set(name, { stop() {} });
    k2.added.add(name);
    started.push(name);
  };
  await a.rejects(k2.approve(901), /request to add agents, but it was not completed: tester: worktree unavailable/,
    'a blocked add must report failure instead of looking approved to the action caller');
  k2.wake = originalWake;
  a.deepEqual(started, ['designer'], 'the successful sibling may start before the failure is known');
  a.equal(k2.approvals.has(901), false, 'a failed add approval is consumed');
  a.equal(k2.bus.get('resolved:901'), 'blocked', 'the failed add remains visibly blocked');
  a.equal(k2.processes.has('designer'), false, 'a partial crew is rolled back');
  a.equal(k2.added.has('designer'), false, 'rollback removes only newly added standing state');
}

// Resolved approval history is bounded, while an unanswered record survives
// message pruning independently of the transcript.
{
  const b = new Bus(':memory:');
  const old = b.post('orchestrator', null, JSON.stringify({ kind: 'push', reason: 'old' }), 'approval');
  const pending = b.post('orchestrator', null, JSON.stringify({ kind: 'push', reason: 'pending' }), 'approval');
  const newest = b.post('orchestrator', null, JSON.stringify({ kind: 'push', reason: 'newest' }), 'approval');
  b.set(`resolved:${old}`, 'approved');
  b.set(`resolved:${newest}`, 'rejected');
  b.prune({ keepMessages: 0, keepApprovals: 1 });
  a.deepEqual(b.approvals().map((p) => p.id), [pending, newest],
    'pending and newest resolved approvals survive bounded pruning');
  a.equal(b.get(`approval:${old}`), undefined, 'old resolved approval payload is pruned');
  a.equal(b.get(`resolved:${old}`), undefined, 'old resolved status is pruned with its payload');
  b.close();
}

await k2.stop();

// A damaged persisted crew list must not make a restart unavailable. There is
// no safe agent crew to infer from corrupt state; the system still starts.
const recovered = new AgenticOS(repo, configPath);
recovered.bus.set('added', '{broken');
await recovered.start();
a.equal(recovered.added.has('designer'), false,
  'a corrupt added state must not restore a previously added agent');
await recovered.stop();

try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
try { rmSync(stateDir(repo), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-approvals.js OK â€” pending approvals and resting crew survive restart');
