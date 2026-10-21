import { state as storeState, subscribe, post as storePost, sameId } from './store.js';
import { spendText, turnsText, tone } from './views/util.js';
import { icon } from './icons.js';
import { statusLabel } from './status.js';

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

// The rail is four destinations. Everything else the app can show is a tab of
// one of them, a chip on a run, or a Settings tab (see ui/routes.js).
const NAV_ICONS = Object.freeze({ home: 'target', inbox: 'bell', team: 'who', knowledge: 'vault', automations: 'workflows' });

function navButton(view, label, page, badge = 0) {
  const button = node('button', `sidebar-nav-button${page === view ? ' selected' : ''}`, label);
  button.type = 'button';
  button.dataset.view = view;
  button.dataset.tip = label;
  if (page === view) button.setAttribute('aria-current', 'page');
  button.prepend(icon(NAV_ICONS[view] ?? 'more'));
  if (badge) {
    button.append(node('span', 'sidebar-badge', String(badge)));
    button.setAttribute('aria-label', `${label}, ${badge} waiting`);
  }
  return button;
}

/** A short age for a run row: now, 12m, 2h, 3d. */
export function ago(ts, now = Date.now()) {
  const ms = now - Number(ts);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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

  root.className = 'sidebar';
  root.textContent = '';

  const header = node('div', 'sidebar-header');
  const brandRow = node('div', 'sidebar-brand-row');
  // The brand is the way home: Overview is no longer a rail destination.
  const brand = node('button', 'sidebar-brand');
  brand.type = 'button';
  brand.dataset.view = 'home';
  brand.dataset.tip = 'Overview';
  const brandName = node('span', 'sidebar-brand-name', 'Agentic OS');
  const brandRepo = node('span', 'sidebar-brand-repo');
  brand.append(icon('logo', 18), brandName, brandRepo);
  const mobileClose = node('button', 'sidebar-mobile-close', 'Close');
  mobileClose.type = 'button';
  mobileClose.dataset.action = 'mobile-close';
  brandRow.append(brand, mobileClose);
  // A run is a conversation with the orchestrator, so "New run" opens a fresh
  // one; the runs list below is the conversations list.
  const add = node('button', 'sidebar-new');
  add.type = 'button';
  add.dataset.action = 'new';
  add.dataset.tip = 'Start a new run';
  add.setAttribute('aria-keyshortcuts', 'Control+N');
  add.append(icon('plus', 15), node('span', 'sidebar-new-label', 'New run'), node('span', 'sidebar-new-hint', 'Ctrl N'));
  header.append(brandRow, add);

  const mode = node('section', 'sidebar-section sidebar-mode');
  const modeTitle = node('h2', 'sidebar-heading', 'Mode');
  const modeList = node('div', 'sidebar-mode-list');
  mode.append(modeTitle, modeList);

  const workspace = node('nav', 'sidebar-section sidebar-nav');
  workspace.setAttribute('aria-label', 'Workspace');
  const workspaceTitle = node('h2', 'sidebar-heading', 'Workspace');
  const workspaceList = node('div', 'sidebar-nav-list');
  workspace.append(workspaceTitle, workspaceList);

  const conversations = node('section', 'sidebar-section sidebar-conversations');
  const conversationsTitle = node('h2', 'sidebar-heading');
  const conversationsRepo = node('span', 'sidebar-heading-repo');
  const conversationsBranch = node('span', 'sidebar-heading-branch');
  conversationsTitle.append(conversationsRepo, conversationsBranch);
  const conversationList = node('div', 'conversation-list');
  conversations.append(conversationsTitle, conversationList);

  // #41: pausing the court used to have no visible surface at all beyond a
  // chat notice addressed to the orchestrator — the sovereign had no reason
  // to be looking at that conversation, so a court paused for its turn
  // budget just looked stopped, for no visible reason, with no way back in.
  const pauseBanner = node('div', 'sidebar-pause-banner');
  pauseBanner.hidden = true;
  const pauseText = node('p', 'sidebar-pause-text');
  const pauseActions = node('div', 'sidebar-pause-actions');
  const resumeButton = node('button', 'sidebar-pause-resume', 'Resume');
  resumeButton.type = 'button';
  resumeButton.dataset.action = 'resume';
  const raiseButton = node('button', 'sidebar-pause-raise', 'Add 100 turns & resume');
  raiseButton.type = 'button';
  raiseButton.dataset.action = 'raise-turn-budget';
  pauseActions.append(resumeButton, raiseButton);
  pauseBanner.append(pauseText, pauseActions);

  const footer = node('footer', 'sidebar-footer');
  const repo = node('button', 'sidebar-repo');
  repo.type = 'button';
  repo.dataset.action = 'repo';
  const spend = node('span', 'sidebar-spend');
  const settings = node('button', 'sidebar-settings', 'Settings');
  settings.type = 'button';
  settings.dataset.action = 'settings';
  footer.append(pauseBanner, repo, spend, settings);

  const collapse = node('button', 'sidebar-collapse', 'Collapse');
  collapse.type = 'button';
  collapse.dataset.action = 'collapse';
  footer.append(collapse);
  // Everything that can outgrow the rail's own height scrolls together as
  // one region, so the header and footer are never the thing the browser
  // clips when they do not fit. See .sidebar-scroll in app.css.
  const scroll = node('div', 'sidebar-scroll');
  scroll.append(mode, workspace, conversations);
  root.append(header, scroll, footer);

  const updatePreference = (value) => {
    if (typeof options.setPref === 'function') return options.setPref('sidebarCollapsed', value);
    if (currentState.prefs) currentState.prefs.sidebarCollapsed = value;
  };

  function renderConversations() {
    conversationList.textContent = '';
    conversationsRepo.textContent = repoName(currentState.repo ?? currentState.repository);
    conversationsBranch.textContent = currentState.base ?? '';
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
        const open = node('button', 'conversation-open');
        open.type = 'button';
        // The open run wears the run's own tone; every other row is a ring.
        const runState = String(currentState.run?.status ?? currentState.run?.state ?? '').toLowerCase().replace(/[- ]/g, '_');
        const live = sameId(id, active) && runState && !['completed', 'cancelled'].includes(runState);
        open.append(node('span', `status-dot conversation-dot ${live ? tone(runState) : ''}`.trim()),
          node('span', 'conversation-title', conversationTitle(conversation)),
          node('span', 'conversation-age', ago(conversation.created_ts ?? conversation.createdTs)));
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
    // The badge counts only what needs a decision; news and due-soon items do not.
    const waiting = ((currentState.inbox ?? []).filter?.((item) => item.tone === 'attention').length ?? 0)
      + (currentState.doctor?.ready === false && currentState.doctor?.ok !== false ? 1 : 0);
    const items = [
      ['inbox', 'Inbox', waiting],
      ['team', 'Team'],
      ['knowledge', 'Knowledge'],
      ['automations', 'Automations'],
    ];
    for (const [view, label, badge] of items) workspaceList.append(navButton(view, label, page, badge));
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

  function renderFooter() {
    const path = currentState.repo ?? currentState.repository;
    repo.textContent = repoName(path);
    brandRepo.textContent = repoName(path);
    repo.dataset.tip = path || 'Attach a repository';
    const money = spendText(currentState.spend);
    const turns = turnsText(currentState.spend);
    spend.textContent = [money, turns].filter(Boolean).join(' · ');

    // Pausing degrades visibly (#41): a court paused for its turn budget (or
    // by the sovereign's own hand) shows a banner right where the spend
    // total already lives, instead of only a chat notice nobody may be
    // reading. Reuses the exact `paused` flag and `pause()`/`resume()` pair
    // the sovereign's manual pause already relies on — this is not a
    // second pause mechanism.
    const paused = Boolean(currentState.paused);
    pauseBanner.hidden = !paused;
    if (paused) {
      const why = currentState.pausedWhy || '';
      pauseText.textContent = why ? `Paused — ${why}` : 'Paused by you.';
      const isTurnBudget = /turn budget/i.test(why);
      raiseButton.hidden = !isTurnBudget;
    }

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
    else if (action === 'resume') {
      resumeButton.disabled = true;
      send(post, 'resume', {}).then((result) => {
        resumeButton.disabled = false;
        if (!result?.ok) options.toast?.(result?.error ?? 'Could not resume the team.', true);
      });
    } else if (action === 'raise-turn-budget') {
      // "100 more turns from right now": the daemon adds them to this
      // session's cap (Kingdom#raiseTurnBudget), relative to its own count.
      raiseButton.disabled = true;
      send(post, 'raiseTurnBudget', { by: 100 }).then((result) => {
        raiseButton.disabled = false;
        if (!result?.ok) options.toast?.(result?.error ?? 'Could not raise the turn budget.', true);
      });
    }
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
