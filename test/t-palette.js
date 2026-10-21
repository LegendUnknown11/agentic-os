// Ctrl K reaches every page and every run, because the rail now shows four
// destinations. The matching and the run ages are pure, so they are exercised
// directly; the dialog itself is driven in real Chromium by t-theme-geometry.
//   node test/t-palette.js
import { strict as a } from 'node:assert';
import { filterItems, paletteItems } from '../ui/palette.js';
import { ago } from '../ui/sidebar.js';
import { parseHash } from '../ui/routes.js';

const state = { conversations: [{ id: 'c1', title: 'Electron acceptance pass' }, { id: 'c2', title: '' }, { id: 'c3', title: '', parent_id: 'c1' }, { title: 'no id' }] };
const items = paletteItems(state);

// every destination the rail dropped is still reachable, and routes where it lives
const pages = items.filter((i) => i.kind === 'page');
for (const label of ['Overview', 'Inbox', 'Approvals', 'Messages', 'My tasks', 'Team', 'Activity', 'Knowledge', 'Memory', 'Notes', 'Automations', 'Objective', 'Changes', 'Tasks', 'Usage', 'Doctor', 'Settings']) {
  const item = pages.find((p) => p.label === label);
  a.ok(item, `${label} must be reachable from search`);
  a.notEqual(parseHash(`#${item.target}`).page === 'home' && label !== 'Overview', true, `${label} must not route to Overview`);
}
console.log(`  ${pages.length} pages reachable, none of them routed to Overview by accident`);

// runs come from the conversations list; a row with no id is skipped
const runs = items.filter((i) => i.kind === 'run');
a.deepEqual(runs.map((r) => r.label), ['Electron acceptance pass', 'New chat', 'Branch'], 'an untitled run reads New chat, a branch reads Branch');
a.deepEqual(runs[0].target, { page: 'thread', member: 'orchestrator', conversation: 'c1' });
console.log('  runs listed from the conversations, untitled and branched ones named');

// matching: label prefix, then label contains, then hint; stable within a rank
a.deepEqual(filterItems(items, '').length, items.length, 'an empty query shows everything');
a.equal(filterItems(items, 'inbox')[0].label, 'Inbox', 'a prefix match ranks first');
a.deepEqual(filterItems(items, 'APPROV').map((i) => i.label), ['Approvals'], 'matching ignores case');
a.ok(filterItems(items, 'settings').some((i) => i.label === 'Usage'), 'a page is found by where it lives now (the hint)');
a.ok(filterItems(items, 'settings').findIndex((i) => i.label === 'Settings') < filterItems(items, 'settings').findIndex((i) => i.label === 'Usage'), 'a label match outranks a hint match');
a.deepEqual(filterItems(items, 'zzzz'), [], 'no match is an empty list, not everything');
a.deepEqual(paletteItems({}).filter((i) => i.kind === 'run'), [], 'no conversations is no runs');
a.deepEqual(paletteItems({ conversations: { conversations: [{ id: 'x', title: 'T' }] } }).filter((i) => i.kind === 'run').length, 1, 'the daemon\'s wrapped shape is read too');
console.log('  matching ranks prefix, then label, then hint, and never invents results');

// run ages
const now = 1_000_000_000_000;
a.equal(ago(now - 5_000, now), 'now');
a.equal(ago(now - 12 * 60_000, now), '12m');
a.equal(ago(now - 2 * 3_600_000, now), '2h');
a.equal(ago(now - 3 * 86_400_000, now), '3d');
a.equal(ago(undefined, now), '', 'a run with no timestamp shows no age');
a.equal(ago(now + 60_000, now), '', 'a timestamp from the future shows no age');
console.log('  run ages read now, 12m, 2h, 3d');

console.log('t-palette.js OK — every page and run is one search away');
