// The shell's route table, kept pure so the suite can exercise it without a DOM.
//
// A hash names a page and, for the pages that host several views, a tab:
//   #inbox/approvals   #team/activity   #knowledge/notes   #settings
// The pages below are the only things the shell mounts. Every other id the
// interface has ever navigated to is an ALIAS: it lands on the page and tab
// that now hosts that view, instead of silently falling back to Overview (the
// failure `#tasks` hit on 2026-09-25, which t-pages guards).

/** Pages the shell mounts. `thread` carries its own member and conversation. */
export const PAGES = ['home', 'thread', 'inbox', 'team', 'knowledge', 'automations', 'settings', 'objective', 'changes', 'tasks'];

/** Pages that host several views as tabs, in strip order: [key, label]. */
export const TABS = {
  inbox: [['all', 'All'], ['approvals', 'Approvals'], ['messages', 'Messages'], ['tasks', 'My tasks']],
  team: [['agents', 'Agents'], ['activity', 'Activity']],
  knowledge: [['memory', 'Memory'], ['notes', 'Notes']],
};

/** Retired destinations and where their view now lives. */
export const ALIASES = {
  approvals: { page: 'inbox', tab: 'approvals' },
  messages: { page: 'inbox', tab: 'messages' },
  agents: { page: 'team', tab: 'agents' },
  activity: { page: 'team', tab: 'activity' },
  memory: { page: 'knowledge', tab: 'memory' },
  notes: { page: 'knowledge', tab: 'notes' },
  usage: { page: 'settings', section: 'usage' },
  doctor: { page: 'settings', section: 'doctor' },
};

const decodePart = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

const tabKeys = (page) => (TABS[page] ?? []).map(([key]) => key);

/** The tab to show: a valid requested one, else the page's first. */
export function tabOf(page, requested) {
  const keys = tabKeys(page);
  return keys.includes(requested) ? requested : keys[0];
}

/** `#inbox/approvals` -> { page: 'inbox', tab: 'approvals' }. Never throws. */
export function parseHash(hash = '') {
  const parts = String(hash).replace(/^#/, '').replace(/^\/+/, '').split('/');
  const page = decodePart(parts.shift() ?? '');
  if (page.startsWith('agent:')) return {
    page: 'thread', member: decodePart(page.slice(6)), conversation: decodePart(parts.join('/') || 'default'),
  };
  if (page === 'thread') return {
    page,
    member: decodePart(parts.shift() || 'orchestrator'),
    conversation: decodePart(parts.join('/') || 'default'),
  };
  if (Object.hasOwn(ALIASES, page)) {
    const alias = ALIASES[page];
    return alias.tab ? { page: alias.page, tab: alias.tab } : { ...alias };
  }
  if (!PAGES.includes(page)) return { page: 'home' };
  if (TABS[page]) return { page, tab: tabOf(page, decodePart(parts[0] ?? '')) };
  return { page };
}

/** The canonical hash for a route, so a retired id is rewritten on arrival. */
export function hashFor(route) {
  const value = typeof route === 'object' && route ? route : parseHash(String(route ?? 'home'));
  const page = String(value.page || 'home').replace(/^#?\/?/, '');
  if (page === 'thread') {
    return ['thread', encodeURIComponent(value.member ?? 'orchestrator'), encodeURIComponent(value.conversation ?? 'default')].join('/');
  }
  if (TABS[page]) return `${page}/${tabOf(page, value.tab)}`;
  return page;
}

/** What `navigate('approvals')` should write, whatever vocabulary the caller used. */
export function canonicalHash(view) {
  if (typeof view === 'object' && view) return hashFor(view);
  const route = parseHash(`#${view ?? 'home'}`);
  return hashFor(route);
}
