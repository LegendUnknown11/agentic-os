import { h, page, section, empty, button, membersOf, displayName, modeDef, setView, subscribe } from './util.js';
import { statusLabel } from '../status.js';

const open = (view) => () => setView(view);
const MODE_COPY = {
  chat: { label: 'Chat', blurb: 'Start a direct conversation with AgentOS.', action: 'Talk directly with the orchestrator.', cta: 'Start a direct chat' },
  cowork: { label: 'Cowork', blurb: 'Delegate multi-step workspace work to your team.', action: 'Describe the outcome and let AgentOS plan the work.', cta: 'Delegate workspace work' },
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

export function render(state, root, actions = {}, queueExpanded = false) {
  root.replaceChildren();
  if (state.ready === false) {
    const message = state.conn === 'down'
      ? 'The local service is offline. Reconnecting…'
      : 'Loading the team, conversations, and current work…';
    const shell = page('AgentOS', 'Your local team workspace.');
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
  const crewVisible = m.crew === 'all' || m.crew?.length;
  const taskLoading = m.tasks !== false && state.tasksLoading;
  const taskFailure = m.tasks !== false && !taskLoading && state.tasksError;
  const queueVisible = m.tasks !== false && rows.length;
  const workingVisible = crewVisible && working.length;
  const attentionVisible = crewVisible && attention.length;
  const approvalsVisible = crewVisible && approvals.length;
  const changesVisible = m.merge !== false && changes.length;
  const shell = page('Overview', mode.blurb);
  const grid = h('div', { class: 'home-grid' });
  const needsRepository = userMode(state) === 'code' && !state.repo && !state.repository;
  const modeAction = needsRepository ? 'Attach a repository before planning a code change.' : mode.action;
  const modeCta = needsRepository ? 'Attach a repository' : mode.cta;
  const modeTarget = needsRepository ? 'settings' : { page: 'thread', member: 'orchestrator' };

  const modeCard = h('section', { class: `home-card home-mode-card mode-${userMode(state)}` },
    h('p', { class: 'mode-kicker', text: 'Current mode' }),
    h('h2', { text: mode.label }),
    h('p', { text: modeAction }),
    h('div', { class: 'button-row' }, button(modeCta, open(modeTarget), 'primary')));

  const objective = h('div', { class: 'home-card home-objective' }, h('h2', { text: goal?.text ? 'Current objective' : 'Start here' }));
  if (goal?.text) objective.append(h('p', { text: goal.text }), h('div', { class: 'button-row' }, button('Talk to the orchestrator', open({ page: 'thread', member: 'orchestrator' }), 'primary'), button('Edit objective', open('objective'))));
  else objective.append(h('p', { class: 'muted', text: 'Set the outcome first. Every agent receives it before it starts work.' }), h('div', { class: 'button-row' }, button('Set objective', open('objective'), 'primary'), button('Start a conversation', open({ page: 'thread', member: 'orchestrator' }))));
  if (goal?.milestones?.length) objective.append(h('p', { class: 'muted', text: `${goal.milestones.filter((x) => x.done).length}/${goal.milestones.length} milestones complete` }));
  grid.append(h('div', { class: 'home-lead' }, modeCard, objective));

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
    const queue = h('div', { class: 'home-card' }, h('h2', { text: `Queue · ${rows.length}` }));
    for (const task of visibleQueueRows(rows, queueExpanded)) {
      queue.append(h('div', { class: `task-row task-${task.shown}` },
        h('b', { text: `#${task.id} · ${task.shown}` }), h('span', {},
          h('span', { text: task.title ?? task.detail ?? `Task #${task.id}` }),
          h('small', { class: 'muted', text: taskMeta(task) }))));
    }
    if (rows.length > QUEUE_PREVIEW) {
      const toggle = button(queueExpanded ? 'Show fewer tasks' : `Show all ${rows.length} tasks`, () => actions.setQueueExpanded?.(!queueExpanded));
      toggle.setAttribute('aria-expanded', String(queueExpanded));
      queue.append(h('div', { class: 'button-row' }, toggle));
    }
    grid.append(queue);
  }

  if (workingVisible) {
    const card = h('div', { class: 'home-card' }, h('h2', { text: `Working now · ${working.length}` }));
    working.slice(0, 8).forEach(([name, member]) => card.append(button(`${displayName(name, member.role)} · ${statusLabel(currentStatus(name, member))}`, open({ page: 'thread', member: name }), 'list-row')));
    grid.append(card);
  }

  if (attentionVisible) {
    const card = h('div', { class: 'home-card home-attention' }, h('h2', { text: `Needs attention · ${attention.length}` }));
    attention.slice(0, 8).forEach(([name, member]) => card.append(button(`${displayName(name, member.role)} · ${statusLabel(currentStatus(name, member))}`, open({ page: 'thread', member: name }), 'list-row')));
    grid.append(card);
  }

  if (approvalsVisible) {
    const needs = h('div', { class: 'home-card' }, h('h2', { text: `Needs you · ${approvals.length}` }));
    approvals.slice(0, 5).forEach((approval) => needs.append(button(`${String(approval.kind ?? 'request').toUpperCase()} · ${approval.from ?? 'team'}`, open('approvals'), 'list-row')));
    grid.append(needs);
  }

  if (changesVisible) {
    const card = h('div', { class: 'home-card' }, h('h2', { text: `Changes ready · ${changes.length}` }));
    changes.slice(0, 7).forEach((change) => card.append(button(`${displayName(change.peasant)} · review changes`, open('changes'), 'list-row')));
    grid.append(card);
  }

  if (!taskLoading && !taskFailure && !queueVisible && !workingVisible && !attentionVisible && !approvalsVisible && !changesVisible) {
    grid.append(h('p', { class: 'home-empty', text: 'Your workspace is ready. Set an objective or start a conversation to begin.' }));
  }

  shell.append(grid);
  root.append(shell);
}

export function mount(state, root, actions = {}) {
  let queueExpanded = false;
  const renderCurrent = () => render(state, root, { ...actions, setQueueExpanded: (value) => {
    queueExpanded = Boolean(value);
    renderCurrent();
  } }, queueExpanded);
  renderCurrent();
  return subscribe(renderCurrent);
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
