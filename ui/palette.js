import { icon } from './icons.js';

// Ctrl K: one box that reaches every destination and every run. The rail shows
// four destinations, so everything else (Approvals, Usage, a worktree diff, an
// older run) is found here instead of by hunting through menus.

/** Where each destination lives now, for people who remember where it used to be. */
const DESTINATIONS = [
  ['Overview', 'Objective, runs, what needs you', 'home'],
  ['Inbox', 'Everything waiting on you', 'inbox'],
  ['Approvals', 'Inbox', 'approvals'],
  ['Messages', 'Inbox', 'messages'],
  ['My tasks', 'Inbox', 'inbox/tasks'],
  ['Team', 'Agents and what each is doing', 'team'],
  ['Activity', 'Team', 'activity'],
  ['Knowledge', 'Memory and notes', 'knowledge'],
  ['Memory', 'Knowledge', 'memory'],
  ['Notes', 'Knowledge', 'notes'],
  ['Automations', 'Workflows and templates', 'automations'],
  ['Objective', 'Overview', 'objective'],
  ['Changes', 'Review what the team changed', 'changes'],
  ['Tasks', "Your list and the team's queue", 'tasks'],
  ['Usage', 'Settings', 'usage'],
  ['Doctor', 'Settings', 'doctor'],
  ['Settings', 'Repository, models, appearance', 'settings'],
];

/** Every row the palette can show for this state. Pure, for the suite. */
export function paletteItems(state = {}) {
  const items = DESTINATIONS.map(([label, hint, target]) => ({ kind: 'page', label, hint, target }));
  const rows = Array.isArray(state.conversations) ? state.conversations
    : state.conversations?.conversations ?? state.conversations?.items ?? [];
  for (const row of rows) {
    const id = row?.id ?? row?.conversationId;
    if (!id) continue;
    items.push({ kind: 'run', label: row.title || (row.parent_id || row.parentId ? 'Branch' : 'New chat'), hint: 'Run', target: { page: 'thread', member: 'orchestrator', conversation: id } });
  }
  return items;
}

/** Substring match on the label first, then the hint; stable otherwise. Pure. */
export function filterItems(items, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return items;
  const score = (item) => {
    const label = item.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    if (String(item.hint).toLowerCase().includes(q)) return 2;
    return -1;
  };
  return items.map((item, index) => ({ item, index, rank: score(item) }))
    .filter((entry) => entry.rank >= 0)
    .sort((x, y) => x.rank - y.rank || x.index - y.index)
    .map((entry) => entry.item);
}

let openState = null;

/** Open the palette; returns a close function. A second call closes the first. */
export function openPalette({ state, navigate, host = document.body }) {
  if (openState) { openState.close(); return () => {}; }
  const opener = document.activeElement;
  const all = paletteItems(state);
  let results = all;
  let index = 0;

  const scrim = document.createElement('div');
  scrim.className = 'palette-scrim';
  const dialog = document.createElement('div');
  dialog.className = 'palette';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Search');
  const field = document.createElement('div');
  field.className = 'palette-field';
  const input = document.createElement('input');
  input.className = 'palette-input';
  input.type = 'text';
  input.placeholder = 'Go to a page or a run';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');
  input.setAttribute('aria-label', 'Search pages and runs');
  field.append(icon('search', 15), input);
  const list = document.createElement('ul');
  list.className = 'palette-list';
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  dialog.append(field, list);
  scrim.append(dialog);

  const close = () => {
    if (!openState) return;
    openState = null;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
  };
  const choose = (item) => {
    close();
    if (item) navigate(item.target);
  };
  const paint = () => {
    list.replaceChildren();
    index = Math.min(index, Math.max(0, results.length - 1));
    if (!results.length) {
      const none = document.createElement('li');
      none.className = 'palette-empty';
      none.textContent = 'Nothing matches.';
      list.append(none);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    results.forEach((item, i) => {
      const row = document.createElement('li');
      row.className = `palette-row${i === index ? ' selected' : ''}`;
      row.id = `palette-row-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === index));
      const label = document.createElement('span');
      label.textContent = item.label;
      const hint = document.createElement('span');
      hint.className = 'palette-hint';
      hint.textContent = item.hint;
      row.append(label, hint);
      row.addEventListener('pointerdown', (event) => { event.preventDefault(); choose(item); });
      list.append(row);
    });
    input.setAttribute('aria-activedescendant', `palette-row-${index}`);
    list.querySelector('.selected')?.scrollIntoView?.({ block: 'nearest' });
  };
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { event.preventDefault(); return; }       // the input is the only stop
    if (event.key === 'ArrowDown') { event.preventDefault(); index = (index + 1) % Math.max(1, results.length); paint(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); index = (index - 1 + results.length) % Math.max(1, results.length); paint(); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(results[index]); }
  }
  input.addEventListener('input', () => { results = filterItems(all, input.value); index = 0; paint(); });
  scrim.addEventListener('pointerdown', (event) => { if (event.target === scrim) close(); });
  document.addEventListener('keydown', onKey, true);
  host.append(scrim);
  paint();
  input.focus();
  openState = { close };
  return close;
}
