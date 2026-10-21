import { h, page, section, empty, note, button, field, input, select, post, get, subscribe, editing, membersOf, tone, date, apiError, requestToken } from './util.js';

// Priority is a small ordered scale, not a free number: the queue offers
// higher first (src/bus.js availableTasks), and four steps is all a person
// actually distinguishes.
export const PRIORITIES = [[2, 'Urgent'], [1, 'High'], [0, 'Normal'], [-1, 'Low']];
const priorityLabel = (value) => (PRIORITIES.find(([n]) => n === Number(value ?? 0)) ?? PRIORITIES[2])[1];
const CLOSED = new Set(['done', 'dropped']);

// The view repaints on every store change, which during a stream is every
// frame. What the user has opened or half-typed lives in state, or the
// next event collapsed the closed list and wiped the new-task fields.
const viewState = (state) => (state.tasksView ??= { closedOpen: false, doneOpen: false, team: '', mine: '', due: '' });
function remembered(control, view, key) {
  control.value = view[key];
  control.addEventListener('input', () => { view[key] = control.value; });
  return control;
}
function foldable(view, key, summary, list) {
  const details = h('details', { class: 'task-closed' }, h('summary', { text: summary }), list);
  details.open = view[key];
  details.addEventListener('toggle', () => { view[key] = details.open; });
  return details;
}

/** Open first by priority then age; closed after, newest first. Pure, for the suite. */
export function orderTasks(tasks = []) {
  const open = tasks.filter((t) => !CLOSED.has(t.state))
    .sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0) || x.id - y.id);
  const closed = tasks.filter((t) => CLOSED.has(t.state)).sort((x, y) => y.id - x.id);
  return { open, closed };
}

/** Members a task can go to: everyone but the briefer, who only watches. */
export function assignable(state) {
  return membersOf(state).map(([name, member]) => ({ name, role: member?.role }))
    .filter((m) => m.role !== 'briefer').map((m) => m.name);
}

// A focused <select> counts as editing (util.js editing()), so the live
// 'tasks' event would not repaint after a change made from one. Repaint
// explicitly once the daemon has accepted it.
function taskAction(body, feedback, control, refresh) {
  feedback.hidden = true;
  if (control) control.disabled = true;
  return post('task', body).then((result) => {
    if (result?.ok === false) throw new Error(result.error ?? 'Could not update the task.');
    refresh?.();
    return result;
  }).catch((error) => {
    feedback.textContent = error?.message ?? 'Could not update the task.';
    feedback.hidden = false;
  }).finally(() => { if (control?.isConnected) control.disabled = false; });
}

function teamRow(task, members, feedback, refresh) {
  const closed = CLOSED.has(task.state);
  const names = task.owner && !members.includes(task.owner) ? [...members, task.owner] : members;
  const owner = select([['', 'Unassigned'], ...names.map((m) => [m, m])], task.owner ?? '');
  owner.setAttribute('aria-label', `Owner of task #${task.id}`);
  owner.disabled = closed || task.state === 'verifying';
  owner.addEventListener('change', () => taskAction({ op: 'assign', id: task.id, owner: owner.value || null }, feedback, owner, refresh));
  const priority = select(PRIORITIES.map(([n, label]) => [String(n), label]), String(task.priority ?? 0));
  priority.setAttribute('aria-label', `Priority of task #${task.id}`);
  priority.disabled = closed;
  priority.addEventListener('change', () => taskAction({ op: 'priority', id: task.id, priority: Number(priority.value) }, feedback, priority, refresh));
  const close = button(closed ? 'Reopen' : 'Drop',
    (event) => taskAction({ op: closed ? 'reopen' : 'drop', id: task.id }, feedback, event?.currentTarget, refresh));
  const meta = [`#${task.id}`, task.state, priorityLabel(task.priority), task.blockedBy?.length ? `waits on ${task.blockedBy.map((n) => `#${n}`).join(', ')}` : null]
    .filter(Boolean).join(' · ');
  return h('li', { class: `task-manage ${tone(task.state)}`.trim(), 'data-task-id': String(task.id) },
    h('div', { class: 'task-manage-text' }, h('strong', { text: task.title }), h('span', { class: 'card-meta', text: meta })),
    h('div', { class: 'task-manage-controls' }, owner, priority, close));
}

function teamQueue(state, refresh) {
  const tasks = state.tasks?.tasks ?? state.tasks ?? [];
  const members = assignable(state);
  const feedback = note('', 'danger');
  feedback.hidden = true;
  feedback.setAttribute('role', 'alert');

  const view = viewState(state);
  const title = remembered(input('', 'What should the team do?'), view, 'team');
  title.setAttribute('aria-label', 'New team task');
  const owner = select([['', 'Anyone (unassigned)'], ...members.map((m) => [m, m])], '');
  owner.setAttribute('aria-label', 'Assign the new task to');
  const priority = select(PRIORITIES.map(([n, label]) => [String(n), label]), '0');
  priority.setAttribute('aria-label', 'Priority of the new task');
  const add = button('Add task', async () => {
    const text = title.value.trim();
    if (!text) { feedback.textContent = 'Enter a task first.'; feedback.hidden = false; return; }
    const result = await taskAction({ op: 'create', title: text, owner: owner.value || null, priority: Number(priority.value) }, feedback, add);
    if (result) { view.team = ''; refresh?.(); }
  }, 'primary');
  title.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add.click(); } });

  const { open, closed } = orderTasks(tasks);
  return section('Team queue',
    h('div', { class: 'task-new' }, field('Task', title), field('Owner', owner), field('Priority', priority), h('div', { class: 'button-row' }, add)),
    feedback,
    state.tasksError ? note(state.tasksError, 'danger') : null,
    open.length ? h('ul', { class: 'task-manage-list', 'aria-label': 'Open team tasks' }, ...open.map((t) => teamRow(t, members, feedback, refresh)))
      : empty(state.tasksLoading ? 'Loading the team queue…' : 'Nothing is queued for the team.'),
    closed.length ? foldable(view, 'closedOpen', `Closed · ${closed.length}`,
      h('ul', { class: 'task-manage-list', 'aria-label': 'Closed team tasks' }, ...closed.map((t) => teamRow(t, members, feedback, refresh)))) : null);
}

/* ---------- my tasks: the user's own list ---------- */

const DAY = 86_400_000;

/** How a due time reads, and whether it needs attention. Pure, for the suite. */
export function dueState(task, now = Date.now()) {
  if (task.doneTs) return { label: `Done ${date(task.doneTs)}`, tone: 'settled' };
  if (task.dueTs == null) return { label: 'No due date', tone: '' };
  if (task.snoozedUntil > now) return { label: `Snoozed until ${date(task.snoozedUntil)}`, tone: 'idle' };
  if (task.dueTs <= now) return { label: `Overdue since ${date(task.dueTs)}`, tone: 'attention' };
  return { label: `Due ${date(task.dueTs)}`, tone: task.dueTs - now < DAY ? 'live' : '' };
}

export function loadMyTasks(state, render) {
  const token = requestToken(state, 'myTasksRequest');
  return get('/api/myTasks').then((data) => {
    if (state.myTasksRequest !== token) return;
    if (data?.ok !== false) { state.myTasks = data.tasks ?? []; state.myTasksError = null; }
    else state.myTasksError = apiError(data, 'Could not load your tasks.');
    render?.();
  });
}

function myAction(body, feedback, control, refresh) {
  feedback.hidden = true;
  if (control) control.disabled = true;
  return post('myTask', body).then((result) => {
    if (result?.ok === false) throw new Error(result.error ?? 'Could not update your task.');
    refresh?.();
    return result;
  }).catch((error) => {
    feedback.textContent = error?.message ?? 'Could not update your task.';
    feedback.hidden = false;
  }).finally(() => { if (control?.isConnected) control.disabled = false; });
}

function myRow(task, feedback, refresh) {
  const due = dueState(task);
  const done = h('input', { type: 'checkbox', checked: Boolean(task.doneTs), 'aria-label': `Done: ${task.title}` });
  done.addEventListener('change', () => myAction({ op: done.checked ? 'done' : 'undo', id: task.id }, feedback, done, refresh));
  const snooze = task.doneTs || task.dueTs == null ? null
    : button('Snooze a day', (event) => myAction({ op: 'snooze', id: task.id, forMs: DAY }, feedback, event?.currentTarget, refresh));
  const remove = button('Delete', (event) => myAction({ op: 'delete', id: task.id }, feedback, event?.currentTarget, refresh));
  return h('li', { class: `task-manage my-task ${due.tone}`.trim(), 'data-my-task-id': String(task.id) },
    h('label', { class: 'my-task-check' }, done,
      h('span', { class: 'task-manage-text' }, h('strong', { text: task.title }),
        h('span', { class: 'card-meta', text: [due.label, task.by !== 'user' ? `added by ${task.by}` : null].filter(Boolean).join(' · ') }),
        task.notes ? h('span', { class: 'my-task-notes', text: task.notes }) : null)),
    h('div', { class: 'task-manage-controls' }, snooze, remove));
}

function myTasks(state, refresh) {
  const tasks = state.myTasks ?? [];
  const feedback = note('', 'danger');
  feedback.hidden = true;
  feedback.setAttribute('role', 'alert');
  const view = viewState(state);
  const title = remembered(input('', 'Something to remember…'), view, 'mine');
  title.setAttribute('aria-label', 'New task for you');
  const due = remembered(h('input', { type: 'datetime-local', 'aria-label': 'Due (optional)' }), view, 'due');
  const add = button('Add', async () => {
    const text = title.value.trim();
    if (!text) { feedback.textContent = 'Enter a task first.'; feedback.hidden = false; return; }
    const dueTs = due.value ? new Date(due.value).getTime() : null;
    const result = await myAction({ op: 'add', title: text, dueTs: Number.isFinite(dueTs) ? dueTs : null }, feedback, add);
    if (result) { view.mine = ''; view.due = ''; refresh?.(); }
  }, 'primary');
  title.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add.click(); } });
  const open = tasks.filter((t) => !t.doneTs);
  const closed = tasks.filter((t) => t.doneTs);
  return section('My tasks',
    h('div', { class: 'task-new my-task-new' }, field('Task', title), field('Due', due), h('div', { class: 'button-row' }, add)),
    feedback,
    state.myTasksError ? note(state.myTasksError, 'danger') : null,
    open.length ? h('ul', { class: 'task-manage-list', 'aria-label': 'Your open tasks' }, ...open.map((t) => myRow(t, feedback, refresh)))
      : empty(state.myTasks ? 'Nothing on your list.' : 'Loading your list…'),
    closed.length ? foldable(view, 'doneOpen', `Done · ${closed.length}`,
      h('ul', { class: 'task-manage-list', 'aria-label': 'Your finished tasks' }, ...closed.map((t) => myRow(t, feedback, refresh)))) : null);
}

export function renderTasks(state, root) {
  if (root.isConnected === false) return;
  root.replaceChildren();
  const shell = page('Tasks', "Your own list and the team's queue, in one place.");
  const refresh = () => { if (root.isConnected !== false) renderTasks(state, root); };
  shell.append(myTasks(state, refresh), teamQueue(state, refresh));
  root.append(shell);
}

export function mountTasks(state, root) {
  renderTasks(state, root);
  // The orchestrator can add to the list from its own MCP process, which the
  // daemon does not hear; loading on every visit is what keeps that visible.
  void loadMyTasks(state, () => { if (root.isConnected !== false && !editing(root)) renderTasks(state, root); });
  const off = subscribe(() => { if (!editing(root)) renderTasks(state, root); });
  return () => { requestToken(state, 'myTasksRequest'); off?.(); };
}

/** Your own list on its own, as the Inbox's "My tasks" tab (no team queue). */
export function renderMyTasks(state, root) {
  if (root.isConnected === false) return;
  root.replaceChildren();
  const refresh = () => { if (root.isConnected !== false) renderMyTasks(state, root); };
  root.append(h('div', { class: 'view-page' }, myTasks(state, refresh)));
}

export function mountMyTasks(state, root) {
  renderMyTasks(state, root);
  void loadMyTasks(state, () => { if (root.isConnected !== false && !editing(root)) renderMyTasks(state, root); });
  const off = subscribe(() => { if (!editing(root)) renderMyTasks(state, root); });
  return () => { requestToken(state, 'myTasksRequest'); off?.(); };
}
export const render = renderTasks;
export const mount = mountTasks;
