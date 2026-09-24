import { get, post, subscribe, state, setView as storeSetView, money } from '../store.js';
import { mdToHtml } from '../markdown.js';
import { displayName } from '../names.js';

export { get, post, subscribe, mdToHtml, displayName, money };

// Store the route and notify the shell. The hash is the main router's durable
// address; without it a button would repaint the current page and be lost on
// reload.
export function setView(view) {
  const value = typeof view === 'object' && view ? view : { page: view };
  const page = String(value.page ?? 'home');
  const member = value.member ?? state.view?.member ?? 'orchestrator';
  const memberConversation = state.members?.get?.(member)?.conversationId;
  const conversation = value.conversation ?? (value.member ? memberConversation : state.view?.conversation ?? memberConversation) ?? 'default';
  const next = page === 'thread'
    ? ['thread', encodeURIComponent(member), encodeURIComponent(conversation)].join('/')
    : page;
  storeSetView(page === 'thread' ? { ...value, page, member, conversation } : view);
  if (typeof location !== 'undefined' && location.hash.slice(1) !== next) location.hash = next;
}

export const esc = (value) => String(value ?? '');

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key in node && !key.startsWith('aria-') && !key.startsWith('data-')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Draw one tooltip for every current and future [data-tip] control. */
export function attachHoverTips(root) {
  const tip = h('div', { class: 'hover-tip' });
  tip.id = 'ui-hover-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  root.append(tip);
  let active = null;

  const targetOf = (value) => value?.closest?.('[data-tip]');
  const hide = () => {
    active?.removeAttribute('aria-describedby');
    active = null;
    tip.hidden = true;
  };
  const show = (target) => {
    const text = target?.dataset?.tip;
    if (!text) return hide();
    active?.removeAttribute('aria-describedby');
    active = target;
    tip.textContent = text;
    tip.hidden = false;
    target.setAttribute('aria-describedby', tip.id);
    const rect = target.getBoundingClientRect();
    const viewportWidth = globalThis.innerWidth ?? globalThis.window?.innerWidth ?? 0;
    const viewportHeight = globalThis.innerHeight ?? globalThis.window?.innerHeight ?? 0;
    tip.style.left = `${Math.max(8, Math.min(rect.right + 8, viewportWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(rect.top, viewportHeight - tip.offsetHeight - 8))}px`;
  };
  const onOver = (event) => {
    const target = targetOf(event.target);
    if (target && !target.contains(event.relatedTarget)) show(target);
  };
  const onOut = (event) => {
    const target = targetOf(event.target);
    if (target && !target.contains(event.relatedTarget)) hide();
  };
  const onFocusIn = (event) => show(targetOf(event.target));
  const onFocusOut = (event) => {
    const target = targetOf(event.target);
    if (target && !target.contains(event.relatedTarget)) hide();
  };
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  globalThis.addEventListener?.('resize', hide);
  root.addEventListener('scroll', hide, true);
  return () => {
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerout', onOut);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    globalThis.removeEventListener?.('resize', hide);
    root.removeEventListener('scroll', hide, true);
    tip.remove();
  };
}

export const clear = (root) => { root.replaceChildren(); return root; };
export const editing = (root) => {
  const active = globalThis.document?.activeElement;
  return Boolean(active && root.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
};
export const page = (title, description = '') => h('div', { class: 'view-page' },
  h('div', { class: 'view-heading' }, h('h1', { text: title }), description && h('p', { class: 'view-description', text: description })));
export const section = (title, ...children) => h('section', { class: 'view-section' }, h('h2', { text: title }), ...children);

// One status vocabulary for every domain that reads as "how is this going":
// run status, task state, member state (fed from displayStatus() and
// statusLabel()), doctor check, merge result, activity kind. Four tones only —
// live (accent), attention (danger), settled (ok), idle (faint) — because a
// status word means the same thing everywhere it appears; before this, the
// same word (e.g. "ready_for_review") could read as accent in one card and ok
// in another. A status this doesn't recognise gets no tone class, not a
// guessed one — activity kinds like "summary" or "message" are meant to stay
// neutral, not read as "live".
const TONE_LIVE = new Set(['running', 'active', 'working', 'busy', 'verifying', 'requested', 'implemented',
  'reading', 'editing', 'searching', 'delegating', 'thinking', 'speaking', 'messaging', 'briefing',
  'consulting', 'recording', 'catching up', 'reviewing', 'proposing', 'rejecting', 'finishing',
  'assigning', 'summoning', 'coordinating']);
const TONE_SETTLED = new Set(['done', 'completed', 'verified', 'merged', 'dropped', 'ready_for_review', 'ok',
  // An approval's resolution is the same question in another domain. "answered"
  // settles a question; "approved" settles a request. "rejected" is a decision,
  // not a fault, but it is the branch that stops work, so it reads as attention
  // for the same reason "blocked" does.
  'approved', 'answered']);
const TONE_IDLE = new Set(['idle', 'pending', 'planning', 'paused', 'awake', 'resting', 'off']);
const TONE_ATTENTION = new Set(['blocked', 'failed', 'rate limited', 'error', 'cancelled', 'warn', 'fail', 'rejected']);
export function tone(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (TONE_ATTENTION.has(value)) return 'attention';
  if (TONE_SETTLED.has(value)) return 'settled';
  if (TONE_IDLE.has(value)) return 'idle';
  if (TONE_LIVE.has(value)) return 'live';
  return '';
}
export const empty = (text) => h('p', { class: 'empty', text });
export const note = (text, cls = '') => h('p', { class: `note ${cls}`, text });
// Primary buttons carry Editorial's pill-plus-circular-arrow shape; every
// other variant stays a plain label — see .button.primary in app.css.
export const button = (label, action, cls = '') => h(
  'button', { class: `button ${cls}`.trim(), type: 'button', on: { click: action } },
  label,
  cls.split(' ').includes('primary') && h('span', { class: 'button-icon', 'aria-hidden': 'true' }, '→'),
);

export function field(label, control, hint = '') {
  const variant = control?.type === 'checkbox' ? ' field-check' : '';
  return h('label', { class: `field${variant}` }, h('span', { class: 'field-label', text: label }), hint && h('small', { text: hint }), control);
}

export const input = (value = '', placeholder = '') => h('input', { value, placeholder, autocomplete: 'off' });
export const textarea = (value = '', placeholder = '') => h('textarea', { value, placeholder, spellcheck: false });
export const select = (items, value) => {
  const node = h('select');
  for (const item of items) {
    const [v, label] = Array.isArray(item) ? item : [item, item];
    node.append(h('option', { value: v, text: label }));
  }
  if (value != null) node.value = value;
  return node;
};

export const check = (value = false) => h('input', { type: 'checkbox', checked: value });
export const meter = (value, label = '') => {
  const current = Math.max(0, Math.min(100, Number(value) || 0));
  return h('div', { class: 'meter-wrap' }, label && h('span', { text: label }),
    h('div', { class: 'meter', role: 'progressbar', 'aria-label': label || 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(current)) },
      h('i', { style: { width: `${current}%` } })));
};
export const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));

// #45: "it just says Opus Sonnet, not the model number at all" — a member
// configured with the claude CLI's own short aliases ("opus", "sonnet",
// "haiku", "fable") or a bare model id showed up in every selector with no
// version number, so two generations of the same family were indistinguishable
// on screen. This is presentation only: the alias/id keeps being sent to the
// CLI unchanged (agent.js), and an id this table does not know is shown as-is
// rather than guessed at — an unlabeled model must never be hidden.
//
// The bare aliases are the one place a version is inferred rather than read:
// the CLI resolves them itself. Their labels record what each alias resolved
// to as of 2026-09-23, confirmed by the repository owner for #45 — opus is
// Opus 5.5, sonnet Sonnet 5, haiku Haiku 4.5, fable Fable 5.1. src/price.js
// bills each alias at that same model's rate; when the CLI moves an alias,
// change both tables together (t-pages.js and price.js's self-check pin them).
const MODEL_LABELS = {
  opus: 'Opus 5.5', // the CLI's `opus` alias resolves to Opus 5.5 (#75)
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
  fable: 'Fable 5.1',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-fable-5-1': 'Fable 5.1',
};
export const modelLabel = (model) => (model ? MODEL_LABELS[model] ?? model : model);
export const date = (ts) => ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export const membersOf = (state) => state.members instanceof Map ? [...state.members.entries()] : Object.entries(state.members ?? {}).map(([name, member]) => [name, member]);
export const modeDef = (state) => state.modeDef ?? state.modeInfo ?? state.modes?.[state.mode] ?? { crew: 'all', worktrees: true, merge: true, tasks: true };
export const modeAllows = (state, capability) => {
  const mode = modeDef(state);
  if (capability === 'crew') return mode.crew === 'all' || (mode.crew?.length ?? 0) > 0;
  if (capability === 'worktrees') return mode.worktrees !== false;
  if (capability === 'merge') return mode.merge !== false;
  if (capability === 'tasks') return mode.tasks !== false;
  if (capability === 'workflows') return mode.workflows === true;
  return true;
};
/** A failed API result's error, or null when it did not fail. */
export const apiError = (result, fallback) => result?.ok === false ? result.error ?? fallback : null;
/** Bump and return a view's request token, so a stale response can tell it lost. */
export const requestToken = (state, key) => { state[key] = (state[key] ?? 0) + 1; return state[key]; };
export function spendText(spend) {
  if (spend == null) return '';
  if (typeof spend === 'number') return money(spend);
  const amount = Number(spend.total ?? spend.spent ?? spend.costUsd);
  if (!Number.isFinite(amount)) return String(spend.text ?? '');
  return money(amount);
}
// #41: turns are counted court-wide and shown beside the existing spend
// total (state.spend already carries `turns` from every 'spend' event, and
// `turnBudget` from the session's cap) — nothing to show before the first
// real turn, and no "/0" once a budget exists but nothing has run yet.
export function turnsText(spend) {
  const turns = Number(spend?.turns ?? 0);
  if (!turns) return '';
  const cap = Number(spend?.turnBudget ?? 0);
  return cap ? `${turns}/${cap} turns` : `${turns} turns`;
}
/** What a mode permits, in its own flags — the header/drawer mode control's subtitle. */
export const modePermissionText = (mode) => !mode ? '' : [
  mode.crew === 'all' ? 'full crew' : mode.crew?.length ? `${mode.crew.length}-person crew` : 'no crew',
  mode.worktrees && 'worktrees', mode.merge && 'merge', mode.tasks && 'tasks',
].filter(Boolean).join(' · ');

export async function load(state, key, url, render) {
  const result = await get(url);
  if (result?.ok !== false) state[key] = result;
  render?.(state);
  return result;
}

export function bind(state, root, render) {
  const off = subscribe(() => render(state, root));
  return () => off?.();
}

export function error(root, message = 'The team is not answering.') {
  root.replaceChildren(empty(message));
}
