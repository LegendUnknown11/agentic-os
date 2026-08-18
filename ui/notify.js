// Desktop notifications for the things that stall the court while you are not
// looking at the window.
//
// Deliberately narrow. A notification for every event would be noise you learn
// to dismiss without reading, and then the one that mattered gets dismissed
// too. Only four things qualify: something is WAITING on you, something BROKE,
// something was REFUSED, or the money ran out.
const KEY = 'kd.notify';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };

const prefs = { approvals: true, failures: true, budget: true, done: false, ...load() };
export const settings = () => ({ ...prefs, permission: perm() });

export const perm = () =>
  (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

export function setPref(patch) {
  Object.assign(prefs, patch);
  localStorage.setItem(KEY, JSON.stringify(prefs));
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

/**
 * Route one stream event. Returns true if something was shown, which is only
 * used by the test hook — callers do not care.
 */
export function onEvent(d) {
  switch (d.type) {
    case 'approval':
      return prefs.approvals && fire('The team is waiting on you',
        `${d.from ?? 'A member'} asks to ${d.kind ?? 'proceed'}.`, 'approval');

    case 'failure':
      return prefs.failures && fire(`${d.name} has failed`, d.message, 'failure');

    case 'mergeFailed':
      return prefs.failures && fire('Merge refused', `${d.peasant}: ${d.message}`, 'merge');

    case 'limited':
      return prefs.failures && fire(`${d.name} is rate limited`,
        `Resets ${d.resetsAt}. Retrying will not help.`, 'limited');

    case 'budget':
      return prefs.budget && fire(
        d.scope === 'kingdom' ? 'Team spend ceiling reached' : `${d.name} hit its ceiling`,
        `$${(d.spent ?? 0).toFixed(2)} of $${d.cap}. Everyone stopped.`, 'budget');

    case 'merged':
      return prefs.done && fire('Merged', `${d.peasant} is in the base branch.`, 'done');

    default:
      return false;
  }
}
