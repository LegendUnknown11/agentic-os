export * from './pages.js';
export { renderAutomations, mountAutomations } from './automations.js';
export { renderSettings, mountSettings } from './settings.js';

import { render as renderHome, mount as mountHome } from './home.js';
import {
  VIEW_RENDERERS, VIEW_MOUNTS, renderApprovals, mountApprovals, renderMessages, mountMessages,
  renderAgents, mountAgents, renderActivity, mountActivity, renderMemory, mountMemory, renderNotes, mountNotes,
} from './pages.js';
import { renderInbox, mountInbox } from './inbox.js';
import { renderMyTasks, mountMyTasks } from './tasks.js';
import { renderAutomations, mountAutomations } from './automations.js';
import { renderSettings, mountSettings } from './settings.js';
import { tabbedPage } from './tabs.js';

export { renderHome, mountHome };

// Inbox, Team and Knowledge each host views that used to be rail destinations.
// Their bodies are the original render/mount pairs, unchanged.
const inboxPage = tabbedPage('inbox', 'Inbox', 'Everything inside the app that is waiting on you, most urgent first.', {
  all: { render: renderInbox, mount: mountInbox },
  approvals: { render: renderApprovals, mount: mountApprovals },
  messages: { render: renderMessages, mount: mountMessages },
  tasks: { render: renderMyTasks, mount: mountMyTasks },
});
const teamPage = tabbedPage('team', 'Team', 'Who is on the team, what each one is doing, and what just happened.', {
  agents: { render: renderAgents, mount: mountAgents },
  activity: { render: renderActivity, mount: mountActivity },
});
const knowledgePage = tabbedPage('knowledge', 'Knowledge', 'What the team remembers, and your own notes.', {
  memory: { render: renderMemory, mount: mountMemory },
  notes: { render: renderNotes, mount: mountNotes },
});

// Route-level registry: only what the shell mounts as a page. A retired id
// (approvals, agents, usage, ...) is an alias in routes.js and lands on the
// tab or settings section that hosts it; its own render/mount pair stays in
// VIEW_RENDERERS / VIEW_MOUNTS for that host to use.
const PAGE_VIEWS = ['objective', 'changes', 'tasks'];
export const renderers = {
  home: renderHome,
  inbox: inboxPage.render,
  team: teamPage.render,
  knowledge: knowledgePage.render,
  automations: renderAutomations,
  settings: renderSettings,
  ...Object.fromEntries(PAGE_VIEWS.map((name) => [name, VIEW_RENDERERS[name]])),
};
export const mounts = {
  home: mountHome,
  inbox: inboxPage.mount,
  team: teamPage.mount,
  knowledge: knowledgePage.mount,
  automations: mountAutomations,
  settings: mountSettings,
  ...Object.fromEntries(PAGE_VIEWS.map((name) => [name, VIEW_MOUNTS[name]])),
};

export function viewFor(name = 'home') {
  const key = String(name).split(':')[0];
  return { render: renderers[key] ?? renderHome, mount: mounts[key] ?? mountHome };
}
