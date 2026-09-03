import { h, page, section, empty, note, button, input, mdToHtml, displayName, date, get, subscribe, editing } from './util.js';

const apiError = (result, fallback) => result?.ok === false ? result.error ?? fallback : null;
const requestToken = (state, key) => { state[key] = (state[key] ?? 0) + 1; return state[key]; };
function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

export function renderMemory(state, root) {
  root.replaceChildren();
  const shell = page('Memory', 'Search your team’s history and the notes it can cite.');
  const search = input(state.memoryQuery ?? '', 'Search history…');
  search.setAttribute('aria-label', 'Search memory');
  search.disabled = Boolean(state.memoryLoading);
  const searchButton = button('Search', () => form.requestSubmit(), 'primary');
  searchButton.disabled = Boolean(state.memoryLoading);
  if (state.memoryLoading) searchButton.textContent = 'Searching…';
  async function runSearch(query) {
    const token = requestToken(state, 'memoryRequest');
    state.memoryQuery = String(query ?? '').trim();
    state.memoryLoading = true;
    state.memoryError = null;
    state.memory = {};
    renderMemory(state, root);
    let pending = 2;
    const settle = (key, result, fallback) => {
      if (!root.isConnected || state.memoryRequest !== token) return;
      state.memory = { ...(state.memory ?? {}), [key]: result };
      const error = apiError(result, fallback);
      if (error) state.memoryError = [state.memoryError, error].filter(Boolean).join(' ');
      pending -= 1;
      if (!pending) state.memoryLoading = false;
      renderMemory(state, root);
    };
    get(`/api/recall?q=${encodeURIComponent(state.memoryQuery)}`).then((result) => settle('recall', result, 'Could not search history.'));
    get(`/api/vault?q=${encodeURIComponent(state.memoryQuery)}`).then((result) => settle('vault', result, 'Could not search notes.'));
  }
  const form = h('form', { class: 'search-row', on: { submit: async (event) => {
    event.preventDefault();
    await runSearch(search.value);
  } } }, search, searchButton);
  shell.append(form);
  const data = state.memory ?? {};
  if (state.memoryError) shell.append(h('div', { class: 'button-row' }, note(state.memoryError, 'danger'), button('Retry', () => runSearch(state.memoryQuery), 'primary')));
  const history = section('History');
  const recallFailure = apiError(data.recall, 'Could not search history.');
  if (state.memoryLoading && !data.recall) history.append(empty('Searching history…'));
  else if (recallFailure) history.append(note(recallFailure, 'danger'));
  else if (!data.recall?.hits?.length) history.append(empty(state.memoryQuery ? 'Nothing matches in history.' : 'Search what the team has said or done.'));
  for (const hit of data.recall?.hits ?? []) history.append(h('article', { class: 'activity-row' }, h('div', { class: 'card-meta', text: `${displayName(hit.who)} · ${date(hit.ts)}` }), h('div', { class: 'markdown', html: mdToHtml(hit.text) })));
  shell.append(history);
  const vaultFailure = apiError(data.vault, 'Could not search notes.');
  if (state.memoryLoading && !data.vault) shell.append(section('Notes', empty('Searching notes…')));
  else if (vaultFailure) shell.append(section('Notes', note(vaultFailure, 'danger')));
  else if (data.vault?.configured) shell.append(section('Notes', ...(data.vault.notes?.length ? data.vault.notes.map((n) => h('a', { class: 'vault-link', href: '#notes', 'data-vault': n.path }, h('b', { text: n.path }), n.lines?.[0]?.text && h('span', { class: 'muted', text: n.lines[0].text }))) : [empty('Nothing matches in notes.')] )));
  root.append(shell);
}

export function mountMemory(state, root) {
  state.memoryLoading = false;
  state.memoryError = null;
  renderMemory(state, root);
  const off = bind(state, root, renderMemory);
  return () => {
    requestToken(state, 'memoryRequest');
    state.memoryLoading = false;
    off?.();
  };
}
export const render = renderMemory;
export const mount = mountMemory;
