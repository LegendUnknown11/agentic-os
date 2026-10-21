import { h, spendText, turnsText, tone } from './views/util.js';
import { icon } from './icons.js';
import { runStatus } from './run.js';

// The session inspector: the cards the T3 canvas draws beside a run. Every row
// is read from state the daemon already streams (workspace, branch, the run's
// tasks and lifecycle, changed worktrees, the team, spend). The canvas also
// draws a context-window meter, Compact session and a Remote control toggle;
// nothing here measures or does those, so they are not drawn.

const LIFECYCLE = [['planning', 'Plan'], ['running', 'Run'], ['verifying', 'Verify'], ['ready_for_review', 'Review'], ['completed', 'Done']];
const STAGE_OF = { planning: 0, running: 1, paused: 1, blocked: 1, verifying: 2, ready_for_review: 3, completed: 4, cancelled: 4 };
const CLOSED = new Set(['done', 'dropped']);

const repoName = (path) => (path ? String(path).split(/[\\/]/).filter(Boolean).pop() : '');
const tasksOf = (state) => (Array.isArray(state.tasks) ? state.tasks : state.tasks?.tasks ?? []);
const changesOf = (state) => (Array.isArray(state.changes) ? state.changes : state.changes?.changed ?? []);

/**
 * What the Progress card lists, in order: the run's tasks if it has any, else
 * the run's lifecycle stages. Pure, for the suite.
 * @returns {{ label: string, state: 'done' | 'current' | 'todo' }[]}
 */
export function progressSteps(state) {
  const run = state.run;
  const ids = new Set((run?.taskIds ?? []).map(Number));
  const tasks = tasksOf(state).filter((task) => !ids.size || ids.has(Number(task.id)));
  if (tasks.length) {
    let currentSeen = false;
    return tasks.slice(0, 12).map((task) => {
      if (CLOSED.has(task.state)) return { label: task.title ?? `Task #${task.id}`, state: 'done' };
      const working = !currentSeen && ['active', 'claimed', 'verifying'].includes(task.state);
      if (working) currentSeen = true;
      return { label: task.title ?? `Task #${task.id}`, state: working ? 'current' : 'todo' };
    });
  }
  if (!run) return [];
  const at = STAGE_OF[runStatus(run)] ?? 0;
  return LIFECYCLE.map(([, label], index) => ({ label, state: index < at ? 'done' : index === at ? 'current' : 'todo' }));
}

const kv = (iconName, ...children) => h('div', { class: 'inspector-kv' }, icon(iconName, 15), ...children);

function card(id, title, open, body) {
  const isOpen = open.has(id);
  const head = h('button', { class: 'inspector-head', type: 'button', 'data-action': 'inspector-toggle', 'data-card': id, 'aria-expanded': String(isOpen) },
    h('span', { text: title }), icon(isOpen ? 'chevron-down' : 'chevron-right', 12));
  return h('section', { class: 'inspector-card', 'data-card': id }, head, isOpen ? h('div', { class: 'inspector-body' }, ...body) : null);
}

function stepRow(step) {
  const mark = step.state === 'done' ? icon('check', 14) : h('span', { class: `inspector-ring ${step.state}`, 'aria-hidden': 'true' });
  return h('div', { class: `inspector-step ${step.state}` }, mark,
    h('span', { text: step.label }), h('span', { class: 'visually-hidden', text: step.state === 'done' ? ' (done)' : step.state === 'current' ? ' (in progress)' : ' (not started)' }));
}

/** The right-hand column of a run. `open` is a Set of card ids the reader has expanded. */
export function renderInspector(state, { open }) {
  const run = state.run;
  const environment = [
    kv('folder', h('span', { text: repoName(state.repo ?? state.repository) || 'No repository' }),
      state.repo ? h('span', { class: 'inspector-sub mono', text: String(state.repo) }) : null),
    state.base ? kv('branch', h('span', { class: 'mono', text: String(state.base) })) : null,
    state.mode ? kv('mode', h('span', { text: `${String(state.mode).replace(/^./, (c) => c.toUpperCase())} mode` })) : null,
  ].filter(Boolean);

  const steps = progressSteps(state);
  const progress = steps.length ? steps.map(stepRow) : [h('p', { class: 'inspector-empty', text: 'No run or task is in progress.' })];

  const changed = changesOf(state);
  const outputs = changed.length ? changed.map((change) => h('button', { class: 'inspector-out', type: 'button', 'data-action': 'run-tab', 'data-tab': 'diff' },
    h('span', { text: String(change.peasant ?? change.name ?? 'worktree') }), h('span', { class: 'inspector-sub mono', text: 'diff' })))
    : [h('p', { class: 'inspector-empty', text: 'Nothing has changed in a worktree yet.' })];

  const members = state.members instanceof Map ? [...state.members.values()] : Object.values(state.members ?? {});
  const awake = members.filter((member) => member?.awake || member?.state === 'awake' || member?.state === 'busy').length;
  const spend = [spendText(state.spend), turnsText(state.spend)].filter(Boolean).join(' · ');
  const session = [
    kv('who', h('span', { text: 'Team' }), h('span', { class: 'inspector-sub', text: members.length ? `${awake}/${members.length} awake` : 'no one yet' })),
    kv('advisor', h('span', { text: 'Skills' }), h('span', { class: 'inspector-sub', text: Array.isArray(state.skills) && state.skills.length ? `${state.skills.length} available` : 'none loaded' })),
    kv('metrics', h('span', { text: 'Spend' }), h('span', { class: 'inspector-sub mono', text: spend || 'nothing yet' })),
  ];

  const aside = h('aside', { class: 'run-inspector', 'aria-label': 'Session inspector' },
    card('environment', 'Environment', open, environment),
    card('progress', run ? 'Progress' : 'Tasks', open, progress),
    card('outputs', 'Outputs', open, outputs),
    card('session', 'This session', open, session));
  aside.dataset.tone = run ? tone(runStatus(run)) : '';
  return aside;
}
