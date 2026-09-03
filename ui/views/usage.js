import {
  h, page, section, empty, note, button, meter, kb, money, displayName,
  get, subscribe, editing,
} from './util.js';

const apiError = (result, fallback) => result?.ok === false ? result.error ?? fallback : null;
const requestToken = (state) => { state.metricsRequest = (state.metricsRequest ?? 0) + 1; return state.metricsRequest; };
const refresh = async (state, key, url) => { const result = await get(url); if (result?.ok !== false) state[key] = result; return result; };
function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

export function renderUsage(state, root) {
  root.replaceChildren();
  const m = state.metrics ?? {};
  const total = m.total ?? {};
  const shell = page('Usage', 'Real token totals, turns, spend, and subscription allowances.');
  if (state.metricsLoading) { shell.append(section('Usage', empty('Loading token totals…'))); root.append(shell); return; }
  const loadFailure = state.metricsError ?? apiError(m, 'Could not load usage.');
  if (loadFailure) {
    const retry = button('Retry', async () => {
      state.metricsLoading = true;
      state.metricsError = null;
      renderUsage(state, root);
      const data = await refresh(state, 'metrics', '/api/metrics');
      if (!root.isConnected) return;
      state.metricsLoading = false;
      state.metricsError = apiError(data, 'Could not load usage.');
      renderUsage(state, root);
    }, 'primary');
    shell.append(h('div', { class: 'button-row' }, note(loadFailure, 'danger'), retry));
    if (!state.metrics || state.metrics?.ok === false) { root.append(shell); return; }
  }
  const stats = h('div', { class: 'stats' }, ...[
    ['turns', total.turns ?? 0], ['input', kb(total.in)], ['output', kb(total.out)], ['spent', money(m.spent)],
  ].map(([label, value]) => h('div', { class: 'stat' }, h('b', { text: String(value) }), h('span', { text: label }))));
  shell.append(stats);
  if (m.cap) shell.append(meter((m.spent / m.cap) * 100, `${money(m.spent)} of ${money(m.cap)} budget`));
  if (m.quotas?.length) shell.append(section('Plan allowances', ...m.quotas.map((q) => h('div', { class: 'quota' }, h('div', { text: `${q.label} · ${kb(q.used)} / ${kb(q.limit)} tokens` }), q.pct == null ? null : meter(q.pct)))));
  const table = h('table', { class: 'data-table' }, h('thead', {}, h('tr', {}, ...['Agent', 'Turns', 'Input', 'Per turn', 'Context', 'Spent'].map((x) => h('th', { text: x })) )));
  const body = h('tbody');
  for (const member of m.members ?? []) body.append(h('tr', {}, h('td', { text: displayName(member.name, member.role) }), h('td', { text: member.turns }), h('td', { text: kb(member.in) }), h('td', { text: kb(member.perTurn) }), h('td', { text: member.ctx ? kb(member.ctx) : '—' }), h('td', { text: member.spent ? money(member.spent) : '—' })));
  table.append(body);
  shell.append(section('Per agent', m.members?.length ? h('div', { class: 'table-wrap' }, table) : empty('No turns recorded yet.')));
  root.append(shell);
}

export function mountUsage(state, root) {
  const token = requestToken(state);
  state.metricsLoading = true;
  state.metricsError = null;
  renderUsage(state, root);
  const off = bind(state, root, renderUsage);
  void get('/api/metrics').then((data) => {
    if (root.isConnected === false || state.metricsRequest !== token) {
      if (state.metricsRequest === token) state.metricsLoading = false;
      return;
    }
    state.metricsLoading = false;
    if (data?.ok !== false) state.metrics = data;
    state.metricsError = apiError(data, 'Could not load usage.');
    renderUsage(state, root);
  });
  return () => { requestToken(state); off?.(); };
}
export const render = renderUsage;
export const mount = mountUsage;
