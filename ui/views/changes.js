import { h, page, section, empty, note, button, membersOf, displayName, modeAllows, get, post, subscribe, setView, editing, tone, apiError, requestToken } from './util.js';
import { renderRunReview } from '../run.js';

const rows = (value, key = 'rows') => Array.isArray(value) ? value : value?.[key] ?? [];
const refresh = async (state, key, url) => {
  let result;
  try { result = await get(url); }
  catch (error) { result = { ok: false, error: error?.message ?? `Could not load ${key}.` }; }
  if (result?.ok !== false) {
    state[key] = result;
    state[`${key}Error`] = null;
  } else state[`${key}Error`] = apiError(result, `Could not load ${key}.`);
  return result;
};
const rerender = (state, root, render) => { if (root.isConnected) render(state, root); };
const refreshChanges = (state, options = {}) => options.refreshLists
  ? options.refreshLists()
  : refresh(state, 'changes', '/api/changes');
function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

/* Changes ---------------------------------------------------------------- */
const changeFlow = 'Work in progress -> Ready for review -> Merge requested -> Result';
const idleStatuses = new Set(['idle', 'turn_end', 'ready', 'awake', 'exited', 'idle-slept']);

export function pushState(state, unmerged = false) {
  if (!modeAllows(state, 'worktrees') || !modeAllows(state, 'merge')) return 'unavailable';
  if (unmerged) return 'merge-first';
  return rows(state.approvals, 'approvals').some((approval) => approval.kind === 'push' && !approval.resolved)
    ? 'pending' : 'ready';
}

function lifecycleMap(state) {
  return state.changeLifecycle ?? (state.changeLifecycle = {});
}

function latestMergeNotice(state, agent) {
  return [...(state.notices ?? [])].reverse().find((event) =>
    (event.type === 'merged' || event.type === 'mergeFailed') && event.agent === agent);
}

export function changeStage(state, agent, stat = '') {
  const map = lifecycleMap(state);
  let current = map[agent];
  if (stat && current?.status === 'merged' && current.stat !== stat) {
    current = map[agent] = { status: 'review', stat };
  } else if (stat && !current) {
    current = map[agent] = { status: 'review', stat };
  }
  if (current?.status && current.status !== 'review') return current;
  const event = latestMergeNotice(state, agent);
  if (event?.type === 'merged') return map[agent] = { status: 'merged', stat, message: `Merged into ${state.base ?? 'the base branch'}.` };
  if (event?.type === 'mergeFailed') return map[agent] = { status: 'failed', stat, message: event.message ?? 'The merge did not happen.' };
  return current ?? { status: stat ? 'review' : 'work' };
}

function setChangeStage(state, agent, patch) {
  const map = lifecycleMap(state);
  map[agent] = { ...map[agent], ...patch };
  return map[agent];
}

function flowNote() {
  return note(`Lifecycle: ${changeFlow}. Open the diff before requesting a merge; this page reports the result.`);
}

function workingEntries(state, changedNames) {
  return membersOf(state).filter(([name, member]) => {
    if (member.role !== 'agent' || changedNames.has(name) || !member.awake) return false;
    const status = member.status ?? state.log?.get?.(name)?.at?.(-1)?.type ?? '';
    return member.serving || member.busy || ['working', 'busy', 'verifying'].includes(status) || !idleStatuses.has(status);
  });
}

function mergeResult(state, root, agent, result, life) {
  if (!['requested', 'merged', 'failed'].includes(life.status)) return null;
  const merged = life.status === 'merged';
  const failed = life.status === 'failed';
  const card = h('article', { class: `activity-row merge-result ${merged ? 'merged' : failed ? 'failed' : 'requested'} ${tone(life.status)}`.trim() },
    h('div', { class: 'card-meta', text: `Result · ${displayName(agent)}` }),
    h('h3', { text: merged ? 'Merged into the base branch' : failed ? 'Merge did not happen' : 'Merge requested' }),
    h('p', { text: merged
      ? `${life.message ?? `The work is now in ${state.base ?? 'the base branch'}.`} Continue with the next task.`
      : failed
        ? `${life.message ?? 'Nothing was changed.'} Review the diff, fix the branch, then request the merge again.`
        : 'The request was sent. Keep this page open for the merged or refused result.' }));
  if (life.status === 'requested') card.append(button('Refresh status', async () => {
    await refreshChanges(state, root._changesOptions);
    rerender(state, root, renderChanges);
  }));
  if (failed && result) card.append(button('Review diff', () => diffDetail(state, root, agent), 'primary'));
  return card;
}

function statFiles(stat = '') {
  return String(stat).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)/);
    return match ? [{ path: match[1], plus: (match[3].match(/\+/g) ?? []).length, minus: (match[3].match(/-/g) ?? []).length }] : [];
  });
}
function diffDetail(state, root, agent, file = '') {
  const token = requestToken(state, 'diffRequest');
  changeStage(state, agent);
  root.replaceChildren(page('Changes', `${displayName(agent)} · reading worktree…`));
  get(`/api/diff?agent=${encodeURIComponent(agent)}${file ? `&file=${encodeURIComponent(file)}` : ''}`).then((result) => {
    if (!root.isConnected || state.diffRequest !== token) return;
    root.replaceChildren();
    const shell = page('Changes', `${displayName(agent)} · ${result.base ?? state.base ?? 'base'}`);
    shell.append(flowNote());
    const current = changeStage(state, agent, result.stat ?? '');
    if (!result.ok) {
      const retry = button('Retry', () => diffDetail(state, root, agent, file), 'primary');
      shell.append(h('div', { class: 'button-row' }, note(result.error ?? 'Could not read the diff.', 'danger'), retry));
    }
    else if (result.none || (!result.stat?.trim() && !result.diff?.trim())) shell.append(mergeResult(state, root, agent, null, current) ?? empty(result.reason ?? 'No changes yet.'));
    else {
      const files = statFiles(result.stat);
      if (!file && files.length) shell.append(section('Files', ...files.map((f) => button(`${f.path}  +${f.plus} −${f.minus}`, () => diffDetail(state, root, agent, f.path), 'list-row'))));
      if (file) shell.append(button('‹ all files', () => diffDetail(state, root, agent), 'link'));
      const pre = h('pre', { class: 'diff' });
      for (const line of String(result.diff ?? '').split('\n')) pre.append(h('span', { class: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '', text: `${line}\n` }));
      shell.append(section(file || 'Diff', pre));
      if (result.truncated) shell.append(note('Diff truncated. Open a single file for the rest.'));
      const actions = h('div', { class: 'button-row' });
      const merge = button(current.status === 'requested' ? 'Merge requested' : `Merge into ${result.base ?? state.base ?? 'base'}`, async () => {
        merge.disabled = true;
        merge.textContent = 'Merge requested';
        setChangeStage(state, agent, { status: 'requested', stat: result.stat, message: 'The merge request is running.' });
        let response;
        try { response = await post('merge', { agent }); }
        catch (error) { response = { ok: false, error: error?.message ?? 'The merge did not happen.' }; }
        if (response?.ok === false) setChangeStage(state, agent, { status: 'failed', stat: result.stat, message: response.error ?? 'The merge did not happen.' });
        else setChangeStage(state, agent, { status: 'merged', stat: result.stat, message: `Merged into ${result.base ?? state.base ?? 'the base branch'}.` });
        await refreshChanges(state, root._changesOptions);
        rerender(state, root, renderChanges);
      }, 'primary');
      merge.disabled = !modeAllows(state, 'merge') || current.status === 'requested' || current.status === 'merged';
      actions.append(merge, button('Refresh', () => diffDetail(state, root, agent, file)));
      shell.append(actions);
      if (current.status !== 'review') shell.append(mergeResult(state, root, agent, result, current));
    }
    root.append(shell);
  }).catch((error) => {
    if (!root.isConnected || state.diffRequest !== token) return;
    root.replaceChildren(page('Changes', `${displayName(agent)} · ${state.base ?? 'base'}`), h('div', { class: 'button-row' }, note(error?.message ?? 'Could not read the diff.', 'danger'), button('Retry', () => diffDetail(state, root, agent, file), 'primary')));
  });
}
export function renderChanges(state, root, options = {}) {
  root._changesOptions = options;
  root.replaceChildren();
  const allChanged = rows(state.changes, 'changed');
  const changed = allChanged.filter((change) => changeStage(state, change.agent, change.stat).status !== 'merged');
  const shell = page('Changes', 'Review worktrees before deciding what reaches the base branch.');
  if (state.changesLoading) { shell.append(section('Work', empty('Loading worktrees…'))); root.append(shell); return; }
  const loadFailure = state.changesError ?? apiError(state.changes, 'Could not load changes.');
  if (loadFailure) {
    const retry = button('Retry', async () => {
      state.changesLoading = true;
      state.changesError = null;
      renderChanges(state, root, options);
      await refreshChanges(state, options);
      if (!root.isConnected) return;
      state.changesLoading = false;
      renderChanges(state, root, options);
    }, 'primary');
    shell.append(h('div', { class: 'button-row' }, note(loadFailure, 'danger'), retry));
    if (!state.changes || state.changes?.ok === false) { root.append(shell); return; }
  }
  shell.append(flowNote());
  const finalReview = renderRunReview(state, { post: options.post ?? post, toast: options.toast });
  if (finalReview) shell.append(finalReview);
  const release = section('Release');
  const releaseState = pushState(state, Boolean(allChanged.length));
  if (releaseState === 'unavailable') {
    release.append(note('Push is available in Code mode after the work is reviewed and merged.'));
  } else if (releaseState === 'merge-first') {
    release.append(note('Merge or resolve the listed worktrees before requesting a push.'));
  } else if (releaseState === 'pending') {
    release.append(note('A push request is waiting for your approval in your Inbox.'));
  } else {
    const request = button('Request push', async () => {
      request.disabled = true;
      request.textContent = 'Request sent';
      let result;
      try { result = await post('requestPush', { reason: 'Reviewed changes are ready for the configured remote.' }); }
      catch (error) { result = { ok: false, error: error?.message ?? 'Could not request a push.' }; }
      if (result?.ok === false) {
        request.disabled = false;
        request.textContent = 'Request push';
        release.append(note(result.error ?? 'Could not request a push.', 'danger'));
      }
    }, 'primary');
    release.append(note('The final push is always gated by an approval.'), h('div', { class: 'button-row' }, request));
  }
  shell.append(release);
  const working = workingEntries(state, new Set(allChanged.map((change) => change.agent)));
  const inProgress = section(`Work in progress${working.length ? ` · ${working.length}` : ''}`);
  if (!working.length) inProgress.append(empty('No agent is mid-turn without a diff. New work appears here as it changes its worktree.'));
  working.forEach(([name, member]) => inProgress.append(button(`${displayName(name, member.role)} · editing its worktree`, () => setView({ page: 'thread', member: name }), 'list-row')));
  shell.append(inProgress);
  const body = section(`Ready to review${changed.length ? ` · ${changed.length}` : ''}`);
  if (!changed.length) body.append(empty('No unmerged work.'));
  else {
    body.append(note(modeAllows(state, 'merge')
      ? 'Select a worktree to inspect its diff, then merge it when the review is complete.'
      : 'Select a worktree to inspect its diff. Merging is disabled in this mode.'));
    changed.forEach((change) => {
      const files = statFiles(change.stat);
      const count = files.length;
      body.append(button(`Review ${displayName(change.agent)}  ·  ${count || 'Some'} ${count === 1 ? 'file' : 'files'} changed`, () => diffDetail(state, root, change.agent), 'list-row'));
    });
  }
  shell.append(body);
  const activity = Object.entries(state.changeLifecycle ?? {})
    .filter(([, life]) => ['requested', 'merged', 'failed'].includes(life.status));
  if (activity.length) shell.append(section('Merge activity', ...activity.map(([agent, life]) => mergeResult(
    state, root, agent, allChanged.find((change) => change.agent === agent), life))));
  root.append(shell);
}
export function mountChanges(state, root, options = {}) {
  const token = requestToken(state, 'changesRequest');
  state.changesLoading = true;
  state.changesError = null;
  const render = (next, host) => renderChanges(next, host, options);
  render(state, root);
  const off = bind(state, root, render);
  void refreshChanges(state, options).then((data) => {
    if (root.isConnected === false || state.changesRequest !== token) {
      if (state.changesRequest === token) state.changesLoading = false;
      return;
    }
    state.changesLoading = false;
    if (!options.refreshLists) {
      if (data?.ok === false) state.changesError = apiError(data, 'Could not load changes.');
      else { state.changes = data; state.changesError = null; }
    }
    render(state, root);
  }).catch((error) => {
    if (root.isConnected === false || state.changesRequest !== token) return;
    state.changesLoading = false;
    state.changesError = error?.message ?? 'Could not load changes.';
    render(state, root);
  });
  return () => { requestToken(state, 'changesRequest'); off?.(); };
}
export const render = renderChanges;
export const mount = mountChanges;
