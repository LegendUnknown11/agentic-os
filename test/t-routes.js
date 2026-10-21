// The shell's route table (ui/routes.js) is pure, so it is exercised directly.
// What it must never do is send a retired destination to Overview: that is how
// `#tasks` silently rendered the wrong page on 2026-09-25.
//   node test/t-routes.js
import { strict as a } from 'node:assert';
import { ALIASES, PAGES, TABS, canonicalHash, hashFor, parseHash, tabOf } from '../ui/routes.js';
import { renderers, mounts, viewFor } from '../ui/views/index.js';
import { VIEW_RENDERERS } from '../ui/views/pages.js';

// every retired id lands on the page and tab that hosts it
const LANDINGS = {
  approvals: { page: 'inbox', tab: 'approvals' },
  messages: { page: 'inbox', tab: 'messages' },
  agents: { page: 'team', tab: 'agents' },
  activity: { page: 'team', tab: 'activity' },
  memory: { page: 'knowledge', tab: 'memory' },
  notes: { page: 'knowledge', tab: 'notes' },
  usage: { page: 'settings', section: 'usage' },
  doctor: { page: 'settings', section: 'doctor' },
  objective: { page: 'home', open: 'objective' },
};
for (const [from, want] of Object.entries(LANDINGS)) {
  a.deepEqual(parseHash(`#${from}`), want, `#${from} must land on its new home, not Overview`);
}
a.deepEqual(Object.keys(ALIASES).sort(), Object.keys(LANDINGS).sort(), 'every alias is pinned here, so a new one is a decision');
console.log('  9 retired destinations land on their new tab, settings section or Overview');

// nothing a view is registered under can fall back to Overview
for (const name of Object.keys(VIEW_RENDERERS)) {
  const route = parseHash(`#${name}`);
  a.ok(PAGES.includes(name) || Object.hasOwn(ALIASES, name), `#${name} is a registered view and must be a page or an alias`);
  a.ok(route.page !== 'home' || ALIASES[name]?.page === 'home', `#${name} must not fall back to Overview by accident`);
}
for (const name of Object.keys(renderers)) a.ok(PAGES.includes(name), `the registry mounts ${name}, so it must be a routed page`);
for (const name of PAGES.filter((p) => p !== 'thread')) {
  a.equal(typeof renderers[name], 'function', `${name} needs a renderer`);
  a.equal(typeof mounts[name], 'function', `${name} needs a mount`);
}
a.equal(viewFor('inbox').mount, mounts.inbox);
console.log('  every registered view is routed or aliased; every page has a renderer and a mount');

// tabs
a.deepEqual(parseHash('#inbox'), { page: 'inbox', tab: 'all' }, 'a tabbed page opens on its first tab');
a.deepEqual(parseHash('#inbox/messages'), { page: 'inbox', tab: 'messages' });
a.deepEqual(parseHash('#inbox/nonsense'), { page: 'inbox', tab: 'all' }, 'an unknown tab falls back to the first, not to Overview');
a.deepEqual(parseHash('#team/activity'), { page: 'team', tab: 'activity' });
a.equal(tabOf('knowledge', 'notes'), 'notes');
a.equal(tabOf('knowledge', 'bogus'), 'memory');
console.log('  tabs resolve, and an unknown one never leaves the page');

// threads and plain pages are untouched
a.deepEqual(parseHash('#thread/orchestrator/c1'), { page: 'thread', member: 'orchestrator', conversation: 'c1' });
a.deepEqual(parseHash('#agent:builder'), { page: 'thread', member: 'builder', conversation: 'default' });
a.deepEqual(parseHash('#thread'), { page: 'thread', member: 'orchestrator', conversation: 'default' });
a.deepEqual(parseHash('#settings'), { page: 'settings' });
a.deepEqual(parseHash('#automations'), { page: 'automations' });
a.deepEqual(parseHash(''), { page: 'home' });
a.deepEqual(parseHash('#nope'), { page: 'home' }, 'a truly unknown id is the one case that opens Overview');
a.deepEqual(parseHash('#%E0%A4%A'), { page: 'home' }, 'a malformed escape must not throw');
console.log('  threads, plain pages and unknown ids parse as before');

// the address a navigation writes is canonical
a.equal(canonicalHash('approvals'), 'inbox/approvals');
a.equal(canonicalHash('inbox'), 'inbox/all');
a.equal(canonicalHash('agents'), 'team/agents');
a.equal(canonicalHash('usage'), 'settings');
a.equal(canonicalHash('home'), 'home');
a.equal(canonicalHash({ page: 'team', tab: 'activity' }), 'team/activity');
a.equal(hashFor({ page: 'thread', member: 'a b', conversation: 'x/y' }), 'thread/a%20b/x%2Fy');
for (const page of Object.keys(TABS)) for (const [key] of TABS[page]) {
  a.deepEqual(parseHash(`#${hashFor({ page, tab: key })}`), { page, tab: key }, `${page}/${key} round-trips`);
}
console.log('  navigations write the canonical address, and every tab round-trips');

console.log('t-routes.js OK — retired destinations are aliases, never a silent fall back to Overview');
