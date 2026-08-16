// The court rail: the list of members down the left, and the way you reach one.
//
// This replaces the node graph. A graph is a good way to see six things and a
// bad way to see sixteen — the nodes stopped being readable long before the
// court was finished, and the layout work went into keeping circles apart
// rather than into the transcripts, which is what anyone actually reads.
//
// Same job, so the same shape of API the graph exposed: upsert, state, status,
// size. Nothing here knows about the canvas.
import { avatar } from './avatar.js';
import { arrive, depart, pulse } from './feel.js';

const rows = new Map();     // name -> {el, role, state, status, ctx}
let listEl, onOpen;
const ORDER = { king: 0, jester: 1, peasant: 2 };
const GROUP = { king: 'Throne', jester: 'Watch', peasant: 'Court' };

export function initRail(el, opts = {}) {
  listEl = el;
  onOpen = opts.onOpen ?? (() => {});
}

export function upsertNode(name, role) {
  let r = rows.get(name);
  if (!r) {
    // Only default on CREATE. Defaulting on every call is how the king once
    // got quietly demoted to a peasant by a caller that only had a name.
    role ??= 'peasant';
    const el = document.createElement('button');
    el.className = `rail-row ${role === 'king' ? 'king' : ''}`;
    el.innerHTML = '<span class="nm"></span><span class="st"></span>';
    el.prepend(avatar(name, role));
    el.querySelector('.nm').textContent = name;
    el.onclick = () => onOpen(name);
    r = { el, role, state: 'asleep', status: '', ctx: 0 };
    rows.set(name, r);
    listEl.append(el);
    resort();
    arrive(el);          // after resort(): it moves the node, which cancels it
  } else if (role && role !== r.role) {
    r.role = role;
    r.el.classList.toggle('king', role === 'king');
    r.el.querySelector('.av')?.classList.toggle('crown', role === 'king');
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
  for (const [, r] of sorted) {
    if (r.role !== group) {
      group = r.role;
      const h = document.createElement('div');
      // The role goes on the class so the throne's heading can wear gold. The
      // rule trailing off to the right is drawn by ::after, so the text node
      // has to stay the only child.
      h.className = `rail-group ${group}`;
      h.textContent = GROUP[group] ?? 'Court';
      listEl.append(h);
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
  r.serving = serving;
  r.el.classList.toggle('serving', Boolean(serving));
  refreshTip(name);
}

const STATE_WORD = (r) =>
  r.state === 'dead' ? 'failed'
    : r.state === 'awake' || r.state === 'busy' ? 'awake'
    : r.serving ? 'resting — wakes on its next message'
    : 'not summoned';

export function setStatus(name, word, tone = 'busy') {
  const r = upsertNode(name);
  r.status = word;
  const st = r.el.querySelector('.st');
  // "not summoned" printed beside twelve of fourteen rows is not information,
  // it is wallpaper — and it drowned the two rows that had something to say.
  // Absence is carried by the row's own dimming instead.
  st.textContent = word === 'idle' || word === 'not summoned' ? '' : word;
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
  r.ctx = ctxTokens;
  refreshTip(name);
}

export function setTip(name, lines) {
  const r = upsertNode(name);
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
      [{ background: 'rgba(69,236,198,.22)' }, { background: 'transparent' }],
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
