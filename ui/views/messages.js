import { h, page, section, empty, mdToHtml, displayName, date, subscribe, editing } from './util.js';

const rows = (value, key = 'rows') => Array.isArray(value) ? value : value?.[key] ?? [];
const messageRows = (state) => rows(state.messages, 'messages').concat(rows(state.events, 'events').filter((e) => e.type === 'message' || e.type === 'delivered').map((e) => ({ ...e, sender: e.from ?? e.name, body: e.text ?? e.message ?? e.body })));
function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

export function renderMessages(state, root) {
  root.replaceChildren();
  const shell = page('Messages', 'The bus between the orchestrator and the team.');
  const body = section('Recent messages');
  if (state.ready === false) body.append(empty('Loading messages…'));
  else {
    const messages = messageRows(state).slice(-200).reverse();
    if (!messages.length) body.append(empty('No messages yet.'));
    for (const message of messages) body.append(h('article', { class: 'message-row' }, h('div', { class: 'card-meta', text: `${displayName(message.sender ?? message.from)}${message.recipient ? ` → ${displayName(message.recipient)}` : ''} · ${date(message.ts)}` }), h('div', { class: 'markdown', html: mdToHtml(message.body ?? message.text ?? '') })));
  }
  shell.append(body); root.append(shell);
}

export function mountMessages(state, root) {
  renderMessages(state, root);
  return bind(state, root, renderMessages);
}
export const render = renderMessages;
export const mount = mountMessages;
