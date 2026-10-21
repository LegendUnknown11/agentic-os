import { h, page, section, empty, button, membersOf, displayName, modeDef, setView, subscribe, tone, get, apiError, requestToken, date, money } from './util.js';
import { statusLabel } from '../status.js';
import { statusDot } from '../avatar.js';
import { renderRunOverview, runStatus, runStatusLabel } from '../run.js';
import { objectiveSection } from './objective.js';
import { startRunSection, loadRunTemplates } from './start-run.js';
import { waitingCount } from './inbox.js';
import { cancelMetrics, loadMetrics, warningFor } from './usage.js';

const open = (view) => () => setView(view);

const ACTIVE_RUNS = new Set(['planning', 'running', 'paused', 'blocked', 'verifying', 'ready_for_review']);
const ATTENTION_STATES = new Set(['rate limited', 'failed', 'blocked']);
const QUEUE_PREVIEW = 7;
export const needsAttention = (status) => ATTENTION_STATES.has(statusLabel(status));

const queued = (tasks = []) => tasks
  .filter((task) => !['done', 'dropped'].includes(task.state))
  .map((task) => ({ ...task, shown: task.blockedBy?.length ? 'blocked' : task.state }))
  .sort((a, b) => ({ blocked: 0, planning: 1, active: 2, pending: 3 }[a.shown] ?? 9) - ({ blocked: 0, planning: 1, active: 2, pending: 3 }[b.shown] ?? 9) || (a.id ?? 0) - (b.id ?? 0));
export const visibleQueueRows = (rows, expanded = false) => expanded ? rows : rows.slice(0, QUEUE_PREVIEW);
export const taskMeta = (task) => [
  task.owner ? `Assigned to ${task.owner}` : 'Unassigned',
  task.blockedBy?.length ? `Waiting on ${task.blockedBy.map((id) => `#${id}`).join(', ')}`
    : task.state === 'planning' ? 'Awaiting plan approval' : null,
].filter(Boolean).join(' · ');

const homeStateKey = (state) => JSON.stringify([
  state.ready, state.mode, state.goal, state.run, state.tasksLoading, state.tasksError, state.tasks,
  state.approvals, state.changes, state.spend, state.inbox, state.homeRuns, state.homeEdit, state.homeStartRun,
  membersOf(state).map(([name, member]) => [name, member.role, member.added, member.awake, member.status,
    state.status?.get?.(name) ?? state.status?.[name], state.log?.get?.(name)?.at?.(-1)?.type]),
]);

// With no active run, the single most urgent thing takes the lead position a
// run would otherwise hold — the first item off the merged urgency ranking,
// or changes waiting on review, or setting an objective at all.
function nextStepFor({ urgent, changesVisible, changes, goal, actions = {} }) {
  if (urgent.length) {
    const top = urgent[0];
    return h('section', { class: 'home-card home-next-step' },
      h('h2', { text: 'Next step' }), h('p', { text: top.text }),
      top.open && h('div', { class: 'button-row' }, button('Take a look', top.open, 'primary')));
  }
  if (changesVisible) {
    return h('section', { class: 'home-card home-next-step' },
      h('h2', { text: 'Next step' }),
      h('p', { text: `${changes.length} change${changes.length === 1 ? '' : 's'} ready for review.` }),
      h('div', { class: 'button-row' }, button('Review changes', open('changes'), 'primary')));
  }
  if (!goal?.text) {
    // Tagged, because the ambient card at the foot of the grid says exactly
    // this when there is no objective either. Seen live 2026-09-21 on a fresh
    // team: "Next step" and "Start here" rendered the same sentence and the
    // same two buttons, one above the other.
    const card = h('section', { class: 'home-card home-next-step' },
      h('h2', { text: 'Next step' }),
      h('p', { text: 'Set the outcome first. Every agent receives it before it starts work.' }),
      h('div', { class: 'button-row' }, button('Set objective', actions.editObjective ?? open('objective'), 'primary'), button('Start a conversation', open({ page: 'thread', member: 'orchestrator' }))));
    card.dataset.lead = 'objective';
    return card;
  }
  // An objective and no run: the next step is starting one. The form is on
  // this page now, under the objective it starts from.
  const card = h('section', { class: 'home-card home-next-step' },
    h('h2', { text: 'Next step' }),
    h('p', { text: 'Start a run to put the team on this objective, with acceptance criteria to verify against.' }),
    h('div', { class: 'button-row' }, button('Start a run', actions.startRun ?? open('objective'), 'primary')));
  card.dataset.lead = 'start-run';
  return card;
}

const runIsActive = (state) => Boolean(state.run) && ACTIVE_RUNS.has(runStatus(state.run));

/** Every run, newest first, with what it spent — the Runs table's rows. */
export function loadHomeRuns(state, render) {
  const token = requestToken(state, 'homeRunsRequest');
  return get('/api/runSpend').then((data) => {
    if (state.homeRunsRequest !== token) return;
    if (data?.ok !== false) { state.homeRuns = data.runs ?? []; state.homeRunsError = null; }
    else state.homeRunsError = apiError(data, 'Could not load your runs.');
    render?.();
  }).catch(() => {});
}

/** "PUSH · builder" reads as a bold title and a muted detail, as in the canvas's rows. */
const inboxTitle = (state, approval) => (Array.isArray(state.inbox) ? state.inbox : [])
  .find((item) => item.id === `approval:${approval.id}`)?.title;

function rowText(text) {
  const [title, ...rest] = String(text).split(' · ');
  return h('span', { class: 'row-text' }, h('b', { class: 'row-title', text: title }), rest.length ? h('span', { class: 'row-detail', text: rest.join(' · ') }) : null);
}

/** The standing objective as the page's headline, with the two things to do about it. */
function objectiveBlock(state, actions) {
  const goal = state.goal;
  const toggle = button(state.homeEdit ? 'Close editor' : goal?.text ? 'Edit objective' : 'Set objective', actions.editObjective ?? open('objective'));
  const start = goal?.text && !runIsActive(state)
    ? button(state.homeStartRun ? 'Hide run form' : 'Start a run', actions.startRun ?? open('objective'), 'primary') : null;
  return h('section', { class: 'home-objective-block', 'aria-label': 'Objective' },
    h('span', { class: 'home-stat-label', text: 'Objective' }),
    h('p', { class: `home-headline${goal?.text ? '' : ' muted'}`, text: goal?.text ? goal.text : 'No objective set' }),
    h('div', { class: 'button-row' }, toggle, start));
}

/**
 * "Spend today": the daemon's ledger figure for the local day it names, from
 * the snapshot and every 'spend' event. Pure, for the suite. Nothing streamed
 * yet reads as a dash, never as $0.00.
 */
export function spendToday(spend) {
  const today = spend?.today;
  if (!today || !Number.isFinite(Number(today.usd))) return '—';
  return money(Number(today.usd));
}

/** Who drove a run: its recorded lead, else whoever spent most on it. Pure. */
export function runAgent(run) {
  return run?.lead || (Array.isArray(run?.agents) ? run.agents[0] : null) || '—';
}

/** Four numbers: what is running, what waits on you, what is open, what it cost today. */
function counters(state, tasks, approvals) {
  const runs = state.homeRuns;
  const active = runs ? runs.filter((run) => ACTIVE_RUNS.has(String(run.state))).length : (runIsActive(state) ? 1 : 0);
  const waiting = state.inbox ? waitingCount(state.inbox) : approvals.length;
  const open = tasks.filter((task) => !['done', 'dropped'].includes(task.state)).length;
  const spend = spendToday(state.spend);
  const stat = (label, value, cls = '') => h('div', { class: 'home-stat' }, h('span', { class: 'home-stat-label', text: label }), h('span', { class: `home-stat-value ${cls}`.trim(), text: String(value) }));
  return h('div', { class: 'home-stats', role: 'group', 'aria-label': 'At a glance' },
    stat('Active runs', active), stat('Waiting on you', waiting, waiting ? 'attention' : ''), stat('Open tasks', open), stat('Spend today', spend, 'mono'));
}

/** Run, agent, stage, updated — the canvas's columns. A run's spend is in Settings, Usage. */
function runsTable(state) {
  const runs = state.homeRuns;
  if (!runs?.length) return null;
  const rows = runs.slice(0, 8).map((run) => {
    const status = runStatus({ status: run.state });
    const dot = statusDot();
    const dotTone = tone(status);
    if (dotTone) dot.classList.add(dotTone);
    return h('tr', {},
      h('td', {}, h('span', { class: 'home-run-name' }, dot, h('span', { text: run.objective || `Run ${run.id}` }))),
      h('td', { text: runAgent(run) }),
      h('td', {}, h('b', { class: `run-badge ${dotTone}`.trim(), text: runStatusLabel(status) })),
      h('td', { text: date(run.endedTs ?? run.createdTs) }));
  });
  return h('section', { class: 'home-card home-runs' }, h('h2', { text: 'Runs' }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Run' }), h('th', { scope: 'col', text: 'Agent' }), h('th', { scope: 'col', text: 'Stage' }), h('th', { scope: 'col', text: 'Updated' }))),
      h('tbody', {}, ...rows))));
}

export function render(state, root, actions = {}, queueExpanded = false) {
  root.replaceChildren();
  if (state.ready === false) {
    const message = state.conn === 'down'
      ? 'The local service is offline. Reconnecting…'
      : 'Loading the team, conversations, and current work…';
    const shell = page('Agentic OS', 'Your local team workspace.');
    shell.append(section('Connection', empty(message)));
    root.append(shell);
    return;
  }
  const m = modeDef(state);
  const goal = state.goal;
  const tasks = state.tasks?.tasks ?? state.tasks ?? [];
  const approvals = (state.approvals ?? []).filter((a) => !a.resolved);
  const changes = state.changes?.changed ?? state.changes ?? [];
  const members = membersOf(state);
  const team = members.filter(([, member]) => member.role === 'agent' && member.added);
  const currentStatus = (name, member) => state.status?.get?.(name) ?? state.status?.[name] ?? member.status ?? state.log?.get?.(name)?.at?.(-1)?.type ?? 'idle';
  const attention = team.filter(([name, member]) => needsAttention(currentStatus(name, member)));
  const working = team.filter(([name, member]) => member.awake && !needsAttention(currentStatus(name, member))
    && !['idle', 'turn_end', 'ready', 'awake'].includes(currentStatus(name, member)));
  const rows = queued(tasks);
  const blocked = rows.filter((task) => task.shown === 'blocked');
  const queueRows = rows.filter((task) => task.shown !== 'blocked');
  const crewVisible = m.crew === 'all' || m.crew?.length;
  const taskLoading = m.tasks !== false && state.tasksLoading;
  const taskFailure = m.tasks !== false && !taskLoading && state.tasksError;
  const queueVisible = m.tasks !== false && queueRows.length;
  const workingVisible = crewVisible && working.length;
  const changesVisible = m.merge !== false && changes.length;
  // The h1 is the page's name for assistive tech and focus; the objective is
  // the visible headline, as in the canvas.
  const shell = h('div', { class: 'view-page home-page' }, h('h1', { class: 'visually-hidden', text: 'Overview' }));
  shell.append(objectiveBlock(state, actions));
  const editor = state.homeEdit ? objectiveSection(state, () => actions.rerender?.()) : null;
  if (editor) shell.append(editor);
  shell.append(counters(state, tasks, approvals));
  const grid = h('div', { class: 'home-grid' });

  // Urgency, computed at render time rather than fixed in source order:
  // pending approvals block the whole crew, a failed member needs direct
  // intervention, a blocked task is usually waiting on one of the above.
  const urgent = [
    ...(crewVisible ? approvals.map((a) => ({
      // The inbox already words each approval for a person ("Add tester,
      // reviewer"); the bare kind is the fallback before it has loaded.
      text: `${inboxTitle(state, a) ?? String(a.kind ?? 'request').toUpperCase()} · ${a.from ?? 'team'}`, open: open('approvals'),
      tone: tone('blocked'),
    })) : []),
    ...(crewVisible ? attention.map(([name, member]) => {
      const label = statusLabel(currentStatus(name, member));
      return {
        text: `${displayName(name, member.role)} · ${label}`,
        open: open({ page: 'thread', member: name }), tone: tone(label),
      };
    }) : []),
    ...(m.tasks !== false ? blocked.map((task) => ({
      text: `${task.title ?? task.detail ?? `Task #${task.id}`} · ${taskMeta(task)}`, tone: tone('blocked'),
    })) : []),
  ];

  // The canvas's order: what needs you, then every run, then the open run's
  // detail and the rest of the work.
  if (urgent.length) {
    const needs = h('div', { class: 'home-card home-needs' }, h('h2', { text: `Needs you · ${urgent.length}` }));
    for (const item of urgent) {
      const cls = `task-row ${item.tone ?? ''}`.trim();
      const dot = statusDot();
      if (item.tone) dot.classList.add(item.tone);
      // The clickable branch also carries `button`, or it is the only
      // interactive control in the app with no hover affordance and no
      // enforced tap target — .task-row alone declares neither.
      needs.append(item.open
        ? h('button', { class: `button ${cls}`, type: 'button', on: { click: item.open } }, dot, rowText(item.text))
        : h('div', { class: cls }, dot, rowText(item.text)));
    }
    grid.append(needs);
  }

  const runsCard = runsTable(state);
  if (runsCard) grid.append(runsCard);

  const runSummary = renderRunOverview(state, { post: actions.post, toast: actions.toast });
  const next = runSummary ? null : nextStepFor({ urgent, changesVisible, changes, goal, actions });
  if (runSummary) grid.append(runSummary);
  else if (next) grid.append(next);
  const leadAsksForObjective = next?.dataset?.lead === 'objective';

  const efficiencyWarning = state.metrics?.ok === false ? null : warningFor(state.metrics);
  if (efficiencyWarning) grid.append(h('aside', { class: 'home-card home-efficiency-warning attention' },
    h('p', { text: efficiencyWarning.text }),
    h('a', { class: 'button link', href: efficiencyWarning.href, text: efficiencyWarning.action })));



  if (taskLoading) {
    grid.append(h('section', { class: 'home-card' },
      h('h2', { text: 'Current work' }),
      h('p', { class: 'muted', text: rows.length ? 'Refreshing current work…' : 'Loading current work…' })));
  }

  if (taskFailure) {
    grid.append(h('section', { class: 'home-card home-attention' },
      h('h2', { text: 'Current work unavailable' }),
      h('p', { text: rows.length ? `Showing the last known queue. ${taskFailure}` : taskFailure }),
      h('div', { class: 'button-row' }, button('Retry', () => actions.refreshLists?.(), 'primary'))));
  }

  if (queueVisible) {
    const queue = h('div', { class: 'home-card' }, h('h2', { text: `Queue · ${queueRows.length}` }));
    for (const task of visibleQueueRows(queueRows, queueExpanded)) {
      const dot = statusDot();
      const dotTone = tone(task.shown);
      if (dotTone) dot.classList.add(dotTone);
      queue.append(h('div', { class: `task-row task-${task.shown} ${tone(task.shown)}`.trim() },
        dot, h('b', { text: `#${task.id} · ${task.shown}` }), h('span', {},
          h('span', { text: task.title ?? task.detail ?? `Task #${task.id}` }),
          h('small', { class: 'muted', text: taskMeta(task) }))));
    }
    if (queueRows.length > QUEUE_PREVIEW) {
      const toggle = button(queueExpanded ? 'Show fewer tasks' : `Show all ${queueRows.length} tasks`, () => actions.setQueueExpanded?.(!queueExpanded));
      toggle.setAttribute('aria-expanded', String(queueExpanded));
      queue.append(h('div', { class: 'button-row' }, toggle));
    }
    grid.append(queue);
  }

  if (workingVisible) {
    const card = h('div', { class: 'home-card' }, h('h2', { text: `Team activity · ${working.length}` }));
    working.slice(0, 8).forEach(([name, member]) => card.append(button(`${displayName(name, member.role)} · ${statusLabel(currentStatus(name, member))}`, open({ page: 'thread', member: name }), 'list-row')));
    grid.append(card);
  }

  if (changesVisible) {
    const card = h('div', { class: 'home-card' }, h('h2', { text: `Worktree changes · ${changes.length}` }));
    changes.slice(0, 7).forEach((change) => card.append(button(`${displayName(change.agent)} · review changes`, open('changes'), 'list-row')));
    grid.append(card);
  }

  // The objective's start-a-run form, when asked for.
  const startable = goal?.text && !runSummary;
  if (state.homeStartRun && startable) grid.append(startRunSection(state, () => actions.rerender?.()));

  if (!runSummary && !next && !urgent.length && !taskLoading && !taskFailure && !queueVisible && !workingVisible && !changesVisible) {
    grid.append(h('p', { class: 'home-empty', text: 'Your workspace is ready. Set an objective or start a conversation to begin.' }));
  }

  shell.append(grid);
  root.append(shell);
}

export function mount(state, root, actions = {}) {
  let queueExpanded = false;
  let active = true;
  let snapshot = '';
  const repaint = () => { if (active && root.isConnected !== false) renderCurrent(); };
  const flip = (key) => () => { state[key] = !state[key]; repaint(); };
  const renderCurrent = () => render(state, root, {
    ...actions,
    rerender: repaint,
    editObjective: flip('homeEdit'),
    startRun: flip('homeStartRun'),
    setQueueExpanded: (value) => { queueExpanded = Boolean(value); renderCurrent(); },
  }, queueExpanded);
  renderCurrent();
  snapshot = homeStateKey(state);
  // The Runs table follows the current run: a new run, or one changing stage.
  let runKey = `${state.run?.id}|${state.run?.state ?? state.run?.status}`;
  const off = subscribe(() => {
    const nowRun = `${state.run?.id}|${state.run?.state ?? state.run?.status}`;
    if (nowRun !== runKey) { runKey = nowRun; void loadHomeRuns(state, repaint); }
    const next = homeStateKey(state);
    if (next === snapshot) return;
    snapshot = next;
    renderCurrent();
  });
  void loadHomeRuns(state, repaint);
  void loadRunTemplates(state, repaint);
  const ownsMetrics = !state.metrics && !state.metricsLoading && !state.metricsError;
  if (ownsMetrics) void loadMetrics(state, () => {
    if (!state.metricsLoading && active && root.isConnected !== false) renderCurrent();
  });
  return () => {
    active = false;
    off?.();
    requestToken(state, 'homeRunsRequest');
    requestToken(state, 'runTemplatesRequest');
    if (ownsMetrics && state.metricsLoading) cancelMetrics(state);
  };
}

export { queued };

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('home.js')) {
  const module = await import('node:assert/strict');
  const assert = module.default ?? module;
  assert.deepEqual(queued([
    { id: 1, state: 'done' }, { id: 2, state: 'pending' }, { id: 3, state: 'active' }, { id: 4, state: 'pending', blockedBy: [3] },
  ]).map((task) => task.id), [4, 3, 2], 'home queue keeps blocked work first and hides completed work');
  assert.deepEqual(visibleQueueRows(Array.from({ length: 8 }, (_, id) => ({ id }))).map((task) => task.id), [0, 1, 2, 3, 4, 5, 6], 'home queue previews seven tasks until expanded');
  assert.equal(taskMeta({ owner: 'coder', blockedBy: [3, 4] }), 'Assigned to coder · Waiting on #3, #4', 'home queue names ownership and dependencies');
  assert.equal(taskMeta({ state: 'planning' }), 'Unassigned · Awaiting plan approval', 'planning work names its approval gate');
  assert.equal(needsAttention('limited'), true, 'rate-limited work needs attention');
  assert.equal(needsAttention('reading'), false, 'active work does not need attention');
  console.log('home views ok');
}
