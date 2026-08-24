// The automation graph: the nodes and wires of one workflow, drawn and edited.
//
// The engine's model is not an edges list — a node points at the next node's id
// via `next`, and a condition points at two (`{then, else}`). See
// src/workflows.js. Everything here reads and writes that shape directly rather
// than keeping a parallel graph and syncing it, so what you drag IS what runs.
//
// The pure half (TYPES, autoLayout, wire, removeNode, newNode, makeStart) has
// no DOM in it and is what the self-check at the foot of this file drives. Only
// mount() touches elements.
//
// NO IMPORTS, deliberately. src/workflows.js — whose switch TYPES below mirrors
// — imports node:fs and so cannot be served to the browser the way /modes.js
// is, and ui/canvas.js reads localStorage at module load. Importing either
// would make this file unloadable in one environment or the other; instead the
// self-check imports the engine (node only) and asserts TYPES against it.

const NODE_W = 168, NODE_H = 62, GAP_X = 64, GAP_Y = 26, PAD = 18;

/** The comparisons evalCondition understands (workflows.js:32). */
export const OPS = ['eq', 'neq', 'gt', 'lt', 'contains', 'exists'];

/**
 * What each node type is, in one table: the fields its inspector shows, the
 * config a fresh one starts with, and the one line the node itself displays.
 *
 * This is the UI's copy of runNode()'s switch, so it is asserted against the
 * engine's own NODE_TYPES rather than trusted — a type added to the engine and
 * missed here would otherwise just be a palette chip that never appears.
 *
 * Field kinds: text, number, select (with options), json (anything the engine
 * takes as an object or array — a textarea parsed on the way out).
 */
export const TYPES = {
  http: {
    blurb: 'Call a URL',
    defaults: { url: '', method: 'GET' },
    fields: [['url', 'text'], ['method', 'select', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']],
      ['headers', 'json'], ['body', 'json']],
    sub: (c) => `${c.method || 'GET'} ${c.url || '—'}`,
  },
  delay: {
    blurb: 'Wait',
    defaults: { ms: 1000 },
    fields: [['ms', 'number']],
    sub: (c) => `${c.ms ?? 0}ms`,
  },
  log: {
    blurb: 'Record a line',
    defaults: { message: '' },
    fields: [['message', 'text']],
    sub: (c) => c.message || '—',
  },
  set: {
    blurb: 'Write values into the run',
    defaults: { values: {} },
    fields: [['values', 'json']],
    sub: (c) => Object.keys(c.values ?? {}).join(', ') || '—',
  },
  condition: {
    blurb: 'Branch on a value',
    defaults: { path: '', op: 'eq', value: '' },
    fields: [['path', 'text'], ['op', 'select', OPS], ['value', 'text']],
    branches: true,
    sub: (c) => `${c.path || '?'} ${c.op || 'eq'} ${c.op === 'exists' ? '' : (c.value ?? '')}`.trim(),
  },
  bus: {
    blurb: 'Post a message to the court',
    defaults: { to: '', body: '' },
    fields: [['to', 'text'], ['body', 'text'], ['from', 'text'], ['kind', 'text']],
    sub: (c) => `→ ${c.to || 'everyone'}`,
  },
  transform: {
    blurb: 'Filter and pick over an array',
    defaults: { from: '', to: '' },
    fields: [['from', 'text'], ['to', 'text'], ['filter', 'json'], ['pick', 'json']],
    sub: (c) => c.from || '—',
  },
  foreach: {
    blurb: 'Repeat a sub-chain per item',
    defaults: { from: '', item: 'item', body: [] },
    fields: [['from', 'text'], ['item', 'text'], ['to', 'text'], ['body', 'json']],
    sub: (c) => `each ${c.item || 'item'} of ${c.from || '—'}`,
  },
};

/** The palette's order. The self-check asserts it against the engine's NODE_TYPES. */
export const PALETTE = Object.keys(TYPES);

// --- pure graph edits -----------------------------------------------------

/** Both branch targets of a node, whichever form `next` is in. */
export const targetsOf = (n) =>
  (n?.next && typeof n.next === 'object' ? [n.next.then, n.next.else] : [n?.next]).filter(Boolean);

/**
 * Give every node without coordinates a place, by walking `next` from the start
 * node: depth is the column, arrival order within a depth is the row. Nodes no
 * chain reaches still have to be reachable by the sovereign's mouse, so they
 * land in a column of their own past the end rather than stacked on the origin.
 *
 * Nodes that already carry x/y are left exactly where they were put — this runs
 * on every repaint, and a layout that moved a dragged node back would make the
 * drag look broken.
 */
export function autoLayout(nodes = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map();
  let frontier = nodes[0] ? [nodes[0].id] : [];
  let d = 0;
  while (frontier.length && d <= nodes.length) {
    const next = [];
    for (const id of frontier) {
      if (depth.has(id) || !byId.has(id)) continue;   // also the cycle guard
      depth.set(id, d);
      next.push(...targetsOf(byId.get(id)));
    }
    frontier = next;
    d++;
  }
  const orphanCol = depth.size ? Math.max(...depth.values()) + 1 : 0;
  const rows = new Map();
  for (const n of nodes) {
    const col = depth.get(n.id) ?? orphanCol;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    if (typeof n.x !== 'number') n.x = PAD + col * (NODE_W + GAP_X);
    if (typeof n.y !== 'number') n.y = PAD + row * (NODE_H + GAP_Y);
  }
  return nodes;
}

/**
 * Point `fromId` at `toId`; a null target clears that connection.
 *
 * A condition keeps both branches, so wiring "then" must not drop "else" —
 * that is the whole reason this is a function and not an assignment at three
 * call sites.
 */
export function wire(nodes, fromId, branch, toId) {
  const from = nodes.find((n) => n.id === fromId);
  // A node pointing at itself is a guaranteed loop-guard abort at run time
  // (workflows.js:118), so it is refused at the gesture instead.
  if (!from || fromId === toId) return nodes;
  if (TYPES[from.type]?.branches) {
    const key = branch === 'else' ? 'else' : 'then';
    const next = { ...(from.next && typeof from.next === 'object' ? from.next : {}) };
    if (toId) next[key] = toId; else delete next[key];
    if (Object.keys(next).length) from.next = next; else delete from.next;
  } else if (toId) from.next = toId;
  else delete from.next;
  return nodes;
}

/**
 * Delete a node AND every pointer at it. Leaving the pointers behind does not
 * fail loudly — runWorkflow stops with "no such node" mid-run
 * (workflows.js:120), which reads as a broken automation, not a broken delete.
 */
export function removeNode(nodes, id) {
  const out = nodes.filter((n) => n.id !== id);
  for (const n of out) {
    if (n.next === id) delete n.next;
    else if (n.next && typeof n.next === 'object') {
      if (n.next.then === id) delete n.next.then;
      if (n.next.else === id) delete n.next.else;
      if (!Object.keys(n.next).length) delete n.next;
    }
  }
  return out;
}

/** A fresh node of `type`, with an id nothing else is using. */
export function newNode(type, x, y, existing = []) {
  const taken = new Set(existing);
  let id = type, n = 2;
  while (taken.has(id)) id = `${type}${n++}`;
  return {
    id, type,
    config: structuredClone(TYPES[type]?.defaults ?? {}),
    x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)),
  };
}

/** Make `id` the node the run starts from — the engine begins at nodes[0]. */
export function makeStart(nodes, id) {
  const i = nodes.findIndex((n) => n.id === id);
  if (i > 0) nodes.unshift(nodes.splice(i, 1)[0]);
  return nodes;
}

// --- the widget -----------------------------------------------------------

const el = (tag, cls, text) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};
const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);

/**
 * A wire, drawn as a horizontal-tangent cubic so two edges leaving the same
 * node stay tellable apart even when their targets are stacked vertically.
 */
function path(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

const portAt = (n, which) => ({
  x: n.x + (which === 'in' ? 0 : NODE_W),
  y: n.y + (which === 'else' ? NODE_H * 0.72 : which === 'then' ? NODE_H * 0.28 : NODE_H / 2),
});

/**
 * Draw `nodes` into `host` and let them be edited.
 *
 * `nodes` is mutated in place: the caller keeps the array it passed in, which
 * is the same array it saves. `onChange()` fires after any edit that changes
 * the graph, `onSelect(node)` after the selection moves.
 */
export function mount(host, nodes, { onChange, onSelect } = {}) {
  host.classList.add('wfgraph');
  host.textContent = '';
  const wires = svgEl('svg');
  wires.setAttribute('class', 'wires');
  const layer = el('div', 'wfnodes');
  host.append(wires, layer);

  let selected = null;
  let trace = null;                       // id -> {id, ok, error} from the last run
  let liveWire = null;                    // {from, branch, to:{x,y}} while dragging one

  // Pointer positions arrive in SCREEN pixels; node coordinates are host-local.
  // The panel rides the canvas transform (win.js:28), so at any zoom other than
  // 1 an unscaled position makes the node drift away from the cursor — the same
  // bug win.js:145 documents for the panels themselves. The zoom is measured
  // off the element rather than read from canvas.js: the rendered width over
  // the laid-out width IS the total scale, whatever ancestor applied it, and it
  // keeps this file import-free so the tests can load it.
  const local = (e) => {
    const r = host.getBoundingClientRect();
    const k = host.offsetWidth ? r.width / host.offsetWidth : 1;
    return {
      x: (e.clientX - r.left) / k + host.scrollLeft,
      y: (e.clientY - r.top) / k + host.scrollTop,
    };
  };

  function paintWires() {
    wires.textContent = '';
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let w = 0, h = 0;
    for (const n of nodes) { w = Math.max(w, n.x + NODE_W); h = Math.max(h, n.y + NODE_H); }
    wires.setAttribute('width', w + PAD * 2);
    wires.setAttribute('height', h + PAD * 2);
    const line = (a, b, cls) => {
      const p = svgEl('path');
      p.setAttribute('d', path(a, b));
      p.setAttribute('class', cls);
      wires.append(p);
    };
    for (const n of nodes) {
      const pairs = TYPES[n.type]?.branches
        ? [['then', n.next?.then], ['else', n.next?.else]]
        : [['out', typeof n.next === 'string' ? n.next : null]];
      for (const [which, to] of pairs) {
        if (to && byId.has(to)) line(portAt(n, which), portAt(byId.get(to), 'in'), `wire ${which}`);
      }
    }
    if (liveWire) {
      const from = nodes.find((n) => n.id === liveWire.from);
      if (from) line(portAt(from, liveWire.branch), liveWire.to, 'wire live');
    }
  }

  function paint() {
    autoLayout(nodes);
    layer.textContent = '';
    for (const [i, n] of nodes.entries()) {
      const spec = TYPES[n.type];
      const node = el('div', 'wfnode');
      node.dataset.id = n.id;
      node.style.cssText = `left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px`;
      if (n.id === selected) node.classList.add('sel');
      if (i === 0) node.classList.add('start');
      if (!spec) node.classList.add('unknown');
      const t = trace?.get(n.id);
      if (t) {
        node.classList.add(t.ok ? 'ok' : 'fail');
        if (t.error) node.title = t.error;
      }

      const head = el('div', 'wfn-head');
      head.append(el('span', 'wfn-type', n.type), el('span', 'wfn-id', n.id));
      node.append(head, el('div', 'wfn-sub', spec?.sub?.(n.config ?? {}) ?? 'unknown node type'));

      const inPort = el('b', 'wfport in');
      inPort.title = 'Drop a wire here';
      node.append(inPort);
      for (const which of spec?.branches ? ['then', 'else'] : ['out']) {
        const p = el('b', `wfport ${which}`);
        p.dataset.id = n.id;
        p.dataset.branch = which;
        p.title = which === 'out' ? 'Drag to the next node' : `Drag to the node for “${which}”`;
        node.append(p);
      }
      const x = el('button', 'wfn-x', '×');
      x.title = 'Delete this node';
      x.onclick = (e) => { e.stopPropagation(); del(n.id); };
      node.append(x);
      layer.append(node);
    }
    paintWires();
  }

  const changed = () => { paint(); onChange?.(); };

  function select(id) {
    selected = id;
    paint();
    onSelect?.(nodes.find((n) => n.id === id) ?? null);
  }

  function del(id) {
    const kept = removeNode(nodes, id);
    nodes.length = 0;
    nodes.push(...kept);
    if (selected === id) selected = null;
    changed();
    onSelect?.(nodes.find((n) => n.id === selected) ?? null);
  }

  // One listener on the surface rather than four per node: paint() rebuilds
  // every element on every edit, and re-attaching handlers each time is work
  // with nothing to show for it.
  host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const port = e.target.closest('.wfport');
    if (port?.dataset.branch) return dragWire(e, port);
    const node = e.target.closest('.wfnode');
    if (node) return dragNode(e, node);
  });

  function dragNode(e, node) {
    const n = nodes.find((x) => x.id === node.dataset.id);
    if (!n) return;
    e.preventDefault();
    select(n.id);
    const p = local(e);
    const dx = p.x - n.x, dy = p.y - n.y;
    let moved = false;
    const move = (m) => {
      const q = local(m);
      n.x = Math.max(0, Math.round(q.x - dx));
      n.y = Math.max(0, Math.round(q.y - dy));
      moved = true;
      paint();
    };
    // pointercancel, not just pointerup: a touch the system takes back for its
    // own gesture never fires pointerup, and without this the node keeps
    // following the finger forever — win.js:161 hit exactly this.
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (moved) onChange?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function dragWire(e, port) {
    e.preventDefault();
    e.stopPropagation();
    liveWire = { from: port.dataset.id, branch: port.dataset.branch, to: local(e) };
    const move = (m) => { liveWire.to = local(m); paintWires(); };
    const up = (m) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const { from, branch } = liveWire;
      liveWire = null;
      // Released on a node connects to it; released on bare surface clears the
      // connection — otherwise unwiring would need a gesture of its own.
      const drop = m?.target?.closest?.('.wfnode');
      wire(nodes, from, branch, drop ? drop.dataset.id : null);
      changed();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    paintWires();
  }

  paint();
  return {
    paint,
    select,
    selected: () => nodes.find((n) => n.id === selected) ?? null,
    /** Drop a new node of `type` at a screen point — the palette's other half. */
    dropNew(type, clientX, clientY) {
      const p = local({ clientX, clientY });
      const n = newNode(type, p.x - NODE_W / 2, p.y - NODE_H / 2, nodes.map((x) => x.id));
      nodes.push(n);
      select(n.id);
      onChange?.();
      return n;
    },
    /** Promote the selected node to the start of the run. */
    start(id) {
      makeStart(nodes, id);
      changed();
    },
    /** Colour the graph with the outcome of a run: steps are {id, ok, error}. */
    showRun(steps) {
      trace = steps ? new Map(steps.map((s) => [s.id, s])) : null;
      paint();
    },
  };
}

// Self-check, the shape court.js/names.js/overview.js already use: everything
// above mount() is pure, and it is the half that decides what actually runs.
// `typeof process` guard because this module is loaded in a browser too, where
// a bare `process` reference is a ReferenceError that takes the page with it.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('graph.js')) {
  const assert = await import('node:assert/strict');
  const a = assert.default ?? assert;
  const { NODE_TYPES } = await import('../src/workflows.js');

  // --- the palette IS the engine's node set ---
  // src/workflows.js imports node:fs, so the browser cannot load it and TYPES
  // has to be a second copy. This is the assertion that keeps the copy honest:
  // a node type added to the engine and forgotten here fails right here rather
  // than quietly never appearing in the palette.
  a.deepEqual([...PALETTE].sort(), [...NODE_TYPES].sort(),
    'TYPES must name exactly the types runNode interprets');
  for (const t of PALETTE) {
    a.ok(TYPES[t].fields.length, `${t} needs at least one editable field`);
    a.equal(typeof TYPES[t].sub({}), 'string', `${t}'s subtitle must survive an empty config`);
  }
  // The condition op list is the other copy of an engine table.
  a.deepEqual(TYPES.condition.fields.find(([k]) => k === 'op')[2], OPS);
  a.equal(TYPES.condition.branches, true, 'only condition branches');
  a.equal(PALETTE.filter((t) => TYPES[t].branches).length, 1);

  // --- autoLayout: depth is the column, and nothing is left on the origin ---
  const chain = [
    { id: 'a', type: 'set', next: 'b' },
    { id: 'b', type: 'condition', next: { then: 'c', else: 'd' } },
    { id: 'c', type: 'log' },
    { id: 'd', type: 'log' },
    { id: 'lost', type: 'log' },          // nothing points at it
  ];
  autoLayout(chain);
  const col = (id) => chain.find((n) => n.id === id).x;
  a.ok(col('b') > col('a'), 'a successor sits to the right of its predecessor');
  a.equal(col('c'), col('d'), 'both branches of a condition share a column');
  a.ok(chain.find((n) => n.id === 'c').y !== chain.find((n) => n.id === 'd').y,
    'and different rows, or one hides the other');
  a.ok(col('lost') > col('c'), 'an unreachable node gets a column past the end, not the origin');
  for (const n of chain) a.equal(typeof n.y, 'number');

  // A cycle must not hang the layout — the engine allows one (the loop guard
  // catches it at run time), so the editor has to be able to DRAW one.
  const loop = [{ id: 'x', type: 'log', next: 'y' }, { id: 'y', type: 'log', next: 'x' }];
  autoLayout(loop);
  a.equal(loop.filter((n) => typeof n.x === 'number').length, 2, 'a cycle lays out and returns');

  // Positions already set are the sovereign's, not the layout's.
  const placed = [{ id: 'p', type: 'log', x: 500, y: 40 }];
  autoLayout(placed);
  a.equal(placed[0].x, 500, 'autoLayout never moves a node that has been placed');

  // --- wire: a condition keeps both branches ---
  const w = [{ id: 'c', type: 'condition' }, { id: 'l', type: 'log' }, { id: 'm', type: 'log' }];
  wire(w, 'c', 'then', 'l');
  wire(w, 'c', 'else', 'm');
  a.deepEqual(w[0].next, { then: 'l', else: 'm' }, 'wiring else must not drop then');
  wire(w, 'c', 'then', null);
  a.deepEqual(w[0].next, { else: 'm' }, 'clearing one branch leaves the other');
  wire(w, 'c', 'else', null);
  a.equal('next' in w[0], false, 'clearing the last branch leaves no empty object behind');
  wire(w, 'l', 'out', 'm');
  a.equal(w[1].next, 'm', 'a non-branching node points with a plain id');
  wire(w, 'l', 'out', 'l');
  a.equal(w[1].next, 'm', 'a self-loop is refused — it can only ever hit the step guard');

  // --- removeNode scrubs every pointer at it, in both forms ---
  const g = [
    { id: 'a', type: 'set', next: 'b' },
    { id: 'b', type: 'condition', next: { then: 'c', else: 'a' } },
    { id: 'c', type: 'log' },
  ];
  const after = removeNode(g, 'c');
  a.equal(after.length, 2);
  a.deepEqual(after.find((n) => n.id === 'b').next, { else: 'a' },
    'the branch pointing at the deleted node is dropped, the other survives');
  const gone = removeNode(after, 'a');
  a.equal('next' in gone.find((n) => n.id === 'b'), false,
    'emptying every branch removes next entirely, not leaves {}');
  a.equal(gone.filter((n) => targetsOf(n).includes('a')).length, 0, 'nothing still points at it');
  // The claim this test exists for: what is left still runs.
  const { runWorkflow } = await import('../src/workflows.js');
  const stale = removeNode([{ id: 'a', type: 'log', config: {}, next: 'b' }, { id: 'b', type: 'log', config: {} }], 'b');
  a.equal((await runWorkflow({ id: 'x', nodes: stale })).ok, true,
    'a graph with a node deleted still runs — a leftover pointer would be "no such node"');

  // --- newNode: unique ids, and the engine's own defaults ---
  const n1 = newNode('log', 10, 20, []);
  a.equal(n1.id, 'log');
  a.deepEqual(n1.config, TYPES.log.defaults);
  a.equal(newNode('log', 0, 0, ['log']).id, 'log2', 'a second one does not collide');
  a.equal(newNode('log', 0, 0, ['log', 'log2']).id, 'log3');
  n1.config.message = 'mutated';
  a.equal(TYPES.log.defaults.message, '', 'defaults are cloned, not shared with the table');
  a.equal(newNode('log', -40, -9, []).x, 0, 'a node dropped past the edge is clamped, not lost');

  // --- makeStart: the engine begins at nodes[0] ---
  const s = [{ id: 'a', type: 'log' }, { id: 'b', type: 'log' }];
  makeStart(s, 'b');
  a.deepEqual(s.map((n) => n.id), ['b', 'a']);
  makeStart(s, 'b');
  a.deepEqual(s.map((n) => n.id), ['b', 'a'], 'making the start node the start is a no-op');
  makeStart(s, 'nope');
  a.deepEqual(s.map((n) => n.id), ['b', 'a'], 'an unknown id changes nothing');

  console.log('graph.js OK — palette matches the engine, layout places every node, '
    + 'wiring keeps both branches, deleting scrubs the pointers at it');
}
