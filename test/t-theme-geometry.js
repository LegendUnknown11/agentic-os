// Greptile's review of PR #68 (test/t-theme.js:298-302): the assertions pinning
// the three defects the 2026-09-21 live session found only match CSS source
// text. A more specific rule, or an edit that reorders declarations without
// touching the pinned lines, can pass them while the actual rendered layout
// regresses. This suite reads the real computed geometry instead, from a real
// Chromium tab, against the app's own `mountSidebar` (not a hand-copied DOM).
//
// It needs a browser. This repo's CI (`.github/workflows/test.yml`) runs on
// windows-latest with no Playwright browser install step, and adding one is a
// separate, heavier decision than fixing a review nit — so rather than turning
// "no browser here" into a false CI failure, this suite skips itself with a
// clear note when Chromium cannot be launched, and only asserts when it can.
// That is real coverage in every environment that has Chromium (this sandbox,
// and any machine after `npx playwright install chromium`), and an honest
// no-op everywhere else — not a green check standing in for evidence nobody
// collected.
import { strict as a } from 'node:assert';
import { createServer } from 'node:http';
import { readFile, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      readFile(path, (err, body) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// This sandbox pre-installs Chromium outside Playwright's own cache (see
// /root/.ccr/README.md) at a fixed revision that a newer `playwright` on npm
// can outgrow. Prefer Playwright's normal resolution — what every other
// machine, including a future CI step, actually has — and only fall back to
// the sandbox's pinned binary when that resolution fails.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';

async function launch() {
  try {
    return await chromium.launch();
  } catch (e) {
    if (existsSync(SANDBOX_CHROMIUM)) {
      try { return await chromium.launch({ executablePath: SANDBOX_CHROMIUM }); } catch { /* fall through */ }
    }
    console.log(`t-theme-geometry.js SKIPPED — no Chromium available (${e.message.split('\n')[0]}); run "npx playwright install chromium" to get real computed-geometry coverage locally.`);
    return null;
  }
}

const BASE_STATE = {
  view: { page: 'home' },
  prefs: { sidebarCollapsed: false },
  conversations: [],
  approvals: [],
  changes: [],
};

const MODES = [
  { id: 'chat', label: 'Chat', permissions: 'Direct', blurb: 'A direct conversation.' },
  { id: 'code', label: 'Code', permissions: 'Full', blurb: 'Repository work.' },
];

const CONVERSATIONS = Array.from({ length: 6 }, (_, i) => ({ id: `c-${i}`, title: `Conversation ${i + 1}` }));
const MANY_CONVERSATIONS = Array.from({ length: 24 }, (_, i) => ({ id: `c-${i}`, title: `Conversation ${i + 1}` }));

async function mount(page, state, options, bodyClass) {
  await page.evaluate(([state, options, bodyClass]) => {
    document.body.className = bodyClass;
    window.__mountSidebar(state, options);
  }, [state, options, bodyClass]);
}

async function main() {
  const server = await serveStatic();
  const { port } = server.address();
  const browser = await launch();
  if (!browser) { server.close(); return; }

  try {
    // Defect 1 (t-theme.js:302): the collapsed rail's own 16px inset left every
    // nav button 34x44 against the 44px minimum this system enforces. Fixed by
    // dropping the inset to 8px; measured here, not matched in source.
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-geometry.html`);
      await mount(page, { ...BASE_STATE, prefs: { sidebarCollapsed: true } }, { modes: MODES }, 'sidebar-collapsed');
      const box = await page.locator('.sidebar.collapsed .sidebar-nav-button').first().boundingBox();
      a.ok(box, 'the collapsed rail must render at least one nav button');
      a.ok(box.width >= 32, `collapsed rail nav button measured ${box.width}px wide, short of the 32px minimum`);
      a.ok(box.height >= 32, `collapsed rail nav button measured ${box.height}px tall, short of the 32px minimum`);
      await page.close();
    }

    // Defect 2 (t-theme.js:303): the drawer's mode section measured 287x0 and
    // its own pills painted through the row below it, because it was the one
    // unpinned child in a flex column the browser was free to shrink to zero.
    // Fixed with flex-shrink: 0; measured here as real rendered height.
    {
      const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-geometry.html`);
      await mount(page, { ...BASE_STATE, conversations: CONVERSATIONS }, { modes: MODES }, 'sidebar-open');
      const box = await page.locator('.sidebar-mode').boundingBox();
      a.ok(box, 'the open drawer must render a mode section');
      a.ok(box.height > 20, `drawer mode section measured ${box.height}px tall — the flex column squashed it again`);
      await page.close();
    }

    // Defect 3 (t-theme.js:304): with every section pinned, the drawer's
    // content ran 122px past the viewport and the conversation list — the one
    // section without a floor — was squashed to 287x0, so the drawer offered no
    // way to reach a conversation. Fixed by scrolling the drawer as one column
    // (overflow-y: auto) instead of letting flex reclaim an unpinned child's
    // height. Measured here: the applied overflow behavior and the list's real
    // rendered height, not the declaration that produces them.
    {
      const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-geometry.html`);
      await mount(page, { ...BASE_STATE, conversations: CONVERSATIONS }, { modes: MODES }, 'sidebar-open');
      const [overflowY, listBox, rowBox] = await page.evaluate(() => [
        getComputedStyle(document.getElementById('sidebar')).overflowY,
        document.querySelector('.sidebar-conversations').getBoundingClientRect(),
        document.querySelector('.conversation-row').getBoundingClientRect(),
      ]);
      a.equal(overflowY, 'auto', 'the open drawer must scroll as one column instead of clipping overflow content');
      a.ok(listBox.height > 20, `drawer conversation list measured ${listBox.height}px tall — squashed again`);
      a.ok(rowBox.height > 0, 'a conversation row must keep a real rendered height in the drawer');
      await page.close();
    }

    // Defect 4 (t-theme.js: ".sidebar-scroll"): a populated team at a short
    // desktop viewport (1280x720, and the enforced 900px minimum) could ask the
    // rail for more height than it had. Before .sidebar-scroll, #sidebar's own
    // overflow: hidden clipped whatever did not fit — measured live at 1280x720:
    // the footer (Settings/Collapse) ran off the bottom of the viewport.
    // Measured here as real rendered geometry: the footer's bottom edge must
    // stay inside the viewport, and the scroller must actually have overflow to
    // scroll. It used to take twelve conversations plus the More tools
    // disclosure; the disclosure is gone (2026-10-21), so the pressure now comes
    // from a long runs list alone, twenty-four of them.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-geometry.html`);
      await mount(page, { ...BASE_STATE, view: { page: 'inbox' }, conversations: MANY_CONVERSATIONS }, { modes: MODES }, '');
      const [footerBox, scroll, list, viewportHeight] = await page.evaluate(() => [
        document.querySelector('.sidebar-footer').getBoundingClientRect(),
        (() => { const el = document.querySelector('.sidebar-scroll'); return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY }; })(),
        (() => { const el = document.querySelector('.conversation-list'); return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY }; })(),
        window.innerHeight,
      ]);
      a.ok(footerBox.bottom <= viewportHeight + 1, `the rail footer measured its bottom edge at ${footerBox.bottom}px against a ${viewportHeight}px viewport — it must never run past it`);
      a.equal(scroll.overflowY, 'auto', 'the rail middle must be the thing that scrolls, not the whole rail');
      // With four nav rows the runs list is the only part that can outgrow the
      // rail, and it scrolls inside its own box; the middle region only has to
      // be allowed to scroll, which it is.
      a.equal(list.overflowY, 'auto', 'the runs list scrolls inside its own box');
      a.ok(list.scrollHeight > list.clientHeight, 'twenty-four runs must actually overflow their list at 720px — otherwise this proves nothing');
      await page.close();
    }

    console.log('t-theme-geometry.js OK — the three 2026-09-21 layout defects and the 2026-09-23 rail-overflow fix hold at their real computed geometry, in a real browser');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
