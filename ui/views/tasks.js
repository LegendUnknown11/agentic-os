import { h, page, section, empty, note, button, field, input, select, post, subscribe, editing, membersOf, tone } from './util.js';

// Priority is a small ordered scale, not a free number: the queue offers
// higher first (src/bus.js availableTasks), and four steps is all a person
// actually distinguishes.
export const PRIORITIES = [[2, 'Urgent'], [1, 'High'], [0, 'Normal'], [-1, 'Low']];
const priorityLabel = (value) => (PRIORITIES.find(([n]) => n === Number(value ?? 0)) ?? PRIORITIES[2])[1];
const CLOSED = new Set(['done', 'dropped']);

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

  const title = input('', 'What should the team do?');
  title.setAttribute('aria-label', 'New team task');
  const owner = select([['', 'Anyone (unassigned)'], ...members.map((m) => [m, m])], '');
  owner.setAttribute('aria-label', 'Assign the new task to');
  const priority = select(PRIORITIES.map(([n, label]) => [String(n), label]), '0');
  priority.setAttribute('aria-label', 'Priority of the new task');
  const add = button('Add task', async () => {
    const text = title.value.trim();
    if (!text) { feedback.textContent = 'Enter a task first.'; feedback.hidden = false; return; }
    await taskAction({ op: 'create', title: text, owner: owner.value || null, priority: Number(priority.value) }, feedback, add, refresh);
  }, 'primary');
  title.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add.click(); } });

  const { open, closed } = orderTasks(tasks);
  return section('Team queue',
    h('div', { class: 'task-new' }, field('Task', title), field('Owner', owner), field('Priority', priority), h('div', { class: 'button-row' }, add)),
    feedback,
    state.tasksError ? note(state.tasksError, 'danger') : null,
    open.length ? h('ul', { class: 'task-manage-list', 'aria-label': 'Open team tasks' }, ...open.map((t) => teamRow(t, members, feedback, refresh)))
      : empty(state.tasksLoading ? 'Loading the team queue…' : 'Nothing is queued for the team.'),
    closed.length ? h('details', { class: 'task-closed' }, h('summary', { text: `Closed · ${closed.length}` }),
      h('ul', { class: 'task-manage-list', 'aria-label': 'Closed team tasks' }, ...closed.map((t) => teamRow(t, members, feedback, refresh)))) : null);
}

export function renderTasks(state, root) {
  if (root.isConnected === false) return;
  root.replaceChildren();
  const shell = page('Tasks', "Your own list and the team's queue, in one place.");
  const refresh = () => { if (root.isConnected !== false) renderTasks(state, root); };
  shell.append(teamQueue(state, refresh));
  root.append(shell);
}

export function mountTasks(state, root) {
  renderTasks(state, root);
  const off = subscribe(() => { if (!editing(root)) renderTasks(state, root); });
  return () => off?.();
}
export const render = renderTasks;
export const mount = mountTasks;
