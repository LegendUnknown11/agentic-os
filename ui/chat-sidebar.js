// The conversation list beside Chat mode's thread — same DI pattern as every
// other UI module (initX(node, opts)), and the same hover-action/arm-confirm
// row idiom panels.js already uses for workflows, so this doesn't invent a
// second one.
const el = (tag, cls, text) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

let root, list;
let onSelect, onNew, onRename, onArchive, onSearch;
let rows = new Map();   // id -> {row, titleEl}
let activeId = null;

export function initSidebar(node, opts) {
  root = node;
  ({ onSelect, onNew, onRename, onArchive, onSearch } = opts);

  root.className = 'chat-sidebar';
  const head = el('div', 'chat-sidebar-head');
  const add = el('button', 'chat-sidebar-new', '+ New chat');
  add.onclick = () => onNew();
  head.append(add);
  if (onSearch) {
    const search = el('button', 'chat-sidebar-search', '⚲');
    search.title = 'Search everything the court remembers';
    search.onclick = () => onSearch();
    head.append(search);
  }
  const collapseBtn = el('button', 'chat-sidebar-collapse', '‹');
  collapseBtn.title = 'Collapse the conversation list';
  collapseBtn.onclick = toggleCollapsed;
  head.append(collapseBtn);

  list = el('div', 'chat-sidebar-list');
  root.append(head, list);

  if (localStorage.getItem('kd.chatSidebar') === '1') root.classList.add('collapsed');
}

function toggleCollapsed() {
  const on = root.classList.toggle('collapsed');
  localStorage.setItem('kd.chatSidebar', on ? '1' : '0');
}

/** Full (re)paint — used on boot and on a member switch. */
export function paint(conversations, active) {
  list.textContent = '';
  rows = new Map();
  activeId = active;
  for (const c of conversations) list.append(rowFor(c));
  markActive(active);
}

export function setActive(id) {
  activeId = id;
  markActive(id);
}

function markActive(id) {
  for (const [rid, r] of rows) r.row.classList.toggle('active', rid === id);
}

/** A conversation created, renamed, or newly forked elsewhere — reflect it live. */
export function upsert(conv) {
  const existing = rows.get(conv.id);
  if (existing) { existing.titleEl.textContent = titleOf(conv); return; }
  const row = rowFor(conv);
  list.prepend(row);
  markActive(activeId);
}

export function drop(id) {
  rows.get(id)?.row.remove();
  rows.delete(id);
}

function titleOf(c) {
  return c.title || (c.parent_id ? 'Branch' : 'New chat');
}

function rowFor(c) {
  const row = el('div', 'chat-sidebar-row');
  const main = el('button', 'chat-sidebar-main');
  const titleEl = el('span', 'chat-sidebar-title', titleOf(c));
  main.append(titleEl);
  main.onclick = () => onSelect(c.id);

  const rename = el('button', 'chat-sidebar-act', '✎');
  rename.title = 'Rename';
  rename.onclick = (e) => {
    e.stopPropagation();
    const next = prompt('Rename conversation', c.title || '');
    if (next != null) onRename(c.id, next.trim());
  };

  const arch = el('button', 'chat-sidebar-act', '✕');
  arch.title = 'Archive';
  arch.onclick = (e) => {
    e.stopPropagation();
    if (arch.dataset.armed !== '1') { arch.dataset.armed = '1'; arch.textContent = '✓'; arch.title = 'Confirm archive'; return; }
    onArchive(c.id);
  };

  row.append(main, rename, arch);
  rows.set(c.id, { row, titleEl });
  return row;
}
