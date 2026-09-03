// Approval requests are durable bus records, not transient UI events.
//
//   node test/t-approvals.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom, CROWN } from '../src/kingdom.js';
import { Bus } from '../src/bus.js';
import { kingdomDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'kingdom-approvals-'));
const repo = join(dir, 'repo');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: repo });
writeFileSync(join(repo, 'README.md'), '# approvals\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

const configPath = join(dir, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'designer', cli: 'codex' }],
  rolesSeeded: true,
}));

const k = new Kingdom(repo, configPath);
const seen = [];
k.on('approval', (p) => seen.push(p));
a.match(k.briefFor('orchestrator'), /call the summon tool immediately/,
  'the orchestrator must create an approval record through the tool, not prose');
a.deepEqual(k.requestSummon(['designer'], 'design probe'), { ok: true, requested: true },
  'the Team page must create the same durable summon approval as the MCP tool');
await k.start();

a.ok(k.approvals.size, 'a pending approval must survive startup');
a.ok(seen.some((p) => p.kind === 'summon' && p.names[0] === 'designer'),
  'startup must surface a pending approval');

k.bus.post('orchestrator', null,
  JSON.stringify({ kind: 'summon', names: ['designer'], reason: 'second probe' }), 'approval');
await wait(700);
a.equal(k.approvals.size, 2, 'new approval must be picked up by the delivery loop');

/* ---- the king must be TOLD its summons were approved -------------------- */
// Watched live, on the shipped default configuration: a summon of five was
// approved, five peasants woke in five worktrees, "The sovereign approved your
// summons ... Assign their work." was written to the bus — and the orchestrator
// never moved. Four minutes later all five idle-slept, having been handed
// nothing. The court paid for a crew and then stalled.
//
// bus.pending() drops rows where sender = the reader, which is correct: nobody
// is handed their own outbound mail back. But the crown posted these notices as
// the ROLE "orchestrator" to the orchestrator's NAME, and the default name is
// "orchestrator" — so the guard ate every one of them. Twenty call sites, all
// of them the crown telling the king something, all silent out of the box.
//
// Asserted through the real approve() path, with a default-named orchestrator,
// because it is the collision that is the bug: a fixture that renames the king
// passes either way and proves nothing.
{
  a.equal(k.config.orchestrator.name, 'orchestrator',
    'this test is ABOUT the default name — renaming the fixture would hide the bug');

  const id = [...k.approvals.keys()][0];
  await k.approve(id);

  const inbox = k.bus.pending('orchestrator').map((m) => m.body);
  a.ok(inbox.some((b) => /approved your summons/.test(b)),
    'an approved summon must be DELIVERABLE to the orchestrator, not merely written '
    + `to the log. Its inbox held: ${JSON.stringify(inbox).slice(0, 200)}`);
  a.ok(k.bus.history({ limit: 50 }).some((m) => m.sender === CROWN),
    'and it must come from the crown, which is nobody, so no member ever filters it');

  // The guard itself must survive: a member still never re-reads its own post.
  k.bus.post('orchestrator', 'orchestrator', 'talking to myself');
  a.ok(!k.bus.pending('orchestrator').some((m) => m.body === 'talking to myself'),
    'a member must still not be handed its own outbound message back');

  console.log('  an approved summon reaches the king; self-posts still filtered');
}

await k.wake('designer');
// Approval records must outlive the bounded transcript, not merely a clean stop.
k.bus.prune({ keepMessages: 0 });
const pendingId = [...k.approvals.keys()][0];
a.ok(k.bus.approvals().some((p) => p.id === pendingId),
  'the approval payload remains in durable state after message pruning');
await k.stop();
const k2 = new Kingdom(repo, configPath);
await k2.start();
a.ok(k2.approvals.has(pendingId), 'a pruned pending approval survives restart');
const roster = JSON.parse(k2.bus.get('roster'));
const designer = roster.find((r) => r.name === 'designer');
a.equal(designer.summoned, true, 'a woken member stays in the standing crew');
a.equal(designer.awake, false, 'a standing member may restore asleep after restart');

// A failed sibling must not leave a half-approved crew or a still-pending card.
{
  const started = [];
  k2.config.peasants.push({ name: 'tester', cli: 'codex' });
  k2.summoned.delete('designer');
  k2.bus.set('summoned', JSON.stringify([...k2.summoned]));
  k2.approvals.set(901, { kind: 'summon', names: ['designer', 'tester'], from: 'orchestrator' });
  const originalWake = k2.wake;
  k2.wake = async (name) => {
    if (name === 'tester') throw new Error('worktree unavailable');
    k2.agents.set(name, { stop() {} });
    k2.summoned.add(name);
    started.push(name);
  };
  await a.rejects(k2.approve(901), /summons, but it was not completed: tester: worktree unavailable/,
    'a blocked summon must report failure instead of looking approved to the action caller');
  k2.wake = originalWake;
  a.deepEqual(started, ['designer'], 'the successful sibling may start before the failure is known');
  a.equal(k2.approvals.has(901), false, 'a failed summon approval is consumed');
  a.equal(k2.bus.get('resolved:901'), 'blocked', 'the failed summon remains visibly blocked');
  a.equal(k2.agents.has('designer'), false, 'a partial crew is rolled back');
  a.equal(k2.summoned.has('designer'), false, 'rollback removes only newly summoned standing state');
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
// no safe peasant crew to infer from corrupt state; the crown still starts.
const recovered = new Kingdom(repo, configPath);
recovered.bus.set('summoned', '{broken');
await recovered.start();
a.equal(recovered.summoned.has('designer'), false,
  'a corrupt summoned state must not restore a previously summoned peasant');
await recovered.stop();

try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
try { rmSync(kingdomDir(repo), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-approvals.js OK â€” pending approvals and resting crew survive restart');
