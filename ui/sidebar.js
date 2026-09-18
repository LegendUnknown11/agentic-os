import { state as storeState, subscribe, post as storePost, sameId } from './store.js';
import { spendText } from './views/util.js';
import { icon } from './icons.js';
import { statusLabel } from './status.js';

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

const NAV_ICONS = Object.freeze({
  home: 'target', objective: 'goal', approvals: 'approve', changes: 'diff', agents: 'who', activity: 'log',
  messages: 'bus', usage: 'metrics', memory: 'vault', notes: 'document', automations: 'workflows', doctor: 'doctor',
});

function navButton(view, label, page) {
  const button = node('button', `sidebar-nav-button${page === view ? ' selected' : ''}`, label);
  button.type = 'button';
  button.dataset.view = view;
  button.dataset.tip = label;
  if (page === view) button.setAttribute('aria-current', 'page');
  button.prepend(icon(NAV_ICONS[view] ?? 'more'));
  return button;
}

function conversationsOf(state) {
  const value = state?.conversations;
  if (Array.isArray(value)) return value;
  if (value?.items) return Array.isArray(value.items) ? value.items : [];
  if (value?.conversations) return Array.isArray(value.conversations) ? value.conversations : [];
  return value instanceof Map ? [...value.values()] : [];
}

function activeConversationOf(state) {
  const value = state?.conversations;
  return value?.active ?? value?.activeId ?? state?.view?.conversation ?? state?.view?.conversationId
    ?? state?.members?.get?.('orchestrator')?.conversationId ?? 'default';
}

/** Human-facing state label; resting and off are deliberately distinct. */
export function displayStatus(member = {}) {
  const state = member.state ?? (member.awake ? 'awake' : member.summoned ? 'resting' : 'off');
  const activity = member.status;
  const activityText = statusLabel(activity);
  if (state === 'dead' || state === 'failed' || ['failed', 'rate limited', 'blocked'].includes(activityText)) return 'failed';
  if (state === 'busy' || (activity && !['idle', 'resting', 'off'].includes(activityText))) return 'busy';
  if (state === 'awake' || member.awake) return 'awake';
  if (state === 'resting' || member.summoned || member.serving) return 'resting';
  return 'off';
}

function repoName(path) {
  if (!path) return 'No repository';
  return String(path).split(/[\\/]/).filter(Boolean).pop() || path;
}

function conversationTitle(c) {
  return c?.title || (c?.parent_id || c?.parentId ? 'Branch' : 'New chat');
}

function conversationId(c) { return c?.id ?? c?.conversationId; }

export function lastMessageIdFor(state, conversationId) {
  return (Array.isArray(state?.messages) ? state.messages : []).reduce((last, message) => {
    const id = message?.conversationId ?? message?.conversation_id;
    return sameId(id, conversationId) ? Math.max(last, Number(message.id) || 0) : last;
  }, 0);
}

function send(post, action, body) {
  return Promise.resolve().then(() => post(action, body)).catch(() => ({ ok: false, error: 'request failed' }));
}

/**
 * Mount the fixed left rail. The only listeners are on the rail itself, so a
 * route change can remove them with the returned teardown function.
 */
export function mountSidebar(root, options = {}) {
  const post = options.post ?? storePost;
  let currentState = options.state ?? storeState;
  let unsubscribe = () => {};
  let editing = null;
  let armedArchive = null;
  let moreOpen = false;

  root.className = 'sidebar';
  root.textContent = '';

  const header = node('div', 'sidebar-header');
  const brand = node('div', 'sidebar-brand', 'AgentOS');
  const add = node('button', 'sidebar-new', '+ New');
  add.type = 'button';
  add.dataset.action = 'new';
  add.dataset.tip = 'Start a new conversation';
  const mobileClose = node('button', 'sidebar-mobile-close', 'Close');
  mobileClose.type = 'button';
  mobileClose.dataset.action = 'mobile-close';
  header.append(brand, add, mobileClose);

  const mode = node('section', 'sidebar-section sidebar-mode');
  const modeTitle = node('h2', 'sidebar-heading', 'Mode');
  const modeList = node('div', 'sidebar-mode-list');
  mode.append(modeTitle, modeList);

  const workspace = node('nav', 'sidebar-section sidebar-nav');
  workspace.setAttribute('aria-label', 'Workspace');
  const workspaceTitle = node('h2', 'sidebar-heading', 'Workspace');
  const workspaceList = node('div', 'sidebar-nav-list');
  workspace.append(workspaceTitle, workspaceList);

  const more = node('details', 'sidebar-more');
  const moreTitle = node('summary', 'sidebar-heading', 'More tools');
  moreTitle.dataset.tip = 'More tools';
  const moreList = node('div', 'sidebar-nav-list');
  more.append(moreTitle, moreList);
  more.addEventListener('toggle', () => { moreOpen = more.open; });

  const conversations = node('section', 'sidebar-section sidebar-conversations');
  const conversationsTitle = node('h2', 'sidebar-heading', 'Conversations');
  const conversationList = node('div', 'conversation-list');
  conversations.append(conversationsTitle, conversationList);

  const footer = node('footer', 'sidebar-footer');
  const repo = node('button', 'sidebar-repo');
  repo.type = 'button';
  repo.dataset.action = 'repo';
  const spend = node('span', 'sidebar-spend');
  const settings = node('button', 'sidebar-settings', 'Settings');
  settings.type = 'button';
  settings.dataset.action = 'settings';
  footer.append(repo, spend, settings);

  const collapse = node('button', 'sidebar-collapse', 'Collapse');
  collapse.type = 'button';
  collapse.dataset.action = 'collapse';
  footer.append(collapse);
  root.append(header, mode, workspace, more, conversations, footer);

  const updatePreference = (value) => {
    if (typeof options.setPref === 'function') return options.setPref('sidebarCollapsed', value);
    if (currentState.prefs) currentState.prefs.sidebarCollapsed = value;
  };

  function renderConversations() {
    conversationList.textContent = '';
    const active = activeConversationOf(currentState);
    const rows = conversationsOf(currentState);
    if (!rows.length) {
      conversationList.append(node('div', 'sidebar-empty', currentState.ready === false ? 'Loading conversations…' : 'No conversations yet.'));
      return;
    }
    for (const conversation of rows) {
      const id = conversationId(conversation);
      if (!id) continue;
      const row = node('div', `conversation-row${sameId(id, active) ? ' selected' : ''}`);
      row.dataset.conversation = id;
      if (sameId(editing, id)) {
        const form = node('form', 'conversation-edit');
        form.dataset.action = 'rename';
        form.dataset.id = id;
        const input = node('input');
        input.name = 'title';
        input.value = conversation.title ?? '';
        input.setAttribute('aria-label', 'Conversation name');
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            editing = null;
            input.blur();
            render();
          }
        });
        const save = node('button', '', 'Save');
        save.type = 'submit';
        form.append(input, save);
        row.append(form);
      } else {
        const open = node('button', 'conversation-open', conversationTitle(conversation));
        open.type = 'button';
        open.dataset.conversation = id;
        const actions = node('span', 'conversation-actions');
        const rename = node('button', 'conversation-action', 'Rename');
        rename.type = 'button';
        rename.dataset.action = 'rename-start';
        rename.dataset.id = id;
        const branch = node('button', 'conversation-action', 'Branch');
        branch.type = 'button';
        branch.dataset.action = 'branch';
        branch.dataset.id = id;
        const archive = node('button', 'conversation-action', sameId(armedArchive, id) ? 'Confirm' : 'Archive');
        archive.type = 'button';
        archive.dataset.action = 'archive';
        archive.dataset.id = id;
        actions.append(rename, branch, archive);
        row.append(open, actions);
      }
      conversationList.append(row);
    }
  }

  function renderWorkspace() {
    workspaceList.textContent = '';
    const page = currentState.view?.page ?? 'home';
    const pending = (currentState.approvals ?? []).filter((item) => !item.resolved).length;
    const changed = currentState.changes?.changed ?? currentState.changes ?? [];
    const items = [
      ['home', 'Overview'],
      ['objective', 'Objective'],
      ['approvals', pending ? `Decisions · ${pending}` : 'Decisions'],
      ['changes', changed.length ? `Work · ${changed.length}` : 'Work'],
      ['agents', 'Team'],
      ['activity', 'Activity'],
    ];
    for (const [view, label] of items) {
      workspaceList.append(navButton(view, label, page));
    }
  }

  function renderMode() {
    modeList.textContent = '';
    const current = options.modeOf?.(currentState.mode) ?? currentState.userMode ?? currentState.mode;
    for (const choice of options.modes ?? []) {
      const selected = choice.id === current || choice.backend === current;
      const button = node('button', `sidebar-mode-option${selected ? ' selected' : ''}`);
      button.type = 'button';
      button.dataset.action = 'mode';
      button.dataset.mode = choice.id ?? choice.backend;
      button.dataset.tip = choice.blurb ?? '';
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = currentState.ready === false;
      button.append(node('strong', '', choice.label), node('span', '', choice.permissions ?? ''));
      modeList.append(button);
    }
  }

  function renderMore(page) {
    const items = [
      ['messages', 'Messages'], ['usage', 'Usage'], ['memory', 'Memory'],
      ['notes', 'Notes'], ['automations', 'Automations'], ['doctor', 'Doctor'],
    ];
    moreList.textContent = '';
    more.open = moreOpen || items.some(([view]) => page === view);
    for (const [view, label] of items) {
      moreList.append(navButton(view, label, page));
    }
  }

  function renderFooter() {
    const path = currentState.repo ?? currentState.repository;
    repo.textContent = repoName(path);
    repo.dataset.tip = path || 'Attach a repository';
    spend.textContent = spendText(currentState.spend);
    const collapsed = Boolean(currentState.prefs?.sidebarCollapsed);
    root.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    collapse.textContent = collapsed ? 'Expand' : 'Collapse';
    collapse.dataset.tip = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    collapse.setAttribute('aria-expanded', String(!collapsed));
  }

  function render(next = currentState) {
    currentState = next ?? currentState;
    const active = globalThis.document?.activeElement;
    if (active && root.contains(active) && ['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
    renderMode();
    renderWorkspace();
    renderMore(currentState.view?.page ?? 'home');
    renderConversations();
    renderFooter();
  }

  function onClick(event) {
    const target = event.target.closest('[data-action], [data-view], [data-conversation]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (target.dataset.view) {
      options.navigate?.(target.dataset.view);
      return;
    }
    if (target.dataset.conversation && !action) {
      options.onConversation?.(target.dataset.conversation);
      return;
    }
    if (action === 'new') {
      const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      options.onNew?.(id);
      if (!options.onNew) send(post, 'switchConversation', { name: options.member ?? 'orchestrator', conversationId: id });
    } else if (action === 'mode') options.onMode?.(target.dataset.mode);
    else if (action === 'mobile-close') options.onMobileClose?.();
    else if (action === 'settings') options.onSettings?.();
    else if (action === 'repo') options.onRepository?.();
    else if (action === 'collapse') updatePreference(!currentState.prefs?.sidebarCollapsed);
    else if (action === 'rename-start') { editing = target.dataset.id; render(); conversationList.querySelector('input')?.focus(); }
    else if (action === 'archive') {
      const id = target.dataset.id;
      if (armedArchive !== id) { armedArchive = id; render(); return; }
      armedArchive = null;
      send(post, 'archiveConversation', { id }).then((result) => {
        if (!result?.ok) options.toast?.(result?.error ?? 'Could not archive that conversation.', true);
        else if (sameId(currentState.view?.conversation ?? currentState.view?.conversationId, id)) {
          const next = conversationsOf(currentState).find((item) => !sameId(conversationId(item), id));
          if (next) options.onConversation?.(conversationId(next));
          else options.navigate?.('home');
        }
      });
    } else if (action === 'branch') {
      const id = target.dataset.id;
      const conversation = conversationsOf(currentState).find((item) => sameId(conversationId(item), id));
      if (options.onBranch) options.onBranch(conversation ?? { id });
      else send(post, 'branchConversation', {
        name: options.member ?? 'orchestrator',
        conversationId: id,
        forkAtMessageId: Number(conversation?.lastMessageId ?? conversation?.last_message_id
          ?? conversation?.lastId ?? conversation?.fork_at ?? conversation?.forkAt
          ?? lastMessageIdFor(currentState, id)),
        text: '',
      }).then(async (result) => {
        if (!result?.ok) {
          options.toast?.(result?.error ?? 'Could not create that branch.', true);
          return;
        }
        const data = await options.get?.('/api/conversations');
        const active = data?.active;
        if (active) options.onConversation?.(active);
        else options.toast?.(data?.error ?? 'The branch was created but could not be opened.', true);
      }).catch(() => options.toast?.('Could not open the new branch.', true));
    }
  }

  function onSubmit(event) {
    const form = event.target.closest('form[data-action="rename"]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const title = String(new FormData(form).get('title') ?? '').trim();
    const id = form.dataset.id;
    editing = null;
    form.querySelector('input')?.blur();
    render();
    send(post, 'renameConversation', { id, title }).then((result) => {
      if (!result?.ok) options.toast?.(result?.error ?? 'Could not rename that conversation.', true);
    });
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  if (typeof subscribe === 'function') unsubscribe = subscribe((next) => render(next));
  render(currentState);

  return () => {
    unsubscribe?.();
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.textContent = '';
    document.body.classList.remove('sidebar-collapsed');
  };
}

export const mount = mountSidebar;
export const renderSidebar = (root, state = storeState, options = {}) => mountSidebar(root, { ...options, state });
