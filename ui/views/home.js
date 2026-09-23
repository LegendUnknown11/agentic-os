import { h, page, section, empty, button, membersOf, displayName, modeDef, setView, subscribe, tone, spendText } from './util.js';
import { statusLabel } from '../status.js';
import { statusDot } from '../avatar.js';
import { renderRunOverview } from '../run.js';
import { cancelMetrics, loadMetrics, warningFor } from './usage.js';

const open = (view) => () => setView(view);
const MODE_COPY = {
  chat: { label: 'Chat', blurb: 'Start a direct conversation with Agentic OS.', action: 'Talk directly with the orchestrator.', cta: 'Start a direct chat' },
  cowork: { label: 'Cowork', blurb: 'Delegate multi-step workspace work to your team.', action: 'Describe the outcome and let Agentic OS plan the work.', cta: 'Delegate workspace work' },
  code: { label: 'Code', blurb: 'Change a repository with tests and review.', action: 'Work in isolation, then review what is ready to merge.', cta: 'Plan a repo change' },
};

const userMode = (state) => state.userMode ?? (state.mode === 'chat' ? 'chat' : state.mode === 'code' ? 'code' : 'cowork');
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
  state.approvals, state.changes, state.spend,
  membersOf(state).map(([name, member]) => [name, member.role, member.summoned, member.awake, member.status,
    state.status?.get?.(name) ?? state.status?.[name], state.log?.get?.(name)?.at?.(-1)?.type]),
]);

// With no active run, the single most urgent thing takes the lead position a
// run would otherwise hold — the first item off the merged urgency ranking,
// or changes waiting on review, or setting an objective at all.
function nextStepFor({ urgent, changesVisible, changes, goal }) {
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
    // court: "Next step" and "Start here" rendered the same sentence and the
    // same two buttons, one above the other.
    const card = h('section', { class: 'home-card home-next-step' },
      h('h2', { text: 'Next step' }),
      h('p', { text: 'Set the outcome first. Every agent receives it before it starts work.' }),
      h('div', { class: 'button-row' }, button('Set objective', open('objective'), 'primary'), button('Start a conversation', open({ page: 'thread', member: 'orchestrator' }))));
    card.dataset.lead = 'objective';
    return card;
  }
  return null;
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
  const mode = MODE_COPY[userMode(state)] ?? MODE_COPY.cowork;
  const members = membersOf(state);
  const team = members.filter(([, member]) => member.role === 'peasant' && member.summoned);
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
  const shell = page('Overview', mode.blurb);
  const grid = h('div', { class: 'home-grid' });

  // Urgency, computed at render time rather than fixed in source order:
  // pending approvals block the whole crew, a failed member needs direct
  // intervention, a blocked task is usually waiting on one of the above.
  const urgent = [
    ...(crewVisible ? approvals.map((a) => ({
      text: `${String(a.kind ?? 'request').toUpperCase()} · ${a.from ?? 'team'}`, open: open('approvals'),
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

  const runSummary = renderRunOverview(state, { post: actions.post, toast: actions.toast });
  const next = runSummary ? null : nextStepFor({ urgent, changesVisible, changes, goal });
  if (runSummary) grid.append(runSummary);
  else if (next) grid.append(next);
  const leadAsksForObjective = next?.dataset?.lead === 'objective';

  const efficiencyWarning = state.metrics?.ok === false ? null : warningFor(state.metrics);
  if (efficiencyWarning) grid.append(h('aside', { class: 'home-card home-efficiency-warning attention' },
    h('p', { text: efficiencyWarning.text }),
    h('a', { class: 'button link', href: efficiencyWarning.href, text: efficiencyWarning.action })));

  if (urgent.length) {
    const needs = h('div', { class: 'home-card' }, h('h2', { text: `Needs you · ${urgent.length}` }));
    for (const item of urgent) {
      const cls = `task-row ${item.tone ?? ''}`.trim();
      const dot = statusDot();
      if (item.tone) dot.classList.add(item.tone);
      // The clickable branch also carries `button`, or it is the only
      // interactive control in the app with no hover affordance and no
      // enforced tap target — .task-row alone declares neither.
      needs.append(item.open
        ? h('button', { class: `button ${cls}`, type: 'button', on: { click: item.open } }, dot, h('span', { text: item.text }))
        : h('div', { class: cls }, dot, h('span', { text: item.text })));
    }
    grid.append(needs);
  }

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
    const card = h('div', { class: 'home-card' }, h('h2', { text: `Changes ready · ${changes.length}` }));
    changes.slice(0, 7).forEach((change) => card.append(button(`${displayName(change.peasant)} · review changes`, open('changes'), 'list-row')));
    grid.append(card);
  }

  // Ambient: ever-present, always last — ground truth for what the court is
  // doing and what it has spent, not a call to action.
  const ambient = h('div', { class: 'home-card home-objective' }, h('h2', { text: goal?.text ? 'Current objective' : 'Start here' }));
  if (goal?.text) ambient.append(h('p', { text: goal.text }), h('div', { class: 'button-row' }, button('Talk to the orchestrator', open({ page: 'thread', member: 'orchestrator' }), 'primary'), button('Edit objective', open('objective'))));
  else if (!leadAsksForObjective) ambient.append(h('p', { class: 'muted', text: 'Set the outcome first. Every agent receives it before it starts work.' }), h('div', { class: 'button-row' }, button('Set objective', open('objective'), 'primary'), button('Start a conversation', open({ page: 'thread', member: 'orchestrator' }))));
  if (goal?.milestones?.length) ambient.append(h('p', { class: 'muted', text: `${goal.milestones.filter((x) => x.done).length}/${goal.milestones.length} milestones complete` }));
  const spend = spendText(state.spend);
  if (spend) ambient.append(h('p', { class: 'muted', text: `Spend so far: ${spend}` }));
  // A heading with nothing under it is not ambient context. When the lead card
  // has already asked for the objective, this one only appears if it has
  // something of its own to add.
  if (ambient.children.length > 1) grid.append(ambient);

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
  const renderCurrent = () => render(state, root, { ...actions, setQueueExpanded: (value) => {
    queueExpanded = Boolean(value);
    renderCurrent();
  } }, queueExpanded);
  renderCurrent();
  snapshot = homeStateKey(state);
  const off = subscribe(() => {
    const next = homeStateKey(state);
    // ponytail: diagnostic only, for the CI-only t-electron.js run-lifecycle
    // timeout — remove once root-caused. If `instance` here ever differs
    // from the value store.js's notify() logs, this closure's `state` is a
    // different object than the one notify() mutates — a module-identity
    // split, not the shared singleton this file assumes it has.
    console.log('[home] subscribe fired, instance', state.__diagInstance,
      'bail', next === snapshot, 'run.state', state.run?.state);
    if (next === snapshot) return;
    snapshot = next;
    renderCurrent();
  });
  const ownsMetrics = !state.metrics && !state.metricsLoading && !state.metricsError;
  if (ownsMetrics) void loadMetrics(state, () => {
    if (!state.metricsLoading && active && root.isConnected !== false) renderCurrent();
  });
  return () => {
    active = false;
    off?.();
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
