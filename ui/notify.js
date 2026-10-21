// Desktop notifications for the things that stall the team while you are not
// looking at the window.
//
// Deliberately narrow. A notification for every event would be noise you learn
// to dismiss without reading, and then the one that mattered gets dismissed
// too. Only four things qualify: something is WAITING on you, something BROKE,
// something was REFUSED, or the money ran out. A run reaching blocked or
// ready-for-review is the first kind; a completed run is opt-in, like merges.
import { setPrefs, state } from './store.js';

const prefs = () => ({
  approvals: true, failures: true, budget: true, done: false,
  runBlocked: true, runReview: true, runCompleted: false, digests: true,
  ...(state.prefs.notifications ?? {}),
});
export const settings = () => ({ ...prefs(), permission: perm() });

export const perm = () =>
  (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

export function setPref(patch) {
  setPrefs({ notifications: { ...prefs(), ...patch } });
}

/** Asking on page load is the thing everyone blocks, so this is only ever
 *  called from an explicit click in the settings panel. */
export async function request() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

// The window being focused means you are already looking; notifying then is
// pure noise.
const away = () => document.visibilityState !== 'visible' || !document.hasFocus();

// Identical alerts can arrive in bursts (an error storm, a rate limit hitting
// every member at once). Collapse repeats of the same text.
const recent = new Map();
const REPEAT_MS = 20_000;

function fire(title, body, tag) {
  if (perm() !== 'granted' || !away()) return false;
  const key = `${tag}:${body}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < REPEAT_MS) return false;
  recent.set(key, now);
  // Keyed on the message BODY, so a day of distinct errors is a day of distinct
  // keys and this map only ever grew. Anything older than the window it exists
  // to enforce can no longer suppress anything.
  for (const [k, t] of recent) if (now - t >= REPEAT_MS) recent.delete(k);
  try {
    const n = new Notification(title, { body: String(body ?? '').slice(0, 220), tag, silent: false });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch {
    return false;
  }
}

// The last state seen per run. A 'run' event fires for more than state changes
// (evidence, recovery, approvals), so a notification needs an actual move INTO
// a state, and the snapshot on (re)connect sets the baseline without firing:
// a run that was already blocked before the window connected is not news.
const runStates = new Map();
const RUN_ALERTS = {
  blocked: { pref: 'runBlocked', tag: 'run-blocked', title: 'Run blocked',
    body: (run) => [run.blocker?.operation, run.blocker?.next && `Next: ${run.blocker.next}`].filter(Boolean).join('. ') || run.objective || 'The run needs you.' },
  ready_for_review: { pref: 'runReview', tag: 'run-review', title: 'Run ready for review',
    body: (run) => `${run.objective || 'The run'} passed verification and waits for your final approval.` },
  completed: { pref: 'runCompleted', tag: 'run-done', title: 'Run completed',
    body: (run) => `${run.objective || 'The run'} was applied.` },
};

function runMoved(run, enabled) {
  if (!run?.id) return false;
  const previous = runStates.get(run.id);
  runStates.set(run.id, run.state);
  const alert = RUN_ALERTS[run.state];
  if (!alert || previous === run.state || !enabled[alert.pref]) return false;
  return fire(alert.title, alert.body(run), alert.tag);
}

/**
 * Route one stream event. Returns true if something was shown, which is only
 * used by the test hook — callers do not care.
 */
export function onEvent(d) {
  const enabled = prefs();
  switch (d.type) {
    case 'snapshot':
      if (d.run?.id) runStates.set(d.run.id, d.run.state);
      return false;

    case 'run':
      return runMoved(d.run ?? d, enabled);

    case 'approval':
      return enabled.approvals && fire('The team is waiting on you',
        `${d.from ?? 'A member'} asks to ${d.kind ?? 'proceed'}.`, 'approval');

    case 'failure':
      return enabled.failures && fire(`${d.name} has failed`, d.message, 'failure');

    case 'mergeFailed':
      return enabled.failures && fire('Merge refused', `${d.agent}: ${d.message}`, 'merge');

    case 'limited':
      return enabled.failures && fire(`${d.name} is rate limited`,
        `Resets ${d.resetsAt}. Retrying will not help.`, 'limited');

    case 'budget':
      if (d.scope === 'quota') {
        return enabled.budget && fire(`${d.label} quota reached`,
          `${(d.used ?? 0).toLocaleString()} of ${(d.cap ?? 0).toLocaleString()} tokens. ${d.cli} members stopped.`, 'budget');
      }
      if (d.scope === 'run') {
        return enabled.budget && fire('Run spend ceiling reached',
          `$${(d.spent ?? 0).toFixed(2)} of $${d.cap}. The run is blocked; other work continues.`, 'budget');
      }
      return enabled.budget && fire(
        d.scope === 'total' ? 'Team spend ceiling reached' : `${d.name} hit its ceiling`,
        `$${(d.spent ?? 0).toFixed(2)} of $${d.cap}. Everyone stopped.`, 'budget');

    // A brief or digest an automation built for you (src/workflows.js digest).
    case 'digest':
      return enabled.digests && fire(d.title || 'Your brief', d.body, 'digest');

    case 'merged':
      return enabled.done && fire('Merged', `${d.agent} is in the base branch.`, 'done');

    default:
      return false;
  }
}
