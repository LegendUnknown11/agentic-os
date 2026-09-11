import { state as storeState, subscribe, post as storePost, sameId } from './store.js';
import { mdToHtml } from './markdown.js';
import { pick as pickFiles, upload as uploadAsset } from './assets.js';
import { displayName } from './names.js';
import { date } from './views/util.js';
import { renderRunThreadContext } from './run.js';

const AUTO = '__auto__';
const LOCAL_COMMANDS = [
  { name: 'autocompact', description: 'set the context window' },
  { name: 'argue', description: 'have models compare a question' },
];

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className || tag === 'button') el.className = tag === 'button' ? `button ${className ?? ''}`.trim() : className;
  if (text !== undefined) el.textContent = text;
  return el;
};

const arrayOf = (value) => value instanceof Map ? [...value.values()]
  : Array.isArray(value) ? value
    : value && typeof value === 'object' ? Object.values(value) : [];

function membersOf(state) {
  if (!(state?.members instanceof Map) && !Array.isArray(state?.members)) {
    return arrayOf(state?.members).filter(Boolean);
  }
  return state.members instanceof Map
    ? [...state.members.entries()].map(([name, member]) => ({ name, ...member }))
    : state.members;
}

function viewMember(state, options) {
  return options.member ?? state?.view?.member ?? state?.view?.memberName
    ?? state?.view?.name ?? state?.view?.agent ?? null;
}

function memberRecord(state, name) {
  if (!name) return null;
  const value = state?.members instanceof Map ? state.members.get(name) : arrayOf(state?.members).find((m) => m?.name === name);
  return value ? { name, ...value } : { name, role: name === 'orchestrator' ? 'orchestrator' : 'peasant' };
}

function conversationRecord(state, conversationId) {
  return arrayOf(state?.conversations).find((conversation) =>
    sameId(conversation?.id, conversationId) || sameId(conversation?.conversationId, conversationId));
}

function repoName(path) {
  return path ? String(path).split(/[\\/]/).filter(Boolean).pop() : '';
}

function workContext(state, conversationId) {
  const facts = [];
  const conversation = conversationRecord(state, conversationId);
  const repo = repoName(state?.repo ?? state?.repository);
  const goal = String(state?.goal?.text ?? '').replace(/\s+/g, ' ').trim();
  const members = membersOf(state);
  const awake = members.filter((member) => member.awake || member.state === 'awake' || member.state === 'busy').length;
  const tasks = Array.isArray(state?.tasks) ? state.tasks.filter((task) => task?.state !== 'done') : [];
  const changes = Array.isArray(state?.changes) ? state.changes : state?.changes?.changed ?? [];

  if (conversation?.title) facts.push(conversation.title);
  else if (conversationId) facts.push(conversationId);
  if (repo) facts.push(repo);
  if (goal) facts.push(`Goal: ${goal.slice(0, 96)}${goal.length > 96 ? '…' : ''}`);
  if (members.length) facts.push(`${awake}/${members.length} awake`);
  if (tasks.length) facts.push(`${tasks.length} open task${tasks.length === 1 ? '' : 's'}`);
  if (changes.length) facts.push(`${changes.length} change${changes.length === 1 ? '' : 's'} to review`);
  return facts.join(' · ') || 'No team or work context yet';
}

function draftKey(name, conversationId) { return `${name}::${conversationId}`; }

function isSovereignThread(state, options, name) {
  const view = state?.view ?? {};
  return options.sovereign === true || view.kind === 'chat' || view.type === 'chat'
    || view.member === 'sovereign' || view.member === 'orchestrator' || !name;
}

function activeConversation(state, options) {
  const c = state?.conversations;
  return options.conversationId ?? state?.view?.conversation ?? state?.view?.conversationId
    ?? c?.active ?? c?.activeId ?? 'default';
}

function rawEntries(state, name, conversationId) {
  const sources = [];
  const log = state?.log;
  if (log instanceof Map) sources.push(log.get(name));
  else if (log && typeof log === 'object') sources.push(log[name]);
  const transcript = state?.transcripts;
  if (transcript instanceof Map) sources.push(transcript.get(name));
  else if (transcript && typeof transcript === 'object') sources.push(transcript[name]);
  if (name && Array.isArray(state?.events)) sources.push(state.events.filter((e) => e.agent === name));
  if (name && Array.isArray(state?.messages)) sources.push(state.messages.filter((m) => m.recipient === name || m.sender === name));
  const rows = sources.flatMap((source) => Array.isArray(source) ? source : []);
  return rows.filter((row) => {
    const id = row.conversationId ?? row.conversation_id ?? row.payload?.conversationId ?? row.payload?.conversation_id;
    return !id || sameId(id, conversationId);
  });
}

function normaliseEntry(row, name) {
  const payload = row?.payload ?? {};
  const kind = row?.kind ?? row?.type ?? row?.event ?? '';
  const text = row?.text ?? payload.text ?? row?.body ?? payload.message ?? '';
  const sender = row?.sender ?? row?.from;
  const mine = row?.mine ?? (sender === 'sovereign' || sender === 'user');
  return {
    id: row?.id,
    kind,
    text: String(text ?? ''),
    sender,
    mine: Boolean(mine),
    failed: kind === 'error' || row?.failed,
    attachments: row?.attachments ?? payload.attachments ?? [],
    ts: row?.ts ?? row?.time ?? 0,
    name,
  };
}

function entriesFor(state, name, conversationId) {
  const rows = rawEntries(state, name, conversationId).map((row) => normaliseEntry(row, name));
  rows.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const seen = new Set();
  return rows.filter((row) => {
    // Event and message tables have independent primary keys; a bare id can
    // make an event with id 1 erase a message with id 1 from the transcript.
    const key = row.id != null ? `${row.kind}:${row.id}` : `${row.ts}|${row.kind}|${row.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function approvalsOf(state) {
  const value = state?.approvals;
  return value instanceof Map ? [...value.entries()].map(([id, item]) => ({ id, ...item }))
    : Array.isArray(value) ? value
      : value && typeof value === 'object' ? Object.entries(value).map(([id, item]) => ({ id, ...item })) : [];
}

function pendingApproval(approval, name, sovereign) {
  if (approval.resolved) return false;
  if (sovereign) return true;
  return [approval.name, approval.peasant, approval.agent, approval.from].filter(Boolean).includes(name);
}

function titleForApproval(approval) {
  return { summon: 'Add agents', role: 'New role', merge: 'Merge changes', push: 'Push request', question: 'Question' }[approval.kind]
    ?? String(approval.kind ?? 'Approval');
}

function detailForApproval(approval) {
  if (approval.kind === 'summon') return approval.reason ?? approval.names?.join(', ') ?? '';
  if (approval.kind === 'role') return [approval.reason, approval.prompt].filter(Boolean).join('\n\n');
  if (approval.kind === 'push') return approval.reason ?? approval.verdict ?? 'The team is ready to push.';
  return approval.verdict ?? approval.reason ?? approval.message ?? '';
}

function modelOptions(models) {
  if (!models) return [];
  if (Array.isArray(models)) return models.map((model) => typeof model === 'string' ? { cli: '', model } : model);
  return Object.entries(models).flatMap(([cli, list]) => Array.isArray(list) ? list.map((model) => ({ cli, model })) : []);
}

function fillModel(select, state, member) {
  select.textContent = '';
  const auto = node('option', '', 'Auto · advisor picks');
  auto.value = AUTO;
  select.append(auto);
  const models = modelOptions(state.models);
  const current = member.auto ? AUTO : `${member.cli ?? 'claude'}:${member.model ?? ''}`;
  for (const { cli, model } of models) {
    const option = node('option', '', `${cli ? `${cli} · ` : ''}${model || '(default)'}`);
    option.value = cli ? `${cli}:${model ?? ''}` : String(model ?? '');
    select.append(option);
  }
  if (current !== AUTO && ![...select.options].some((o) => o.value === current)) {
    const option = node('option', '', `${member.cli ?? 'claude'} · ${member.model ?? '(default)'}`);
    option.value = current;
    select.insertBefore(option, select.options[1] ?? null);
  }
  select.value = current;
}

function effortValues(state, member) {
  const byModel = state?.efforts?.byModel;
  const values = byModel?.[member.model] ?? state?.efforts?.[member.cli] ?? state?.efforts?.[member.cli ?? 'claude'] ?? [];
  return [...new Set(['', ...(Array.isArray(values) ? values : []), ...(member.effort ? [member.effort] : [])])];
}

function fillEffort(select, state, member) {
  select.textContent = '';
  const auto = node('option', '', 'Effort · auto');
  auto.value = AUTO;
  select.append(auto);
  for (const effort of effortValues(state, member)) {
    const option = node('option', '', effort || 'Effort · default');
    option.value = effort;
    if (effort) option.textContent = `Effort · ${effort}`;
    select.append(option);
  }
  select.value = member.auto ? AUTO : (member.effort ?? '');
  select.disabled = member.takesEffort === false && !member.auto;
}

function attachmentList(attachments) {
  if (typeof attachments === 'string') {
    try { attachments = JSON.parse(attachments); } catch { return []; }
  }
  return Array.isArray(attachments) ? attachments : attachments ? [attachments] : [];
}

function appendAttachments(parent, attachments) {
  for (const item of attachmentList(attachments)) {
    const name = typeof item === 'string' ? item : item.name;
    if (!name) continue;
    const link = node('a', 'message-attachment', name);
    link.href = `/assets/${encodeURIComponent(name)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
  }
}

function renderApprovalCard(card, approval, questionPicks, questionOthers) {
  card.className = `approval-card pending${approval.kind === 'question' ? ' question-card' : ''}`;
  card.dataset.approvalId = String(approval.id);
  card.append(node('div', 'approval-title', `${titleForApproval(approval)} #${approval.id}`));
  if (approval.from) card.append(node('div', 'approval-from', `From ${displayName(approval.from)}`));
  if (approval.kind !== 'question') {
    const detail = node('div', 'approval-detail');
    detail.textContent = detailForApproval(approval);
    card.append(detail);
    const actions = node('div', 'approval-actions');
    const approve = node('button', 'primary', 'Approve');
    approve.type = 'button';
    approve.dataset.action = 'approve';
    const reject = node('button', '', 'Reject');
    reject.type = 'button';
    reject.dataset.action = 'reject';
    actions.append(approve, reject);
    card.append(actions);
    return;
  }
  const questions = approval.questions ?? [];
  const picks = questionPicks.get(String(approval.id)) ?? new Map();
  questionPicks.set(String(approval.id), picks);
  questions.forEach((question, index) => {
    const block = node('fieldset', 'question-block');
    const legend = node('legend', '', question.header ?? question.question ?? 'Question');
    block.append(legend);
    if (question.question && question.header) block.append(node('div', 'question-text', question.question));
    const selected = picks.get(index) ?? new Set();
    picks.set(index, selected);
    for (const option of question.options ?? []) {
      const button = node('button', `question-option${selected.has(option.label) ? ' selected' : ''}`);
      button.type = 'button';
      button.dataset.action = 'question-option';
      button.dataset.question = String(index);
      button.dataset.option = option.label;
      button.setAttribute('aria-pressed', String(selected.has(option.label)));
      button.append(node('strong', '', option.label));
      if (option.description) button.append(node('small', '', option.description));
      block.append(button);
    }
    const other = node('input', 'question-other');
    other.placeholder = 'Other…';
    other.setAttribute('aria-label', `Other answer for ${question.header ?? question.question ?? `Question ${index + 1}`}`);
    other.dataset.questionOther = String(index);
    other.dataset.questionKey = `${approval.id}:${index}`;
    other.value = questionOthers.get(other.dataset.questionKey) ?? '';
    block.append(other);
    card.append(block);
  });
  const submit = node('button', 'primary', 'Submit answer');
  submit.type = 'button';
  submit.dataset.action = 'answer-question';
  card.append(submit);
}

/** Mount one flat transcript for either the user-facing chat or a team member. */
/**
 * The three DOM regions render() used to build inline.
 *
 * They are top level and take everything they read as arguments, so each can be
 * reasoned about — and called — without the 13 mutable locals mountThread holds.
 * render() keeps what genuinely belongs to the closure: draft capture, scroll
 * restoration, and the key bookkeeping around them.
 */
function threadHeader(state, { name, member, sovereign, ready, label, conversationId }) {
  const header = node('header', 'thread-header');
  const heading = node('div', `thread-heading${sovereign ? ' sovereign' : ''}`);
  heading.append(node('h1', '', `Chat with ${label}`));
  const subtitle = [!sovereign && (member.title || member.description), workContext(state, conversationId)]
    .filter(Boolean).join(' · ');
  heading.append(node('p', 'thread-subtitle', subtitle));
  const runContext = renderRunThreadContext(state);
  if (runContext) heading.append(runContext);
  const controls = node('div', 'thread-controls');
  const model = node('select', 'thread-model');
  model.dataset.control = 'model';
  model.dataset.tip = 'Model';
  model.setAttribute('aria-label', 'Model');
  fillModel(model, state, member);
  model.disabled = !ready;
  const modelControl = node('label', 'thread-control');
  modelControl.append(node('span', 'thread-control-label', 'Model'), model);
  controls.append(modelControl);
  const effort = node('select', 'thread-effort');
  effort.dataset.control = 'effort';
  effort.dataset.tip = 'Reasoning effort';
  effort.setAttribute('aria-label', 'Reasoning effort');
  fillEffort(effort, state, member);
  effort.disabled = !ready || effort.disabled;
  const effortControl = node('label', 'thread-control');
  effortControl.append(node('span', 'thread-control-label', 'Effort'), effort);
  controls.append(effortControl);
  if (!sovereign) {
    const power = node('button', 'thread-power', member.awake ? 'Sleep' : 'Wake');
    power.type = 'button';
    power.dataset.action = member.awake ? 'sleep' : 'wake';
    power.dataset.name = name;
    power.dataset.tip = member.awake ? 'Stop this agent while keeping its session' : 'Wake this agent';
    power.disabled = !ready;
    controls.append(power);
  }
  header.append(heading, controls);
  return header;
}

// Prunes questionOthers and submittedApprovals as a side effect: an approval
// that has left the state must not keep its typed "other" text or its disabled
// flag alive for whatever approval reuses the id next.
function threadMessages(state, { name, sovereign, conversationId, questionPicks, questionOthers, submittedApprovals }) {
  const messages = node('section', 'thread-messages');
  const entries = entriesFor(state, name, conversationId);
  for (const entry of entries) {
    const row = node('article', `thread-message ${entry.mine ? 'mine' : 'theirs'}${entry.failed ? ' failed' : ''}`);
    row.append(node('div', 'message-meta', `${entry.mine ? 'You' : displayName(entry.sender ?? name)}${entry.ts ? ` · ${date(entry.ts)}` : ''}`));
    const body = node('div', 'message-body markdown');
    const markdown = !entry.mine && (entry.kind === 'text' || entry.kind === 'summary' || !entry.kind);
    if (markdown) body.innerHTML = mdToHtml(entry.text);
    else body.textContent = entry.text;
    if (!body.textContent && !body.innerHTML) body.textContent = '…';
    row.append(body);
    appendAttachments(row, entry.attachments);
    messages.append(row);
  }
  const approvals = approvalsOf(state).filter((approval) => pendingApproval(approval, name, sovereign));
  const liveApprovalIds = new Set(approvals.map((approval) => String(approval.id)));
  for (const id of submittedApprovals.keys()) if (!liveApprovalIds.has(id)) submittedApprovals.delete(id);
  for (const key of questionOthers.keys()) if (!liveApprovalIds.has(key.split(':', 1)[0])) questionOthers.delete(key);
  for (const approval of approvals) {
    const card = node('article');
    renderApprovalCard(card, approval, questionPicks, questionOthers);
    const submitted = submittedApprovals.get(String(approval.id));
    if (submitted) {
      card.dataset.submitted = '1';
      card.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
      card.append(node('div', 'approval-detail', submitted));
    }
    messages.append(card);
  }
  if (!entries.length && !approvals.length) messages.append(node('div', 'thread-empty', state.ready === false
    ? 'Loading conversation…' : sovereign ? 'Start a conversation.' : 'No transcript yet.'));
  return messages;
}

function threadComposer({ name, label, conversationId, pendingFiles, sending, uploading, ready }) {
  const composer = node('form', 'thread-composer');
  composer.dataset.conversation = conversationId;
  composer.dataset.recipient = name;
  composer.setAttribute('aria-label', `Message ${label}`);
  composer.setAttribute('aria-busy', String(sending || uploading));
  const attachmentRow = node('div', 'thread-attachments');
  attachmentRow.hidden = !pendingFiles.length;
  for (const file of pendingFiles) {
    const chip = node('span', 'attachment-chip');
    chip.append(node('span', 'attachment-name', file.name));
    const remove = node('button', '', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.dataset.action = 'remove-attachment';
    remove.dataset.attachment = file.name;
    chip.append(remove);
    attachmentRow.append(chip);
  }
  const inputRow = node('div', 'thread-input-row');
  const attach = node('button', 'thread-attach', 'Attach');
  attach.type = 'button';
  attach.dataset.action = 'attach';
  attach.disabled = sending || uploading || !ready;
  attach.textContent = uploading ? 'Uploading…' : 'Attach';
  attach.dataset.tip = `Attach a file for ${label}`;
  const field = node('textarea', 'thread-input');
  field.name = 'text';
  field.rows = 1;
  field.placeholder = `Message ${label}…`;
  field.setAttribute('aria-label', `Message ${label}`);
  field.disabled = sending || !ready;
  field.autocomplete = 'off';
  const sendButton = node('button', 'thread-send', 'Send');
  sendButton.type = 'submit';
  sendButton.disabled = sending || uploading || !ready;
  sendButton.dataset.tip = `Send to ${label}`;
  if (sending) sendButton.textContent = 'Sending…';
  else if (uploading) sendButton.textContent = 'Uploading…';
  inputRow.append(attach, field, sendButton);
  const skills = node('div', 'skill-menu');
  skills.hidden = true;
  composer.append(attachmentRow, inputRow, skills);
  return composer;
}

export function mountThread(root, options = {}) {
  const post = options.post ?? storePost;
  let currentState = options.state ?? storeState;
  let unsubscribe = () => {};
  let mounted = true;
  let pendingFiles = [];
  let sending = false;
  let uploading = false;
  const drafts = new Map();
  let renderedDraftKey = null;
  const questionPicks = new Map();
  const questionOthers = new Map();
  const submittedApprovals = new Map();
  let skillIndex = 0;
  const composerHost = options.composer ?? root;
  const listenerHosts = composerHost === root ? [root] : [root, composerHost];

  root.className = 'thread';
  root.textContent = '';

  function currentName() { return viewMember(currentState, options) ?? 'orchestrator'; }
  function currentThreadKey() { return draftKey(currentName(), activeConversation(currentState, options)); }
  function isCurrentThread(key) { return mounted && currentThreadKey() === key; }
  function rememberDraft() {
    const field = composerHost.querySelector('.thread-input');
    if (!field || !renderedDraftKey) return;
    drafts.set(renderedDraftKey, {
      text: field.value,
      start: Number.isInteger(field.selectionStart) ? field.selectionStart : field.value.length,
      end: Number.isInteger(field.selectionEnd) ? field.selectionEnd : field.value.length,
      focused: globalThis.document?.activeElement === field,
      files: pendingFiles.map((file) => ({ ...file })),
    });
  }
  function restoreDraft(field, key) {
    const draft = drafts.get(key);
    if (!draft) return;
    field.value = draft.text;
    if (draft.focused) field.focus?.();
    if (typeof field.setSelectionRange === 'function') {
      const start = Math.min(draft.start, field.value.length);
      const end = Math.min(draft.end, field.value.length);
      field.setSelectionRange(start, end);
    }
  }
  function render(next = currentState, captureDraft = true) {
    currentState = next ?? currentState;
    const previousMessages = root.querySelector?.('.thread-messages');
    const previousScrollTop = previousMessages?.scrollTop ?? 0;
    const stickToBottom = !previousMessages
      || (previousMessages.scrollHeight - previousMessages.scrollTop - previousMessages.clientHeight < 48);
    const name = currentName();
    const member = memberRecord(currentState, name);
    const sovereign = isSovereignThread(currentState, options, name);
    const ready = currentState.ready !== false;
    const conversationId = activeConversation(currentState, options);
    const label = displayName(name, member.role);
    const key = draftKey(name, conversationId);
    if (captureDraft) rememberDraft();
    for (const other of root.querySelectorAll?.('[data-question-other]') ?? []) {
      questionOthers.set(other.dataset.questionKey, other.value);
    }
    pendingFiles = (drafts.get(key)?.files ?? []).map((file) => ({ ...file }));
    root.textContent = '';
    composerHost.textContent = '';
    root.dataset.member = name;
    root.dataset.conversation = conversationId;
    root.setAttribute('aria-busy', String(sending || uploading));

    const header = threadHeader(currentState, { name, member, sovereign, ready, label, conversationId });
    const messages = threadMessages(currentState, {
      name, sovereign, conversationId, questionPicks, questionOthers, submittedApprovals,
    });
    const composer = threadComposer({
      name, label, conversationId, pendingFiles, sending, uploading, ready,
    });
    root.append(header, messages);
    composerHost.append(composer);
    restoreDraft(composer.querySelector('.thread-input'), key);
    renderedDraftKey = key;
    messages.scrollTop = stickToBottom ? messages.scrollHeight : previousScrollTop;
  }

  function input() { return composerHost.querySelector('.thread-input'); }
  function skillMenu() { return composerHost.querySelector('.skill-menu'); }
  function skillItems(query) {
    const skills = Array.isArray(currentState.skills) ? currentState.skills : [];
    return [...LOCAL_COMMANDS, ...skills].filter((skill) => !query || skill.name.toLowerCase().includes(query)
      || String(skill.description ?? '').toLowerCase().includes(query));
  }
  function paintSkills() {
    const field = input();
    const menu = skillMenu();
    if (!field || !menu || !field.value.startsWith('/') || /^\/\S+\s/.test(field.value)) {
      if (menu) menu.hidden = true;
      return;
    }
    const query = field.value.slice(1).toLowerCase().split(/\s/, 1)[0];
    const items = skillItems(query);
    if (!items.length) { menu.hidden = true; return; }
    skillIndex = Math.min(skillIndex, items.length - 1);
    menu.textContent = '';
    items.forEach((skill, index) => {
      const item = node('button', `skill-option${index === skillIndex ? ' selected' : ''}`);
      item.type = 'button';
      item.dataset.action = 'skill';
      item.dataset.skill = skill.name;
      item.append(node('strong', '', `/${skill.name}`), node('small', '', skill.description ?? ''));
      menu.append(item);
    });
    menu.hidden = false;
  }

  async function withUploadState(work) {
    if (uploading || sending || currentState.ready === false) return;
    const key = currentThreadKey();
    uploading = true;
    render();
    try {
      await work(key);
    } finally {
      uploading = false;
      if (mounted) render();
    }
  }

  async function uploadFiles(files, key) {
    for (const file of files) {
      const result = await uploadAsset(file);
      if (!isCurrentThread(key)) return;
      if (result?.ok) pendingFiles.push({ name: result.name, kind: result.kind });
      else options.toast?.(result?.error ?? `Could not attach ${file.name}.`, true);
    }
  }

  async function attach() {
    await withUploadState(async (key) => {
      const files = await pickFiles('image/*,.pdf,.txt,.md,.csv,.json', true);
      await uploadFiles(files, key);
    });
  }

  async function sendMessage(form) {
    if (sending || uploading || currentState.ready === false) return;
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (!text && !pendingFiles.length) return;
    const name = currentName();
    const conversationId = form.dataset.conversation || activeConversation(currentState, options);
    const key = draftKey(name, conversationId);
    const files = pendingFiles;
    const bodyText = pendingFiles.length
      ? `${text}${text ? '\n\n' : ''}[Attached: ${pendingFiles.map((file) => file.name).join(', ')}]`
      : text;
    const body = isSovereignThread(currentState, options, name)
      ? { text: bodyText, conversationId, attachments: files }
      : { name, text: bodyText, conversationId, attachments: files };
    sending = true;
    render();
    let result;
    try {
      result = await post(isSovereignThread(currentState, options, name) ? 'command' : 'speak', body);
    } catch (error) {
      result = { ok: false, error: error?.message ?? 'That message could not be sent.' };
    }
    sending = false;
    if (!mounted) return;
    if (!isCurrentThread(key)) {
      render(currentState);
      return;
    }
    if (!result?.ok) {
      pendingFiles = files;
      options.toast?.(result?.error ?? 'That message could not be sent.', true);
    } else {
      pendingFiles = [];
      drafts.delete(draftKey(name, conversationId));
    }
    render(currentState, result?.ok ? false : true);
    if (!result?.ok) {
      const field = input();
      if (field) { field.value = text; field.focus(); }
    }
  }

  async function updateModel(select) {
    const name = currentName();
    const member = memberRecord(currentState, name);
    const wasDisabled = select.disabled;
    select.disabled = true;
    let result;
    try {
      if (select.value === AUTO) result = await post('model', { name, auto: true });
      else {
        const [cli, ...rest] = select.value.split(':');
        result = await post('model', { name, cli, model: rest.join(':') });
      }
    } catch { result = { ok: false, error: 'The model could not be changed.' }; }
    select.disabled = wasDisabled;
    if (!result?.ok) {
      options.toast?.(result?.error ?? 'The model could not be changed.', true);
      if (select.isConnected !== false) fillModel(select, currentState, member);
    }
    return result;
  }

  async function updateEffort(select) {
    const name = currentName();
    const member = memberRecord(currentState, name);
    const wasDisabled = select.disabled;
    select.disabled = true;
    let result;
    try {
      result = select.value === AUTO
        ? await post('model', { name, auto: true })
        : await post('model', { name, cli: member.cli, model: member.model, effort: select.value });
    } catch { result = { ok: false, error: 'The reasoning effort could not be changed.' }; }
    select.disabled = wasDisabled;
    if (!result?.ok) {
      options.toast?.(result?.error ?? 'The reasoning effort could not be changed.', true);
      if (select.isConnected !== false) fillEffort(select, currentState, member);
    }
    return result;
  }

  async function approvalAction(action, id, target) {
    const card = target?.closest?.('[data-approval-id]');
    card?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    let result;
    try {
      result = await post(action, { id: Number(id) });
    } catch (error) {
      result = { ok: false, error: error?.message ?? 'That decision could not be recorded.' };
    }
    if (!result?.ok) {
      options.toast?.(result?.error ?? 'That decision could not be recorded.', true);
      card?.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    } else if (card) {
      submittedApprovals.set(String(id), action === 'approve' ? 'Approved.' : 'Rejected.');
      card.dataset.submitted = '1';
      card.append(node('div', 'approval-detail', submittedApprovals.get(String(id))));
    }
  }

  async function answerQuestion(card, submit) {
    const id = String(card.dataset.approvalId);
    const picks = questionPicks.get(id) ?? new Map();
    const answers = [...card.querySelectorAll('[data-question-other]')].map((other, index) => {
      const chosen = [...(picks.get(index) ?? new Set())];
      const custom = other.value.trim();
      return custom ? [...chosen, custom] : chosen;
    });
    if (answers.some((answer) => !answer.length)) {
      options.toast?.('Answer every question before submitting.', true);
      return;
    }
    // The daemon needs the choices; unlike approve/reject, this action carries
    // one answer array per question.
    submit.disabled = true;
    let result;
    try {
      result = await post('answerQuestion', { id: Number(id), answers });
    } catch (error) {
      result = { ok: false, error: error?.message ?? 'That answer could not be recorded.' };
    }
    if (!result?.ok) {
      submit.disabled = false;
      options.toast?.(result?.error ?? 'That answer could not be recorded.', true);
    } else {
      submittedApprovals.set(id, 'Answer submitted.');
      card.dataset.submitted = '1';
      card.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
      card.append(node('div', 'approval-detail', 'Answer submitted.'));
    }
  }

  function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || (!root.contains(target) && !composerHost.contains(target))) return;
    const action = target.dataset.action;
    if (action === 'attach') return attach();
    if (action === 'remove-attachment') {
      pendingFiles = pendingFiles.filter((file) => file.name !== target.dataset.attachment);
      return render();
    }
    if (action === 'skill') {
      const field = input();
      if (field) { field.value = `/${target.dataset.skill} `; field.focus(); }
      skillMenu().hidden = true;
      return;
    }
    const card = target.closest('[data-approval-id]');
    if (action === 'approve' || action === 'reject') return approvalAction(action, card?.dataset.approvalId, target);
    if (action === 'answer-question') return answerQuestion(card, target);
    if (action === 'question-option') {
      const id = String(card.dataset.approvalId);
      const index = Number(target.dataset.question);
      const approval = approvalsOf(currentState).find((item) => String(item.id) === id);
      const question = approval?.questions?.[index];
      const picks = questionPicks.get(id) ?? new Map();
      const selected = picks.get(index) ?? new Set();
      if (selected.has(target.dataset.option)) selected.delete(target.dataset.option);
      else {
        if (!question?.multiSelect) {
          selected.clear();
          card.querySelectorAll(`[data-question="${index}"]`).forEach((button) => {
            button.classList.remove('selected');
            button.setAttribute('aria-pressed', 'false');
          });
        }
        selected.add(target.dataset.option);
      }
      picks.set(index, selected);
      questionPicks.set(id, picks);
      target.classList.toggle('selected', selected.has(target.dataset.option));
      target.setAttribute('aria-pressed', String(selected.has(target.dataset.option)));
      return;
    }
    if (action === 'wake' || action === 'sleep') {
      target.disabled = true;
      return Promise.resolve().then(() => post(action, { name: target.dataset.name })).then((result) => {
        if (!result?.ok) {
          target.disabled = false;
          options.toast?.(result?.error ?? `Could not ${action} this agent.`, true);
        } else target.textContent = action === 'sleep' ? 'Rest requested' : 'Wake requested';
        return result;
      }).catch((error) => {
        target.disabled = false;
        options.toast?.(error?.message ?? `Could not ${action} this agent.`, true);
        return { ok: false, error: error?.message };
      });
    }
  }

  function onSubmit(event) {
    if (!event.target.matches('.thread-composer')) return;
    event.preventDefault();
    sendMessage(event.target);
  }

  function onInput(event) {
    if (event.target.matches('.thread-input')) { skillIndex = 0; paintSkills(); }
  }

  function onChange(event) {
    if (event.target.dataset.control === 'model') updateModel(event.target);
    if (event.target.dataset.control === 'effort') updateEffort(event.target);
  }

  function onKeyDown(event) {
    if (!event.target.matches('.thread-input')) return;
    const menu = skillMenu();
    if (menu?.hidden) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.target.form?.requestSubmit();
      }
      return;
    }
    const count = menu.children.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      skillIndex = (skillIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      paintSkills();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      menu.children[skillIndex]?.click();
    } else if (event.key === 'Escape') menu.hidden = true;
  }

  function onDragOver(event) {
    if (event.target.closest('.thread-messages, .thread-composer')) { event.preventDefault(); root.classList.add('drag-over'); }
  }
  function onDragLeave(event) {
    const zone = event.target.closest?.('.thread-messages, .thread-composer');
    const nextZone = event.relatedTarget?.closest?.('.thread-messages, .thread-composer');
    if (zone && !nextZone) root.classList.remove('drag-over');
  }
  async function onDrop(event) {
    if (!event.target.closest('.thread-messages, .thread-composer')) return;
    event.preventDefault();
    root.classList.remove('drag-over');
    await withUploadState((key) => uploadFiles([...(event.dataTransfer?.files ?? [])], key));
  }

  for (const host of listenerHosts) {
    host.addEventListener('click', onClick);
    host.addEventListener('submit', onSubmit);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    host.addEventListener('keydown', onKeyDown);
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);
  }
  if (typeof subscribe === 'function') unsubscribe = subscribe((next) => render(next));
  render(currentState);

  return () => {
    mounted = false;
    unsubscribe?.();
    for (const host of listenerHosts) {
      host.removeEventListener('click', onClick);
      host.removeEventListener('submit', onSubmit);
      host.removeEventListener('input', onInput);
      host.removeEventListener('change', onChange);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
    }
    root.textContent = '';
    composerHost.textContent = '';
  };
}

export const renderThread = (root, state = storeState, options = {}) => mountThread(root, { ...options, state });
export { entriesFor };
