import { apply, get, post, setPrefs, setView, state, subscribe } from './store.js';
import { modeOf } from '/modes.js';
import { attachHoverTips, modePermissionText } from './views/util.js';
import * as Assets from './assets.js';
import * as Notify from './notify.js';

// The public and backend vocabulary are the same three choices.
export const USER_MODES = Object.freeze([
  Object.freeze({ id: 'chat', backend: 'chat', label: 'Chat', blurb: 'Start a direct conversation with Agentic OS.', action: 'Talk directly; no delegation or task list.' }),
  Object.freeze({ id: 'cowork', backend: 'cowork', label: 'Cowork', blurb: 'Delegate multi-step workspace work to your team.', action: 'Describe the outcome; Agentic OS plans and coordinates.' }),
  Object.freeze({ id: 'code', backend: 'code', label: 'Code', blurb: 'Change a repository with tests and review.', action: 'Work in isolation, then review what is ready to merge.' }),
]);

const USER_MODE_BY_ID = new Map(USER_MODES.map((mode) => [mode.id, mode]));
export const userModeOf = (backend) => USER_MODES.find((mode) => mode.backend === backend)?.id ?? 'cowork';
const backendModeOf = (id) => USER_MODE_BY_ID.get(id)?.backend;

let mountSidebar;
let mountThread;
let viewFor;
let uiReady;
const loadUI = () => uiReady ??= Promise.all([
  import('./sidebar.js'), import('./thread.js'), import('./views/index.js'),
]).then(([sidebar, thread, views]) => {
  mountSidebar = sidebar.mountSidebar;
  mountThread = thread.mountThread;
  viewFor = views.viewFor;
});

const $ = (id) => document.getElementById(id);
const VIEWS = new Set(['home', 'thread', 'approvals', 'changes', 'usage', 'activity', 'messages', 'agents', 'objective', 'memory', 'notes', 'automations', 'doctor', 'settings']);
const KEYS = { a: 'approvals', d: 'changes', m: 'usage', c: 'activity', b: 'messages', e: 'agents', g: 'objective', r: 'memory', v: 'notes', f: 'automations' };
const decodePart = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};
function routeOf() {
  const parts = location.hash.slice(1).replace(/^\/+/, '').split('/');
  const page = decodePart(parts.shift() ?? '');
  if (page.startsWith('agent:')) return {
    page: 'thread', member: decodePart(page.slice(6)), conversation: decodePart(parts.join('/') || 'default'),
  };
  if (page === 'thread') return {
    page,
    member: decodePart(parts.shift() || 'orchestrator'),
    conversation: decodePart(parts.join('/') || 'default'),
  };
  return { page: VIEWS.has(page) ? page : 'home' };
}
const viewName = () => routeOf().page;
function routeFor(view) {
  const value = typeof view === 'object' && view ? view : { page: view };
  const page = String(value.page || 'home').replace(/^#?\/?/, '');
  if (page !== 'thread') return page;
  return ['thread', encodeURIComponent(value.member ?? state.view?.member ?? 'orchestrator'),
    encodeURIComponent(value.conversation ?? state.view?.conversation ?? 'default')].join('/');
}

let source = null;
let reconnect = null;
let connectionAttempt = 0;
let currentCleanup = () => {};
let booted = false;
let bootFailed = false;
let modeNotice = '';
// Counts every applied stream event, so an in-flight async probe (see
// maybeOpenDoctor) can tell whether the moment it started in still holds by
// the time it resolves, the same staleness check connectionAttempt already
// gives a reconnect.
let eventsApplied = 0;
let modeRequest = 0;
let mountSequence = 0;
let doctorProbe = false;
let toastTimer = null;
let noteRequest = 0;
let listsRequest = null;
let connectedConversation = null;

function connection(value) {
  state.conn = value;
  // Connection changes are UI state, not stream events, but they still share
  // the same render notification path.
  apply({ type: '__connection__' });
}

function toast(message, danger = false) {
  const host = $('toast');
  if (!host) return;
  clearTimeout(toastTimer);
  const item = document.createElement('div');
  if (danger) item.className = 'danger';
  item.textContent = String(message ?? 'Something went wrong.');
  host.replaceChildren(item);
  toastTimer = setTimeout(() => {
    if (host.contains(item)) host.replaceChildren();
    toastTimer = null;
  }, 5000);
}

function openVaultNote(path) {
  const notePath = String(path ?? '').trim();
  if (!notePath) return;
  const request = ++noteRequest;
  state.notesDetail = { path: notePath, loading: true, request };
  setView('notes');
  navigate('notes');
  get(`/api/vault?path=${encodeURIComponent(notePath)}`).then((detail) => {
    if (request !== noteRequest || state.notesDetail?.path !== notePath || state.notesDetail?.request !== request) return;
    const error = detail?.ok === false ? detail.error ?? 'Could not read note.' : null;
    state.notesDetail = error
      ? { path: notePath, error }
      : { path: detail?.path ?? notePath, body: detail?.body ?? '' };
    apply({ type: '__note__' });
  });
}

function onDocumentClick(event) {
  const target = event.target?.closest?.('.vault-link');
  if (!target) return;
  event.preventDefault();
  openVaultNote(target.dataset.vault);
}

function streamConversation() {
  const view = state.view ?? {};
  if (view.page !== 'thread' || view.member !== 'orchestrator') return null;
  const conversation = view.conversation ?? view.conversationId;
  return conversation == null ? null : String(conversation);
}

function syncStreamScope() {
  if (streamConversation() !== connectedConversation) connect();
}

function connect() {
  if (bootFailed) return;
  if (reconnect) clearTimeout(reconnect);
  reconnect = null;
  const attempt = ++connectionAttempt;
  if (source) source.close();
  const conversation = streamConversation();
  const scopeChanged = conversation !== connectedConversation;
  connectedConversation = conversation;
  const params = new URLSearchParams();
  // A different conversation needs its retained transcript, not a global
  // cursor that could be newer than every row in that branch.
  if (!scopeChanged && state.cursor) params.set('since', String(state.cursor));
  if (conversation != null) params.set('conversation', conversation);
  const query = params.size ? `?${params}` : '';
  source = new EventSource(`/stream${query}`);
  connection('connecting');
  // ponytail: diagnostic only, for the CI-only t-electron.js run-lifecycle
  // timeout — remove once root-caused. Distinguishes "no event ever arrived"
  // from "an event arrived but the repaint didn't reflect it".
  console.log('[sse] connect() attempt', attempt, 'query', query || '(none)');
  source.onopen = () => {
    if (attempt !== connectionAttempt) return;
    console.log('[sse] onopen, readyState', source.readyState);
    connection('up');
  };
  source.onmessage = (message) => {
    if (attempt !== connectionAttempt) return;
    try {
      const event = JSON.parse(message.data);
      console.log('[sse] message type', event.type);
      const firstSnapshot = event.type === 'snapshot' && !state.ready;
      // The advisor can flip the court's mode on its own reading of one plain
      // message (Kingdom#queueMode, by: 'advisor') — Chat becomes Cowork or
      // Code with no sovereign click on the mode switcher at all. That is how
      // "I thought it was only one prompt" turns into unexplained delegation:
      // the header text updated, but nothing said why or that it wasn't the
      // sovereign's own choice. A mode change the sovereign clicked already
      // gets its own notice from chooseMode(); this covers every other one.
      if (event.type === 'mode' && event.by && event.by !== 'sovereign') {
        const target = event.pending ?? event.mode;
        const label = USER_MODE_BY_ID.get(userModeOf(target))?.label ?? target;
        const reason = event.why ? ` — ${event.why}` : '';
        modeNotice = event.pending
          ? `Agentic OS will switch to ${label} mode once the court is idle${reason}.`
          : `Agentic OS switched to ${label} mode${reason}.`;
        toast(modeNotice);
      }
      apply(event);
      eventsApplied += 1;
      Notify.onEvent(event);
      state.modeDef = modeOf(state.mode);
      void maybeOpenDoctor(firstSnapshot);
      if (event.type === 'snapshot') get('/api/conversations').then((data) => {
        if (attempt !== connectionAttempt || bootFailed) return;
        if (data?.ok !== false) apply({ type: 'conversations', conversations: data.conversations ?? [], active: data.active });
      });
    }
    catch (err) { console.error('dropped malformed stream event', err, message.data); }
  };
  source.onerror = () => {
    if (attempt !== connectionAttempt) return;
    console.log('[sse] onerror, readyState', source?.readyState);
    connection('down');
    source?.close();
    source = null;
    if (!reconnect) reconnect = setTimeout(() => { reconnect = null; connect(); }, 1000);
  };
}

async function refreshLists() {
  if (listsRequest) return listsRequest;
  const run = (async () => {
    apply({ type: 'tasksLoading', loading: true });
    const tasksRequest = get('/api/tasks').then((tasks) => {
      if (tasks?.ok !== false) {
        apply({ type: 'tasks', tasks: tasks.tasks ?? [] });
      } else {
        apply({ type: 'tasksError', error: tasks?.error ?? 'Could not load current work.' });
      }
    });
    const changesRequest = get('/api/changes').then((changes) => {
      if (changes?.ok !== false) {
        state.changesError = null;
        apply({ type: 'changes', changes: changes.changed ?? [] });
      } else {
        state.changesError = changes?.error ?? 'Could not load changes.';
        apply({ type: '__changes-error__' });
      }
    });
    await Promise.all([tasksRequest, changesRequest]);
  })();
  listsRequest = run;
  try { return await run; }
  finally { if (listsRequest === run) listsRequest = null; }
}

async function maybeOpenDoctor(firstSnapshot) {
  if (!firstSnapshot || doctorProbe || location.hash.slice(1)) return;
  doctorProbe = true;
  const bootEventCount = eventsApplied;
  const report = await get('/api/doctor');
  // The probe is async and can resolve well after boot. Anything that
  // happened while it was in flight — a run created, an event streamed in —
  // means the sovereign is already mid-task, and grabbing the screen for a
  // first-run health check at that point isn't a greeting, it's an
  // interruption. eventsApplied mirrors the connectionAttempt staleness
  // check above: if it moved since the probe started, the probe's result no
  // longer describes "nothing has happened yet" and must not act.
  if (report?.ready === false && !location.hash.slice(1) && eventsApplied === bootEventCount) navigate('doctor');
}

function renderShell() {
  const header = $('header');
  if (header && !header.dataset.foundation) {
    header.dataset.foundation = '1';
    header.innerHTML = '<div class="app-identity"><span class="brand">Agentic OS</span><span class="brand-tag">your team, in one place</span></div><span class="repo"></span><span class="header-sep" aria-hidden="true">·</span><span class="goal-context"></span><nav class="mode-switcher" aria-label="Work mode"></nav><button class="mobile-menu" type="button" aria-controls="sidebar" aria-expanded="false">Menu</button><span class="connection" aria-label="Connection"></span>';
    const switcher = header.querySelector('.mode-switcher');
    for (const choice of USER_MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mode-option';
      button.dataset.mode = choice.id;
      button.dataset.tip = choice.blurb;
      button.setAttribute('aria-label', `${choice.label}: ${choice.blurb}`);
      const label = document.createElement('strong');
      label.textContent = choice.label;
      const permits = document.createElement('span');
      permits.textContent = modePermissionText(modeOf(choice.backend));
      button.append(label, permits);
      button.addEventListener('click', () => chooseMode(choice.id));
      switcher.append(button);
    }
    header.querySelector('.mobile-menu')?.addEventListener('click', () => {
      if (document.body.classList.contains('sidebar-open')) closeMobileNav();
      else openMobileNav();
    });
    $('sidebar-scrim')?.addEventListener('click', closeMobileNav);
  }
  state.userMode = userModeOf(state.mode);
  const ready = state.ready !== false;
  const choice = USER_MODE_BY_ID.get(state.userMode) ?? USER_MODE_BY_ID.get('cowork');
  const switcher = header?.querySelector('.mode-switcher');
  if (switcher) for (const button of switcher.querySelectorAll('[data-mode]')) {
    const selected = ready && button.dataset.mode === choice.id;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = modeRequest > 0 || !ready;
  }
  const repo = header?.querySelector('.repo');
  if (repo) repo.textContent = ready ? (state.repo ? `${String(state.repo).split(/[\\/]/).pop()}${state.base ? ` · ${state.base}` : ''}` : 'no repository') : 'Connecting…';
  const goal = header?.querySelector('.goal-context');
  if (goal) goal.textContent = ready ? (modeNotice || (state.goal?.text ? String(state.goal.text).replace(/\s+/g, ' ').trim() : 'No objective set')) : 'Waiting for workspace state…';
  const conn = header?.querySelector('.connection');
  if (conn) {
    conn.className = `connection ${state.conn === 'up' ? 'up' : state.conn === 'down' ? 'down' : ''}`;
    conn.textContent = state.conn === 'up' ? 'Connected' : state.conn === 'down' ? 'Reconnecting' : 'Connecting...';
    conn.setAttribute('aria-label', `Connection: ${conn.textContent}`);
    conn.setAttribute('aria-live', 'polite');
    conn.dataset.tip = state.conn;
  }
}

function renderCurrent() { renderShell(); }

function openMobileNav() {
  document.body.classList.add('sidebar-open');
  $('main')?.toggleAttribute('inert', true);
  $('header')?.querySelector('.mobile-menu')?.setAttribute('aria-expanded', 'true');
  $('sidebar-scrim')?.setAttribute('aria-hidden', 'false');
  $('sidebar')?.querySelector('.sidebar-mobile-close')?.focus();
}

function closeMobileNav() {
  const wasOpen = document.body.classList.contains('sidebar-open');
  document.body.classList.remove('sidebar-open');
  $('main')?.toggleAttribute('inert', false);
  $('header')?.querySelector('.mobile-menu')?.setAttribute('aria-expanded', 'false');
  $('sidebar-scrim')?.setAttribute('aria-hidden', 'true');
  if (wasOpen) $('header')?.querySelector('.mobile-menu')?.focus();
}

function showBootFailure(error) {
  bootFailed = true;
  connectionAttempt++;
  console.error('UI modules failed to load', error);
  source?.close();
  source = null;
  if (reconnect) clearTimeout(reconnect);
  reconnect = null;
  currentCleanup();
  currentCleanup = () => {};
  const host = $('view');
  if (!host) return;
  const shell = document.createElement('div');
  shell.className = 'view-mount boot-failure';
  const heading = document.createElement('h1');
  heading.textContent = 'Agentic OS could not load';
  const message = document.createElement('p');
  message.textContent = 'The interface did not start. Reload this window to try again.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button primary';
  retry.textContent = 'Reload interface';
  retry.addEventListener('click', () => location.reload());
  shell.append(heading, message, retry);
  host.replaceChildren(shell);
}

function showViewFailure(error, sequence = mountSequence) {
  if (sequence !== mountSequence) return;
  console.error('UI view failed to load', error);
  currentCleanup();
  currentCleanup = () => {};
  const host = $('view');
  if (!host) return;
  const shell = document.createElement('div');
  shell.className = 'view-mount boot-failure';
  const heading = document.createElement('h1');
  heading.textContent = 'This view could not load';
  const message = document.createElement('p');
  message.textContent = 'The page did not start. Retry it to continue.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button primary';
  retry.textContent = 'Retry view';
  retry.addEventListener('click', () => mountRoute(viewName()));
  shell.append(heading, message, retry);
  host.replaceChildren(shell);
  focusViewHeading(shell);
}

function focusViewHeading(root) {
  const heading = root.querySelector('h1');
  if (!heading || typeof heading.focus !== 'function') return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

async function chooseMode(id) {
  const backend = backendModeOf(id);
  const choice = USER_MODE_BY_ID.get(id);
  if (state.ready === false || !backend || !choice || modeRequest) return;
  const request = ++modeRequest;
  modeNotice = `Switching to ${choice.label}… ${choice.action}`;
  renderShell();
  const result = await post('mode', { mode: backend, why: `sovereign chose ${choice.label}` });
  if (request !== modeRequest) return;
  modeRequest = 0;
  if (!result?.ok) {
    modeNotice = result?.error ?? `Could not switch to ${choice.label}.`;
    renderShell();
    return;
  }
  modeNotice = choice.action;
  // Chat is a destination, not a dashboard state: selecting it opens the
  // orchestrator's direct thread immediately.
  if (id === 'chat') startDirectConversation();
  else navigate('home');
  renderShell();
}

function startDirectConversation() {
  const id = state.view?.conversation ?? state.view?.conversationId
    ?? state.members?.get?.('orchestrator')?.conversationId
    ?? state.conversations?.active ?? state.conversations?.activeId ?? 'default';
  openConversation(id);
}

/**
 * The only view lifecycle. A view may return one cleanup function; timers and
 * subscriptions cannot outlive the view that owns them.
 */
export async function mount(name = viewName()) {
  const sequence = ++mountSequence;
  await loadUI();
  if (sequence !== mountSequence) return;
  currentCleanup();
  currentCleanup = () => {};
  const route = routeOf();
  setView(route.page === 'thread' && name === 'thread' ? route : name);
  syncStreamScope();
  state.modeDef = modeOf(state.mode);
  const host = $('view');
  if (!host) return;
  const root = document.createElement('div');
  root.className = 'view-mount';
  host.classList.add('view-changing');
  host.scrollTop = 0;
  host.replaceChildren(root);
  const reveal = () => { if (sequence === mountSequence) host.classList.remove('view-changing'); };
  if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(reveal);
  else if (globalThis.queueMicrotask) globalThis.queueMicrotask(reveal);
  else globalThis.setTimeout?.(reveal, 0);
  const context = {
    state, root, header: $('header'), composer: $('composer'), post, get, navigate, toast, refreshLists,
    sovereign: !state.view?.member || state.view.member === 'orchestrator',
  };
  const listsRefresh = refreshLists();
  const mounted = name === 'thread'
    ? mountThread(root, context)
    : viewFor(name).mount(state, root, context);
  const cleanup = mounted;
  if (sequence !== mountSequence) {
    cleanup?.();
    return;
  }
  currentCleanup = cleanup || (() => {});
  if (state.ready !== false) focusViewHeading(root);
  const timer = setInterval(refreshLists, 10_000);
  const prior = currentCleanup;
  currentCleanup = () => { clearInterval(timer); prior?.(); };
  await listsRefresh;
}

function mountRoute(name = viewName()) {
  if (name !== 'notes') noteRequest++;
  const sequence = mountSequence + 1;
  return mount(name).catch((error) => showViewFailure(error, sequence));
}

function navigate(view) {
  closeMobileNav();
  const next = routeFor(view || 'home');
  if (location.hash.slice(1) === next) mountRoute(viewName());
  else location.hash = next;
}

function openConversation(conversationId) {
  const previousView = { ...state.view };
  const view = { page: 'thread', conversation: conversationId, member: 'orchestrator' };
  setView(view);
  navigate(view);
  post('switchConversation', { name: 'orchestrator', conversationId }).then((result) => {
    if (result?.ok === false) {
      toast(`${result.error ?? 'Could not open that conversation.'} Staying on the previous view.`, true);
      if (state.view?.page === 'thread' && state.view?.member === 'orchestrator'
        && String(state.view?.conversation) === String(conversationId)) {
        setView(previousView);
        navigate(previousView);
      }
    }
  });
}

function onHashChange() { mountRoute(viewName()); }

function onKeydown(event) {
  if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
    closeMobileNav();
    return;
  }
  if (event.key === 'Tab' && document.body.classList.contains('sidebar-open')) {
    const drawer = $('sidebar');
    const focusable = [...(drawer?.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((element) => !element.disabled && !element.hidden);
    const current = focusable.indexOf(document.activeElement);
    const last = focusable.length - 1;
    if (last >= 0 && (current < 0 || (event.shiftKey && current === 0) || (!event.shiftKey && current === last))) {
      event.preventDefault();
      focusable[event.shiftKey ? last : 0].focus();
    }
    return;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const view = KEYS[event.key.toLowerCase()];
  if (!view) return;
  event.preventDefault();
  navigate(view);
}

export function boot() {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  attachHoverTips(document.body);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onDocumentClick);
  subscribe(renderCurrent);
  loadUI().then(() => {
    Assets.initBackground(document.getElementById('bg'));
    Assets.refresh();
    mountSidebar($('sidebar'), {
      state, post, get, navigate,
      setPref: (key, value) => setPrefs({ [key]: value }),
      toast,
      modes: USER_MODES.map((m) => ({ ...m, permissions: modePermissionText(modeOf(m.backend)) })),
      modeOf: userModeOf,
      onMode: chooseMode,
      onConversation: openConversation,
      onNew: openConversation,
      onRepository: () => { state.settingsSection = 'repo'; navigate('settings'); },
      onSettings: () => navigate('settings'),
      onMobileClose: closeMobileNav,
    });
    connect();
    return mount(viewName());
  }).catch(showBootFailure);
}

if (typeof document !== 'undefined') boot();

export { connect, navigate, viewName };
