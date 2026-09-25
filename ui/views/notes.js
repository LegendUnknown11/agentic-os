import { h, page, empty, note, button, input, get, subscribe, editing, apiError, requestToken } from './util.js';

function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

async function loadDetail(state, root, path) {
  const notePath = String(path ?? '').trim();
  if (!notePath) return;
  const token = requestToken(state, 'notesRequest');
  state.notesDetail = { path: notePath, loading: true };
  renderNotes(state, root);
  const detail = await get(`/api/vault?path=${encodeURIComponent(notePath)}`);
  if (!root.isConnected || state.notesRequest !== token || state.notesDetail?.path !== notePath) return;
  const error = apiError(detail, 'Could not read note.');
  state.notesDetail = error
    ? { path: notePath, error }
    : { path: detail.path ?? notePath, body: detail.body ?? '' };
  renderNotes(state, root);
}

export function renderNotes(state, root) {
  root.replaceChildren();
  const shell = page('Notes', 'Browse your team’s durable notes.');
  const search = input(state.notesQuery ?? '', 'Search notes…');
  search.setAttribute('aria-label', 'Search notes');
  search.disabled = Boolean(state.notesLoading);
  const body = h('div', { class: 'notes-body' });
  async function list() {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Loading…';
    const token = requestToken(state, 'notesRequest');
    state.notesQuery = search.value.trim();
    state.notesDetail = null;
    state.notesLoading = true;
    renderNotes(state, root);
    const result = await get(`/api/vault${state.notesQuery ? `?q=${encodeURIComponent(state.notesQuery)}` : ''}`);
    if (!root.isConnected || state.notesRequest !== token) return;
    state.notesLoading = false;
    state.notesError = apiError(result, 'Could not load notes.');
    if (!state.notesError) state.notes = result;
    renderNotes(state, root);
  }
  const refreshButton = button('Refresh', list);
  refreshButton.disabled = Boolean(state.notesLoading);
  if (state.notesLoading) refreshButton.textContent = 'Loading…';
  search.addEventListener('input', () => {
    clearTimeout(state.notesTimer);
    state.notesTimer = setTimeout(() => { state.notesTimer = null; list(); }, 220);
  });
  shell.append(h('div', { class: 'search-row' }, search, refreshButton), body);
  const data = state.notes ?? {};
  if (state.notesDetail) {
    const detail = state.notesDetail;
    body.append(button('‹ back', () => { state.notesDetail = null; renderNotes(state, root); }, 'link'));
    if (detail.loading) body.append(empty('Loading note…'));
    else if (detail.error) body.append(h('div', { class: 'button-row' }, note(detail.error, 'danger'), button('Retry', () => loadDetail(state, root, detail.path), 'primary')));
    else body.append(h('h2', { text: detail.path }), h('pre', { class: 'note-body', text: detail.body }));
  } else {
    if (state.notesLoading) body.append(empty('Loading notes…'));
    else {
      const loadFailure = state.notesError ?? apiError(data, 'Could not load notes.');
      if (loadFailure) body.append(h('div', { class: 'button-row' }, note(loadFailure, 'danger'), button('Retry', list, 'primary')));
      else if (!data.configured) body.append(empty('No notes folder configured.'));
      else if (!data.notes?.length) body.append(empty(state.notesQuery ? 'Nothing matches.' : 'No notes found.'));
      else data.notes.forEach((n) => {
        const row = button(n.path, () => loadDetail(state, root, n.path), 'list-row');
        if (n.lines?.[0]?.text) row.append(h('span', { class: 'muted', text: n.lines[0].text }));
        body.append(row);
      });
    }
  }
  root.append(shell);
}

export function mountNotes(state, root) {
  state.notesLoading = true;
  state.notesError = null;
  renderNotes(state, root);
  const off = bind(state, root, renderNotes);
  const token = requestToken(state, 'notesRequest');
  void get('/api/vault').then((result) => {
    if (!root.isConnected || state.notesRequest !== token) return;
    state.notesLoading = false;
    state.notesError = apiError(result, 'Could not load notes.');
    if (!state.notesError) state.notes = result;
    renderNotes(state, root);
  });
  return () => {
    clearTimeout(state.notesTimer);
    state.notesTimer = null;
    state.notesDetail = null;
    requestToken(state, 'notesRequest');
    off?.();
  };
}
export const render = renderNotes;
export const mount = mountNotes;
