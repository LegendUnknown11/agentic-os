// The session inspector shows only what the daemon already knows. Its one piece
// of logic is Progress: the run's own tasks if it has any, else the run's
// lifecycle. Pure, so it is exercised directly.
//   node test/t-inspector.js
import { strict as a } from 'node:assert';
import { progressSteps, contextReading } from '../ui/inspector.js';

// no run and no tasks: nothing to show, not an invented checklist
a.deepEqual(progressSteps({}), [], 'nothing in progress is an empty list');
a.deepEqual(progressSteps({ tasks: [] }), []);

// a run with tasks lists its tasks: done, the one being worked, then the rest
const withTasks = {
  run: { id: 'r', status: 'running', taskIds: [1, 2, 3] },
  tasks: [
    { id: 1, title: 'Render template', state: 'done' },
    { id: 2, title: 'Publish snapshot', state: 'active' },
    { id: 3, title: 'Verify page', state: 'pending' },
    { id: 9, title: 'Someone else\'s task', state: 'active' },
  ],
};
a.deepEqual(progressSteps(withTasks), [
  { label: 'Render template', state: 'done' },
  { label: 'Publish snapshot', state: 'current' },
  { label: 'Verify page', state: 'todo' },
], 'only the run\'s own tasks, with exactly one in progress');
console.log('  a run\'s tasks read done, in progress, not started; other runs\' tasks are left out');

// only one task is ever "current", even if two are active
const two = { run: { taskIds: [1, 2] }, tasks: [{ id: 1, title: 'A', state: 'active' }, { id: 2, title: 'B', state: 'active' }] };
a.deepEqual(progressSteps(two).map((s) => s.state), ['current', 'todo']);
// closed tasks (done, dropped) are both finished
a.deepEqual(progressSteps({ run: { taskIds: [1, 2] }, tasks: [{ id: 1, title: 'A', state: 'done' }, { id: 2, title: 'B', state: 'dropped' }] }).map((s) => s.state), ['done', 'done']);

// a run with no tasks falls back to the lifecycle, positioned by the run's state
const stage = (status) => progressSteps({ run: { id: 'r', status } }).map((s) => `${s.label}:${s.state}`).join(' ');
a.equal(stage('planning'), 'Plan:current Run:todo Verify:todo Review:todo Done:todo');
a.equal(stage('running'), 'Plan:done Run:current Verify:todo Review:todo Done:todo');
a.equal(stage('blocked'), 'Plan:done Run:current Verify:todo Review:todo Done:todo', 'a blocked run is still in its Run stage');
a.equal(stage('verifying'), 'Plan:done Run:done Verify:current Review:todo Done:todo');
a.equal(stage('ready_for_review'), 'Plan:done Run:done Verify:done Review:current Done:todo');
a.equal(stage('completed'), 'Plan:done Run:done Verify:done Review:done Done:current');
console.log('  with no tasks, the lifecycle is positioned by the run\'s state');

// a long task list is bounded
const many = { tasks: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `T${i + 1}`, state: 'pending' })) };
a.equal(progressSteps(many).length, 12, 'the card shows at most twelve steps');

// the context meter: tokens against a known window, or plainly unknown
const known = contextReading({ context: { orchestrator: { tokens: 250_000, window: 1_000_000 } } });
a.deepEqual([known.tokens, known.window, known.pct], [250_000, 1_000_000, 25]);
a.equal(known.text, '250k of 1.0M · 25%');
const unknown = contextReading({ context: { orchestrator: { tokens: 42_000, window: null } } });
a.equal(unknown.pct, null, 'no window, no percent — never a guessed one');
a.equal(unknown.text, '42k · window unknown');
a.equal(contextReading({}).text, 'not measured yet', 'nothing streamed is not zero');
a.equal(contextReading({ context: { coder: { tokens: 9_000, window: 200_000 } } }, 'coder').pct, 4.5, 'any member can be read');
console.log('  the context meter reads tokens of a known window, or says the window is unknown');

console.log('t-inspector.js OK — Progress is the run\'s own work, or its lifecycle, and never invented');
