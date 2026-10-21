import { h, page } from './util.js';
import { TABS, hashFor, tabOf } from '../routes.js';

// A page that hosts several existing views as tabs (Inbox, Team, Knowledge).
// Each tab body is the same render/mount pair its view always had, mounted into
// its own panel, so every view keeps its own subscriptions, request tokens and
// cleanup. Switching tabs runs the previous body's cleanup first; leaving the
// page runs the current one's. The host's own heading is the page's h1, and the
// body's duplicate heading is hidden by CSS (.tab-panel .view-heading).

function paint(strip, active) {
  for (const button of strip.querySelectorAll('button')) {
    const on = button.dataset.tab === active;
    button.classList.toggle('selected', on);
    if (on) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

/**
 * Build the render/mount pair for a tabbed page.
 * `bodies` maps a tab key (see TABS in routes.js) to `{ render, mount }`.
 */
export function tabbedPage(id, title, description, bodies) {
  const tabs = TABS[id];
  const shellOf = (state) => {
    const active = tabOf(id, state.tabs?.[id]);
    const shell = page(title, description);
    shell.classList.add('tabbed-page');
    const strip = h('nav', { class: 'settings-tabs tab-strip', 'aria-label': `${title} sections` });
    for (const [key, label] of tabs) strip.append(h('button', { class: 'button', type: 'button', 'data-tab': key, text: label }));
    const body = h('div', { class: 'tab-body' });
    shell.append(strip, body);
    paint(strip, active);
    return { shell, strip, body, active };
  };

  function render(state, root) {
    root.replaceChildren();
    const { shell, body, active } = shellOf(state);
    const panel = h('div', { class: 'tab-panel', 'data-tab-panel': active });
    body.append(panel);
    bodies[active].render(state, panel);
    root.append(shell);
  }

  function mount(state, root, context = {}) {
    root.replaceChildren();
    const { shell, strip, body } = shellOf(state);
    root.append(shell);
    let cleanup = null;
    let current = null;
    const show = (key) => {
      if (key === current) return;
      cleanup?.();
      cleanup = null;
      current = key;
      state.tabs = { ...state.tabs, [id]: key };
      paint(strip, key);
      const panel = h('div', { class: 'tab-panel', 'data-tab-panel': key });
      body.replaceChildren(panel);
      // The address follows the tab without remounting the page: a hashchange
      // would tear down the very view the click just opened.
      if (typeof history !== 'undefined' && typeof location !== 'undefined') {
        const next = `#${hashFor({ page: id, tab: key })}`;
        if (location.hash !== next) history.replaceState(null, '', next);
      }
      cleanup = bodies[key].mount(state, panel, { ...context, root: panel }) ?? null;
    };
    strip.addEventListener('click', (event) => {
      const key = event.target.closest?.('[data-tab]')?.dataset.tab;
      if (key) show(key);
    });
    show(tabOf(id, context.tab ?? state.tabs?.[id]));
    return () => { cleanup?.(); cleanup = null; current = null; };
  }

  return { render, mount };
}
