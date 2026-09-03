// A small n8n-style automation engine: a workflow is a JSON node graph
// (trigger + nodes with a `next` pointer), stored as one file per workflow
// and run by a tiny interpreter. No eval, no shell — the node types below
// are the entire surface area, on purpose.
import { readdir, readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_STEPS = 200; // a condition node can cycle; this is the loop guard.
const HTTP_TIMEOUT_MS = 30_000;
const HTTP_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

async function responseText(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > HTTP_RESPONSE_MAX_BYTES) {
      throw new Error(`http: response too large (maximum ${HTTP_RESPONSE_MAX_BYTES} bytes)`);
    }
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > HTTP_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`http: response too large (maximum ${HTTP_RESPONSE_MAX_BYTES} bytes)`);
    }
    chunks.push(value);
  }
}

// --- template interpolation, no eval -----------------------------------

function get(obj, path) {
  return String(path ?? '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** "{{a.b}}" in strings is replaced from ctx; objects/arrays recurse. */
function interp(val, ctx) {
  if (typeof val === 'string') {
    return val.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
      const v = get(ctx, path);
      return v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(val)) return val.map((v) => interp(v, ctx));
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, interp(v, ctx)]));
  return val;
}

function evalCondition(cfg, ctx) {
  const left = get(ctx, cfg.path);
  const right = cfg.value;
  switch (cfg.op) {
    case 'eq': return String(left) === String(right);
    case 'neq': return String(left) !== String(right);
    case 'gt': return Number(left) > Number(right);
    case 'lt': return Number(left) < Number(right);
    case 'contains': return String(left ?? '').includes(String(right));
    case 'exists': return left !== undefined && left !== null;
    default: throw new Error(`condition: unknown op "${cfg.op}"`);
  }
}

// --- node execution -------------------------------------------------------

/**
 * Every type `runNode` below handles, named once so the UI's node palette can
 * be asserted against it rather than drifting from it. The self-check runs one
 * of each through the interpreter, so a type added to the switch and forgotten
 * here — or listed here and never implemented — fails the suite instead of
 * surfacing as a palette chip that produces an unrunnable graph.
 */
export const NODE_TYPES = ['http', 'delay', 'log', 'set', 'condition', 'bus', 'transform', 'foreach'];

async function runNode(node, ctx, { bus, budget, workflowId } = {}) {
  if (budget && ++budget.used > MAX_STEPS) throw new Error(`foreach: max steps exceeded (${MAX_STEPS})`);
  const cfg = interp(node.config ?? {}, ctx);
  switch (node.type) {
    case 'http': {
      const method = String(cfg.method || 'GET').toUpperCase();
      const r = await fetch(cfg.url, {
        method,
        headers: cfg.headers,
        body: ['GET', 'HEAD'].includes(method) || cfg.body === undefined ? undefined : JSON.stringify(cfg.body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const text = await responseText(r);
      let body; try { body = JSON.parse(text); } catch { body = text; }
      ctx[node.id] = { status: r.status, body };
      return true;
    }
    case 'delay':
      await new Promise((res) => setTimeout(res, Number(cfg.ms) || 0));
      return true;
    case 'log':
      (ctx.log ??= []).push(cfg.message ?? '');
      return true;
    case 'set':
      Object.assign(ctx, cfg.values ?? {});
      return true;
    case 'condition':
      return evalCondition(cfg, ctx);
    case 'bus':
      if (!bus) throw new Error('bus node: no bus attached to this run');
      bus.post(cfg.from || `workflow:${workflowId ?? 'unknown'}`, cfg.to || null, cfg.body ?? '', cfg.kind || 'message');
      return true;
    // ponytail: filter/pick only, not a general map — enough to shape an http
    // response into what the rest of the graph needs, without an eval.
    case 'transform': {
      const arr = get(ctx, node.config.from);
      if (!Array.isArray(arr)) throw new Error(`transform: "${node.config.from}" is not an array`);
      let out = arr;
      if (node.config.filter) out = out.filter((item) => evalCondition(node.config.filter, item));
      if (node.config.pick) out = out.map((item) => Object.fromEntries(node.config.pick.map((k) => [k, item?.[k]])));
      ctx[node.config.to || node.id] = out;
      return true;
    }
    // ponytail: the body is a flat sub-chain run in array order (no branching
    // inside it) — a real sub-graph would need its own next-pointer stack,
    // more than a prototype's "do this per item" case needs.
    case 'foreach': {
      const arr = get(ctx, node.config.from);
      if (!Array.isArray(arr)) throw new Error(`foreach: "${node.config.from}" is not an array`);
      if (arr.length > MAX_STEPS) throw new Error(`foreach: too many items (maximum ${MAX_STEPS})`);
      const itemVar = node.config.item || 'item';
      const results = [];
      budget ??= { used: 0 };
      for (const item of arr) {
        const subCtx = { ...ctx, [itemVar]: item };
        for (const sub of node.config.body ?? []) await runNode(sub, subCtx, { bus, budget, workflowId });
        results.push(subCtx);
      }
      ctx[node.config.to || node.id] = results;
      return true;
    }
    default:
      throw new Error(`unknown node type "${node.type}"`);
  }
}

/**
 * Runs from the first node in `nodes` until one has no `next`. `next` is
 * either a node id, or `{then, else}` for a condition node's branch.
 * `input` seeds ctx for a webhook or bus trigger's payload.
 */
export async function runWorkflow(wf, { bus, input } = {}) {
  const ctx = input !== undefined ? { input } : {};
  const steps = [];
  const byId = Object.fromEntries((wf.nodes ?? []).map((n) => [n.id, n]));
  let cur = wf.nodes?.[0]?.id;
  let guard = 0;
  while (cur) {
    if (++guard > MAX_STEPS) { steps.push({ id: cur, ok: false, error: 'max steps exceeded' }); break; }
    const node = byId[cur];
    if (!node) { steps.push({ id: cur, ok: false, error: 'no such node' }); break; }
    try {
      const result = await runNode(node, ctx, { bus, workflowId: wf.id });
      steps.push({ id: node.id, type: node.type, ok: true });
      cur = node.next && typeof node.next === 'object' ? node.next[result ? 'then' : 'else'] : node.next;
    } catch (e) {
      steps.push({ id: node.id, type: node.type, ok: false, error: e.message });
      break;
    }
  }
  return { ok: !steps.some((s) => !s.ok), ctx, steps };
}

// --- storage: one JSON file per workflow ----------------------------------

export const validWorkflowId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
const fileOf = (dir, id) => join(dir, `${id}.json`);
const intervalMs = (trigger) => {
  const every = Number(trigger?.everyMs);
  return Number.isFinite(every) && every > 0 ? every : null;
};
const dailyTime = (trigger) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(trigger?.at ?? ''));
  return match && [Number(match[1]), Number(match[2])];
};
const busPattern = (trigger) => String(trigger?.pattern ?? '').trim();
const invalidWorkflow = (message) => Object.assign(new Error(message), { status: 400 });
function validateSchedule(trigger) {
  if (trigger?.type === 'interval' && intervalMs(trigger) == null) {
    throw invalidWorkflow('interval trigger needs a positive finite everyMs');
  }
  if (trigger?.type === 'daily' && !dailyTime(trigger)) {
    throw invalidWorkflow('daily trigger needs a time from 00:00 to 23:59');
  }
  if (trigger?.type === 'bus' && !busPattern(trigger)) {
    throw invalidWorkflow('bus trigger needs a non-empty pattern');
  }
}

export async function listWorkflows(dir, { onInvalid } = {}) {
  let files;
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const workflows = await Promise.all(files.map(async (f) => {
    try { return JSON.parse(await readFile(join(dir, f), 'utf8')); }
    catch (error) {
      if (!onInvalid) throw error;
      onInvalid(f, error);
      return undefined;
    }
  }));
  return workflows.filter((wf) => wf !== undefined);
}

export async function saveWorkflow(dir, wf) {
  if (!validWorkflowId(wf.id)) throw new Error('workflow id must use letters, numbers, underscores, or hyphens');
  if (!Array.isArray(wf.nodes)) throw invalidWorkflow('workflow nodes must be an array');
  validateSchedule(wf.trigger);
  await mkdir(dir, { recursive: true });
  await writeFile(fileOf(dir, wf.id), JSON.stringify(wf, null, 2));
  return wf;
}

export async function deleteWorkflow(dir, id) {
  if (!validWorkflowId(id)) throw new Error('workflow id must use letters, numbers, underscores, or hyphens');
  try { await unlink(fileOf(dir, id)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/**
 * Records a run onto the bus's own event log — reusing the table that already
 * exists rather than a second run-history file, and for free it makes past
 * runs show up in `recall` too. `agent` is namespaced (`workflow:<id>`) so a
 * workflow's runs never collide with a real court member's events.
 */
export function logRun(bus, wf, result) {
  bus.logEvent(`workflow:${wf.id}`, 'workflow_run', {
    name: wf.name, ok: result.ok, steps: result.steps.length,
    error: result.steps.find((s) => !s.ok)?.error,
  });
}

export const runHistory = (bus, id, limit = 20) =>
  bus.events({ agent: `workflow:${id}`, type: 'workflow_run', limit, tail: true });

// --- interval + bus-message scheduling --------------------------------------
//
// One in-memory "last ran"/cursor map, checked on a poll rather than one
// setInterval per workflow — same tradeoff bus.js documents for its own 300ms
// poll: fewer moving parts than per-item timers, and new/edited workflows are
// picked up on the very next tick with no re-registration step. Both maps
// reset on daemon restart: an interval workflow fires once on the next tick
// after a restart instead of waiting out its remaining period, and a bus
// trigger simply starts watching from "now" — fine for a prototype.
const lastRun = new Map();
const busCursor = new Map();
const unreadableWorkflowFiles = new Set();
let schedulerRunning = false;

/** Call periodically (daemon.js runs this off a setInterval). */
export async function tickScheduler(dir, { bus, onRun } = {}) {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    const fire = async (wf, input) => {
      const result = await runWorkflow(wf, { bus, input }).catch((e) => ({ ok: false, error: e.message, steps: [] }));
      if (bus) logRun(bus, wf, result);
      onRun?.(wf, result);
    };
    for (const wf of await listWorkflows(dir, {
      onInvalid: (file, error) => {
        if (unreadableWorkflowFiles.has(file)) return;
        unreadableWorkflowFiles.add(file);
        console.error(`workflow scheduler: skipped unreadable ${file}: ${error.message}`);
      },
    })) {
      if (!wf || typeof wf !== 'object' || Array.isArray(wf)) continue;
      if (wf.enabled === false) continue;
      if (wf.trigger?.type === 'interval') {
        const every = intervalMs(wf.trigger);
        if (every == null) continue;
        const last = lastRun.get(wf.id) ?? 0;
        if (now - last < every) continue;
        lastRun.set(wf.id, now);
        await fire(wf, undefined);
      } else if (wf.trigger?.type === 'daily') {
        const time = dailyTime(wf.trigger);
        if (!time) continue;
        const d = new Date(now);
        const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), ...time).getTime();
        if (now < target) continue;                        // today's time hasn't come yet
        if ((lastRun.get(wf.id) ?? 0) >= target) continue;  // already fired for today's target
        lastRun.set(wf.id, now);
        await fire(wf, undefined);
      } else if (wf.trigger?.type === 'bus' && bus) {
        const pattern = busPattern(wf.trigger);
        if (!pattern) continue;
        if (!busCursor.has(wf.id)) {
          // First sight: start watching from "now", not from message #0. Set
          // once and stop — recomputing "now" on every empty tick would keep
          // moving the floor forward and could skip the very message that
          // arrives between one tick and the next.
          busCursor.set(wf.id, bus.history({ limit: 1, tail: true })[0]?.id ?? 0);
          continue;
        }
        const rows = bus.history({ since: busCursor.get(wf.id), limit: 50 });
        if (!rows.length) continue;
        busCursor.set(wf.id, Math.max(...rows.map((r) => r.id)));
        for (const m of rows) if (m.sender !== `workflow:${wf.id}` && m.body.includes(pattern)) await fire(wf, m);
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

if (process.argv[1]?.endsWith('workflows.js')) {
  const { strict: a } = await import('node:assert');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const src = await readFile(new URL(import.meta.url), 'utf8');

  // set -> condition -> branch -> log
  const wf = {
    id: 'wf1',
    name: 'branch test',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'a', type: 'set', config: { values: { n: 5 } }, next: 'b' },
      { id: 'b', type: 'condition', config: { path: 'n', op: 'gt', value: 3 }, next: { then: 'c', else: 'd' } },
      { id: 'c', type: 'log', config: { message: 'n is big: {{n}}' } },
      { id: 'd', type: 'log', config: { message: 'n is small' } },
    ],
  };
  const r1 = await runWorkflow(wf);
  a.equal(r1.ok, true);
  a.deepEqual(r1.steps.map((s) => s.id), ['a', 'b', 'c'], 'condition true takes the then branch');
  a.deepEqual(r1.ctx.log, ['n is big: 5'], 'interpolation reads the ctx a set node wrote');

  // else branch
  wf.nodes[0].config.values.n = 1;
  const r2 = await runWorkflow(wf);
  a.deepEqual(r2.steps.map((s) => s.id), ['a', 'b', 'd'], 'condition false takes the else branch');

  const templatedCondition = await runWorkflow({
    id: 'templated-condition', trigger: { type: 'manual' },
    nodes: [
      { id: 'a', type: 'set', config: { values: { actual: 'ready', expected: 'ready' } }, next: 'b' },
      { id: 'b', type: 'condition', config: { path: 'actual', op: 'eq', value: '{{expected}}' }, next: { then: 'c', else: 'd' } },
      { id: 'c', type: 'log', config: { message: 'matched' } },
      { id: 'd', type: 'log', config: { message: 'missed' } },
    ],
  });
  a.deepEqual(templatedCondition.steps.map((s) => s.id), ['a', 'b', 'c'], 'condition values must interpolate from the workflow context');

  // an infinite loop is caught by the step guard, not left to hang forever
  const loopy = {
    id: 'loop', trigger: { type: 'manual' },
    nodes: [{ id: 'x', type: 'log', config: { message: 'again' }, next: 'x' }],
  };
  const r3 = await runWorkflow(loopy);
  a.equal(r3.ok, false);
  a.equal(r3.steps.length, MAX_STEPS + 1, 'aborts at the guard, not before, not after');

  // a bus node posts through whatever bus is handed in
  const posted = [];
  const fakeBus = { post: (...args) => posted.push(args) };
  const busWf = {
    id: 'busy', trigger: { type: 'manual' },
    nodes: [{ id: 'p', type: 'bus', config: { to: 'coder', body: 'hello from a workflow' } }],
  };
  await runWorkflow(busWf, { bus: fakeBus });
  a.deepEqual(posted[0].slice(0, 3), ['workflow:busy', 'coder', 'hello from a workflow']);

  // an unknown node type fails that step and stops, rather than doing nothing silently
  const bad = { id: 'bad', trigger: { type: 'manual' }, nodes: [{ id: 'z', type: 'nope', config: {} }] };
  const r4 = await runWorkflow(bad);
  a.equal(r4.ok, false);
  a.ok(r4.steps[0].error.includes('unknown node type'));

  // NODE_TYPES is what the UI's palette is asserted against, so it has to stay
  // exactly the switch in runNode — both ways. The list is checked against the
  // cases in the source, and every entry is then actually run, so a name that
  // is merely spelled right in both places still has to interpret.
  const runNodeSrc = src.slice(src.indexOf('async function runNode'), src.indexOf('* Runs from the first node'));
  a.deepEqual(
    [...runNodeSrc.matchAll(/^ {4}case '(\w+)':/gm)].map((m) => m[1]).sort(),
    [...NODE_TYPES].sort(),
    'NODE_TYPES and runNode\'s switch must name the same set');
  // Configs chosen to fail fast and locally — http gets an unparseable URL so
  // nothing leaves the machine. The claim is only "the interpreter knows this
  // type", so any error EXCEPT "unknown node type" passes.
  const MINIMAL = {
    http: { url: '' }, delay: { ms: 0 }, log: { message: 'x' }, set: { values: {} },
    condition: { path: 'x', op: 'exists' }, bus: { body: 'x' },
    transform: { from: 'missing' }, foreach: { from: 'missing' },
  };
  for (const type of NODE_TYPES) {
    const r = await runWorkflow(
      { id: 'probe', trigger: { type: 'manual' }, nodes: [{ id: 'n', type, config: MINIMAL[type] }] },
      { bus: { post() {} } });
    a.doesNotMatch(r.steps[0].error ?? '', /unknown node type/, type + ' must be interpretable');
  }

  // An outbound step needs a deadline. This mock never reaches the network;
  // it only proves the interpreter passes a cancellation signal to fetch.
  const realFetch = globalThis.fetch;
  try {
    let signal;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      throw new Error('simulated network failure');
    };
    const timed = await runWorkflow({
      id: 'timed-http', trigger: { type: 'manual' },
      nodes: [{ id: 'http', type: 'http', config: { url: 'https://example.test' } }],
    });
    a.ok(signal instanceof AbortSignal, 'an http node must give fetch a cancellation signal');
    a.equal(timed.ok, false, 'a failed timed request remains a failed workflow step');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Node fetch rejects GET/HEAD request bodies. Keep legacy JSON workflows
  // runnable by omitting that body at the execution boundary.
  const realFetchMethod = globalThis.fetch;
  try {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(options);
      return new Response('{}', { status: 200 });
    };
    const getWithBody = await runWorkflow({
      id: 'get-body', trigger: { type: 'manual' },
      nodes: [{ id: 'http', type: 'http', config: { url: 'https://example.test', method: 'GET', body: { ignored: true } } }],
    });
    const postWithBody = await runWorkflow({
      id: 'post-body', trigger: { type: 'manual' },
      nodes: [{ id: 'http', type: 'http', config: { url: 'https://example.test', method: 'POST', body: { kept: true } } }],
    });
    a.equal(getWithBody.ok, true, 'a GET workflow with a legacy body must remain runnable');
    a.equal(requests[0].body, undefined, 'GET must never pass a body to fetch');
    a.equal(postWithBody.ok, true, 'a POST workflow with a body must remain runnable');
    a.equal(requests[1].body, '{"kept":true}', 'POST keeps its configured JSON body');
  } finally {
    globalThis.fetch = realFetchMethod;
  }

  // A remote endpoint can also send an unbounded response. The interpreter
  // must reject it before it becomes workflow context.
  const realFetchBody = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
    const oversizedResponse = await runWorkflow({
      id: 'large-http', trigger: { type: 'manual' },
      nodes: [{ id: 'http', type: 'http', config: { url: 'https://example.test' } }],
    });
    a.equal(oversizedResponse.ok, false, 'an oversized http response must fail the workflow step');
    a.match(oversizedResponse.steps[0].error, /response too large/);
  } finally {
    globalThis.fetch = realFetchBody;
  }

  const realFetchFallback = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ status: 200, text: async () => 'x'.repeat(2 * 1024 * 1024 + 1) });
    const oversizedFallback = await runWorkflow({
      id: 'large-fallback', trigger: { type: 'manual' },
      nodes: [{ id: 'http', type: 'http', config: { url: 'https://example.test' } }],
    });
    a.equal(oversizedFallback.ok, false, 'a non-streaming oversized response must also fail');
    a.match(oversizedFallback.steps[0].error, /response too large/);
  } finally {
    globalThis.fetch = realFetchFallback;
  }

  // transform: filter then pick, no eval involved
  const transformWf = {
    id: 't1', trigger: { type: 'manual' },
    nodes: [
      { id: 'a', type: 'set', config: { values: { rows: [{ id: 1, s: 'open', n: 'a' }, { id: 2, s: 'closed', n: 'b' }, { id: 3, s: 'open', n: 'c' }] } }, next: 'b' },
      { id: 'b', type: 'transform', config: { from: 'rows', to: 'open', filter: { path: 's', op: 'eq', value: 'open' }, pick: ['id'] } },
    ],
  };
  const r5 = await runWorkflow(transformWf);
  a.deepEqual(r5.ctx.open, [{ id: 1 }, { id: 3 }], 'closed rows dropped, only "id" kept');

  // foreach: a flat sub-chain runs once per item, each with its own ctx
  const posted2 = [];
  const busForEach = { post: (...args) => posted2.push(args) };
  const foreachWf = {
    id: 'f1', trigger: { type: 'manual' },
    nodes: [
      { id: 'a', type: 'set', config: { values: { names: ['x', 'y'] } }, next: 'b' },
      { id: 'b', type: 'foreach', config: { from: 'names', item: 'n', body: [
        { id: 'inner', type: 'bus', config: { to: null, body: 'hi {{n}}' } },
      ] } },
    ],
  };
  await runWorkflow(foreachWf, { bus: busForEach });
  a.deepEqual(posted2.map((p) => p[2]), ['hi x', 'hi y'], 'each iteration sees its own item via {{n}}');

  // Webhook input can supply the source array, so foreach needs the same
  // established work bound as the graph itself.
  const oversizedForEach = await runWorkflow({
    id: 'too-many-items', trigger: { type: 'manual' },
    nodes: [
      { id: 'a', type: 'set', config: { values: { items: Array.from({ length: MAX_STEPS + 1 }, (_, i) => i) } }, next: 'b' },
      { id: 'b', type: 'foreach', config: { from: 'items', body: [] } },
    ],
  });
  a.equal(oversizedForEach.ok, false, 'an oversized foreach must fail instead of consuming unbounded work');
  a.match(oversizedForEach.steps.at(-1).error, /too many items/);

  const oversizedBody = await runWorkflow({
    id: 'too-many-substeps', trigger: { type: 'manual' },
    nodes: [{ id: 'b', type: 'foreach', config: {
      from: 'input.items', body: [{ id: 'one', type: 'log' }, { id: 'two', type: 'log' }],
    } }],
  }, { input: { items: Array(MAX_STEPS).fill('x') } });
  a.equal(oversizedBody.ok, false, 'foreach subnodes share the same total work budget');
  a.match(oversizedBody.steps[0].error, /max steps exceeded/);

  // storage round-trips through real files
  const dir = await mkdtemp(join(tmpdir(), 'wf-test-'));
  a.deepEqual(await listWorkflows(dir), [], 'an empty dir lists as empty');
  a.deepEqual(await listWorkflows(join(dir, 'missing')), [], 'a missing dir lists as empty');
  await writeFile(join(dir, 'broken.json'), '{not json');
  await a.rejects(() => listWorkflows(dir), SyntaxError, 'malformed workflow JSON must reach callers');
  let invalidFiles = 0;
  a.deepEqual(await listWorkflows(dir, { onInvalid: () => invalidFiles++ }), [], 'a caller can skip unreadable workflow files');
  a.equal(invalidFiles, 1, 'a skipped workflow must be reported to the caller');
  await rm(join(dir, 'broken.json'));
  await saveWorkflow(dir, wf);
  a.equal((await listWorkflows(dir))[0].id, 'wf1');
  await a.rejects(() => listWorkflows(fileOf(dir, 'wf1')), (e) => e.code === 'ENOTDIR',
    'a real directory read failure must reach callers');
  await deleteWorkflow(dir, 'wf1');
  a.deepEqual(await listWorkflows(dir), []);

  await a.rejects(
    () => saveWorkflow(dir, { id: 'bad-interval', trigger: { type: 'interval', everyMs: -1 }, nodes: [] }),
    /positive finite everyMs/, 'a non-positive interval must be refused before it can schedule every tick');
  await a.rejects(
    () => saveWorkflow(dir, { id: 'bad-daily', trigger: { type: 'daily', at: '25:99' }, nodes: [] }),
    /00:00 to 23:59/, 'an invalid daily time must not be normalized into another day');
  await a.rejects(
    () => saveWorkflow(dir, { id: 'bad-nodes', trigger: { type: 'manual' }, nodes: {} }),
    /workflow nodes must be an array/, 'a workflow graph must remain an array at the persistence boundary');
  await a.rejects(
    () => saveWorkflow(dir, { id: 'bad-bus', trigger: { type: 'bus', pattern: '   ' }, nodes: [] }),
    /non-empty pattern/, 'a blank bus trigger must be refused instead of silently never firing');

  // Missing files are idempotent, but a real unlink failure must reach callers.
  await mkdir(fileOf(dir, 'blocked'));
  await a.rejects(() => deleteWorkflow(dir, 'blocked'), (e) => ['EPERM', 'EISDIR'].includes(e.code));
  await rm(fileOf(dir, 'blocked'), { recursive: true, force: true });

  // logRun/runHistory: a run's outcome lands on the real bus and reads back
  const { Bus } = await import('./bus.js');
  const realBus = new Bus(':memory:');
  await saveWorkflow(dir, busWf);
  const runResult = await runWorkflow(busWf, { bus: realBus });
  logRun(realBus, busWf, runResult);
  a.equal(runHistory(realBus, 'busy').length, 1);
  a.equal(runHistory(realBus, 'busy')[0].payload.ok, true);
  a.equal(runHistory(realBus, 'nonexistent').length, 0);

  // the scheduler only fires an interval workflow once its period has elapsed
  await saveWorkflow(dir, { id: 'ticker', trigger: { type: 'interval', everyMs: 60_000 }, nodes: busWf.nodes });
  let runs = 0;
  await tickScheduler(dir, { bus: realBus, onRun: () => runs++ });
  await tickScheduler(dir, { bus: realBus, onRun: () => runs++ });
  a.equal(runs, 1, 'a second tick inside the same period must not re-fire it');
  await deleteWorkflow(dir, 'ticker');

  await saveWorkflow(dir, { id: 'slow-ticker', trigger: { type: 'interval', everyMs: 1 }, nodes: [{ id: 'wait', type: 'delay', config: { ms: 999 } }] });
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let now = 10;
  let releaseDelay;
  const delayStarted = new Promise((resolve) => { releaseDelay = resolve; });
  try {
    Date.now = () => now;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms !== 999) return realSetTimeout(callback, ms, ...args);
      if (releaseDelay) {
        const release = releaseDelay;
        releaseDelay = null;
        release(() => callback(...args));
      } else callback(...args);
      return 0;
    };
    let overlapRuns = 0;
    const first = tickScheduler(dir, { bus: realBus, onRun: (w) => { if (w.id === 'slow-ticker') overlapRuns++; } });
    const release = await delayStarted;
    now = 20;
    await tickScheduler(dir, { bus: realBus, onRun: (w) => { if (w.id === 'slow-ticker') overlapRuns++; } });
    release();
    await first;
    a.equal(overlapRuns, 1, 'an overlapping scheduler tick must not duplicate a slow workflow');
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
  await deleteWorkflow(dir, 'slow-ticker');

  await writeFile(join(dir, 'broken-schedule.json'), '{not json');
  await saveWorkflow(dir, { id: 'healthy-sibling', trigger: { type: 'interval', everyMs: 60_000 }, nodes: busWf.nodes });
  let siblingRuns = 0;
  await tickScheduler(dir, { bus: realBus, onRun: (w) => { if (w.id === 'healthy-sibling') siblingRuns++; } });
  a.equal(siblingRuns, 1, 'one unreadable workflow file must not stop a valid scheduled sibling');
  await rm(join(dir, 'broken-schedule.json'));
  await deleteWorkflow(dir, 'healthy-sibling');

  // A manually edited legacy file bypasses saveWorkflow, so the scheduler
  // also refuses it rather than turning a bad negative interval into a run on
  // every five-second poll.
  await writeFile(fileOf(dir, 'legacy-bad-interval'), JSON.stringify({
    id: 'legacy-bad-interval', trigger: { type: 'interval', everyMs: -1 }, nodes: busWf.nodes,
  }));
  await writeFile(fileOf(dir, 'legacy-bad-daily'), JSON.stringify({
    id: 'legacy-bad-daily', trigger: { type: 'daily', at: '25:99' }, nodes: busWf.nodes,
  }));
  let legacyRuns = 0;
  await tickScheduler(dir, { bus: realBus, onRun: () => legacyRuns++ });
  await tickScheduler(dir, { bus: realBus, onRun: () => legacyRuns++ });
  a.equal(legacyRuns, 0, 'a malformed persisted schedule must never run');
  await deleteWorkflow(dir, 'legacy-bad-interval');
  await deleteWorkflow(dir, 'legacy-bad-daily');

  // a daily trigger fires once its time-of-day has passed today, not before,
  // and not a second time later the same day. Wall-clock, like the interval
  // test above — assumes the test isn't run in the last hour before midnight.
  const now2 = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  await saveWorkflow(dir, { id: 'daily-future', trigger: { type: 'daily', at: hhmm(new Date(now2.getTime() + 3600_000)) }, nodes: busWf.nodes });
  await saveWorkflow(dir, { id: 'daily-past', trigger: { type: 'daily', at: hhmm(new Date(now2.getTime() - 60_000)) }, nodes: busWf.nodes });
  const dailyRuns = { future: 0, past: 0 };
  const onDaily = (w) => { if (w.id === 'daily-future') dailyRuns.future++; if (w.id === 'daily-past') dailyRuns.past++; };
  await tickScheduler(dir, { bus: realBus, onRun: onDaily });
  a.equal(dailyRuns.future, 0, 'a daily trigger must not fire before its time today');
  a.equal(dailyRuns.past, 1, 'a daily trigger fires once its time has passed today');
  await tickScheduler(dir, { bus: realBus, onRun: onDaily });
  a.equal(dailyRuns.past, 1, 'and not again later the same day');
  await deleteWorkflow(dir, 'daily-future');
  await deleteWorkflow(dir, 'daily-past');

  // a bus-triggered workflow fires only on a message matching its pattern,
  // and only ever sees messages posted AFTER it started watching
  realBus.post('someone', null, 'irrelevant chatter, posted before the trigger existed');
  await saveWorkflow(dir, { id: 'watcher', trigger: { type: 'bus', pattern: 'deploy finished' }, nodes: busWf.nodes });
  await tickScheduler(dir, { bus: realBus }); // establishes the "watch from now" cursor
  realBus.post('ci', null, 'build failed'); // does not match the pattern
  let watcherRuns = 0;
  await tickScheduler(dir, { bus: realBus, onRun: (w) => { if (w.id === 'watcher') watcherRuns++; } });
  a.equal(watcherRuns, 0, 'a non-matching message must not fire the trigger');
  realBus.post('ci', null, 'deploy finished on prod');
  await tickScheduler(dir, { bus: realBus, onRun: (w) => { if (w.id === 'watcher') watcherRuns++; } });
  a.equal(watcherRuns, 1, 'a matching message fires it exactly once');
  await deleteWorkflow(dir, 'watcher');

  const loopBus = new Bus(':memory:');
  const echoer = { id: 'echoer', trigger: { type: 'bus', pattern: 'echo' }, nodes: [{ id: 'reply', type: 'bus', config: { body: 'echo' } }] };
  await saveWorkflow(dir, echoer);
  await tickScheduler(dir, { bus: loopBus }); // establish the trigger cursor
  loopBus.post('outside', null, 'echo');
  let echoRuns = 0;
  await tickScheduler(dir, { bus: loopBus, onRun: (w) => { if (w.id === 'echoer') echoRuns++; } });
  a.equal(echoRuns, 1, 'an external matching message fires the bus workflow once');
  a.equal(loopBus.history({ limit: 1, tail: true })[0].sender, 'workflow:echoer', 'a workflow must namespace its own bus output');
  await tickScheduler(dir, { bus: loopBus, onRun: (w) => { if (w.id === 'echoer') echoRuns++; } });
  a.equal(echoRuns, 1, 'a workflow must not trigger itself from its own bus output');
  await deleteWorkflow(dir, 'echoer');
  loopBus.close();

  realBus.close();
  await rm(dir, { recursive: true, force: true });

  console.log('workflows.js self-check OK — node graph execution, branching, loop guard, transform, '
    + 'foreach, storage, run history, interval + bus-triggered scheduling');
}
