import { h, page, section, empty, note, button, input, select, date, mdToHtml, displayName, get, subscribe, editing, tone, apiError, requestToken } from './util.js';

const DEFAULT_KINDS = 'summary,message,done,error';
function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

async function loadActivity(state, root, query, kinds) {
  const token = requestToken(state, 'activityRequest');
  const result = await get(`/api/log?kinds=${encodeURIComponent(kinds)}&q=${encodeURIComponent(query)}`);
  if (!root.isConnected || state.activityRequest !== token) return;
  state.activityLoading = false;
  state.activityError = apiError(result, 'Could not load activity.');
  if (!state.activityError) state.activity = result;
  renderActivity(state, root);
}

export function renderActivity(state, root) {
  root.replaceChildren();
  const shell = page('Activity', 'Search summaries, messages, completions, and errors.');
  const search = input(state.activityQuery ?? '', 'Search the log…');
  const filters = select([[DEFAULT_KINDS, 'Everything'], ['summary', 'Summaries'], ['message', 'Messages'], ['error', 'Errors'], ['done', 'Done']], state.activityKinds ?? DEFAULT_KINDS);
  search.setAttribute('aria-label', 'Search activity');
  filters.setAttribute('aria-label', 'Filter activity');
  const searchButton = button('Search', () => form.requestSubmit(), 'primary');
  search.disabled = filters.disabled = searchButton.disabled = Boolean(state.activityLoading);
  if (state.activityLoading) searchButton.textContent = 'Searching…';
  const form = h('form', { class: 'search-row', on: { submit: async (event) => {
    event.preventDefault();
    search.disabled = filters.disabled = searchButton.disabled = true;
    searchButton.textContent = 'Searching…';
    state.activityQuery = search.value;
    state.activityKinds = filters.value;
    state.activityLoading = true;
    renderActivity(state, root);
    await loadActivity(state, root, state.activityQuery, state.activityKinds);
  } } }, search, filters, searchButton);
  shell.append(form);
  const data = state.activity ?? {};
  const activityRows = Array.isArray(data.rows) ? data.rows : [];
  if (state.activityLoading) { shell.append(section('Timeline', empty('Loading activity…'))); root.append(shell); return; }
  const loadFailure = state.activityError ?? apiError(data, 'Could not load activity.');
  if (loadFailure) {
    const retry = button('Retry', () => {
      state.activityLoading = true;
      renderActivity(state, root);
      return loadActivity(state, root, state.activityQuery ?? '', state.activityKinds ?? DEFAULT_KINDS);
    }, 'primary');
    shell.append(h('div', { class: 'button-row' }, note(loadFailure, 'danger'), retry));
    if (!state.activity || state.activity?.ok === false) { root.append(shell); return; }
  }
  const body = section(data.total ? `${data.total} results` : 'Timeline');
  if (!activityRows.length) body.append(empty(data.query ? `Nothing matches “${data.query}”.` : 'Nothing has happened yet.'));
  for (const row of activityRows) body.append(h('article', { class: `activity-row ${row.kind ?? ''} ${tone(row.kind)}`.trim() }, h('div', { class: 'card-meta', text: `${displayName(row.who)}${row.to ? ` → ${displayName(row.to)}` : ''} · ${date(row.ts)}` }), h('div', { class: 'markdown', html: mdToHtml(row.text) })));
  shell.append(body); root.append(shell);
}

export function mountActivity(state, root) {
  state.activityLoading = true;
  state.activityError = null;
  renderActivity(state, root);
  const off = bind(state, root, renderActivity);
  void loadActivity(state, root, state.activityQuery ?? '', state.activityKinds ?? DEFAULT_KINDS);
  return () => {
    requestToken(state, 'activityRequest');
    state.activityLoading = false;
    off?.();
  };
}
export const render = renderActivity;
export const mount = mountActivity;
