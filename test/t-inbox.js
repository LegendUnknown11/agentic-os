// The Inbox: everything inside the app waiting on the sovereign, ranked
// (src/inbox.js). Pure, so every ranking rule is pinned here.
//
//   node test/t-inbox.js
import { strict as a } from 'node:assert';
import { inboxBrief, inboxItems, teamDigest } from '../src/inbox.js';

const now = 100 * 86_400_000;
const H = 3_600_000;

/* ---------- empty is said, not blank ---------- */
a.deepEqual(inboxItems({ now }), []);
a.equal(inboxBrief([], { now }), 'Nothing is waiting on you.');

/* ---------- ranking across every source ---------- */
const items = inboxItems({
  now,
  run: { id: 'r1', state: 'blocked', objective: 'ship the importer', blocker: { operation: 'verification of coder', next: 'fix the test', at: now - H } },
  approvals: [
    { id: 9, ts: now - 2 * H, from: 'orchestrator', kind: 'summon', names: ['coder', 'tester'], reason: 'two files' },
    { id: 4, ts: now - 5 * H, from: 'orchestrator', kind: 'question', questions: [{ question: 'Which database?' }] },
    { id: 3, ts: now - 9 * H, from: 'coder', kind: 'merge', peasant: 'coder', resolved: 'approved' },
  ],
  myTasks: [
    { id: 1, title: 'call the bank', dueTs: now - H },
    { id: 2, title: 'renew domain', dueTs: now + 2 * H, notes: 'expires Friday' },
    { id: 3, title: 'far off', dueTs: now + 5 * 86_400_000 },
    { id: 4, title: 'snoozed', dueTs: now - H, snoozedUntil: now + H },
    { id: 5, title: 'done already', dueTs: now - H, doneTs: now - 1 },
    { id: 6, title: 'no date' },
  ],
  messages: [
    { id: 70, ts: now - 2 * 86_400_000, sender: 'workflow:old', body: 'stale' },
    { id: 71, ts: now - 3 * H, sender: 'workflow:digest', body: 'yesterday: 3 tasks done' },
    { id: 72, ts: now - H, sender: 'orchestrator', body: 'the plan is ready\n\nsee thread' },
  ],
});
a.deepEqual(items.map((i) => i.id), [
  'run:r1',                       // a blocked run stops the most work
  'approval:4', 'approval:9',     // decisions, oldest waiting first
  'mine:1',                       // your overdue task
  'mine:2',                       // due within a day
  'message:72', 'message:71',     // messages, newest first
]);
a.equal(items[0].tone, 'attention');
a.match(items[0].detail, /verification of coder\. Next: fix the test/, 'a blocked run says why and what next');
a.equal(items[1].title, 'Which database?', 'a question reads as the question');
a.equal(items[1].kind, 'question');
a.equal(items[2].title, 'Summon coder, tester');
a.match(items[2].detail, /Team request from orchestrator: two files/);
a.equal(items[4].tone, 'live');
a.equal(items[4].detail, 'expires Friday');
a.equal(items[5].detail, 'the plan is ready see thread', 'messages flatten to one line');
a.ok(!items.some((i) => i.id === 'approval:3'), 'a resolved approval is not waiting on anyone');
a.ok(!items.some((i) => ['mine:3', 'mine:4', 'mine:5', 'mine:6'].includes(i.id)), 'far-off, snoozed, done and undated tasks stay out');
a.ok(!items.some((i) => i.id === 'message:70'), 'messages older than a day stay out');

/* ---------- a run ready for review ranks after decisions and overdue tasks ---------- */
const review = inboxItems({ now, run: { id: 'r2', state: 'ready_for_review', objective: 'x' }, myTasks: [{ id: 1, title: 'late', dueTs: now - 1 }] });
a.deepEqual(review.map((i) => i.id), ['mine:1', 'run:r2']);
a.equal(review[1].href, '#changes', 'review opens where the final review lives');

/* ---------- the brief ---------- */
const brief = inboxBrief(items, { now, max: 3 });
a.match(brief, /^4 things need you \(/, 'the headline counts what is actually blocked on you, not messages');
a.equal(brief.split('\n').length, 5, 'headline, three items, and a pointer to the rest');
a.match(brief, /…and 4 more in the Inbox\.$/);
a.match(inboxBrief([{ rank: 5, title: 'From x', detail: 'hi' }], { now }), /^Nothing is blocked on you/);

/* ---------- the team digest ---------- */
{
  const digest = teamDigest({
    now,
    tasks: [
      { id: 1, state: 'done', done_ts: now - H, title: 'fix the parser', ts: now - 3 * H },
      { id: 2, state: 'done', done_ts: now - 3 * 86_400_000, title: 'old work', ts: now - 4 * 86_400_000 },
      { id: 3, state: 'pending', blockedBy: [4], title: 'test it', ts: now - 2 * H },
      { id: 4, state: 'active', blockedBy: [], title: 'build it', ts: now - 30 * H },
      { id: 5, state: 'dropped', title: 'abandoned', ts: now - H },
    ],
    runs: [
      { id: 'r0', state: 'completed', completedTs: now - 2 * H, objective: 'old' },
      { id: 'r1', state: 'ready_for_review', objective: 'ship the importer' },
    ],
    runSpendUsd: 2.1, waiting: 3,
  });
  const lines = digest.split('\n');
  a.match(lines[0], /^Team digest \(\d{4}-\d{2}-\d{2}\)\.$/);
  a.equal(lines[1], 'Finished: 1 — fix the parser', 'only work finished in the last day');
  a.equal(lines[2], 'Queue: 2 open (1 waiting on a dependency), 3 added in the last day', 'dropped is not open');
  a.equal(lines[3], 'Run: ship the importer — ready for review; closed in the last day: 1 completed, 0 cancelled');
  a.equal(lines[4], 'Run spend in the last day: $2.10');
  a.equal(lines[5], 'Waiting on you: 3 — open the Inbox.');
  a.match(teamDigest({ now }), /Finished: 0\nQueue: 0 open, 0 added in the last day\nRun: none in progress\n.*\$0\.00\nNothing is waiting on you\.$/,
    'an idle day still reads as a full, honest digest');
}

console.log('t-inbox.js OK — blocked run, decisions, overdue, review, due today, messages; resolved, snoozed, done and stale stay out');
