import { h, page, section, empty, note, button, get, subscribe, apiError, requestToken, date } from './util.js';

// The ranking lives in src/inbox.js on the daemon, so the Inbox view and the
// morning-brief automation can never disagree about what is waiting.
const KIND_LABELS = { run: 'Run', approval: 'Decision', question: 'Question', task: 'Your task', message: 'Message' };

export function loadInbox(state, render) {
  const token = requestToken(state, 'inboxRequest');
  return get('/api/inbox').then((data) => {
    if (state.inboxRequest !== token) return;
    if (data?.ok !== false) { state.inbox = data.items ?? []; state.inboxError = null; }
    else state.inboxError = apiError(data, 'Could not load your inbox.');
    render?.();
  });
}

/** What still needs a decision from you, as opposed to what is just news. */
export const waitingCount = (items = []) => items.filter((item) => item.tone === 'attention').length;

function row(item) {
  return h('li', { class: `inbox-item ${item.tone ?? ''}`.trim(), 'data-inbox-id': item.id },
    h('div', { class: 'task-manage-text' },
      h('span', { class: 'card-meta', text: [KIND_LABELS[item.kind] ?? item.kind, item.ts ? date(item.ts) : null].filter(Boolean).join(' · ') }),
      h('strong', { text: item.title }),
      item.detail ? h('span', { class: 'inbox-detail', text: item.detail }) : null),
    h('a', { class: 'button link', href: item.href ?? '#home', text: 'Open' }));
}

export function renderInbox(state, root) {
  if (root.isConnected === false) return;
  root.replaceChildren();
  const items = state.inbox;
  const waiting = waitingCount(items ?? []);
  const shell = page('Inbox', 'Everything inside the app that is waiting on you, most urgent first.');
  const refresh = button('Refresh', () => loadInbox(state, () => renderInbox(state, root)));
  const body = items == null
    ? (state.inboxError ? note(state.inboxError, 'danger') : empty('Loading your inbox…'))
    : items.length
      ? h('ul', { class: 'task-manage-list', 'aria-label': 'Waiting on you' }, ...items.map(row))
      : empty('Nothing is waiting on you.');
  shell.append(section(items?.length ? (waiting ? `Needs you · ${waiting}` : 'For your attention') : 'Inbox',
    items != null && state.inboxError ? note(`Refresh failed: ${state.inboxError} Showing the last inbox.`, 'danger') : null,
    body, h('div', { class: 'button-row' }, refresh)));
  root.append(shell);
}

export function mountInbox(state, root) {
  const repaint = () => { if (root.isConnected !== false) renderInbox(state, root); };
  renderInbox(state, root);
  void loadInbox(state, repaint);
  // Approvals, the run, your list and messages move on the stream. Refetch
  // only when one of them did, at most once a second: the store notifies on
  // every frame of member output, and this was a request a second for as long
  // as anyone was typing.
  const inputs = () => [state.approvals?.length, state.run?.id, state.run?.state, state.myTasks?.length, state.messageCursor].join('|');
  let seen = inputs();
  let timer = null;
  const off = subscribe(() => {
    const now = inputs();
    if (timer || now === seen) return;
    seen = now;
    timer = setTimeout(() => { timer = null; void loadInbox(state, repaint); }, 1000);
  });
  return () => { clearTimeout(timer); requestToken(state, 'inboxRequest'); off?.(); };
}
export const render = renderInbox;
export const mount = mountInbox;
