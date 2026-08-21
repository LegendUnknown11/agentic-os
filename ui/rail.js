// The court rail: the list of members down the left, and the way you reach one.
//
// This replaces the node graph. A graph is a good way to see six things and a
// bad way to see sixteen — the nodes stopped being readable long before the
// court was finished, and the layout work went into keeping circles apart
// rather than into the transcripts, which is what anyone actually reads.
//
// Same job, so the same shape of API the graph exposed: upsert, state, status,
// size. Nothing here knows about the canvas.
import { statusDot } from './avatar.js';
import { arrive, brand, depart, pulse } from './feel.js';
import { displayName, roleGroup } from './names.js';

const rows = new Map();     // name -> {el, role, state, status, ctx}
let listEl, onOpen;
const ORDER = { orchestrator: 0, briefer: 1, peasant: 2 };

export function initRail(el, opts = {}) {
  listEl = el;
  onOpen = opts.onOpen ?? (() => {});
}

// Names the roster has said are NOT in the court.
//
// applyRoster removes them, and then the snapshot replays ~400 events and ~200
// messages, every one of which calls upsertNode — so a dismissed peasant was
// recreated within the same tick that removed it, and a reload put all 105
// configured roles back in the rail. That is the exact regression the removal
// feature exists to prevent (105 rows, 4,179px of scroll). Only the roster
// speaks to this, through admit().
const dismissed = new Set();

/** The roster's word: this member belongs in the rail. */
export function admit(name, role) {
  dismissed.delete(name);
  return upsertNode(name, role);
}

export function upsertNode(name, role) {
  let r = rows.get(name);
  if (!r) {
    if (dismissed.has(name)) return null;   // a transcript replay is not a summons
    // Only default on CREATE. Defaulting on every call is how the orchestrator once
    // got quietly demoted to a peasant by a caller that only had a name.
    role ??= 'peasant';
    const el = document.createElement('button');
    el.className = `rail-row ${role === 'orchestrator' ? 'orchestrator' : ''}`;
    el.innerHTML = '<span class="nm"></span><span class="st"></span>';
    el.prepend(statusDot(name, role));
    el.querySelector('.nm').textContent = displayName(name, role);
    el.onclick = () => onOpen(name);
    r = { el, role, state: 'asleep', status: '', ctx: 0 };
    rows.set(name, r);
    listEl.append(el);
    resort();
    arrive(el);          // after resort(): it moves the node, which cancels it
  } else if (role && role !== r.role) {
    r.role = role;
    // The printed name can depend on the role — `orchestrator` shows as Orchestrator
    // only while it IS the orchestrator — so a promotion has to repaint it.
    r.el.querySelector('.nm').textContent = displayName(name, role);
    r.el.classList.toggle('orchestrator', role === 'orchestrator');
    resort();
  }
  return r;
}

/** Groups in a fixed order, members alphabetical inside a group. */
function resort() {
  const sorted = [...rows.entries()].sort((a, b) =>
    (ORDER[a[1].role] ?? 2) - (ORDER[b[1].role] ?? 2) || a[0].localeCompare(b[0]));

  listEl.textContent = '';
  let group = null;
  for (const [name, r] of sorted) {
    if (r.role !== group) {
      group = r.role;
      const heading = roleGroup(group);
      // A heading over a single row that already says the same word is noise.
      // The orchestrator and the monitor are singletons whose printed name IS
      // the role, so "Orchestrator / Orchestrator" was stacked twice. A named
      // one ("Rex") still gets its heading, because then it says something.
      const members = sorted.filter(([, x]) => x.role === group);
      const redundant = members.length === 1
        && displayName(members[0][0], group) === heading;
      if (!redundant) {
        const h = document.createElement('div');
        // The role goes on the class so the throne's heading can wear gold. The
        // rule trailing off to the right is drawn by ::after, so the text node
        // has to stay the only child.
        h.className = `rail-group ${group}`;
        h.textContent = heading;
        listEl.append(h);
      }
    }
    listEl.append(r.el);
  }
}

/**
 * Three states, not two.
 *
 *   awake    — a live process, working or waiting for mail
 *   resting  — in the crew, idle-slept, revives on its next message with its
 *              memory intact. Costs nothing while it sits there.
 *   off      — not summoned at all
 *
 * The rail used to collapse the middle one into "asleep", so a court of seven
 * members quietly doing their jobs looked like a court of none. That is what a
 * status light is FOR — the distinction between resting and absent is the
 * whole question the sovereign is asking when they glance at it.
 */
export function setState(name, state) {
  const r = upsertNode(name);
  if (!r) return;   // dismissed: the roster has said this one holds no row
  const woke = state !== r.state && (state === 'awake' || state === 'busy');
  r.state = state;
  // A member coming to life is the one transition worth a ring. Only on the
  // CHANGE — this is called on every roster tick, and pulsing an already-awake
  // member twice a second is a strobe, not a signal.
  if (woke) pulse(r.el.querySelector('.av'));
  r.el.classList.toggle('awake', state === 'awake' || state === 'busy');
  r.el.classList.toggle('busy', state === 'busy');
  r.el.classList.toggle('dead', state === 'dead');
  if (state === 'awake' || state === 'busy') r.el.classList.add('serving');
  refreshTip(name);
}

/** In the crew, whether or not it currently has a process. */
export function setServing(name, serving) {
  const r = upsertNode(name);
  if (!r) return;   // dismissed: the roster has said this one holds no row
  r.serving = serving;
  r.el.classList.toggle('serving', Boolean(serving));
  refreshTip(name);
}

const STATE_WORD = (r) =>
  r.state === 'dead' ? 'failed'
    : r.state === 'awake' || r.state === 'busy' ? 'awake'
    : r.serving ? 'resting — wakes on its next message'
    : 'not added';

export function setStatus(name, word, tone = 'busy') {
  const r = upsertNode(name);
  if (!r) return;   // dismissed: the roster has said this one holds no row
  r.status = word;
  const st = r.el.querySelector('.st');
  // "not added" printed beside twelve of fourteen rows is not information, it
  // is wallpaper — and it drowned the two rows that had something to say.
  // Absence is carried by the row's own dimming instead. Matched on the word
  // app.js:399 emits: these two strings have to agree, and when they did not
  // the placeholder came back on every row.
  st.textContent = word === 'idle' || word === 'not added' ? '' : word;
  st.className = `st tone-${tone}`;
  // "Busy" is the one thing worth animating: it is the difference between
  // waiting for a member and waiting for nothing.
  r.el.classList.toggle('busy', Boolean(word) && word !== 'idle' && r.state === 'awake');
}

/**
 * The newest one-line summary, under the member's name. This is the rail's
 * real job now: sixteen rows telling you what everyone is actually doing,
 * without opening a single panel.
 */
export function setSummary(name, text) {
  const r = upsertNode(name);
  if (!r) return;   // dismissed: the roster has said this one holds no row
  r.summary = text;
  let s = r.el.querySelector('.sum');
  if (!s) {
    s = document.createElement('span');
    s.className = 'sum';
    r.el.querySelector('.nm')?.after(s);
    r.el.classList.add('two-line');
  }
  s.textContent = text;
  s.title = text;
}

export function setSize(name, ctxTokens) {
  const r = upsertNode(name);
  if (!r) return;   // dismissed: the roster has said this one holds no row
  r.ctx = ctxTokens;
  refreshTip(name);
}

export function setTip(name, lines) {
  const r = upsertNode(name);
  if (!r) return;   // dismissed: the roster has said this one holds no row
  r.tip = lines;
  refreshTip(name);
}

function refreshTip(name) {
  const r = rows.get(name);
  if (!r) return;
  r.el.title = [
    `${name} — ${STATE_WORD(r)}`,
    ...(r.tip ?? []),
    r.ctx ? `context ${(r.ctx / 1000).toFixed(0)}k tokens` : null,
  ].filter(Boolean).join('\n');
}

/** A message travelled between two members. The one authored moment left. */
export function flash(from, to) {
  for (const name of [from, to]) {
    const r = rows.get(name);
    if (!r) continue;
    r.el.animate(
      [{ background: brand('--accent-rgb', .22) }, { background: 'transparent' }],
      { duration: 900, easing: 'cubic-bezier(.22,1,.36,1)' },
    );
  }
}

/** Mark which members have a panel open, so the rail reflects the workspace. */
export function setOpen(openIds) {
  for (const [name, r] of rows) r.el.classList.toggle('open', openIds.has(`m:${name}`));
}

/**
 * Take a member out of the rail entirely.
 *
 * The rail is the PARTY, not the roster. Before this existed every configured
 * role got a row whether or not it was in the court, so a stock config put 107
 * rows and 4,179px of scroll behind a 580px viewport — and 105 of them said
 * "not summoned", which is the one thing a member list should never mostly say.
 * Recruiting moved to its own screen (panels.js, openSummon) and this is how a
 * dismissed member leaves the list.
 */
export function remove(name) {
  dismissed.add(name);
  const r = rows.get(name);
  if (!r) return;
  // Dropped from `rows` immediately, removed from the DOM when the collapse
  // finishes. Anything arriving during those 260ms must see them as already
  // gone — a re-summon mid-departure would otherwise find a stale row and then
  // have it deleted out from under it.
  rows.delete(name);
  depart(r.el, () => {
    r.el.remove();
    resort();          // drops a group heading that just lost its last member
  });
}

export const has = (name) => rows.has(name);
export const names = () => [...rows.keys()];
export const count = () => rows.size;

export function initCollapse(btn) {
  const apply = () => {
    document.body.classList.toggle('rail-collapsed', localStorage.getItem('kd.rail') === '1');
  };
  btn.onclick = () => {
    localStorage.setItem('kd.rail', localStorage.getItem('kd.rail') === '1' ? '0' : '1');
    apply();
  };
  apply();
}

/** Forces the same collapse the button toggles — used to default Chat mode
 * collapsed on entry, without a second collapsed/expanded flag to keep in sync. */
export function collapse() {
  localStorage.setItem('kd.rail', '1');
  document.body.classList.add('rail-collapsed');
}
