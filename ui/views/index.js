export * from './pages.js';
export { renderAutomations, mountAutomations } from './automations.js';
export { renderSettings, mountSettings } from './settings.js';

import { render as renderHome, mount as mountHome } from './home.js';
import { VIEW_RENDERERS, VIEW_MOUNTS } from './pages.js';
import { renderAutomations, mountAutomations } from './automations.js';
import { renderSettings, mountSettings } from './settings.js';

export { renderHome, mountHome };

export const renderers = {
  home: renderHome, ...VIEW_RENDERERS, automations: renderAutomations, settings: renderSettings,
};
export const mounts = {
  home: mountHome, ...VIEW_MOUNTS, automations: mountAutomations, settings: mountSettings,
};

export function viewFor(name = 'home') {
  const key = String(name).split(':')[0];
  return { render: renderers[key] ?? renderHome, mount: mounts[key] ?? mountHome };
}
