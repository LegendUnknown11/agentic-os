// A dedicated ChatGPT/T3-Chat-style thread for Chat mode, now with real
// multiple conversations: each is its own backend session (kingdom.js kills
// and respawns the orchestrator's process on switch — no CLI backend can
// hold two threads open at once), so switching here is a real, sometimes
// interrupting, action — never a purely cosmetic tab flip.
//
// This does NOT read from app.js's shared `log` Map / `append()` pipeline —
// that bakes a "✉ sender: " prefix and a 200-char truncation into the
// sovereign's own lines at append time (app.js's renderMessage), which is
// wrong for a clean bubble. Instead this taps the raw SSE payload directly,
// the same way notify.js already does, and keeps its own small per-
// conversation buffer so history survives switching away and back.

import { mdToHtml } from './markdown.js';
import { attachMic } from './voice.js';
import { setIcon } from './icons.js';
import { initSidebar, paint as paintSidebar, setActive as setSidebarActive, upsert as sidebarUpsert, drop as sidebarDrop } from './chat-sidebar.js';
import { pick as pickFiles, upload as uploadAsset } from './assets.js';

const CAP = 300;

let root, thread, composer, input, attachRow, modelSel, effortSel, statusEl;
let post, toast, fillModels, fillEfforts, AUTO;
let orchestratorName = 'orchestrator';
let orchestratorRow = null;
let activeConv = 'default';
let cache = new Map();          // conversationId -> [{mine, text, failed}]
let pendingEchoes = new Map();  // conversationId -> count of sends awaiting their own `delivered` echo
let pendingFiles = [];          // [{name, kind}] uploaded, waiting to ride the next message

export function initChat(node, opts) {
  root = node;
  ({ post, toast, fillModels, fillEfforts, AUTO } = opts);

  const sidebarNode = document.createElement('div');
  initSidebar(sidebarNode, {
    onSelect: switchTo,
    onNew: startNew,
    onRename: renameConv,
    onArchive: archiveConv,
    onSearch: opts.openRecall,
  });

  const main = document.createElement('div');
  main.className = 'chat-main';

  thread = document.createElement('div');
  thread.className = 'chat-thread';

  composer = document.createElement('form');
  composer.className = 'chat-composer';
  composer.innerHTML = `<div class="chat-attach-row" hidden></div>
    <div class="row1">
      <button type="button" class="attach"></button>
      <input placeholder="Message the court…" autocomplete="off">
      <button type="button" class="mic"></button>
      <button type="submit" class="send"></button>
    </div>
    <div class="chips"></div>`;
  input = composer.querySelector('input');
  attachRow = composer.querySelector('.chat-attach-row');
  setIcon(composer.querySelector('.attach'), 'attach', 'Attach a file');
  setIcon(composer.querySelector('.mic'), 'mic', 'Dictate');
  setIcon(composer.querySelector('.send'), 'send', 'Send');
  attachMic(composer.querySelector('.mic'), input);
  composer.querySelector('.attach').onclick = async () => {
    const files = await pickFiles('image/*,.pdf,.txt,.md,.csv,.json');
    for (const f of files) await attachFile(f);
  };
  thread.addEventListener('dragover', (e) => { e.preventDefault(); thread.classList.add('drag-over'); });
  thread.addEventListener('dragleave', () => thread.classList.remove('drag-over'));
  thread.addEventListener('drop', async (e) => {
    e.preventDefault();
    thread.classList.remove('drag-over');
    for (const f of [...(e.dataTransfer?.files ?? [])]) await attachFile(f);
  });

  modelSel = document.createElement('select');
  modelSel.className = 'model';
  modelSel.title = 'Which backend answers';
  effortSel = document.createElement('select');
  effortSel.className = 'model effort';
  effortSel.title = 'Reasoning effort';
  composer.querySelector('.chips').append(chip(modelSel), chip(effortSel));

  // No custom "cli:model" text entry here (locked scope: catalogued,
  // already-authenticated backends only) — revert and say so.
  modelSel.onchange = () => {
    if (modelSel.value === '__custom__') return revert(modelSel);
    if (modelSel.value === AUTO) return setAuto();
    const [cli, ...rest] = modelSel.value.split(':');
    changeProvider(cli, rest.join(':'), undefined);
  };
  effortSel.onchange = () => {
    if (effortSel.value === AUTO) return setAuto();
    if (!orchestratorRow) return;
    changeProvider(orchestratorRow.cli, orchestratorRow.model, effortSel.value);
  };

  composer.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !pendingFiles.length) return;
    input.value = '';
    const files = pendingFiles;
    pendingFiles = [];
    renderAttachRow();
    send(composeWithAttachments(text, files));
  };

  main.append(thread, composer);
  root.append(sidebarNode, main);
}

export function focusComposer() {
  input?.focus();
}

export async function onEvent(d) {
  if (d.type === 'snapshot') {
    seedFromRoster(d.roster);
    cache = new Map();
    statusEl = null;
    await refreshConversations();
    return;
  }
  if (d.type === 'roster') return seedFromRoster(d.roster);
  if (d.type === 'delivered') {
    const m = d.msg;
    if (m.sender !== 'sovereign' || m.recipient !== orchestratorName) return;
    const conv = m.conversation_id ?? 'default';
    // Already shown instantly by send() — this is just the bus round-trip
    // confirming it landed, not a second message. Still worth stealing the
    // real bus id off it, since edit/regenerate need a message's id to fork
    // at, and the optimistic echo never had one.
    const n = pendingEchoes.get(conv) ?? 0;
    if (n > 0) {
      pendingEchoes.set(conv, n - 1);
      const buf = cache.get(conv);
      const row = buf && [...buf].reverse().find((e) => e.mine && e.id == null);
      if (row) row.id = m.id;
      return;
    }
    // A branch's own conversationSwitched handler can load this exact message
    // via loadConversation() before this delivered echo for it arrives —
    // observed live: editing/regenerating produced a doubled bubble.
    if (cache.get(conv)?.some((e) => e.mine && e.id === m.id)) return;
    return appendTo(conv, { mine: true, text: m.body, id: m.id });   // e.g. sent from another tab
  }
  if (d.type === 'event' && d.name === orchestratorName) return routeEvent(d.conversationId ?? 'default', d.kind, d.payload);
  if (d.type === 'conversationSwitched' && d.name === orchestratorName) {
    if (d.interrupted) toast('The previous conversation was interrupted mid-reply.', true);
    if (d.conversationId !== activeConv) {
      // Another tab (or a branch/regenerate) moved the one live session —
      // there is only ever one, so this tab has to follow it.
      activeConv = d.conversationId;
      setSidebarActive(activeConv);
      await loadConversation(activeConv);
      if (activeConv === d.conversationId) renderThread(activeConv);
    }
    return;
  }
  if (d.type === 'conversationRenamed') return sidebarUpsert(d);
  if (d.type === 'conversationArchived') {
    sidebarDrop(d.id);
    cache.delete(d.id);
    if (d.id === activeConv) switchTo('default');
    return;
  }
}

async function refreshConversations() {
  const r = await fetch(`/api/conversations?member=${encodeURIComponent(orchestratorName)}`)
    .then((x) => x.json()).catch(() => null);
  if (!r?.ok) return;
  paintSidebar(r.conversations, r.active);
  activeConv = r.active;
  await loadConversation(activeConv);
  renderThread(activeConv);
}

/** Fetches one conversation's own history — the shared court-wide snapshot
 * (200 messages / 400 events) can easily have aged a quiet thread out. */
async function loadConversation(id) {
  if (cache.has(id)) return;
  const res = await fetch(`/stream?conversation=${encodeURIComponent(id)}`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  const snap = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
  const rows = [];
  for (const m of snap.messages ?? []) {
    if (m.sender === 'sovereign' && m.recipient === orchestratorName) rows.push({ ts: m.ts, mine: true, text: m.body, id: m.id });
  }
  for (const ev of snap.events ?? []) {
    if (ev.agent !== orchestratorName) continue;
    if (ev.type === 'text') rows.push({ ts: ev.ts, mine: false, text: ev.payload.text.trim() });
    else if (ev.type === 'error') rows.push({ ts: ev.ts, mine: false, text: `⚠ ${ev.payload.message}`, failed: true });
  }
  // messages and events are two separate tables, each ordered by its own id —
  // only `ts` puts a sovereign line and the reply that followed it in order.
  rows.sort((a, b) => a.ts - b.ts);
  cache.set(id, rows.map(({ mine, text, failed, id: mid }) => ({ mine, text, failed: failed ?? false, id: mid })));
}

async function switchTo(id) {
  if (id === activeConv) return;
  activeConv = id;
  setSidebarActive(id);
  await loadConversation(id);
  if (activeConv === id) renderThread(id);
  post('switchConversation', { name: orchestratorName, conversationId: id }).then((r) => {
    if (!r.ok) toast(`Could not switch conversations: ${r.error ?? 'unknown'}`, true);
  });
}

function startNew() {
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  cache.set(id, []);
  sidebarUpsert({ id, title: '', parent_id: null });
  switchTo(id);
}

function renameConv(id, title) {
  post('renameConversation', { id, title }).then((r) => { if (!r.ok) toast('Rename failed.', true); });
}

function archiveConv(id) {
  post('archiveConversation', { id }).then((r) => { if (!r.ok) toast('Archive failed.', true); });
}

function seedFromRoster(roster) {
  const row = roster?.find((r) => r.role === 'orchestrator');
  if (!row) return;
  orchestratorRow = row;
  orchestratorName = row.name;
  fillModels(modelSel, row.cli ?? 'claude', row.model, row.auto);
  fillEfforts(effortSel, row.cli ?? 'claude', row.effort, row.takesEffort, row.model, row.auto);
}

function routeEvent(conv, kind, payload) {
  if (kind === 'text') { appendTo(conv, { mine: false, text: payload.text.trim() }); if (conv === activeConv) clearStatus(); }
  else if (kind === 'tool') { if (conv === activeConv) setStatusLine(`· ${payload.name} ·`); }
  else if (kind === 'error') { appendTo(conv, { mine: false, text: `⚠ ${payload.message}`, failed: true }); if (conv === activeConv) clearStatus(); }
  else if (kind === 'turn_end') { if (conv === activeConv) clearStatus(); }
}

/** Upload immediately (so a slow upload doesn't hold up the composer), then
 * hold the result as a chip until the sovereign actually sends the message —
 * the same "attach now, ride the next turn" shape as ChatGPT/T3. */
async function attachFile(file) {
  const r = await uploadAsset(file);
  if (!r.ok) { toast(`Could not attach ${file.name}: ${r.error ?? 'unknown'}`, true); return; }
  pendingFiles.push({ name: r.name, kind: r.kind });
  renderAttachRow();
}

function renderAttachRow() {
  attachRow.textContent = '';
  attachRow.hidden = pendingFiles.length === 0;
  for (const f of pendingFiles) {
    const chip = document.createElement('span');
    chip.className = 'chat-attach-chip';
    chip.textContent = f.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '✕';
    rm.title = 'Remove attachment';
    rm.onclick = () => { pendingFiles = pendingFiles.filter((x) => x !== f); renderAttachRow(); };
    chip.append(rm);
    attachRow.append(chip);
  }
}

// The orchestrator finds any upload on its own via list_uploads, but naming
// it in the message is what makes an attachment feel attached to THIS turn
// rather than just another file sitting in the pile.
function composeWithAttachments(text, files) {
  if (!files.length) return text;
  const note = `[Attached: ${files.map((f) => f.name).join(', ')}]`;
  return text ? `${text}\n\n${note}` : note;
}

function send(text) {
  appendTo(activeConv, { mine: true, text });   // instant — see the counter note at the top
  pendingEchoes.set(activeConv, (pendingEchoes.get(activeConv) ?? 0) + 1);
  const conv = activeConv;
  setTimeout(() => { const n = pendingEchoes.get(conv); if (n) pendingEchoes.set(conv, n - 1); }, 15000);
  setStatusLine('· thinking ·');
  post('command', { text, conversationId: activeConv });
}

function setAuto() {
  post('model', { name: orchestratorName, auto: true }).then((r) => {
    if (!r.ok) return toast(`could not set auto: ${r.error ?? 'unknown'}`, true);
    toast('Model and effort handed to the advisor.');
  });
}

function changeProvider(cli, model, effort) {
  post('model', { name: orchestratorName, cli, model, effort }).then((r) => {
    if (!r.ok) return toast(`model change failed: ${r.error ?? 'unknown'}`, true);
    toast(`Switching to ${cli}${model ? ' / ' + model : ' (default)'}`
      + `${effort ? ' at ' + effort + ' effort' : ''}…`);
  });
}

function revert(sel) {
  sel.value = sel.dataset.current;
  toast('Custom model entry isn’t available from Chat — pick from the list.', true);
}

function chip(sel) {
  const c = document.createElement('label');
  c.className = 'chip';
  c.append(sel);
  return c;
}

function appendTo(conv, entry) {
  if (!cache.has(conv)) cache.set(conv, []);
  const buf = cache.get(conv);
  buf.push(entry);
  if (buf.length > CAP) buf.shift();
  if (conv === activeConv) renderBubble(entry.mine, entry.text, entry.failed, buf.length - 1);
}

function renderThread(id) {
  thread.textContent = '';
  statusEl = null;
  (cache.get(id) ?? []).forEach((e, idx) => renderBubble(e.mine, e.text, e.failed, idx));
}

// None of claude/codex/agy/opencode can rewind a session in place, so
// "edit" and "regenerate" both mean the same thing: fork a fresh sibling
// conversation seeded with everything up to (not including) the turn being
// changed, then post the new/repeated text into it. `kingdom.branchFrom`
// already does the replay + repost; this just finds the right fork point.
function findMine(conv, fromIdx) {
  const buf = cache.get(conv) ?? [];
  for (let i = fromIdx; i >= 0; i--) if (buf[i]?.mine && buf[i].id != null) return { idx: i, id: buf[i].id, text: buf[i].text };
  return null;
}

function branch(forkAtMessageId, text) {
  post('branchConversation', { name: orchestratorName, conversationId: activeConv, forkAtMessageId, text }).then((r) => {
    if (!r.ok) return toast(`Could not branch: ${r.error ?? 'unknown'}`, true);
    refreshConversations();
  });
}

function editMessage(idx, newText) {
  const before = findMine(activeConv, idx - 1);
  branch(before?.id ?? 0, newText);
}

function regenerateReply(idx) {
  const trigger = findMine(activeConv, idx);
  if (!trigger) return toast('Nothing to regenerate — no prior message found.', true);
  const before = findMine(activeConv, trigger.idx - 1);
  branch(before?.id ?? 0, trigger.text);
}

function renderBubble(mine, text, failed, idx) {
  const row = document.createElement('div');
  row.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;
  const b = document.createElement('div');
  b.className = mine ? 'bubble' : `bubble t-text${failed ? ' failed' : ''}`;
  if (mine) b.textContent = text; else b.innerHTML = mdToHtml(text);
  row.append(b);

  if (idx != null) {
    const acts = document.createElement('div');
    acts.className = 'chat-msg-acts';
    if (mine) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-msg-act';
      btn.textContent = '✎ Edit';
      btn.onclick = () => {
        const t = prompt('Edit message — this branches into a new conversation:', text);
        if (t && t.trim() && t.trim() !== text) editMessage(idx, t.trim());
      };
      acts.append(btn);
    } else if (!failed) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-msg-act';
      btn.textContent = '⟳ Regenerate';
      btn.onclick = () => regenerateReply(idx);
      acts.append(btn);
    }
    row.append(acts);
  }

  if (statusEl) thread.insertBefore(row, statusEl); else thread.append(row);
  scrollDown();
}

function setStatusLine(text) {
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'chat-status';
    thread.append(statusEl);
  }
  statusEl.textContent = text;
  scrollDown();
}

function clearStatus() {
  statusEl?.remove();
  statusEl = null;
}

function scrollDown() {
  if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120) {
    thread.scrollTop = thread.scrollHeight;
  }
}
