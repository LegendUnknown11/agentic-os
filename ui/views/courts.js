// Multiple courts at once (issue #42) — a small switcher panel reachable
// from Settings' Repository panel. It never ends the CURRENT court: opening
// or starting another one runs alongside whatever is already running, and
// only the dedicated "End…" action per row is destructive.
//
// This is a thin view onto electron/main.js's `courts:list/open/end` IPC
// (see electron/court-preload.cjs) backed by src/courts.js's registry — not
// a source of truth this file owns. Outside Electron (a plain browser tab,
// which is how Playwright and a developer verify this UI) `window
// .kingdomShell` does not exist at all, so this degrades to a visible note
// instead of silently doing nothing — see HANDOFF.md rule 3.
import { h, note, button, empty } from './util.js';

const hasShell = () => typeof window !== 'undefined' && Boolean(window.kingdomShell?.listCourts);

/** Fetch the live court list into `state.courts` and call back so the
 *  caller can re-render. Fire-and-forget: a stale or momentarily-failed
 *  fetch here must never block anything else in Settings from working. */
export function refreshCourts(state, onDone) {
  if (!hasShell()) { onDone?.(); return; }
  window.kingdomShell.listCourts()
    .then((courts) => { state.courts = Array.isArray(courts) ? courts : []; })
    .catch(() => { state.courts = state.courts ?? []; })
    .finally(() => onDone?.());
}

/** What went wrong with a switcher action, or null when nothing did. A
 *  cancelled confirmation or picker is not an error. */
export const courtActionError = (result, fallback) => (result?.ok === false ? (result.error ?? fallback) : null);

/** Run one switcher action and keep its failure visible until the next one:
 *  a failed start, open or end used to reset the button and say nothing. */
async function runAction(state, rerender, fn, fallback) {
  try {
    state.courtsError = courtActionError(await fn(), fallback);
  } catch (e) {
    state.courtsError = e?.message ?? fallback;
  } finally {
    refreshCourts(state, rerender);
  }
}

function courtRow(state, court, rerender) {
  const label = court.repo ?? '(no repository attached)';
  const busy = { current: false };
  const withBusy = (fn, fallback) => async () => {
    if (busy.current) return;
    busy.current = true;
    try { await runAction(state, rerender, fn, fallback); } finally { busy.current = false; }
  };
  // Rows are addressed by PORT: a repo-less court has no path to name it, and
  // several repo-less courts can run at once.
  const openBtn = button(court.open ? 'Focus' : 'Open',
    withBusy(() => window.kingdomShell.focusCourt(court.port), 'Could not open that workspace.'), 'primary');
  const endBtn = button('End…',
    withBusy(() => window.kingdomShell.endCourt(court.port), 'Could not end that workspace.'));
  return h('div', { class: 'court-row' },
    h('div', { class: 'court-row-id' },
      h('span', { class: 'court-repo', text: label }),
      h('span', { class: 'court-port', text: `port ${court.port}` })),
    h('div', { class: 'button-row' }, openBtn, endBtn));
}

/**
 * The switcher itself: a list of live courts plus a "start another one"
 * control. `rerender` is called after every action so the list reflects
 * what actually happened rather than an optimistic guess.
 */
export function courtsSwitcher(state, rerender) {
  if (!hasShell()) {
    return note('Opening or ending another workspace is only available in the desktop app.');
  }
  const list = state.courts ?? [];
  const rows = list.length ? list.map((c) => courtRow(state, c, rerender)) : empty('No other workspaces are running right now.');

  const startBtn = button('Start a workspace for another repository…', async () => {
    startBtn.disabled = true;
    try {
      await runAction(state, rerender, async () => {
        const picked = await window.kingdomShell.chooseRepo();
        return picked?.path ? window.kingdomShell.openCourt(picked.path) : null;
      }, 'Could not start a workspace for that repository.');
    } finally {
      startBtn.disabled = false;
    }
  });

  return h('div', { class: 'courts-switcher' },
    ...(state.courtsError ? [note(state.courtsError, 'danger')] : []),
    h('div', { class: 'courts-list' }, ...(Array.isArray(rows) ? rows : [rows])),
    h('div', { class: 'button-row' }, startBtn));
}
