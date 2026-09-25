// The sovereign managing the team's task list directly (Kingdom.manageTask).
//
// Before this the UI could only watch the queue. Every change here must reach
// the member it affects as a message, or a reassigned member keeps working a
// task that is no longer theirs.
//
//   node test/t-task-admin.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-taskadmin-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');
const configPath = join(repo, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }, { name: 'tester', cli: 'codex' }],
}));

const k = new Kingdom(repo, configPath);
k.on('error', () => {});
await k.start();
const inbox = (name) => k.bus.history({ limit: 400 }).filter((m) => m.recipient === name && m.sender === 'sovereign');

try {
  /* ---------- create, with and without an owner ---------- */
  const loose = k.manageTask({ op: 'create', title: 'write the changelog' });
  a.equal(loose.state, 'pending');
  a.equal(loose.by, 'sovereign', 'the task records who asked for it');
  const owned = k.manageTask({ op: 'create', title: 'fix the parser', detail: 'nested quotes', owner: 'coder', priority: 2 });
  a.equal(owned.owner, 'coder');
  a.equal(owned.state, 'active');
  a.equal(owned.priority, 2);
  a.match(inbox('coder').at(-1)?.body ?? '', /Task #\d+ \(fix the parser\) was assigned to you[\s\S]*nested quotes/,
    'the new owner is told, with the detail');
  a.throws(() => k.manageTask({ op: 'create', title: '   ' }), /needs a title/);
  a.throws(() => k.manageTask({ op: 'create', title: 'x', owner: 'nobody' }), /not a member/);

  /* ---------- priority orders what an idle member is offered ---------- */
  const urgent = k.manageTask({ op: 'create', title: 'hotfix' });
  k.manageTask({ op: 'priority', id: urgent.id, priority: 5 });
  a.equal(k.bus.availableTasks()[0].id, urgent.id, 'a higher-priority task is offered before an older one');

  /* ---------- reassign tells both members; unassign returns it to the pool ---------- */
  const moved = k.manageTask({ op: 'assign', id: owned.id, owner: 'tester' });
  a.equal(moved.owner, 'tester');
  a.match(inbox('tester').at(-1)?.body ?? '', /assigned to you/);
  a.match(inbox('coder').at(-1)?.body ?? '', /reassigned to tester by the sovereign\. Stop work on it\./,
    'the previous owner must be told to stop');
  const freed = k.manageTask({ op: 'assign', id: owned.id, owner: null });
  a.equal(freed.owner, null);
  a.equal(freed.state, 'pending');
  a.match(inbox('tester').at(-1)?.body ?? '', /unassigned by the sovereign/);

  /* ---------- drop and reopen ---------- */
  k.manageTask({ op: 'assign', id: loose.id, owner: 'coder' });
  const dropped = k.manageTask({ op: 'drop', id: loose.id });
  a.equal(dropped.state, 'dropped');
  a.equal(dropped.owner, null);
  a.match(inbox('coder').at(-1)?.body ?? '', /dropped by the sovereign/);
  a.throws(() => k.manageTask({ op: 'assign', id: loose.id, owner: 'coder' }), /reopen it first/,
    'a dropped task cannot be handed out without reopening it');
  const reopened = k.manageTask({ op: 'reopen', id: loose.id });
  a.equal(reopened.state, 'pending');
  a.throws(() => k.manageTask({ op: 'reopen', id: loose.id }), /not closed/);
  a.throws(() => k.manageTask({ op: 'drop', id: 9999 }), /No task #9999/);
  a.throws(() => k.manageTask({ op: 'teleport', id: loose.id }), /Unknown task operation/);
  console.log('t-task-admin.js OK — the sovereign can create, assign, reprioritise, drop and reopen, and members are told');
} finally {
  await k.stop();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
