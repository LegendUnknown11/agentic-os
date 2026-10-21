import { strict as a } from 'node:assert';

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.options = [];
    this.className = '';
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.listeners = {};
    this.nodeType = 1;
    this.classList = { add: (name) => { this.className = [this.className, name].filter(Boolean).join(' '); } };
  }

  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text ?? this.children.map((child) => child.textContent).join(''); }
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
      if (this.tagName === 'SELECT' && child.tagName === 'OPTION') this.options.push(child);
    }
  }
  insertBefore(child, before) {
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.append(child);
    else this.children.splice(index, 0, child);
  }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== listener); }
  dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener(event); }
  closest(selector) {
    let current = this;
    while (current) {
      if (selector === '[data-action]' && current.dataset.action) return current;
      if (selector === '[data-approval-id]' && current.dataset.approvalId) return current;
      if (selector === '.thread-composer' && current.className === 'thread-composer') return current;
      current = current.parentNode;
    }
    return null;
  }
  matches(selector) { return selector === '.thread-composer' && this.className === 'thread-composer'; }
  contains(target) { return target === this || this.children.some((child) => child?.contains?.(target)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const visit = (child) => {
      if (!child) return;
      if (selector === '.thread-input' && child.className === 'thread-input') found.push(child);
      if (selector === '.thread-composer' && child.className === 'thread-composer') found.push(child);
      if (selector === '.skill-menu' && child.className === 'skill-menu') found.push(child);
      if (selector === '[data-question-other]' && child.dataset.questionOther !== undefined) found.push(child);
      if (selector === 'button' && child.tagName === 'BUTTON') found.push(child);
      for (const nested of child.children ?? []) visit(nested);
    };
    visit(this);
    return found;
  }
  focus() { globalThis.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}

class FakeAudio {
  constructor() { this.paused = true; this.duration = 0; this.currentTime = 0; this.src = ''; }
  addEventListener() {}
  removeEventListener() {}
  play() { return Promise.resolve(); }
  pause() {}
  removeAttribute() {}
  load() {}
}

globalThis.Audio = FakeAudio;
// createElementNS and createTextNode exist because the session inspector (ui/inspector.js) draws
// SVG icons and composes with views/util's h(); both are DOM calls the fake must answer.
globalThis.document = {
  activeElement: null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
};
globalThis.FormData = class {
  constructor(form) { this.form = form; }
  get(name) { return name === 'text' ? this.form.querySelector('.thread-input')?.value ?? null : null; }
};

const { state, apply, resetForTest, setView } = await import('../ui/store.js');
const { entriesFor, mountThread } = await import('../ui/thread.js');

// store.js's schedule() falls back to setTimeout(notify, 0) when requestAnimationFrame
// is unavailable (true in this Node test environment) — a microtask flush resolves
// before that macrotask fires, so this must wait one tier further out.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

resetForTest();
state.members.set('orchestrator', { name: 'orchestrator', role: 'orchestrator' });
state.members.set('coder', { name: 'coder', role: 'agent', added: true });
state.conversations = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }];
state.view = { page: 'thread', member: 'orchestrator', conversation: 'a' };
state.ready = true;
state.approvals = [
  { id: 7, kind: 'question', questions: [{ header: 'Direction', options: [{ label: 'Keep going' }] }] },
  { id: 8, kind: 'add', names: ['coder'], reason: 'Need help' },
];
state.log.set('orchestrator', [{ id: 1, kind: 'text', payload: { text: 'event with id one' }, conversation_id: 'a', ts: 1 }]);
state.messages = [{ id: 1, sender: 'user', recipient: 'orchestrator', body: 'message with id one', conversation_id: 'a', ts: 2 }];
a.deepEqual(entriesFor(state, 'orchestrator', 'a').map((entry) => entry.text), ['event with id one', 'message with id one'],
  'event and message tables must not collide when their independent IDs match');

const root = new FakeElement('main');
const composer = new FakeElement('div');
const stop = mountThread(root, { state, composer, post: async (action) => {
  if (action === 'reject' || action === 'wake') throw new Error('daemon unavailable');
  return { ok: true };
}, toast: (message, error) => { state.lastToast = { message, error }; } });

// Rendering-level coverage for workContext()'s header fact — a raw "N/M"
// fraction named nothing was cryptic (issue #39/#48). Neither fixture member
// above is awake, so this must read "Team 0/2 awake", not a bare "0/2".
const findByClass = (node, cls) => {
  if (node.className === cls) return node;
  for (const child of node.children ?? []) { const found = findByClass(child, cls); if (found) return found; }
  return null;
};
const subtitle = findByClass(root, 'thread-subtitle');
a.ok(subtitle, 'the thread header must render a work-context subtitle');
a.match(subtitle.textContent, /Team 0\/2 awake/, 'the header awake-count fact must name what it counts, not read as a bare fraction');

let field = composer.querySelector('.thread-input');
field.value = 'draft A';
field.focus();
field.setSelectionRange(2, 5);
let other = root.querySelector('[data-question-other]');
a.ok(other, 'the inline question should render its custom answer field');
other.value = 'Keep the current direction';
apply({ type: 'goal', text: 'Keep this draft while the team updates.' });
await flush();
field = composer.querySelector('.thread-input');
a.equal(field.value, 'draft A', 'a store rerender must preserve an unsent draft');
a.equal(field.selectionStart, 2);
a.equal(field.selectionEnd, 5);
a.equal(globalThis.document.activeElement, field);
other = root.querySelector('[data-question-other]');
a.equal(other.value, 'Keep the current direction', 'a live rerender must preserve a typed custom question answer');

setView({ member: 'coder', conversation: 'b' });
await flush();
field = composer.querySelector('.thread-input');
a.equal(field.value, '', 'a draft must not leak into another conversation');
field.value = 'draft B';

setView({ member: 'orchestrator', conversation: 'a' });
await flush();
field = composer.querySelector('.thread-input');
a.equal(field.value, 'draft A', 'returning to A must restore A\'s draft');
a.equal(field.selectionStart, 2);
a.equal(field.selectionEnd, 5);

setView({ member: 'coder', conversation: 'b' });
await flush();
a.equal(composer.querySelector('.thread-input').value, 'draft B', 'B keeps its own draft');

setView({ member: 'orchestrator', conversation: 'a' });
await flush();
const reject = root.querySelectorAll('button').find((button) => button.dataset.action === 'reject');
a.ok(reject, 'the approval should expose a reject action');
root.dispatchEvent({ type: 'click', target: reject });
await flush();
a.equal(reject.disabled, false, 'a rejected approval request must re-enable its action');
a.equal(state.lastToast?.message, 'daemon unavailable');

setView({ member: 'coder', conversation: 'b' });
await flush();
const wake = root.querySelectorAll('button').find((button) => button.dataset.action === 'wake');
a.ok(wake, 'a member thread should expose a wake action');
root.dispatchEvent({ type: 'click', target: wake });
await new Promise((resolve) => setTimeout(resolve, 0));
a.equal(wake.disabled, false, 'a rejected wake request must re-enable its action');
a.equal(state.lastToast?.message, 'daemon unavailable');

stop();

let resolveSend;
const send = new Promise((resolve) => { resolveSend = resolve; });
setView({ member: 'orchestrator', conversation: 'a' });
await flush();
const staleRoot = new FakeElement('main');
const staleComposer = new FakeElement('div');
const staleStop = mountThread(staleRoot, { state, composer: staleComposer, post: (action) =>
  action === 'command' ? send : Promise.resolve({ ok: true }) });
let staleForm = staleComposer.querySelector('.thread-composer');
staleComposer.querySelector('.thread-input').value = 'draft from A';
staleComposer.dispatchEvent({ type: 'submit', target: staleForm, preventDefault() {} });
await flush();
setView({ member: 'coder', conversation: 'b' });
await flush();
staleComposer.querySelector('.thread-input').value = 'draft from B';
resolveSend({ ok: true });
await flush();
a.equal(staleComposer.querySelector('.thread-input').value, 'draft from B',
  'a stale send completion must not rerender and erase the active thread draft');
staleStop();
console.log('t-thread.js OK — drafts survive rerenders and stay isolated per conversation');
