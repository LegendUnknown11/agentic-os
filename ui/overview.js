// The home screen.
//
// This slot used to hold a three-step first-run tour and nothing else, which
// meant that the moment you set an objective the stage went permanently blank:
// measured on a real boot with a goal set and nobody added, the stage rendered
// zero panels and the tour was hidden, so the default state of the application
// was an empty room.
//
// It sits BEHIND the panels rather than being one — `position:absolute; inset:0;
// z-index:0` under #windows, `pointer-events:none` with the interactive bits
// opting back in. That is why it needs no layout machinery of its own and works
// unchanged in both Grid and Canvas mode: it is the floor, and panels are put
// on top of it. Close everything and you land here instead of nowhere.
//
// The five blocks are the five questions the rest of the UI could not answer
// without opening something:
//   what are we working towards   — the objective, previously a header pill
//   what is queued                — /api/tasks, which had NO consumer at all
//   who is doing what right now   — spread across rail rows
//   what needs me                 — approvals, in three different places
//   what came back                — reachable only by guessing a name
import { displayName } from './names.js';

const el = (tag, cls, text) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

const get = (u) => fetch(u).then((r) => r.json()).catch(() => ({ ok: false }));

let root, api = {};
let tasks = { tasks: [], open: 0, available: 0 };
let changed = [];
let timer = null;

/**
 * How stale the two fetched blocks may be.
 *
 * Everything else here is repainted by an event — the roster tick, a goal
 * change, an approval. Tasks and worktree stats have no event to hang on: the
 * orchestrator writes a task through MCP and the bus does not announce it, and a
 * peasant's worktree changes without anything being posted at all. 10s is slow
 * enough that a court of twenty is not being git-statted continuously and fast
 * enough that a task appears before you go looking for it.
 */
const POLL_MS = 10_000;

export function initOverview(node, opts = {}) {
  root = node;
  api = opts;
  root.hidden = false;
  paintOverview();
}

/** Repaint from live state, and start the poll the first time. */
export function paintOverview() {
  if (!root) return;
  paint();
  if (!timer) {
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }
}

async function refresh() {
  // Not while it is off screen. In Grid mode an open panel hides this layer,
  // and /api/changes runs a git stat per summoned member to answer — polling it
  // every 10s behind a panel nobody can see through is work for nothing.
  // offsetParent goes null exactly when this or an ancestor is display:none,
  // which is the cheapest honest test for "on screen" available here.
  if (root.hidden || root.offsetParent === null) return;
  // Nor for a block this mode does not draw. Chat has no task list and nothing
  // that merges, so both of these would be polled to fill nothing.
  const m = api.mode?.() ?? { tasks: true, merge: true };
  const [t, c] = await Promise.all([
    m.tasks ? get('/api/tasks') : null,
    m.merge ? get('/api/changes') : null,
  ]);
  if (t?.ok) tasks = t;
  if (c?.ok) changed = c.changed ?? [];
  paint();
}

/* ---------- the shaping, kept pure so it can be checked ---------- */

/**
 * Who is doing something right now.
 *
 * `busy` is the question, not `awake`: an awake member sitting at idle is not
 * work in progress, and listing it here is the same mistake the rail made when
 * it printed "not summoned" beside twelve of fourteen rows.
 */
export function working(members, statusOf, summaries) {
  const out = [];
  for (const [name, m] of members) {
    if (!m.awake) continue;
    const status = statusOf.get(name);
    if (!status || status === 'idle') continue;
    out.push({ name, role: m.role, status, summary: summaries.get(name) ?? '' });
  }
  // The orchestrator first — it is the one whose turn explains all the others.
  return out.sort((a, b) =>
    (a.role === 'orchestrator' ? 0 : 1) - (b.role === 'orchestrator' ? 0 : 1) || a.name.localeCompare(b.name));
}

/**
 * The queue, in the order it is worth reading.
 *
 * Not by id. What the sovereign is looking for is the thing that is stuck, then
 * the thing being worked on, then what is waiting to be picked up — a list
 * sorted by insertion puts a finished task from an hour ago above a blocked one.
 * `done` and `dropped` are dropped entirely: this is the queue, not the history,
 * and the Activity panel already owns what happened.
 */
export function queued(rows = []) {
  const RANK = { blocked: 0, planning: 1, active: 2, pending: 3 };
  return rows
    .filter((t) => t.state !== 'done' && t.state !== 'dropped')
    .map((t) => ({
      ...t,
      // A blocked task is not "pending" in any sense the reader cares about.
      shown: t.blockedBy?.length ? 'blocked' : t.state,
    }))
    .sort((a, b) => (RANK[a.shown] ?? 9) - (RANK[b.shown] ?? 9) || a.id - b.id);
}

/** " lib/a.dart | 12 +++---" over many files -> one {files, plus, minus}. */
export function tally(stat = '') {
  let files = 0, plus = 0, minus = 0;
  for (const line of stat.split('\n')) {
    const m = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)/);
    if (!m) continue;
    files++;
    plus += (m[3].match(/\+/g) ?? []).length;
    minus += (m[3].match(/-/g) ?? []).length;
  }
  return { files, plus, minus };
}

/* ---------- painting ---------- */

function section(title, count) {
  const h = el('div', 'ov-head');
  h.append(el('span', 'engraved', title));
  if (count !== undefined && count !== null) h.append(el('span', 'ov-count num', String(count)));
  return h;
}

function paint() {
  if (!root) return;
  const members = api.members?.() ?? new Map();
  const goal = api.goal?.() ?? null;
  const staffed = [...members.values()].some((m) => m.role === 'peasant' && m.summoned);

  // Nothing has been set up at all: the three steps, which are still the right
  // thing to show and are the one part of this slot that already worked.
  if (!staffed && !goal) return paintEmpty();

  root.textContent = '';
  root.classList.add('ov');
  // Cleared, not left set: the empty state builds once and returns early on
  // every later call, so a court that is staffed and then emptied again came
  // back to a blank layer rather than to the three steps.
  delete root.dataset.empty;
  const grid = el('div', 'ov-grid');

  // The shape decides which of the five questions exist. A "Ready to review"
  // block under a mode that never merges is not an empty block, it is a wrong
  // one — it says work is waiting to land when nothing in this mode can land.
  // Read from the mode's own capabilities, so a new mode needs nothing here.
  const m = api.mode?.() ?? { crew: 'all', tasks: true, merge: true };
  const crewed = m.crew === 'all' || (m.crew?.length ?? 0) > 0;

  grid.append(blockObjective(goal));
  if (m.tasks) grid.append(blockQueue());
  if (crewed) grid.append(blockWorking(members), blockNeedsYou());
  if (m.merge) grid.append(blockChanges());
  root.append(grid);
}

function paintEmpty() {
  // Built once and kept: it has no live data in it, and rebuilding it on every
  // roster tick would restart its entrance animation twice a second.
  if (root.dataset.empty === '1') return;
  root.dataset.empty = '1';
  root.classList.remove('ov');
  root.textContent = '';

  const step = (n, label, hint, run) => {
    const b = el('button', 'fr-step');
    b.append(el('span', 'fr-n num', n), el('span', 'fr-label', label), el('span', 'fr-hint', hint));
    b.onclick = run;
    return b;
  };
  root.append(
    el('h1', null, 'No agents yet'),
    el('p', null, 'The orchestrator and the monitor are running. Nobody is doing any work yet.'),
    step('1', 'Add an agent', 'Pick who joins the team', () => api.openSummon?.()),
    step('2', 'Set an objective', 'What everyone is working towards', () => api.openGoal?.()),
    step('3', 'Give an instruction', 'Type it at the bottom', () => api.focusCommand?.()),
  );
}

function block(cls) {
  const b = el('div', `ov-block ${cls}`);
  return b;
}

function blockObjective(goal) {
  const b = block('ov-objective');
  b.append(section('Objective'));
  if (!goal) {
    const set = el('button', 'ov-cta', 'Set an objective');
    set.onclick = () => api.openGoal?.();
    b.append(el('p', 'ov-empty', 'The team works on whatever you last asked, and forgets it on restart.'), set);
    return b;
  }
  const text = el('p', 'ov-goal', goal.text);
  text.onclick = () => api.openGoal?.();
  b.append(text);

  const ms = goal.milestones ?? [];
  if (ms.length) {
    const done = ms.filter((m) => m.done).length;
    const bar = el('div', 'gp-bar');
    const fill = el('i');
    fill.style.width = `${Math.round((done / ms.length) * 100)}%`;
    bar.append(fill);
    const wrap = el('div', 'goal-progress');
    wrap.append(bar, el('span', 'gp-label num', `${done}/${ms.length}`));
    b.append(wrap);
    // The next unfinished one, by name. A bar says how far; this says what next.
    const next = ms.find((m) => !m.done);
    if (next) b.append(el('p', 'ov-next', `Next: ${next.text}`));
  } else {
    b.append(el('p', 'ov-empty', 'No milestones — add some so progress is measurable.'));
  }
  return b;
}

function blockQueue() {
  const rows = queued(tasks.tasks);
  const b = block('ov-queue');
  b.append(section('Queue', rows.length || null));
  if (!rows.length) {
    b.append(el('p', 'ov-empty', tasks.tasks?.length
      ? 'Everything on the list is finished.'
      : 'Nothing queued. The orchestrator adds work here as it breaks a job down.'));
    return b;
  }
  for (const t of rows.slice(0, 8)) {
    const row = el('div', `ov-task state-${t.shown}`);
    row.append(el('span', 'ov-task-state', t.shown));
    row.append(el('span', 'ov-task-title', t.title));
    if (t.owner) row.append(el('span', 'ov-task-who', displayName(t.owner)));
    row.title = [t.title, t.detail, t.blockedBy?.length ? `blocked by #${t.blockedBy.join(', #')}` : '']
      .filter(Boolean).join('\n\n');
    b.append(row);
  }
  if (rows.length > 8) b.append(el('p', 'ov-more', `+${rows.length - 8} more`));
  if (tasks.available) b.append(el('p', 'ov-note', `${tasks.available} ready to be picked up`));
  return b;
}

function blockWorking(members) {
  const rows = working(members, api.statusOf?.() ?? new Map(), api.summaries?.() ?? new Map());
  const b = block('ov-working');
  b.append(section('Working now', rows.length || null));
  if (!rows.length) {
    b.append(el('p', 'ov-empty', 'Nobody is mid-turn. Give an instruction below to start something.'));
    return b;
  }
  for (const r of rows) {
    const row = el('button', 'ov-agent');
    row.append(el('span', 'ov-agent-name', displayName(r.name, r.role)));
    row.append(el('span', 'ov-agent-status', r.status));
    if (r.summary) row.append(el('span', 'ov-agent-sum', r.summary));
    row.onclick = () => api.onOpenMember?.(r.name);
    b.append(row);
  }
  return b;
}

function blockNeedsYou() {
  const waiting = api.approvals?.() ?? [];
  const failed = [...(api.members?.() ?? new Map())]
    .filter(([n]) => api.statusOf?.().get(n) === 'failed')
    .map(([n, m]) => ({ name: n, role: m.role }));
  const b = block('ov-needs');
  b.append(section('Needs you', (waiting.length + failed.length) || null));
  if (!waiting.length && !failed.length) {
    b.append(el('p', 'ov-empty', 'Nothing is waiting on you.'));
    return b;
  }
  for (const a of waiting.slice(0, 5)) {
    const row = el('button', 'ov-ask');
    row.append(el('span', 'ov-ask-kind', a.kind));
    row.append(el('span', 'ov-ask-what', a.who));
    row.onclick = () => api.openApprovals?.();
    b.append(row);
  }
  for (const f of failed) {
    const row = el('button', 'ov-ask failed');
    row.append(el('span', 'ov-ask-kind', 'FAILED'));
    row.append(el('span', 'ov-ask-what', displayName(f.name, f.role)));
    row.onclick = () => api.onOpenMember?.(f.name);
    b.append(row);
  }
  return b;
}

function blockChanges() {
  const b = block('ov-changes');
  b.append(section('Ready to review', changed.length || null));
  if (!changed.length) {
    b.append(el('p', 'ov-empty', 'No unmerged work. Agents write into their own worktrees.'));
    return b;
  }
  for (const c of changed) {
    const t = tally(c.stat);
    const row = el('button', 'ov-change');
    row.append(el('span', 'ov-change-who', c.peasant));
    row.append(el('span', 'ov-change-files', `${t.files} file${t.files === 1 ? '' : 's'}`));
    const ch = el('span', 'ch');
    if (t.plus) ch.append(el('i', 'add', `+${t.plus}`));
    if (t.minus) ch.append(el('i', 'del', `−${t.minus}`));
    row.append(ch);
    row.onclick = () => api.onDiff?.(c.peasant);
    b.append(row);
  }
  return b;
}

// Self-check. `typeof process` rather than a bare `process.argv`: the bare form
// throws ReferenceError in a browser and, because app.js imports this module,
// takes the whole graph down and boots the room to an empty shell.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('overview.js')) {
  const assert = await import('node:assert/strict');
  const a = assert.default ?? assert;

  // --- working() ---
  const members = new Map([
    ['orchestrator', { role: 'orchestrator', awake: true }],
    ['coder', { role: 'peasant', awake: true }],
    ['tester', { role: 'peasant', awake: true }],
    ['scribe', { role: 'peasant', awake: false }],
  ]);
  const status = new Map([['orchestrator', 'delegating'], ['coder', 'editing'],
    ['tester', 'idle'], ['scribe', 'editing']]);
  const sums = new Map([['coder', 'rewriting the parser']]);
  const w = working(members, status, sums);
  a.deepEqual(w.map((x) => x.name), ['orchestrator', 'coder'],
    'idle and asleep are not "working"; the orchestrator sorts first');
  a.equal(w[1].summary, 'rewriting the parser');
  // An asleep member with a stale status must not appear — that status died
  // with the process.
  a.ok(!w.some((x) => x.name === 'scribe'));

  // --- queued() ---
  const rows = queued([
    { id: 1, title: 'a', state: 'done', blockedBy: [] },
    { id: 2, title: 'b', state: 'pending', blockedBy: [] },
    { id: 3, title: 'c', state: 'active', blockedBy: [] },
    { id: 4, title: 'd', state: 'pending', blockedBy: [3] },
    { id: 5, title: 'e', state: 'dropped', blockedBy: [] },
  ]);
  a.deepEqual(rows.map((t) => t.id), [4, 3, 2],
    'blocked first, then active, then free — and finished work is not queue');
  a.equal(rows[0].shown, 'blocked', 'a pending task with unmet needs reads as blocked');

  // --- tally() ---
  const t = tally(' src/a.js | 12 ++++----\n src/b.js | 3 +++\n 2 files changed');
  a.equal(t.files, 2);
  a.equal(t.plus, 7);
  a.equal(t.minus, 4);
  a.deepEqual(tally(''), { files: 0, plus: 0, minus: 0 }, 'an empty stat is not a crash');
  a.deepEqual(tally(undefined), { files: 0, plus: 0, minus: 0 });

  console.log('overview ok');
}
