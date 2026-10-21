// Multiple teams at once (issue #42) — a small switcher panel reachable
// from Settings' Repository panel. It never ends the CURRENT team: opening
// or starting another one runs alongside whatever is already running, and
// only the dedicated "End…" action per row is destructive.
//
// This is a thin view onto electron/main.js's `teams:list/open/end` IPC
// (see electron/team-preload.cjs) backed by src/teams.js's registry — not
// a source of truth this file owns. Outside Electron (a plain browser tab,
// which is how Playwright and a developer verify this UI) `window
// .agenticosShell` does not exist at all, so this degrades to a visible note
// instead of silently doing nothing — see HANDOFF.md rule 3.
import { h, note, button, empty } from './util.js';

const hasShell = () => typeof window !== 'undefined' && Boolean(window.agenticosShell?.listTeams);

/** Fetch the live team list into `state.teams` and call back so the
 *  caller can re-render. Fire-and-forget: a stale or momentarily-failed
 *  fetch here must never block anything else in Settings from working. */
export function refreshTeams(state, onDone) {
  if (!hasShell()) { onDone?.(); return; }
  window.agenticosShell.listTeams()
    .then((teams) => { state.teams = Array.isArray(teams) ? teams : []; })
    .catch(() => { state.teams = state.teams ?? []; })
    .finally(() => onDone?.());
}

/** What went wrong with a switcher action, or null when nothing did. A
 *  cancelled confirmation or picker is not an error. */
export const teamActionError = (result, fallback) => (result?.ok === false ? (result.error ?? fallback) : null);

/** Run one switcher action and keep its failure visible until the next one:
 *  a failed start, open or end used to reset the button and say nothing. */
async function runAction(state, rerender, fn, fallback) {
  try {
    state.teamsError = teamActionError(await fn(), fallback);
  } catch (e) {
    state.teamsError = e?.message ?? fallback;
  } finally {
    refreshTeams(state, rerender);
  }
}

function teamRow(state, team, rerender) {
  const label = team.repo ?? '(no repository attached)';
  const busy = { current: false };
  const withBusy = (fn, fallback) => async () => {
    if (busy.current) return;
    busy.current = true;
    try { await runAction(state, rerender, fn, fallback); } finally { busy.current = false; }
  };
  // Rows are addressed by PORT: a repo-less team has no path to name it, and
  // several repo-less teams can run at once.
  const openBtn = button(team.open ? 'Focus' : 'Open',
    withBusy(() => window.agenticosShell.focusTeam(team.port), 'Could not open that workspace.'), 'primary');
  const endBtn = button('End…',
    withBusy(() => window.agenticosShell.endTeam(team.port), 'Could not end that workspace.'));
  return h('div', { class: 'team-row' },
    h('div', { class: 'team-row-id' },
      h('span', { class: 'team-repo', text: label }),
      h('span', { class: 'team-port', text: `port ${team.port}` })),
    h('div', { class: 'button-row' }, openBtn, endBtn));
}

/**
 * The switcher itself: a list of live teams plus a "start another one"
 * control. `rerender` is called after every action so the list reflects
 * what actually happened rather than an optimistic guess.
 */
export function teamsSwitcher(state, rerender) {
  if (!hasShell()) {
    return note('Opening or ending another workspace is only available in the desktop app.');
  }
  const list = state.teams ?? [];
  const rows = list.length ? list.map((c) => teamRow(state, c, rerender)) : empty('No other workspaces are running right now.');

  const startBtn = button('Start a workspace for another repository…', async () => {
    startBtn.disabled = true;
    try {
      await runAction(state, rerender, async () => {
        const picked = await window.agenticosShell.chooseRepo();
        return picked?.path ? window.agenticosShell.openTeam(picked.path) : null;
      }, 'Could not start a workspace for that repository.');
    } finally {
      startBtn.disabled = false;
    }
  });

  return h('div', { class: 'teams-switcher' },
    ...(state.teamsError ? [note(state.teamsError, 'danger')] : []),
    h('div', { class: 'teams-list' }, ...(Array.isArray(rows) ? rows : [rows])),
    h('div', { class: 'button-row' }, startBtn));
}
