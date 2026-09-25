// Desktop notifications (ui/notify.js): which stream events reach the OS.
//
// The run cases are the reason this suite exists. A 'run' event fires for far
// more than state changes, so a notification must mean the run MOVED into
// blocked, ready_for_review or completed, and a (re)connect snapshot must set
// the baseline without announcing a run that was already blocked.
//
//   node test/t-notify.js
import { strict as a } from 'node:assert';

const shown = [];
globalThis.Notification = class {
  static permission = 'granted';
  constructor(title, options) { shown.push({ title, body: options.body, tag: options.tag }); }
  close() {}
};
globalThis.document = { visibilityState: 'hidden', hasFocus: () => false };
globalThis.window = { focus() {} };

const Notify = await import('../ui/notify.js');
const take = () => shown.splice(0);

/* ---------- a run moving into blocked, carrying its reason ---------- */
{
  Notify.onEvent({ type: 'snapshot', run: { id: 'r1', state: 'running', objective: 'ship it' } });
  a.equal(take().length, 0, 'a snapshot sets the baseline and never notifies');

  Notify.onEvent({ type: 'run', id: 'r1', state: 'blocked', objective: 'ship it',
    blocker: { operation: 'verification of coder', next: 'fix the failing test' } });
  const [blocked] = take();
  a.equal(blocked?.title, 'Run blocked', 'a run entering blocked must notify');
  a.match(blocked.body, /verification of coder/, 'the notification says why');
  a.match(blocked.body, /Next: fix the failing test/, 'and what to do next');

  Notify.onEvent({ type: 'run', id: 'r1', state: 'blocked', objective: 'ship it' });
  a.equal(take().length, 0, 'a repeat event for the same state is not a second notification');
}

/* ---------- the daemon's { run } envelope shape is read too ---------- */
{
  Notify.onEvent({ type: 'run', run: { id: 'r1', state: 'running' } });
  Notify.onEvent({ type: 'run', run: { id: 'r1', state: 'verifying' } });
  a.equal(take().length, 0, 'running and verifying are not notification states');
  Notify.onEvent({ type: 'run', run: { id: 'r1', state: 'ready_for_review', objective: 'ship it' } });
  const [review] = take();
  a.equal(review?.title, 'Run ready for review');
  a.match(review.body, /final approval/);
}

/* ---------- a reconnect while already blocked is not news ---------- */
{
  Notify.onEvent({ type: 'snapshot', run: { id: 'r2', state: 'blocked' } });
  Notify.onEvent({ type: 'run', id: 'r2', state: 'blocked', objective: 'evidence updated' });
  a.equal(take().length, 0, 'a run already blocked at connect must not notify on its next event');
}

/* ---------- completed is opt-in; the toggles are honoured ---------- */
{
  Notify.onEvent({ type: 'run', id: 'r1', state: 'completed', objective: 'ship it' });
  a.equal(take().length, 0, 'completed is off by default');
  Notify.setPref({ runCompleted: true, runBlocked: false });
  Notify.onEvent({ type: 'run', id: 'r3', state: 'completed', objective: 'tidy up' });
  a.equal(take()[0]?.title, 'Run completed', 'turning it on delivers it');
  Notify.onEvent({ type: 'run', id: 'r3', state: 'blocked', objective: 'tidy up' });
  a.equal(take().length, 0, 'turning blocked off silences it');
  const prefs = Notify.settings();
  a.equal(prefs.runReview, true, 'review stays on by default');
  a.equal(prefs.runCompleted, true);
  a.equal(prefs.runBlocked, false);
  Notify.setPref({ runCompleted: false, runBlocked: true });
}

/* ---------- a focused window gets nothing ---------- */
{
  globalThis.document = { visibilityState: 'visible', hasFocus: () => true };
  Notify.onEvent({ type: 'run', id: 'r4', state: 'blocked', objective: 'watched' });
  a.equal(take().length, 0, 'nothing is sent while the window is focused');
  globalThis.document = { visibilityState: 'hidden', hasFocus: () => false };
}

/* ---------- the run spend ceiling names the run, not an undefined member ---------- */
{
  Notify.onEvent({ type: 'budget', scope: 'run', runId: 'r5', spent: 1.2, cap: 1 });
  const [budget] = take();
  a.equal(budget?.title, 'Run spend ceiling reached');
  a.doesNotMatch(budget.title + budget.body, /undefined|Everyone stopped/,
    'a run ceiling stops the run only; it must not read as a member or a court-wide stop');
}

/* ---------- a digest an automation built ---------- */
{
  Notify.onEvent({ type: 'digest', title: 'Your morning brief', body: '2 things need you' });
  const [brief] = take();
  a.equal(brief?.title, 'Your morning brief');
  a.equal(brief.body, '2 things need you');
  Notify.setPref({ digests: false });
  Notify.onEvent({ type: 'digest', title: 'Team digest', body: 'x' });
  a.equal(take().length, 0, 'digests can be turned off');
  Notify.setPref({ digests: true });
}

console.log('t-notify.js OK — runs notify on entering blocked, review and (opt-in) completed, once, never from a snapshot');
