import { h, section, button, note, date, tone } from './views/util.js';
import { statusDot } from './avatar.js';

const array = (value, keys = []) => {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
};

const text = (value, fallback = '') => {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value.text ?? value.message ?? value.title ?? value.label ?? value.name ?? value.detail ?? value.reason ?? value.status ?? fallback);
};

export const runFor = (state = {}) => {
  const value = state.run ?? state.activeRun ?? state.executionRun;
  return value?.run && typeof value.run === 'object' ? value.run : value;
};

export const runId = (run) => run?.id ?? run?.runId ?? run?.run_id ?? null;

export const runStatus = (run) => String(run?.status ?? run?.state ?? 'planning').toLowerCase().replace(/[- ]/g, '_');

export const runStatusLabel = (status) => ({
  planning: 'Planning', running: 'Running', paused: 'Paused', blocked: 'Blocked',
  verifying: 'Verifying', ready_for_review: 'Ready for review', completed: 'Completed',
  cancelled: 'Cancelled', implemented: 'Implemented', verified: 'Verified',
}[runStatus({ status })] ?? text(status, 'Unknown'));

const itemStatus = (item) => String(item?.status ?? item?.state ?? item?.stage ?? '').toLowerCase().replace(/[- ]/g, '_');
const itemLabel = (item) => text(item, 'Untitled deliverable');
const statusClass = (status) => `run-status-${runStatus({ status })}`;

export const objectiveFor = (state, run = runFor(state)) => text(
  run?.objective ?? run?.goal ?? run?.plan?.objective ?? state.goal?.text,
  'No objective recorded.',
);

const statusLine = (item) => item?.status ?? item?.state ?? item?.stage ?? '';
const progressFor = (run) => {
  const progress = array(run, ['progress', 'history', 'events']);
  return run?.lastProgress ?? run?.lastMeaningfulProgress ?? progress.at(-1) ?? null;
};
const recoveryFor = (run) => run?.recovery ?? run?.recoveryState ?? run?.recoveryHistory?.at?.(-1) ?? null;
const listFor = (run, names) => names.flatMap((name) => array(run, [name])).filter(Boolean);

function itemRows(items, emptyText = 'Nothing recorded yet.') {
  if (!items.length) return [h('p', { class: 'empty', text: emptyText })];
  return items.map((item) => {
    const status = itemStatus(item) || 'pending';
    const dot = statusDot();
    const dotTone = tone(status);
    if (dotTone) dot.classList.add(dotTone);
    return h('div', { class: `run-item ${statusClass(status)} ${tone(status)}`.trim() },
      h('span', { class: 'run-item-label' }, dot, h('span', { text: itemLabel(item) })),
      h('b', { text: runStatusLabel(status) }));
  });
}

function runActionButton(label, action, run, { post, toast, onDone } = {}, options = {}) {
  const control = button(label, async () => {
    control.disabled = true;
    let result;
    try { result = await post?.(action, { runId: runId(run) }); }
    catch (error) { result = { ok: false, error: error?.message ?? `Could not ${label.toLowerCase()}.` }; }
    if (result?.ok === false) {
      control.disabled = false;
      toast?.(result.error ?? `Could not ${label.toLowerCase()}.`, true);
      return;
    }
    if (result?.run) Object.assign(run, result.run);
    onDone?.(result);
  }, options.primary ? 'primary' : options.danger ? 'danger' : '');
  control.dataset.runAction = action;
  control.disabled = Boolean(options.disabled);
  if (options.tip) control.dataset.tip = options.tip;
  return control;
}

export function runControls(state, run, options = {}) {
  if (!run) return null;
  const status = runStatus(run);
  const approved = run.finalApproval === true || run.approved === true
    || ['approved', 'accepted'].includes(String(run.approval?.status ?? '').toLowerCase());
  const row = h('div', { class: 'button-row run-controls', 'aria-label': 'Run controls' });
  if (status === 'planning') row.append(runActionButton('Approve plan', 'runApprove', run, options, { primary: true }));
  if (['running', 'verifying'].includes(status)) {
    row.append(runActionButton('Pause', 'runPause', run, options));
    row.append(runActionButton('Stop', 'runStop', run, options, { danger: true }));
  }
  if (['paused', 'blocked'].includes(status)) {
    row.append(runActionButton('Resume', 'runResume', run, options, { primary: true }));
    row.append(runActionButton('Stop', 'runStop', run, options, { danger: true }));
  }
  if (status === 'ready_for_review' && !approved) {
    row.append(runActionButton('Approve final review', 'runApprove', run, options, { primary: true }));
  }
  if (['ready_for_review', 'completed'].includes(status)) {
    row.append(runActionButton('Apply reviewed result', 'runApply', run, options, {
      primary: true, disabled: !approved,
      tip: approved ? 'Apply only this run\'s reviewed delta.' : 'Final approval is required before applying the run.',
    }));
  }
  if (!row.children.length) return null;
  return row;
}

function progressBlock(run) {
  const progress = progressFor(run);
  if (!progress) return null;
  return h('div', { class: 'run-progress' },
    h('b', { text: 'Last meaningful progress' }),
    h('span', { text: `${text(progress)}${progress.ts ? ` · ${date(progress.ts)}` : ''}` }));
}

export function renderRunOverview(state, options = {}) {
  const run = runFor(state);
  if (!run) return null;
  const status = runStatus(run);
  const evidence = listFor(run, ['verificationEvidence', 'verifiedDeliverables', 'deliverables']);
  const verified = evidence.map((item) => item.status || item.state || item.stage
    ? item : { ...item, label: `${item.peasant ?? item.name ?? 'Work'} · verification`, status: item.valid ? 'verified' : 'blocked' });
  const runTaskIds = new Set((run.taskIds ?? []).map(Number));
  const taskRows = Array.isArray(state.tasks) ? state.tasks.filter((task) => !runTaskIds.size || runTaskIds.has(Number(task.id))) : [];
  const currentRows = listFor(run, ['currentWork', 'current', 'activeTasks']);
  const current = currentRows.length ? currentRows : taskRows.filter((task) => !['done', 'dropped'].includes(task.state));
  const blockers = listFor(run, ['blockers', 'blockedBy', 'blocker']);
  const decisions = [
    ...listFor(run, ['decisionsAwaiting', 'decisions', 'pendingDecisions']),
    ...(Array.isArray(state.approvals) ? state.approvals.filter((item) => item.runId === runId(run) || item.run_id === runId(run)) : []),
  ].filter((item) => item?.resolved !== true && item?.status !== 'resolved');
  const recovery = recoveryFor(run);
  const shell = h('section', { class: `home-card run-summary ${statusClass(status)} ${tone(status)}`.trim() },
    h('div', { class: 'run-summary-head' },
      h('div', {}, h('p', { class: 'mode-kicker', text: 'Improvement run' }), h('h2', { text: run.title ?? objectiveFor(state, run) })),
      h('b', { class: `run-badge ${tone(status)}`.trim(), text: runStatusLabel(status) })),
    h('p', { class: 'run-objective', text: objectiveFor(state, run) }),
    progressBlock(run));
  const grid = h('div', { class: 'run-grid' });
  grid.append(section(`Verified deliverables${verified.length ? ` · ${verified.length}` : ''}`, ...itemRows(verified, 'No deliverable has passed verification yet.')));
  grid.append(section(`Current work${current.length ? ` · ${current.length}` : ''}`, ...itemRows(current, 'No active work is recorded.')));
  if (blockers.length) grid.append(section(`Blockers · ${blockers.length}`, ...blockers.map((item) => note(text(item), 'danger'))));
  if (decisions.length) grid.append(section(`Decisions awaiting you · ${decisions.length}`, ...decisions.map((item) => note(text(item)))));
  if (recovery && recovery.active !== false) grid.append(section('Recovery underway', note(text(recovery), 'danger')));
  shell.append(grid);
  const controls = options.post && runControls(state, run, options);
  if (controls) shell.append(controls);
  return shell;
}

function checklist(items) {
  return itemRows(items.map((item) => typeof item === 'string' ? { label: item, status: 'pending' } : item), 'No acceptance checks recorded.');
}

const reviewSection = (title, ...items) => section(title, ...items);

export function renderRunReview(state, options = {}) {
  const run = runFor(state);
  if (!run) return null;
  const review = run.review ?? run.finalReview ?? run.evidence ?? {};
  const status = runStatus(run);
  const diff = review.combinedDiff ?? review.diff ?? review.patch;
  const checks = array(review, ['acceptance', 'acceptanceCriteria', 'checklist']).length
    ? array(review, ['acceptance', 'acceptanceCriteria', 'checklist']) : array(run, ['acceptanceCriteria']);
  const commands = array(review, ['commands', 'verificationCommands']).length
    ? array(review, ['commands', 'verificationCommands'])
    : array(run, ['verificationEvidence']).map((item) => ({
      command: item.command ?? item.testCommand ?? `${item.peasant ?? 'worker'} verification`,
      result: item.output ?? item.tests?.output ?? (item.valid ? 'Verified at the recorded revision.' : 'Unverified or stale evidence.'),
      status: item.valid ? 'verified' : 'blocked',
    }));
  const limitations = array(review, ['limitations', 'remainingLimitations']);
  const walkthrough = array(review, ['walkthrough', 'walkthroughSteps']);
  const captures = array(review, ['captures', 'supportingCaptures']);
  const source = review.sourceState ?? review.sourceComparison ?? run.sourceComparison
    ?? ((run.baselineRevision ?? run.sourceSnapshot)
      ? { baseline: run.baselineRevision ?? run.sourceSnapshot?.revision ?? run.sourceSnapshot,
        current: run.head ?? run.revision, changed: Boolean(run.sourceChanged) } : null);
  if (!diff && !checks.length && !commands.length && !limitations.length && !walkthrough.length && !captures.length && !source
    && !['ready_for_review', 'completed'].includes(status)) return null;
  const shell = h('section', { class: 'view-section run-review' },
    h('h2', { text: 'Final review' }),
    h('p', { class: 'note', text: 'Review the combined run result before applying it to the source checkout.' }));
  if (source) shell.append(reviewSection('Source-state comparison',
    h('div', { class: 'review-comparison' },
      h('span', { text: `Captured baseline: ${text(source.baseline ?? source.base ?? source.before, 'unknown')}` }),
      h('span', { text: `Current source: ${text(source.current ?? source.after, 'unknown')}` }),
      h('b', { class: source.changed ? 'danger' : 'success', text: source.changed ? 'Source changed; refresh review' : 'Baseline unchanged' }))));
  if (diff) shell.append(reviewSection('Combined diff', h('pre', { class: 'diff', text: diff })));
  if (checks.length) shell.append(reviewSection('Acceptance checklist', h('div', { class: 'review-list' }, ...checklist(checks))));
  if (commands.length) shell.append(reviewSection('Commands and results', ...commands.map((item) => {
    const command = text(item.command ?? item.cmd ?? item);
    const result = text(item.result ?? item.output ?? item.detail, 'No result recorded.');
    const itemState = itemStatus(item);
    return h('article', { class: `review-command ${statusClass(itemState)} ${tone(itemState)}`.trim() }, h('code', { text: command }), h('pre', { text: result }));
  })));
  if (limitations.length) shell.append(reviewSection('Remaining limitations', ...limitations.map((item) => note(text(item), 'danger'))));
  if (walkthrough.length) shell.append(reviewSection('Walkthrough', ...walkthrough.map((item, index) => h('div', { class: 'review-step' }, h('b', { text: `${index + 1}. ${text(item.title ?? item.label ?? item)}` }), item.detail && h('span', { text: item.detail })))));
  if (captures.length) shell.append(reviewSection('Supporting captures', ...captures.map((item) => h('div', { class: 'review-capture' }, h('b', { text: text(item.title ?? item.name ?? item, 'Capture') }), item.note && h('span', { text: item.note }), item.interactive === false && h('small', { class: 'muted', text: 'Screenshot only; interactive validation still required.' })))));
  const controls = options.post && runControls(state, run, options);
  if (controls) shell.append(controls);
  return shell;
}

export function renderRunThreadContext(state) {
  const run = runFor(state);
  if (!run) return null;
  const progress = progressFor(run);
  const recovery = recoveryFor(run);
  const body = h('div', { class: 'run-thread-context' },
    h('b', { text: `Run · ${runStatusLabel(runStatus(run))}` }),
    progress && h('span', { text: text(progress) }),
    recovery && recovery.active !== false && h('span', { class: 'danger', text: `Recovery: ${text(recovery)}` }));
  return body;
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('run.js')) {
  const { strict: assert } = await import('node:assert');
  assert.equal(runStatus({ status: 'ready for review' }), 'ready_for_review');
  assert.equal(runStatusLabel('verified'), 'Verified');
  assert.equal(objectiveFor({ goal: { text: 'fallback objective' } }, null), 'fallback objective');
  console.log('run.js OK — run lifecycle labels and objective fallback are stable');
}
