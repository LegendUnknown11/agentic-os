import {
  h, page, section, empty, note, button, kb, money, date, modeAllows, displayName,
  get, post, subscribe, editing, tone,
} from './util.js';
import { statusDot } from '../avatar.js';

const rows = (value, key = 'rows') => Array.isArray(value) ? value : value?.[key] ?? [];
const refresh = async (state, key, url) => { const result = await get(url); if (result?.ok !== false) state[key] = result; return result; };
const apiError = (result, fallback) => result?.ok === false ? result.error ?? fallback : null;
const requestToken = (state) => { state.approvalsRequest = (state.approvalsRequest ?? 0) + 1; return state.approvalsRequest; };
const rerender = (state, root, render) => { if (root.isConnected) render(state, root); };
const approvalKind = (kind) => ({ summon: 'Team request', role: 'Role request', merge: 'Merge request', push: 'Push request', question: 'Question' }[kind]
  ?? `${String(kind ?? 'request').replace(/[-_]+/g, ' ')} request`);
const approvalStatus = (status) => ({ approved: 'Approved', rejected: 'Rejected', blocked: 'Blocked', answered: 'Answered' }[status] ?? 'Decision recorded');
// approvalStatus() names the decision; tone() decides how it reads. Keeping the
// label map here is fine — statusLabel() does the same job for members — but the
// colour must come from the one shared classifier, or this view is the sixth
// private status vocabulary the tone primitive exists to collapse.
const resolvedStatus = (resolved, extra = '') => {
  const shared = tone(resolved);
  const dot = statusDot();
  if (shared) dot.classList.add(shared);
  return h('p', { class: `note approval-status ${shared}`.trim() },
    dot, h('span', { text: `${approvalStatus(resolved)}${extra}` }));
};

function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

/* Approvals -------------------------------------------------------------- */
function approvalCard(state, approval, root) {
  const live = !approval.resolved;
  const card = h('article', { class: `approval-card ${live ? 'pending' : 'resolved'}` },
    h('div', { class: 'card-meta', text: `${approvalKind(approval.kind)} · ${displayName(approval.from ?? 'orchestrator')} · ${date(approval.ts)}` }));
  const feedback = note('', 'danger');
  feedback.hidden = true;
  const showFailure = (message) => {
    feedback.textContent = message ?? 'The decision could not be recorded. Try again.';
    feedback.hidden = false;
  };
  const what = approval.names?.length ? approval.names.join(', ') : approval.peasant ?? approval.name ?? approval.reason ?? '';
  if (what) card.append(h('h3', { text: what }));
  if (approval.reason) card.append(h('p', { text: approval.reason }));
  if (approval.forecast?.crew) card.append(note(`Estimated ${approval.forecast.crew.perTurnUsd == null ? `${kb(approval.forecast.crew.perTurnTokens)} tokens/turn` : `${money(approval.forecast.crew.perTurnUsd)}/turn`}`));

  if (approval.kind === 'question') {
    if (live) {
      card.append(note('Choose an answer, then submit it to unblock the team.'));
      const form = h('div', { class: 'question-options' });
      for (const [qi, question] of (approval.questions ?? []).entries()) {
        const options = h('div', { class: 'question' }, h('h4', { text: question.question ?? `Question ${qi + 1}` }));
        (question.options ?? []).forEach((option) => {
          const radio = h('input', { type: question.multiSelect ? 'checkbox' : 'radio', name: `q-${approval.id}-${qi}`, value: option.label ?? option, 'data-q': qi });
          options.append(h('label', {}, radio, h('span', { text: option.label ?? option })));
        });
        const other = h('input', { class: 'question-other', placeholder: 'Other…' });
        other.setAttribute('aria-label', `Other answer for ${question.header ?? question.question ?? `Question ${qi + 1}`}`);
        other.dataset.questionOther = String(qi);
        options.append(other);
        form.append(options);
      }
      const answer = button('Answer', async () => {
        const answers = [...form.querySelectorAll('.question')].map((options) => {
          const chosen = [...options.querySelectorAll('[data-q]:checked')].map((el) => el.value);
          const other = options.querySelector('[data-question-other]')?.value.trim();
          return other ? [...chosen, other] : chosen;
        });
        if (!answers.length || answers.some((choice) => !choice.length)) {
          showFailure('Answer every question before submitting.');
          return;
        }
        answer.disabled = true;
        try {
          const response = await post('answerQuestion', { id: approval.id, answers });
          if (response?.ok === false) throw new Error(response.error);
          const data = await refresh(state, 'approvals', '/api/approvals');
          if (data?.ok === false) throw new Error(data.error ?? 'The decision was recorded, but the list could not refresh.');
          state.approvals = data.approvals ?? state.approvals ?? [];
          rerender(state, root, renderApprovals);
        } catch (error) {
          answer.disabled = false;
          showFailure(error?.message);
        }
      }, 'primary');
      card.append(form, answer, feedback);
    } else card.append(resolvedStatus(approval.resolved, approval.answers ? `: ${JSON.stringify(approval.answers)}` : ''));
    return card;
  }

  if (live) {
    const actions = h('div', { class: 'button-row' });
    const allowed = modeAllows(state, 'crew');
    card.append(note(allowed ? 'Review the request, then choose Approve or Reject.' : 'This mode prevents team decisions. Switch modes to continue.'));
    const decide = async (action) => {
      approve.disabled = no.disabled = true;
      try {
        const response = await post(action, { id: approval.id });
        if (response?.ok === false) throw new Error(response.error);
        const data = await refresh(state, 'approvals', '/api/approvals');
        if (data?.ok === false) throw new Error(data.error ?? 'The decision was recorded, but the list could not refresh.');
        state.approvals = data.approvals ?? state.approvals ?? [];
        rerender(state, root, renderApprovals);
      } catch (error) {
        approve.disabled = no.disabled = false;
        showFailure(error?.message);
      }
    };
    const approve = button('Approve', () => decide('approve'), 'primary');
    const no = button('Reject', () => decide('reject'));
    approve.disabled = no.disabled = !allowed;
    actions.append(approve, no);
    card.append(actions, feedback);
  } else card.append(resolvedStatus(approval.resolved));
  return card;
}

export function renderApprovals(state, root) {
  root.replaceChildren();
  const all = rows(state.approvals, 'approvals');
  const pending = all.filter((a) => !a.resolved);
  const shell = page('Approvals', 'Requests that need a decision before the team can continue.');
  const body = section(`Waiting on you${pending.length ? ` · ${pending.length}` : ''}`);
  if (state.approvalsLoading) body.append(empty('Loading decisions…'));
  else if (state.approvalsError) body.append(h('div', { class: 'button-row' }, note(state.approvalsError, 'danger'), button('Retry', () => loadApprovals(state, root), 'primary')));
  else if (!pending.length) body.append(empty('Nothing is waiting on you.'));
  pending.forEach((approval) => body.append(approvalCard(state, approval, root)));
  shell.append(body);
  const resolved = all.filter((a) => a.resolved);
  if (resolved.length) shell.append(section('Decision history', ...resolved.slice(0, 40).map((approval) => approvalCard(state, approval, root))));
  root.append(shell);
}
async function loadApprovals(state, root) {
  const token = requestToken(state);
  state.approvalsLoading = true;
  state.approvalsError = null;
  renderApprovals(state, root);
  let data;
  try { data = await get('/api/approvals'); }
  catch (error) { data = { ok: false, error: error?.message ?? 'Could not load decisions.' }; }
  if (root.isConnected === false || state.approvalsRequest !== token) {
    if (state.approvalsRequest === token) state.approvalsLoading = false;
    return;
  }
  state.approvalsLoading = false;
  if (data?.ok === false) state.approvalsError = apiError(data, 'Could not load decisions.');
  else { state.approvalsError = null; state.approvals = data.approvals ?? state.approvals ?? []; }
  renderApprovals(state, root);
}
export function mountApprovals(state, root) {
  const off = bind(state, root, renderApprovals);
  void loadApprovals(state, root);
  return () => { requestToken(state); off?.(); };
}
export const render = renderApprovals;
export const mount = mountApprovals;
