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

function courtRow(state, court, rerender) {
  const label = court.repo ?? '(no repository attached)';
  const busy = { current: false };
  const withBusy = (fn) => async () => {
    if (busy.current) return;
    busy.current = true;
    try { await fn(); } finally { busy.current = false; refreshCourts(state, rerender); }
  };
  const openBtn = button(court.open ? 'Focus' : 'Open', withBusy(async () => {
    await window.kingdomShell.openCourt(court.repo);
  }), 'primary');
  const buttons = [openBtn];
  if (court.repo) {
    buttons.push(button('End…', withBusy(async () => {
      await window.kingdomShell.endCourt(court.repo);
    })));
  }
  return h('div', { class: 'court-row' },
    h('div', { class: 'court-row-id' },
      h('span', { class: 'court-repo', text: label }),
      h('span', { class: 'court-port', text: `port ${court.port}` })),
    h('div', { class: 'button-row' }, ...buttons));
}

/**
 * The switcher itself: a list of live courts plus a "start another one"
 * control. `rerender` is called after every action so the list reflects
 * what actually happened rather than an optimistic guess.
 */
export function courtsSwitcher(state, rerender) {
  if (!hasShell()) {
    return note('Opening or ending another court is only available in the desktop app.');
  }
  const list = state.courts ?? [];
  const rows = list.length ? list.map((c) => courtRow(state, c, rerender)) : empty('No other courts are running right now.');

  const startBtn = button('Start a court for another repository…', async () => {
    startBtn.disabled = true;
    try {
      const picked = await window.kingdomShell.chooseRepo();
      if (picked?.path) await window.kingdomShell.openCourt(picked.path);
    } finally {
      startBtn.disabled = false;
      refreshCourts(state, rerender);
    }
  });

  return h('div', { class: 'courts-switcher' },
    h('div', { class: 'courts-list' }, ...(Array.isArray(rows) ? rows : [rows])),
    h('div', { class: 'button-row' }, startBtn));
}
