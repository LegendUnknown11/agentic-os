// Panel teardown: whichever way a panel dies, its cleanup runs.
//
// This is the first test that drives the renderer at all. It exists because the
// leak it catches was invisible to every other kind of review: close(id) removed
// the element and told the rail, and the caller was trusted to run onClose
// afterwards. Two of the five ways a panel closes did that. Escape did not,
// closeAll() did not, and the rail did not — so the Metrics panel kept a 5s
// poller and Approvals a 6s poller running against detached DOM for the life of
// the page, and the music panel's ~4Hz subscription could not be released at
// all, because its own onClose looked the window up AFTER close() had dropped it.
//
// A fake DOM, not jsdom: win.js touches createElement, one innerHTML template,
// querySelector by class, and ResizeObserver. That is small enough to stand up
// in a few dozen lines and not worth a dependency.
//
//   node test/t-win.js
import { strict as a } from 'node:assert';

/* ---------- the smallest DOM that win.js can run on ---------- */
const el = (tag) => {
  const node = {
    tagName: tag, className: '', dataset: {}, children: [], parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, setAttributeNS() {},
    style: { setProperty() {}, get cssText() { return ''; }, set cssText(_) {} },
    textContent: '',
    offsetWidth: 620, offsetHeight: 440, offsetLeft: 0, offsetTop: 0,
    listeners: {},
    append(...kids) { for (const k of kids) { k.parentNode = node; node.children.push(k); } },
    prepend(k) { k.parentNode = node; node.children.unshift(k); },
    remove() {
      const p = node.parentNode;
      if (p) p.children.splice(p.children.indexOf(node), 1);
      node.parentNode = null;
      node.removed = true;
    },
    addEventListener(t, fn) { (node.listeners[t] ??= []).push(fn); },
    removeEventListener(t, fn) {
      node.listeners[t] = (node.listeners[t] ?? []).filter((f) => f !== fn);
    },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800 }),
    // Only shape win.js actually writes: <div class="bar">…<span class="x"></span></div>
    set innerHTML(html) {
      node.children = [];
      for (const [, tag2, cls] of html.matchAll(/<(\w+)(?:\s+class="([^"]*)")?[^>]*>/g)) {
        const kid = el(tag2);
        kid.className = cls ?? '';
        // The template nests title/stat/slot inside .bar; flatten and let
        // querySelector search the whole subtree, which is all win.js needs.
        node.append(kid);
      }
    },
    querySelector(sel) {
      const hit = (n) => (sel.startsWith('.') ? n.className.split(/\s+/).includes(sel.slice(1))
        : n.tagName === sel);
      const walk = (n) => {
        for (const k of n.children) { if (hit(k)) return k; const d = walk(k); if (d) return d; }
        return null;
      };
      return walk(node);
    },
  };
  return node;
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.document = {
  createElement: el,
  createElementNS: (_ns, tag) => Object.assign(el(tag), { setAttribute() {} }),
};
// Records observers so the test can prove close() releases them.
const observers = [];
globalThis.ResizeObserver = class {
  constructor(fn) { this.fn = fn; this.live = true; observers.push(this); }
  observe() {}
  disconnect() { this.live = false; }
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const C = await import('../ui/canvas.js');
const W = await import('../ui/win.js');

C.initCanvas(el('div'));
W.setHost(el('div'));

/* ---------- every way a panel can die ---------- */
// The point of the list: it is the WAYS, not one way with four names. Escape
// and the rail call W.close() directly and never went through the X button.
const ways = {
  'the X button': (id) => W.getWindow(id).querySelector('.x').onclick(),
  'Escape / the rail (close() directly)': (id) => W.close(id),
  'toggle()': (id) => W.toggle(id),
  'closeAll()': () => W.closeAll(),
};

for (const [how, kill] of Object.entries(ways)) {
  const id = `panel-${how.length}`;
  let closed = 0;
  W.open(id, { title: 'x', onClose: () => closed++ });
  const ro = observers.at(-1);
  a.equal(ro.live, true, 'the panel observes its own size while open');

  kill(id);

  a.equal(closed, 1, `onClose must run exactly once when closed via ${how}`);
  a.equal(W.isOpen(id), false, `and the panel must be gone after ${how}`);
  a.equal(ro.live, false, `the ResizeObserver must be released by ${how}`);
  console.log(`  ${how}: cleanup ran, observer released`);
}

/* ---------- cleanup registered by the panel's own build() ---------- */
// The music panel's case. Its subscription is created inside build(), and the
// only way to reach it from outside was through getWindow(id) — which close()
// had already emptied, so the optional chain silently no-oped over a live ~4Hz
// callback that pinned the whole detached subtree.
{
  let released = false;
  W.open('music-ish', {
    title: 'x',
    build: () => W.onTeardown('music-ish', () => { released = true; }),
  });
  W.close('music-ish');
  a.equal(released, true,
    'cleanup registered from inside build() must run — reaching it via getWindow() after '
    + 'close() cannot work, because close() has already dropped the window');
  console.log('  build()-registered cleanup runs too');
}

/* ---------- closing twice is not closing twice ---------- */
{
  let closed = 0;
  W.open('once', { title: 'x', onClose: () => closed++ });
  W.close('once');
  W.close('once');
  a.equal(closed, 1, 'a second close must be a no-op, not a second teardown');
}

/* ---------- a throwing cleanup does not strand the others ---------- */
{
  let after = false;
  W.open('rude', {
    title: 'x',
    build: () => {
      W.onTeardown('rude', () => { throw new Error('cleanup blew up'); });
      W.onTeardown('rude', () => { after = true; });
    },
  });
  const err = console.error;
  console.error = () => {};   // the throw below is the point; its stack is not
  W.close('rude');
  console.error = err;
  a.equal(after, true, 'one bad cleanup must not stop the rest — that is the leak again');
}

console.log('t-win.js OK — every close path tears down, observers released, build() cleanup reachable');
