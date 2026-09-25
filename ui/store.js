import { STICKY, verbFor } from './status.js';

// The renderer's one state owner. DOM modules consume this state; they do not
// keep their own copies of the stream or start their own timers.

const PREFS_KEY = 'kd.prefs';
const LOG_CAP = 400;
const MESSAGE_CAP = 300;

const readPrefs = () => {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

const memberState = (m = {}) => m.awake ? 'awake' : m.summoned ? 'resting' : 'off';
const rosterEntry = (m = {}, prior = {}) => ({
  ...prior,
  ...m,
  // Role is a roster fact. Live agent events often omit it and must never
  // quietly turn the orchestrator into a peasant.
  role: prior.role ?? m.role ?? 'peasant',
  state: memberState({ ...prior, ...m }),
});

const initialState = () => ({
  repo: null,
  base: null,
  members: new Map(),
  roster: new Map(),
  dismissed: new Set(),
  log: new Map(),
  messages: [],
  approvals: [],
  conversations: [],
  tasks: [],
  changes: [],
  notices: [],
  lastEvent: null,
  run: null,
  goal: null,
  mode: 'code',
  models: {},
  efforts: {},
  skills: [],
  summarizer: {},
  advisor: {},
  assetNotices: {},
  assetUploads: {},
  spend: {},
  conn: 'connecting',
  prefs: readPrefs(),
  view: { page: 'home' },
  cursor: 0,
  messageCursor: 0,
  ready: false,
  rosterReady: false,
  doctorLoading: false,
  notesDetail: null,
  notesError: null,
  memoryLoading: false,
  memoryError: null,
  activityError: null,
  tasksLoading: false,
  tasksError: null,
  changesError: null,
  metricsError: null,
  workflowsError: null,
});

export const state = initialState();

const subs = new Set();
let frame = 0;

const notify = () => {
  frame = 0;
  for (const fn of subs) {
    try { fn(state); } catch (err) { console.error('store subscriber failed', err); }
  }
};

const schedule = () => {
  if (frame) return;
  // requestAnimationFrame does not fire for a backgrounded tab — a dashboard
  // left open while the user works elsewhere would silently stop repainting
  // (data still arrives over SSE/fetch, subscribers just never get called).
  // setTimeout still fires (throttled, but not suppressed) when hidden.
  const raf = globalThis.document?.visibilityState !== 'hidden' && globalThis.requestAnimationFrame;
  frame = raf ? raf(notify) : setTimeout(notify, 0);
};

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function setPrefs(patch = {}) {
  state.prefs = { ...state.prefs, ...patch };
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch {}
  schedule();
  return state.prefs;
}

export function setView(view) {
  if (typeof view === 'object' && view) state.view = { ...state.view, ...view };
  else if (String(view).startsWith('agent:')) state.view = { page: 'thread', member: String(view).slice(6) };
  else state.view = { page: String(view || 'home') };
  schedule();
}

function inRoster(name, row) {
  return Boolean(row) && (row.role === 'orchestrator' || row.role === 'briefer' || row.summoned);
}

function applyRoster(rows = [], replace = true) {
  const next = new Map();
  for (const raw of rows) {
    if (!raw?.name) continue;
    const old = state.roster.get(raw.name) ?? state.members.get(raw.name);
    next.set(raw.name, rosterEntry(raw, old));
  }

  // The daemon's roster is authoritative. Remember names which left it so a
  // replayed transcript cannot recreate them before the next roster repaint.
  if (state.rosterReady && replace) {
    for (const name of state.roster.keys()) if (!next.has(name)) state.dismissed.add(name);
  }
  for (const [name, row] of next) {
    if (inRoster(name, row)) state.dismissed.delete(name);
  }

  state.roster = next;
  // Keep configured-but-not-summoned roles in the map as `off`; the Add Agents
  // view needs them, while the sidebar can filter to the team. Names absent
  // from the roster remain excluded by `dismissed`.
  state.members = new Map([...next].filter(([name]) => !state.dismissed.has(name)));
  state.rosterReady = true;
}

function upsertMember(name, patch = {}) {
  if (!name || state.dismissed.has(name)) return null;
  const current = state.members.get(name) ?? state.roster.get(name);
  if (state.rosterReady && !current) return null;
  const next = rosterEntry(patch, current);
  state.members.set(name, next);
  if (state.roster.has(name)) state.roster.set(name, next);
  return next;
}

function pushLog(name, entry) {
  if (!name) return;
  const list = state.log.get(name) ?? [];
  if (entry.id != null && list.some((x) => x.id === entry.id)) return;
  list.push(entry);
  if (list.length > LOG_CAP) list.splice(0, list.length - LOG_CAP);
  state.log.set(name, list);
}

function applyAgentEvent(d) {
  const m = upsertMember(d.name, d);
  if (!m) return;
  const next = { ...m };
  // Membership (`state`) and activity (`status`) are different facts. Keep
  // the producer's activity value so the rail can distinguish a live verifier
  // from an idle member who happens to be awake.
  if (d.state) next.status = d.state;
  if (d.state === 'awake' || d.state === 'ready' || d.state === 'verifying') next.awake = true;
  if (d.state === 'exited' || d.state === 'idle-slept') next.awake = false;
  next.state = memberState(next);
  // Only a roster/create event may supply a role. Keep the existing role on
  // updates, even when a producer includes a stale or generic role.
  next.role = m.role;
  state.members.set(d.name, next);
  if (state.roster.has(d.name)) state.roster.set(d.name, next);
}

function applyRecordedEvent(d, id = d.id, ts = d.ts) {
  const name = d.agent ?? d.name;
  const kind = d.kind ?? d.type;
  const payload = d.payload ?? {};
  if (id != null) state.cursor = Math.max(state.cursor, Number(id) || 0);
  // Event logs are grouped by member for the rail, but threads are scoped by
  // conversation. Keep the bus column or a producer's camel-case equivalent;
  // dropping it makes sibling branches render one another's transcript.
  pushLog(name, {
    id, ts, type: kind, kind, payload,
    conversation_id: d.conversation_id ?? d.conversationId ?? payload.conversation_id ?? payload.conversationId,
  });
  const member = name ? state.members.get(name) : null;
  if (member && !STICKY.has(member.status)) {
    if (kind === 'turn_end') member.status = member.awake ? 'awake' : 'off';
    else if (kind === 'text') member.status = 'speaking';
    else if (kind === 'tool') member.status = verbFor(payload);
  }
  if (name && kind === 'summary') {
    const member = upsertMember(name, { summary: payload.text ?? '' });
    if (member) member.summary = payload.text ?? '';
  }
  if (name && !state.dismissed.has(name) && !state.members.has(name) && !state.rosterReady) {
    upsertMember(name, { name, role: 'peasant', summoned: true, awake: false });
  }
}

function applyMessage(msg = {}) {
  if (msg.id != null) {
    const id = Number(msg.id) || 0;
    if (state.messages.some((x) => Number(x.id) === id)) return;
    state.messageCursor = Math.max(state.messageCursor, id);
  }
  state.messages.push(msg);
  if (state.messages.length > MESSAGE_CAP) state.messages.splice(0, state.messages.length - MESSAGE_CAP);
}

function approval(row) {
  if (!row || row.id == null) return;
  const i = state.approvals.findIndex((x) => String(x.id) === String(row.id));
  if (i < 0) state.approvals.push(row);
  else state.approvals[i] = { ...state.approvals[i], ...row };
}

function status(name, value) {
  const member = upsertMember(name, {});
  if (!member) return;
  member.status = value;
}

function snapshot(d) {
  state.repo = d.repo ?? null;
  state.base = d.base ?? null;
  if (d.models) state.models = d.models;
  if (d.efforts) state.efforts = d.efforts;
  if (d.advisor) state.advisor = d.advisor;
  if (d.summarizer) state.summarizer = d.summarizer;
  if (d.skills) state.skills = d.skills;
  if (d.goal !== undefined) state.goal = d.goal;
  if (d.run !== undefined) state.run = d.run;
  if (d.mode) state.mode = d.mode;
  // #41: seed the durable turn count and its budget before the first live
  // 'spend' event of this browser session — otherwise a reconnect or a
  // fresh tab shows an empty header even though the court has already taken
  // turns this session.
  if (d.spend) state.spend = { ...state.spend, ...d.spend };
  if (d.paused !== undefined) state.paused = d.paused;
  if (d.pausedWhy !== undefined) state.pausedWhy = d.pausedWhy;
  applyRoster(d.roster ?? []);

  // A reconnect snapshot is a cursor catch-up. A fresh boot repaints the
  // retained tail; IDs make both paths safe if a browser retries a frame.
  for (const e of d.events ?? []) applyRecordedEvent(e);
  for (const m of d.messages ?? []) applyMessage(m);
  state.approvals = [];
  for (const a of d.approvals ?? []) approval(a);
  state.ready = true;
}

export function reduce(_state, d = {}) {
  if (!d || typeof d !== 'object') return _state;
  const type = d.type;
  switch (type) {
    case 'snapshot': snapshot(d); break;
    case 'repo': state.repo = d.repo ?? null; state.base = d.base ?? null; break;
    case 'roster':
      if (d.models) state.models = d.models;
      if (d.efforts) state.efforts = d.efforts;
      applyRoster(d.roster ?? []);
      break;
    case 'agent': applyAgentEvent(d); break;
    case 'event': applyRecordedEvent(d, d.id, d.ts); break;
    case 'delivered': applyMessage(d.msg ?? d); break;
    case 'approval': approval(d); break;
    case 'resolved': state.approvals = state.approvals.filter((a) => String(a.id) !== String(d.id)); break;
    case 'conversationSwitched': {
      const m = upsertMember(d.name, { conversationId: d.conversationId });
      if (m) m.conversationId = d.conversationId;
      if (d.conversationId != null && !state.conversations.some((conversation) =>
        String(conversation?.id ?? conversation?.conversationId) === String(d.conversationId))) {
        state.conversations.push({ id: d.conversationId, member: d.name, title: '' });
      }
      break;
    }
    case 'conversationRenamed': {
      const c = d.conversation ?? d;
      const i = state.conversations.findIndex((x) => String(x.id) === String(c.id));
      if (i >= 0) state.conversations[i] = { ...state.conversations[i], ...c };
      break;
    }
    case 'conversationArchived':
      state.conversations = state.conversations.filter((x) => String(x.id) !== String(d.id));
      break;
    case 'goal': state.goal = d.text ? d : null; break;
    case 'run': state.run = d.run ?? d; break;
    case 'mode': state.mode = d.mode ?? state.mode; break;
    case 'spend': state.spend = { ...state.spend, ...d }; break;
    case 'budget':
      state.spend = {
        ...state.spend,
        budget: d,
        // The turn-budget flavour of this event also carries the current
        // cap (and, when it fired from an actual turn, the count that
        // tripped it) — kept on their own fields so the header can read
        // them the same way it reads state.spend.turns from every 'spend'
        // event, without reaching into the last budget event's shape.
        ...(d.scope === 'turns' ? { turnBudget: d.cap, ...(d.turns != null ? { turns: d.turns } : {}) } : {}),
      };
      break;
    case 'summarizer': state.summarizer = { ...state.summarizer, ...d }; break;
    case 'advisor': state.advisor = { ...state.advisor, ...d }; break;
    case 'tasksLoading': state.tasksLoading = Boolean(d.loading); break;
    case 'tasks': state.tasks = d.tasks ?? []; state.tasksLoading = false; state.tasksError = null; break;
    case 'tasksError': state.tasksLoading = false; state.tasksError = d.error ?? 'Could not load current work.'; break;
    // The sovereign's own list. Broadcast whole on every change, like 'tasks'.
    case 'myTasks': state.myTasks = d.tasks ?? []; state.myTasksError = null; break;
    case 'changes': state.changes = d.changes ?? []; break;
    case 'conversations': {
      state.conversations = d.conversations ?? [];
      if (d.active != null) {
        const name = d.member ?? 'orchestrator';
        const member = upsertMember(name, {
          name,
          role: name === 'orchestrator' ? 'orchestrator' : undefined,
          conversationId: d.active,
        });
        if (member) member.conversationId = d.active;
      }
      break;
    }
    case 'failure': status(d.name, 'failed'); break;
    case 'limited': status(d.name, 'limited'); break;
    case 'advising': status('orchestrator', d.stage === 'start' ? 'briefing' : 'awake'); break;
    case 'paused':
      state.paused = d.paused ?? true;
      // Only kept while actually paused — a resume's own 'paused' event
      // carries no `why`, and a stale reason from the LAST pause must not
      // linger and mislabel the next one.
      state.pausedWhy = state.paused ? (d.why ?? '') : '';
      break;
    default:
      state.lastEvent = d;
      state.notices.push(d);
      if (state.notices.length > 100) state.notices.splice(0, state.notices.length - 100);
      break;
  }
  return _state;
}

export function apply(event) {
  reduce(state, event);
  schedule();
  return state;
}

const parseResponse = async (r) => {
  const body = await r.json().catch(() => ({}));
  return r.ok === false ? { ...body, ok: false } : body;
};

export const get = (url) => fetch(url).then(parseResponse).catch(() => ({ ok: false }));

export const post = (action, body = {}) => {
  const url = String(action).startsWith('/') ? action : `/api/${action}`;
  return Promise.resolve().then(() => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parseResponse).catch(() => ({ ok: false }));
};

export const sameId = (a, b) => String(a ?? '') === String(b ?? '');

export const money = (n) => {
  const number = Number(n);
  const value = Number.isFinite(number) ? number : 0;
  return `$${Math.abs(value) >= 0.01 ? value.toFixed(2) : value.toFixed(3)}`;
};

export const resetForTest = () => { Object.assign(state, initialState(), { prefs: state.prefs }); };
