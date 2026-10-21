import { h, page, section, empty, note, button, meter, kb, money, displayName, get, apiError, requestToken, tone, date } from './util.js';
import { runStatus, runStatusLabel } from '../run.js';

const number = (value) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const percent = (value) => number(value) == null ? null : Math.max(0, Math.min(100, number(value)));
const cachePercent = (value) => number(value) == null ? null : percent(number(value) <= 1 ? number(value) * 100 : number(value));
const knownClass = (value) => {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'cli-reported') return 'reported';
  return ['reported', 'estimated', 'mixed', 'unpriced', 'unavailable'].includes(normalized) ? normalized : null;
};
const tokenText = (value) => value == null ? 'Unavailable' : kb(value);
const costText = (value) => value == null ? 'Unavailable' : money(value);
const rateText = (value) => value == null ? 'Unavailable' : `${Math.round(value)}%`;

export function metricsView(metrics = {}) {
  const total = metrics.total ?? {};
  const members = Array.isArray(metrics.members) ? metrics.members : [];
  const input = number(total.in);
  const cached = number(total.cached);
  const fresh = number(total.fresh) ?? (input != null && cached != null ? Math.max(0, input - cached) : null);
  const written = number(total.written);
  const output = number(total.out);
  const cacheRate = cachePercent(total.cacheRate) ?? (input != null && cached != null ? (input ? (cached / input) * 100 : 0) : null);
  const cost = metrics.cost && typeof metrics.cost === 'object' ? metrics.cost
    : total.cost && typeof total.cost === 'object' ? total.cost : null;
  const legacySpend = number(metrics.spent);
  const classification = knownClass(cost?.classification) ?? (legacySpend != null ? 'estimated' : 'unavailable');
  const auxiliary = metrics.auxiliary && typeof metrics.auxiliary === 'object' ? metrics.auxiliary : null;
  const mcp = metrics.mcp && typeof metrics.mcp === 'object' ? metrics.mcp : null;
  return {
    turns: number(total.turns) ?? 0,
    fresh, cached, written, output, cacheRate,
    hasUnpriced: classification === 'unpriced' || members.some((member) => knownClass(member.costClassification ?? member.cost?.classification) === 'unpriced'),
    cost: {
      fresh: number(cost?.fresh), cached: number(cost?.cached), written: number(cost?.written),
      output: number(cost?.output), total: number(cost?.total) ?? legacySpend, classification,
    },
    auxiliary: auxiliary ? {
      calls: number(auxiliary.calls), failures: number(auxiliary.failures), input: number(auxiliary.input),
      cached: number(auxiliary.cached), written: number(auxiliary.written), output: number(auxiliary.output),
      p50: number(auxiliary.latencyMs?.p50), p95: number(auxiliary.latencyMs?.p95),
      byPurpose: auxiliary.byPurpose && typeof auxiliary.byPurpose === 'object' ? auxiliary.byPurpose : {},
    } : null,
    mcp: mcp ? { maskedCalls: number(mcp.maskedCalls), maskedChars: number(mcp.maskedChars) } : null,
  };
}

export function recommendationFor(metrics) {
  const view = metricsView(metrics);
  if (view.hasUnpriced) return {
    condition: 'Some usage is unpriced.',
    consequence: 'The total cannot support a cost decision until every active model has a rate or allowance.',
    action: 'Open Models & efficiency', href: '#settings',
  };
  if (view.auxiliary && ((view.auxiliary.failures ?? 0) >= 2
    || (view.auxiliary.calls ?? 0) >= Math.max(3, view.turns))) return {
    condition: `${view.auxiliary.failures ?? 0} auxiliary failures across ${view.auxiliary.calls ?? 0} calls.`,
    consequence: 'A helper is adding retries or work outside the main agent turns.',
    action: 'Review auxiliary settings', href: '#settings',
  };
  const { fresh, cached, written, output, total } = view.cost;
  const remainder = (cached ?? 0) + (written ?? 0) + (output ?? 0);
  if (fresh != null && total > 0 && fresh > remainder) return {
    condition: 'Fresh-input cost is the largest classified cost.',
    consequence: 'The cold prompt is being paid again more than cached replay, writes, and output combined.',
    action: 'Review prompt controls', href: '#settings',
  };
  if (cached != null && total > 0 && cached > (fresh ?? 0) + (written ?? 0) + (output ?? 0)) return {
    condition: 'Cached replay cost is the largest classified cost.',
    consequence: 'More turns keep replaying context even though the cache is working.',
    action: 'Open the conversation', href: '#thread',
  };
  return null;
}

export function warningFor(metrics) {
  const view = metricsView(metrics);
  if (view.hasUnpriced) return {
    text: 'Usage includes unpriced model work, so the spend total is incomplete.', action: 'Review model pricing', href: '#settings',
  };
  if ((view.auxiliary?.failures ?? 0) >= 2) return {
    text: `Auxiliary helpers failed ${view.auxiliary.failures} times. Main work continues, but those calls need attention.`,
    action: 'Review helper settings', href: '#settings',
  };
  if (view.fresh != null && view.cached != null && (view.fresh + view.cached) >= 1_000 && view.cacheRate < 10) return {
    text: `Cache reuse is ${rateText(view.cacheRate)}. Most input is arriving cold.`, action: 'Review usage', href: '#usage',
  };
  return null;
}

export function loadMetrics(state, render, force = false) {
  if (!force && state.metricsPending) return state.metricsPending;
  const token = requestToken(state, 'metricsRequest');
  state.metricsLoading = true;
  state.metricsError = null;
  state.metricsNotice = state.metrics && state.metrics.ok !== false ? 'Refreshing. Showing the last valid metrics.' : 'Loading usage metrics.';
  render?.();
  const pending = get('/api/metrics').then((data) => {
    if (state.metricsRequest !== token) return data;
    state.metricsLoading = false;
    if (data?.ok !== false) {
      state.metrics = data;
      state.metricsError = null;
      state.metricsNotice = 'Metrics refreshed.';
    } else {
      state.metricsError = apiError(data, 'Could not load usage.');
      state.metricsNotice = state.metrics && state.metrics.ok !== false
        ? 'Refresh failed. Showing the last valid metrics.' : 'Usage metrics are unavailable.';
    }
    render?.();
    return data;
  }).finally(() => {
    if (state.metricsPending === pending) state.metricsPending = null;
  });
  state.metricsPending = pending;
  return pending;
}

export function cancelMetrics(state) {
  requestToken(state, 'metricsRequest');
  state.metricsLoading = false;
  state.metricsPending = null;
}

/* ---------- run spend: one run's own ledger against maxRunUsd ---------- */

export function loadRunSpend(state, render, force = false) {
  if (!force && state.runSpendPending) return state.runSpendPending;
  const token = requestToken(state, 'runSpendRequest');
  const pending = get('/api/runSpend').then((data) => {
    if (state.runSpendRequest !== token) return data;
    if (data?.ok !== false) {
      state.runSpend = data;
      state.runSpendError = null;
    } else {
      state.runSpendError = apiError(data, 'Could not load run spend.');
    }
    render?.();
    return data;
  }).finally(() => {
    if (state.runSpendPending === pending) state.runSpendPending = null;
  });
  state.runSpendPending = pending;
  return pending;
}

export function cancelRunSpend(state) {
  requestToken(state, 'runSpendRequest');
  state.runSpendPending = null;
}

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** Chart geometry, pure so the suite can pin it: points in a W x H box, the
 *  ceiling's y when there is one, and the y-domain top they share. */
export function spendGeometry(series = [], cap = 0, { width = 640, height = 160, inset = 0 } = {}) {
  const points = series.filter((p) => Number.isFinite(p?.ts) && Number.isFinite(p?.usd));
  const top = Math.max(cap > 0 ? cap : 0, ...points.map((p) => p.usd), 0) * 1.1 || 1;
  const t0 = points[0]?.ts ?? 0;
  const span = (points.at(-1)?.ts ?? 0) - t0;
  const y = (usd) => height - (usd / top) * height;
  const plotWidth = width - 2 * inset;
  return {
    width, height, top,
    // Time on x; turns that share a timestamp spread evenly instead.
    points: points.map((p, i) => ({
      ...p, y: y(p.usd),
      x: inset + (span > 0 ? ((p.ts - t0) / span) * plotWidth : points.length > 1 ? (i / (points.length - 1)) * plotWidth : plotWidth / 2),
    })),
    capY: cap > 0 ? y(cap) : null,
  };
}

function spendChart(series, cap) {
  const geo = spendGeometry(series, cap, { inset: 8 });
  const readout = h('p', { class: 'run-spend-readout', text: 'Point at the line to read a turn.' });
  const chart = svg('svg', {
    class: 'run-spend-chart', viewBox: `0 0 ${geo.width} ${geo.height}`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': `Cumulative run spend, ${money(series.at(-1)?.usd ?? 0)} over ${series.length} recorded points`,
  });
  chart.append(svg('line', { class: 'run-spend-axis', x1: 0, y1: geo.height, x2: geo.width, y2: geo.height }));
  if (geo.capY != null) chart.append(svg('line', { class: 'run-spend-cap', x1: 0, y1: geo.capY, x2: geo.width, y2: geo.capY }));
  if (geo.points.length > 1) {
    chart.append(svg('path', { class: 'run-spend-line', d: geo.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') }));
  }
  const last = geo.points.at(-1);
  // A stretched viewBox turns a <circle> into an ellipse. A zero-length path
  // with a round cap and a non-scaling stroke stays a true circle.
  const mark = (cls, p) => svg('path', { class: cls, d: p ? `M${p.x},${p.y} l0,0` : 'M0,0 l0,0' });
  if (last) chart.append(mark('run-spend-end', last));
  const cross = svg('line', { class: 'run-spend-cross', x1: 0, y1: 0, x2: 0, y2: geo.height, visibility: 'hidden' });
  const dot = mark('run-spend-dot');
  dot.setAttribute('visibility', 'hidden');
  chart.append(cross, dot);
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); readout.textContent = 'Point at the line to read a turn.'; };
  chart.addEventListener('pointermove', (event) => {
    const box = chart.getBoundingClientRect();
    if (!box.width || !geo.points.length) return;
    const at = ((event.clientX - box.left) / box.width) * geo.width;
    const near = geo.points.reduce((best, p) => (Math.abs(p.x - at) < Math.abs(best.x - at) ? p : best));
    cross.setAttribute('x1', near.x); cross.setAttribute('x2', near.x);
    dot.setAttribute('d', `M${near.x},${near.y} l0,0`);
    cross.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    readout.textContent = `${date(near.ts)} · ${money(near.usd)} spent so far`;
  });
  chart.addEventListener('pointerleave', hide);
  const legend = geo.capY == null ? null
    : h('p', { class: 'run-spend-legend' }, h('i', { class: 'run-spend-cap-key', 'aria-hidden': 'true' }), `Dashed line: ${money(cap)} run ceiling`);
  return h('figure', { class: 'run-spend-figure' }, chart, legend, readout);
}

export function runSpendSection(state) {
  const data = state.runSpend;
  const failure = state.runSpendError;
  if (!data) return section('Run spend', failure ? note(failure, 'danger') : empty('Loading run spend.'));
  const spend = data.spend;
  if (!data.run || !spend) return section('Run spend', failure ? note(failure, 'danger') : null, empty('No run has started yet.'));
  const cap = Number(data.cap) || 0;
  const status = runStatus(data.run);
  const header = h('div', { class: 'run-spend-head' },
    h('p', { class: 'run-spend-objective', text: data.run.objective || 'Untitled run' }),
    h('b', { class: `run-badge ${tone(status)}`.trim(), text: runStatusLabel(status) }));
  const ceiling = cap > 0
    ? meter((spend.usd / cap) * 100, `${money(spend.usd)} of ${money(cap)} run ceiling`)
    : note(`${money(spend.usd)} spent. No run ceiling is set; add maxRunUsd to agenticos.config.json to stop a run at a limit.`);
  const members = spend.members?.length
    ? h('dl', { class: 'usage-breakdown compact' }, ...spend.members.flatMap((m) =>
      definition(displayName(m.name), `${money(m.usd)} · ${m.turns} ${m.turns === 1 ? 'turn' : 'turns'}`)))
    : empty('No turns recorded for this run yet.');
  const history = (data.runs ?? []).length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
    h('thead', {}, h('tr', {}, ...['Run', 'State', 'Started', 'Turns', 'Spend'].map((t) => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, ...data.runs.map((r) => h('tr', { class: r.id === data.run.id ? 'current' : null, 'aria-current': r.id === data.run.id ? 'true' : null },
      h('td', { text: r.objective || r.id }), h('td', { text: runStatusLabel(runStatus(r)) }),
      h('td', { text: date(r.createdTs) }), h('td', { text: String(r.turns ?? 0) }), h('td', { text: money(r.usd ?? 0) })))))) : null;
  return section('Run spend',
    failure ? note(`Refresh failed: ${failure} Showing the last valid run spend.`, 'danger') : null,
    header, ceiling,
    spend.series?.length ? spendChart(spend.series, cap) : empty('No turns recorded for this run yet.'),
    h('div', { class: 'run-spend-members' }, h('h3', { class: 'run-spend-sub', text: 'By member' }), members),
    history ? h('div', {}, h('h3', { class: 'run-spend-sub', text: 'Recent runs' }), history) : null);
}

const metricCard = (label, value, detail, extra) => h('article', { class: 'metric-card' },
  h('span', { class: 'metric-label', text: label }), h('strong', { class: 'metric-value', text: value }),
  h('span', { class: 'metric-detail', text: detail }), extra);

const definition = (term, value) => [h('dt', { text: term }), h('dd', { text: value })];

function agentCard(member) {
  const input = number(member.in);
  const cached = number(member.cached);
  const fresh = number(member.fresh) ?? (input != null && cached != null ? Math.max(0, input - cached) : null);
  const cacheRate = cachePercent(member.cacheRate) ?? (input != null && cached != null ? (input ? (cached / input) * 100 : 0) : null);
  const classification = knownClass(member.costClassification ?? member.cost?.classification) ?? (number(member.spent) != null ? 'estimated' : 'unavailable');
  const identity = [member.cli, member.model, member.effort].filter((value) => value != null && value !== '').join(' / ') || 'CLI, model, and effort unavailable';
  const spend = number(member.cost?.total) ?? number(member.spent);
  return h('article', { class: 'agent-usage-card' },
    h('header', {}, h('h3', { text: displayName(member.name, member.role) }), h('p', { text: identity })),
    h('dl', { class: 'agent-usage-details' },
      ...definition('Turns', String(number(member.turns) ?? 0)),
      ...definition('Fresh input', tokenText(fresh)),
      ...definition('Cache rate', rateText(cacheRate)),
      ...definition('Current context', tokenText(number(member.ctx))),
      ...definition('Spend', spend == null ? 'Unavailable' : `${money(spend)} / ${classification}`)),
    cacheRate == null ? null : meter(cacheRate, `${rateText(cacheRate)} cache reuse`));
}

function purposeRows(byPurpose) {
  return Object.entries(byPurpose).map(([purpose, value]) => {
    const calls = number(value?.calls ?? value);
    return h('div', { class: 'usage-purpose-row' }, h('span', { text: purpose }), h('strong', { text: calls == null ? 'Unavailable' : String(calls) }));
  });
}

function agentAttention(members = []) {
  const unpriced = members.find((member) => knownClass(member.costClassification ?? member.cost?.classification) === 'unpriced');
  if (unpriced) return `${displayName(unpriced.name, unpriced.role)} has unpriced usage.`;
  const highest = members.map((member) => ({ member, spend: number(member.cost?.total) ?? number(member.spent) }))
    .filter(({ spend }) => spend != null).sort((a, b) => b.spend - a.spend)[0];
  return highest ? `${displayName(highest.member.name, highest.member.role)} is highest at ${money(highest.spend)}.` : 'No agent-level cost is available.';
}

export function renderUsage(state, root) {
  const activeRefresh = globalThis.document?.activeElement?.dataset?.action === 'refresh-metrics';
  const scrollHost = root.parentElement;
  const scrollTop = scrollHost?.scrollTop ?? 0;
  root.replaceChildren();
  const hasMetrics = Boolean(state.metrics && state.metrics.ok !== false);
  const shell = page('Usage', 'Decide where model cost, cache reuse, and auxiliary work need attention.');
  if (state.metricsLoading && !hasMetrics) {
    const refreshAgain = button('Refresh again', () => loadMetrics(state, () => {
      if (root.isConnected !== false) renderUsage(state, root);
    }, true), 'primary');
    refreshAgain.dataset.action = 'refresh-metrics';
    shell.append(section('Usage',
      h('div', { class: 'usage-status', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true', text: state.metricsNotice ?? 'Loading usage metrics.' }),
      refreshAgain));
    root.append(shell);
    if (activeRefresh) refreshAgain.focus({ preventScroll: true });
    return;
  }
  const metrics = state.metrics ?? {};
  const members = Array.isArray(metrics.members) ? metrics.members : [];
  const view = metricsView(metrics);
  const loadFailure = state.metricsError ?? apiError(metrics, 'Could not load usage.');
  const refresh = button(state.metricsLoading ? 'Refresh again' : 'Refresh', () => {
    const repaint = () => { if (root.isConnected !== false) renderUsage(state, root); };
    void loadRunSpend(state, repaint, true);
    return loadMetrics(state, repaint, true);
  }, 'primary');
  refresh.dataset.action = 'refresh-metrics';
  const status = h('p', {
    class: `usage-status${loadFailure ? ' danger' : ''}`, role: 'status', 'aria-live': 'polite',
    text: loadFailure ? (hasMetrics ? `Refresh failed: ${loadFailure} Showing the last valid metrics.` : loadFailure) : state.metricsNotice ?? '',
  });
  const controls = h('div', { class: 'usage-toolbar' }, status, refresh);
  if (loadFailure && !hasMetrics) {
    refresh.textContent = 'Retry';
    shell.append(controls);
    root.append(shell);
    return;
  }

  const dashboard = h('div', { class: 'usage-dashboard', 'aria-busy': String(Boolean(state.metricsLoading)) });
  const lead = h('div', { class: 'usage-lead' },
    metricCard('Fresh input cost', costText(view.cost.fresh), 'New input sent without a cache read.'),
    metricCard('Cache reuse', rateText(view.cacheRate), view.cacheRate == null ? 'Cache data unavailable.' : `${tokenText(view.cached)} cached-read tokens.`, view.cacheRate == null ? null : meter(view.cacheRate, `${rateText(view.cacheRate)} cache reuse`)),
    metricCard('Auxiliary calls', view.auxiliary?.calls == null ? 'Unavailable' : String(view.auxiliary.calls), view.auxiliary ? `${view.auxiliary.failures ?? 0} failures.` : 'Auxiliary metrics unavailable.'),
    metricCard('Total spend', costText(view.cost.total), `${view.cost.classification} classification. ${agentAttention(members)}`));
  dashboard.append(controls, lead);

  const recommendation = recommendationFor(metrics);
  if (recommendation) dashboard.append(h('aside', { class: 'usage-recommendation attention' },
    h('div', {}, h('strong', { text: recommendation.condition }), h('p', { text: recommendation.consequence })),
    h('a', { class: 'button link', href: recommendation.href, text: recommendation.action })));

  dashboard.append(runSpendSection(state));

  const tokenBreakdown = h('dl', { class: 'usage-breakdown' },
    ...definition('Fresh input', tokenText(view.fresh)), ...definition('Cached reads', tokenText(view.cached)),
    ...definition('Cache writes', tokenText(view.written)), ...definition('Output', tokenText(view.output)));
  const costBreakdown = h('dl', { class: 'usage-breakdown' },
    ...definition('Fresh input', costText(view.cost.fresh)), ...definition('Cached reads', costText(view.cost.cached)),
    ...definition('Cache writes', costText(view.cost.written)), ...definition('Output', costText(view.cost.output)));
  dashboard.append(h('div', { class: 'usage-columns' },
    section('Token flow', tokenBreakdown),
    section('Classified cost', costBreakdown, note(`Total is ${view.cost.classification}. Estimates are never presented as provider-reported spend.`))));

  const allowances = [];
  const cap = number(metrics.cap);
  if (cap > 0 && view.cost.total != null) allowances.push(meter((view.cost.total / cap) * 100,
    `${costText(view.cost.total)} ${view.cost.classification} spend of ${money(cap)} budget`));
  for (const quota of metrics.quotas ?? []) allowances.push(h('div', { class: 'quota' },
    h('span', { text: `${quota.label ?? quota.cli ?? 'Plan'}: ${tokenText(number(quota.used))} of ${tokenText(number(quota.limit))} tokens` }),
    number(quota.pct) == null ? null : meter(quota.pct, `${rateText(quota.pct)} of allowance used`)));
  if (allowances.length) dashboard.append(section('Plan allowances', ...allowances));

  const auxiliary = view.auxiliary;
  dashboard.append(section('Auxiliary and MCP savings',
    h('dl', { class: 'usage-breakdown compact' },
      ...definition('Auxiliary calls', auxiliary?.calls == null ? 'Unavailable' : String(auxiliary.calls)),
      ...definition('Auxiliary failures', auxiliary?.failures == null ? 'Unavailable' : String(auxiliary.failures)),
      ...definition('Latency p50 / p95', auxiliary?.p50 == null && auxiliary?.p95 == null ? 'Unavailable' : `${auxiliary?.p50 ?? 'n/a'} / ${auxiliary?.p95 ?? 'n/a'} ms`),
      ...definition('MCP calls avoided', view.mcp?.maskedCalls == null ? 'Unavailable' : String(view.mcp.maskedCalls)),
      ...definition('MCP characters avoided', tokenText(view.mcp?.maskedChars))),
    auxiliary && Object.keys(auxiliary.byPurpose).length
      ? h('div', { class: 'usage-purposes' }, h('h3', { text: 'Auxiliary calls by purpose' }), ...purposeRows(auxiliary.byPurpose))
      : note('Auxiliary purpose detail is unavailable.')));

  dashboard.append(section('Per agent', members.length
    ? h('div', { class: 'agent-usage-grid' }, ...members.map(agentCard))
    : empty('No turns recorded yet.')));
  dashboard.append(section('Cost classification', h('dl', { class: 'classification-list' },
    ...definition('Reported', 'Spend returned by the provider.'),
    ...definition('Estimated', 'Spend calculated from configured rates, including legacy totals.'),
    ...definition('Mixed', 'A total containing both reported and estimated figures.'),
    ...definition('Unpriced', 'Usage exists but at least one required rate or allowance is missing.'),
    ...definition('Unavailable', 'The backend did not provide enough data to calculate the figure.'))));
  shell.append(dashboard);
  root.append(shell);
  if (scrollHost) scrollHost.scrollTop = scrollTop;
  if (activeRefresh) root.querySelector('[data-action="refresh-metrics"]')?.focus({ preventScroll: true });
}

export function mountUsage(state, root) {
  renderUsage(state, root);
  const repaint = () => { if (root.isConnected !== false) renderUsage(state, root); };
  void loadMetrics(state, repaint, true);
  void loadRunSpend(state, repaint, true);
  return () => { if (state.metricsLoading) cancelMetrics(state); cancelRunSpend(state); };
}
export const render = renderUsage;
export const mount = mountUsage;
