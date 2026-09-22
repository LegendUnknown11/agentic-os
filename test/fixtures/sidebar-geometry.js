// Bridge for test/t-theme-geometry.js: mounts the real rail with
// `ui/sidebar.js`'s own `mountSidebar`, not a hand-copied approximation of its
// DOM, so the computed layout measured in that suite is the layout the app
// itself produces.
import { mountSidebar } from '/ui/sidebar.js';

window.__mountSidebar = (state, options = {}) =>
  mountSidebar(document.getElementById('sidebar'), { state, ...options });
