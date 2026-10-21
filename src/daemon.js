#!/usr/bin/env node
// Runs the team and serves the dashboard over HTTP + SSE.
//
//   node src/daemon.js [repo] [--port 7777] [--config path] [--bind 127.0.0.1]
//
// repo is optional: Chat and Cowork run with none attached, and Code
// mode is refused (see AgenticOS#setMode) until one is picked in the app —
// POST /api/attachRepo, or a repo attached on a previous run and saved to
// the workspace config.
//
// Deliberately its own process rather than living inside Electron: the
// orchestrator needs Node 24's node:sqlite, and this way closing the window
// does not kill the team.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgenticOS, defaultConfigPath } from './agenticos.js';
import { TASK_CLOSED } from './bus.js';
import { stateDir, worktreePath, diffOf, statOf } from './worktree.js';
import { searchVault, recentNotes, readNote } from './vault.js';
import { Speech } from './stt.js';
import { deltaOf, hasUsage, totalsOf } from './usage.js';
import { costClassOf, costOf, tableFrom } from './price.js';
import { readApproval } from './approval.js';
import { inboxBrief, inboxItems, teamDigest } from './inbox.js';
import { WORKFLOW_TEMPLATES, instantiateTemplate } from './workflow-templates.js';
import { listWorkflows, saveWorkflow, deleteWorkflow, runWorkflow, tickScheduler, logRun, runHistory, validWorkflowId } from './workflows.js';
import { runDoctor } from './doctor.js';
import { registerTeam, unregisterTeam, listTeams, TeamConflictError, firstFreePort } from './teams.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'ui');

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.indexOf(n) !== -1 ? argv[argv.indexOf(n) + 1] : d);
const repoArg = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--port'
  && argv[argv.indexOf(a) - 1] !== '--config');

/**
 * No repo on the command line: look for one attached from inside the app on
 * a previous run before settling for none at all. Chat and Cowork don't
 * need one; Code mode is refused until /api/attachRepo gives it one live.
 */
function savedRepo() {
  try {
    const cfg = JSON.parse(readFileSync(defaultConfigPath(null), 'utf8'));
    return cfg.repo && existsSync(join(cfg.repo, '.git')) ? resolve(cfg.repo) : null;
  } catch {
    return null;
  }
}

const repo = repoArg ? resolve(repoArg) : savedRepo();
// A port named explicitly (--port, or AGENTICOS_PORT the way Electron's main
// process pins one) is PINNED: a busy pinned port is a clean, visible error,
// never a silent fallback to something else. With neither given, the port is
// chosen automatically — see the teams.firstFreePort() call beside the real
// .listen() below, once the registry (src/teams.js) can be asked what is
// already taken. `port` starts as a placeholder and is resolved to its real
// value before anything binds; see the trap comment there.
const explicitPort = argv.includes('--port') ? Number(flag('--port'))
  : (process.env.AGENTICOS_PORT ? Number(process.env.AGENTICOS_PORT) : null);
// Where auto-picking starts. 7777 unless AGENTICOS_BASE_PORT moves it — the
// test suites give each daemon-spawning suite its own range so suites that
// run in parallel (each with its own isolated registry) never race for the
// same ports.
const basePort = Number(process.env.AGENTICOS_BASE_PORT) || 7777;
let port = explicitPort ?? basePort;
// A repo named explicitly on the command line gets its own repo-relative
// home (.agenticos/<repoName>/, today's original per-repo layout). A repo
// found via savedRepo() was instead attached LIVE in a previous session —
// per AgenticOS#attachRepo, its config/db/assets stayed at the workspace home
// and never migrated, so rediscovering it here must boot from that same
// home and re-attach, not resolve straight to a repo-relative config/db
// that session never wrote to (which silently forked into a second, empty
// "agenticos" on every repo-less restart).
const homeRepo = repoArg ? repo : null;
const configPath = flag('--config', defaultConfigPath(homeRepo));

// ---- Approve from a phone: bearer-token auth for a non-loopback bind ------
// Loopback (the default) needs nothing beyond originAllowed() below — this
// is purely additive. A bind address reachable from off-machine changes the
// threat model: anyone on that network can open a TCP connection here, so a
// connection that did not arrive over loopback must present a bearer token,
// and even then reaches only reads plus approve/reject/answerQuestion (see
// remoteGate below). Ordering is the whole point: the token exists and the
// refusal below is checked before bindAddr is ever passed to .listen().
const bindAddr = flag('--bind', process.env.AGENTICOS_BIND ?? '127.0.0.1');
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);
const bindIsLoopback = LOOPBACK_BINDS.has(bindAddr);

// AGENTICOS_TEST_DISABLE_TOKEN and AGENTICOS_TEST_FORCE_REMOTE (used in
// remoteConnection() below) exist only for test/t-csrf.js — the same way
// AGENTICOS_CODEX_BIN, AGENTICOS_SETTLE_MS etc. stub real dependencies elsewhere
// in this repo's test suites. Neither is read by electron/main.js or
// documented for real use; a real deploy always generates a real token.
const authToken = process.env.AGENTICOS_TEST_DISABLE_TOKEN === '1'
  ? null
  : randomBytes(32).toString('hex');

if (!bindIsLoopback && !authToken) {
  console.error(`daemon: refusing to bind ${bindAddr} with no bearer token generated — `
    + 'a non-loopback bind must be authenticated. This should never happen outside a test.');
  process.exit(1);
}

// The token is generated, never configured: never read from or written to
// agenticos.config.json, and never printed to stdout/stderr — Electron pipes
// both straight into daemon.log (electron/main.js's startDaemon()), so a
// console.log here would put a working phone credential on disk on every
// boot. Instead it goes to its own untracked file beside this repo's
// existing out-of-tree secret (src/set-token.js's tokens.json is the same
// convention: stateDir is already gitignored), overwritten fresh on every
// start so a stale token never outlives the process that issued it. A
// QR-code-style pairing flow reads this file; that flow is not part of this
// change.
const PHONE_TOKEN_FILE = join(stateDir(homeRepo), 'phone-token.txt');
if (!bindIsLoopback) {
  try {
    mkdirSync(dirname(PHONE_TOKEN_FILE), { recursive: true });
    writeFileSync(PHONE_TOKEN_FILE, `${authToken}\n`, { mode: 0o600 });
  } catch (e) {
    console.error(`daemon: could not write the phone approval token to disk: ${e.message}`);
  }
} else {
  try { unlinkSync(PHONE_TOKEN_FILE); } catch { /* nothing to clean up */ }
}

const agenticos = new AgenticOS(homeRepo, configPath);
const speech = new Speech(process.env.AGENTICOS_SPEECHBIRD ?? agenticos.config.speechbird);
// res -> conversationId the tab asked to be scoped to, or null for an
// unfiltered subscriber (every non-Chat panel, and any Chat tab that hasn't
// picked a conversation yet).
const clients = new Map();
let ready = false;
let metricsCache = { mark: null, value: null };

/**
 * Team-wide events (roster, mode, budget, approvals, ...) always reach every
 * tab. Only the handful of per-thread event types carry a conversation, and
 * only those get filtered against a scoped client — an event type with no
 * conversation of its own is, by construction, team-wide.
 */
function shouldDeliver(clientConv, type, data) {
  if (clientConv == null) return true;
  if (type === 'event') return (data.conversationId ?? 'default') === clientConv;
  if (type === 'delivered') return (data.msg?.conversation_id ?? 'default') === clientConv;
  if (type === 'conversationSwitched') return data.conversationId === clientConv;
  return true;
}

function push(type, data) {
  // envelope type last: it must never be clobbered by a field of the same name
  const line = `data: ${JSON.stringify({ ...data, type })}\n\n`;
  for (const [res, conv] of clients) if (shouldDeliver(conv, type, data)) res.write(line);
}

for (const ev of ['agent', 'event', 'delivered', 'approval', 'verified', 'merged', 'recycled', 'resolved', 'started', 'failure', 'roster', 'failover', 'mergeFailed', 'pushed', 'pushBlocked', 'spend', 'budget', 'limited', 'advising', 'advisor', 'summarizer', 'goal', 'milestone', 'mode', 'compact', 'argued', 'repo', 'paused', 'run', 'conversationSwitched', 'compacted']) {
  agenticos.on(ev, (d) => {
    if (ev === 'roster') metricsCache.mark = null;
    push(ev, d ?? {});
  });
}
agenticos.on('error', (e) => push('error', { message: e.message }));

// Run templates live in the bus's key-value state: a handful of small records,
// read whole and written whole. An unreadable value reads as no templates.
function readRunTemplates() {
  try {
    const list = JSON.parse(agenticos.bus.get('run-templates') ?? '[]');
    return Array.isArray(list) ? list.sort((x, y) => String(x.name).localeCompare(String(y.name))) : [];
  } catch { return []; }
}
const writeRunTemplates = (list) => agenticos.bus.set('run-templates', JSON.stringify(list));

/** The inbox as of now; shared by /api/inbox and the digest workflow node. */
function inboxNow(now = Date.now()) {
  const bus = agenticos.bus;
  const approvals = bus.pendingApprovals().flatMap((m) => {
    const p = readApproval(m.body);
    return p ? [{ id: m.id, ts: m.ts, from: m.sender, ...p, resolved: null }] : [];
  });
  const messages = bus.history({ agent: 'user', tail: true, limit: 50 }).filter((m) => m.recipient === 'user');
  return inboxItems({ approvals, run: bus.currentRun(), myTasks: bus.myTasks({ includeDone: false }), messages, now });
}

/**
 * What a workflow can do that only the daemon can: build a digest from live
 * state, show it on the user's desktop, put a task on the team queue.
 * Handed to every runWorkflow call (manual, webhook, scheduler).
 */
const WORKFLOW_SERVICES = {
  digest: (of) => {
    const now = Date.now();
    const items = inboxNow(now);
    if (of !== 'team') return inboxBrief(items, { now });
    const bus = agenticos.bus;
    return teamDigest({
      tasks: bus.tasks(), runs: bus.runs(), runSpendUsd: bus.runSpendSince(now - 86_400_000),
      waiting: items.filter((item) => item.tone === 'attention').length, now,
    });
  },
  notify: ({ title, body, workflowId }) => push('digest', { title, body, workflowId }),
  addTask: (task) => {
    const created = agenticos.manageTask({ op: 'create', ...task });
    push('tasks', { tasks: agenticos.bus.tasks() });
    return created;
  },
};

const runIdOf = (body) => body.runId ?? body.run_id ?? body.id ?? null;
const publishRun = (run) => { push('run', { run }); return { run }; };
// baselineRevision is deliberately absent: it is the sole guard Final Apply
// has against a source tree that changed since the run was reviewed, and is
// set exactly once, internally, from revisionOf(this.repo) at createRun
// time. Accepting it here would let any request body overwrite it and
// silently defeat that check.
const runFields = (body) => ({
  objective: body.objective,
  sourceSnapshot: body.sourceSnapshot ?? body.source_snapshot,
  approvedPlan: body.approvedPlan ?? body.approved_plan,
  acceptanceCriteria: body.acceptanceCriteria ?? body.acceptance_criteria,
  allowedModels: body.allowedModels ?? body.allowed_models,
  taskIds: body.taskIds ?? body.task_ids,
  recoveryHistory: body.recoveryHistory ?? body.recovery_history,
  verificationEvidence: body.verificationEvidence ?? body.verification_evidence,
  branch: body.branch,
});

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

/**
 * Read a request body as a Buffer, aborting the connection past `maxBytes`
 * rather than growing a string/array without limit. These are the only
 * routes that read a whole body into memory before validating anything —
 * without a cap, the size check every JSON parser gets for free (a huge
 * string just fails to parse, eventually) doesn't apply until the memory is
 * already spent.
 */
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) { req.destroy(); throw Object.assign(new Error('body too large'), { status: 413 }); }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Backgrounds and music the user uploads. Kept beside the database, i.e.
// OUTSIDE the target repo — a wallpaper must never turn up in a diff.
const ASSETS = join(stateDir(homeRepo), 'assets');
// Automation workflows, same reasoning: they're the team's own tooling, not
// something that belongs in a target repo's diff.
const WORKFLOWS_DIR = join(stateDir(homeRepo), 'workflows');
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const AUDIO = new Set(['.mp3', '.m4a', '.ogg', '.opus', '.wav', '.flac']);
const VIDEO = new Set(['.webm', '.mp4']);
// Source material the user feeds the team to read — not something the
// team writes itself (that's the vault). No .docx/.pptx: those need a real
// parser, and every CLI backend is already a coding agent that can read a
// PDF or a text file by path without one — see mcp.js's list_uploads.
const DOCUMENT = new Set(['.pdf', '.txt', '.md', '.csv', '.json']);

/**
 * Filenames arrive from the browser, so they are untrusted input. Keep the stem
 * and the extension, drop everything else — no separators, no `..`, no leading
 * dot. A name that survives this cannot escape the assets directory.
 */
function safeAsset(name) {
  const ext = extname(String(name ?? '')).toLowerCase();
  if (!IMAGE.has(ext) && !AUDIO.has(ext) && !VIDEO.has(ext) && !DOCUMENT.has(ext)) return null;
  const stem = basename(String(name), ext).replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 80);
  return `${stem || 'upload'}${ext}`;
}

const kindOf = (f) => {
  const e = extname(f).toLowerCase();
  return IMAGE.has(e) ? 'image' : AUDIO.has(e) ? 'audio' : VIDEO.has(e) ? 'video'
    : DOCUMENT.has(e) ? 'document' : null;
};

const ACTIONS = {
  // NOT awaited: with the advisor on, this runs a model call before the message
  // reaches the bus, and holding the POST open for that would look like a hung
  // UI. Progress and failure both arrive on the stream as `advising`.
  command: (b) => { agenticos.command(b.text, b.conversationId, b.attachments).catch((e) => push('error', { message: e.message })); },
  speak: (b) => agenticos.speakTo(b.name, b.text, b.conversationId, b.attachments),
  switchConversation: (b) => agenticos.switchConversation(b.name, b.conversationId),
  // Plain bus CRUD, no orchestration — but other tabs still need to hear
  // about it live, the same as every other state change on this stream.
  renameConversation: (b) => push('conversationRenamed', agenticos.bus.renameConversation(b.id, b.title ?? '')),
  archiveConversation: (b) => { agenticos.bus.archiveConversation(b.id); push('conversationArchived', { id: b.id }); },
  branchConversation: (b) => agenticos.branchFrom(b.name, b.conversationId, Number(b.forkAtMessageId), b.text),
  advisor: (b) => agenticos.setAdvisor(b),
  summarizer: (b) => agenticos.setSummarizer(b),
  goal: (b) => agenticos.setGoal(b),
  mode: (b) => agenticos.setMode(b.mode, { why: b.why ?? '', by: b.by ?? 'user' }),
  // A LIVE attach (this endpoint, or the saved-repo re-attach at boot below)
  // changes what repository THIS daemon serves — the registry row written at
  // boot (with whatever `repo` was known then, including null for a
  // Chat/Cowork daemon that started with none) goes stale the moment this
  // runs unless the registry is told. Without this, two daemons could end
  // up serving the SAME repository with no refusal: a repo-less daemon on
  // one port simply attaches whatever it is given, since AgenticOS#attachRepo
  // only refuses a repo DIFFERENT from one it already holds — the exact
  // corruption one-team-per-repo (issue #42) exists to prevent.
  //
  // So: claim the repo in the registry under its lock BEFORE
  // agenticos.attachRepo does any real work (registerTeam's own conflict
  // check refuses if another live team already holds it, naming that
  // team's port), then attach for real. If the attach itself fails for an
  // unrelated reason (bad git repo, no commits), the claim is rolled back to
  // whatever this daemon actually holds afterward — never left pointing at a
  // repo this daemon did not actually attach.
  attachRepo: async (b) => {
    const target = resolve(String(b.path ?? ''));
    await registerTeam({ repo: target, port, pid: process.pid });
    try {
      return await agenticos.attachRepo(b.path);
    } catch (e) {
      try { await registerTeam({ repo: agenticos.repo, port, pid: process.pid }); } catch { /* best effort rollback */ }
      throw e;
    }
  },
  milestone: (b) => agenticos.setMilestone(Number(b.index), Boolean(b.done)),
  wake: (b) => agenticos.wake(b.name),
  add: (b) => {
    const result = agenticos.requestAdd(b.names, b.reason ?? 'Requested from the Team page.');
    if (!result.ok) throw new Error(result.error);
    return result;
  },
  sleep: (b) => agenticos.sleep(b.name),
  // Compact session: the recycle recycleAtTokens fires, by hand. 409 with a
  // reason (busy | asleep | recycling) when the member cannot be compacted now.
  compactSession: (b) => agenticos.compactSession(b.name, { by: 'user' }),
  pause: (b) => agenticos.pause(b.why ?? ''),
  resume: () => agenticos.resume(),
  setBudget: (b) => agenticos.setBudget(b.capUsd),
  setTurnBudget: (b) => agenticos.setTurnBudget(b.cap),
  raiseTurnBudget: (b) => agenticos.raiseTurnBudget(b.by ?? 100),
  requestPush: (b) => agenticos.requestPush(b.reason ?? ''),
  approve: (b) => agenticos.approve(Number(b.id)),
  reject: (b) => agenticos.reject(Number(b.id), b.why ?? ''),
  answerQuestion: (b) => agenticos.answerQuestion(Number(b.id), b.answers),
  merge: (b) => agenticos.merge(b.agent),
  model: (b) => agenticos.setModel(b.name, {
    cli: b.cli, model: b.model, effort: b.effort, auto: b.auto,
  }),
  domainModel: (b) => agenticos.setDomainModel(b.domain, {
    cli: b.cli, model: b.model, effort: b.effort, auto: b.auto,
  }),
  clearSpend: (b) => agenticos.clearSpend(b.name ?? null),
  // Saved starting points for a run: {op: save|delete, name, objective,
  // acceptanceCriteria[], allowedModels[]}. Kept in the bus beside the team.
  runTemplate: (b) => {
    const templates = readRunTemplates();
    if (b.op === 'delete') {
      writeRunTemplates(templates.filter((t) => t.id !== b.id));
      return { templates: readRunTemplates() };
    }
    if (b.op !== 'save') throw new Error(`Unknown operation "${b.op}".`);
    const name = String(b.name ?? '').trim();
    const objective = String(b.objective ?? '').trim();
    if (!name) throw new Error('A template needs a name.');
    if (!objective) throw new Error('A template needs an objective.');
    const clean = (list) => (Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean);
    const template = {
      id: b.id || `rt-${Date.now().toString(36)}`, name, objective,
      acceptanceCriteria: clean(b.acceptanceCriteria), allowedModels: clean(b.allowedModels), updatedTs: Date.now(),
    };
    writeRunTemplates([...templates.filter((t) => t.id !== template.id), template]);
    return { template, templates: readRunTemplates() };
  },
  // The user's own list: {op: add|update|done|undo|snooze|delete, ...}.
  myTask: (b) => {
    const bus = agenticos.bus;
    const id = Number(b.id);
    const need = () => { if (!bus.myTask(id)) throw new Error(`No task #${b.id} on your list.`); };
    let task = null;
    switch (b.op) {
      case 'add': task = bus.addMyTask({ title: b.title, notes: b.notes, dueTs: b.dueTs ?? null }); break;
      case 'update': need(); task = bus.updateMyTask(id, { title: b.title, notes: b.notes, dueTs: b.dueTs }); break;
      case 'done': need(); task = bus.updateMyTask(id, { doneTs: Date.now() }); break;
      case 'undo': need(); task = bus.updateMyTask(id, { doneTs: null }); break;
      // Snooze pushes the reminder, not the deadline: the due time stays true.
      case 'snooze': need(); task = bus.updateMyTask(id, { snoozedUntil: Date.now() + (Number(b.forMs) > 0 ? Number(b.forMs) : 86_400_000) }); break;
      case 'delete': need(); bus.deleteMyTask(id); break;
      default: throw new Error(`Unknown operation "${b.op}".`);
    }
    push('myTasks', { tasks: bus.myTasks() });
    return { task };
  },
  // The user editing the team queue: {op: create|assign|priority|drop|reopen, ...}.
  // Every open tab hears the new list, not just the one that clicked.
  task: (b) => {
    const task = agenticos.manageTask(b);
    push('tasks', { tasks: agenticos.bus.tasks() });
    return { task };
  },
  // Answer first, then go: the caller must not get a dead socket for a
  // shutdown that actually worked.
  shutdown: () => { setTimeout(() => shutdown(0), 150); },
};

// Each run action answers to two spellings: `run/create` (the HTTP-shaped
// one) and `runCreate` (what ui/run.js posts).
const RUN_ACTIONS = {
  create: (b) => agenticos.createRun({ ...runFields(b), id: b.runId ?? b.id ?? null, state: b.state ?? 'planning' }),
  approve: (b) => agenticos.approveRun(runIdOf(b), runFields(b)),
  pause: (b) => agenticos.pauseRun(runIdOf(b), b.why ?? ''),
  stop: (b) => agenticos.stopRun(runIdOf(b), b.why ?? 'stopped by the user'),
  resume: (b) => agenticos.resumeRun(runIdOf(b)),
  apply: (b) => agenticos.applyRun(runIdOf(b)),
};
for (const [name, act] of Object.entries(RUN_ACTIONS)) {
  const handler = async (b) => publishRun(await act(b));
  ACTIONS[`run/${name}`] = handler;
  ACTIONS[`run${name[0].toUpperCase()}${name.slice(1)}`] = handler;
}

const finiteNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function classOf(classes) {
  return classes.size === 0 ? 'unavailable' : classes.size === 1 ? [...classes][0] : 'mixed';
}

function metricCost(p, d, cli, model, table) {
  const reported = p?.costReported === true
    ? finiteNumber(p.costUsd)
    : p?.costReported == null && finiteNumber(p?.costUsd) > 0
      ? finiteNumber(p.costUsd)
      : null;
  const classification = costClassOf({
    usage: p?.usage == null || !hasUsage(p.usage) ? null : p.usage,
    reported,
    cli,
    model,
    table,
  });
  const parts = {
    fresh: costOf({ fresh: d.fresh, in: d.fresh }, cli, model, table),
    cached: costOf({ fresh: 0, in: d.cached, cached: d.cached }, cli, model, table),
    written: costOf({ fresh: 0, in: d.written, written: d.written }, cli, model, table),
    output: costOf({ fresh: 0, in: 0, out: d.out }, cli, model, table),
  };
  const estimated = Object.values(parts).some((v) => v !== null)
    ? Object.values(parts).reduce((sum, v) => sum + (v ?? 0), 0)
    : null;
  return {
    classification,
    parts,
    total: reported ?? estimated ?? 0,
  };
}

const blankMember = (ev, setting) => ({
  name: ev.agent, turns: 0, adds: 0, in: 0, out: 0, cached: 0, written: 0,
  fresh: 0, ctx: 0, first: ev.ts, ...setting,
  _cost: { fresh: 0, cached: 0, written: 0, output: 0, total: 0 },
  _classes: new Set(),
});

/**
 * What the team has actually cost.
 *
 * The one thing that makes this non-trivial: codex reports `usage` in
 * `turn.completed` CUMULATIVELY PER THREAD, not per turn. It climbs all session
 * and resets when the session restarts. Summing it across turns counts every
 * earlier turn again — measured on a real run, that turned 65M input tokens
 * into an apparent 420M. So take DELTAS, and treat a drop as a new thread.
 */
function buildMetrics() {
  // Filtered in SQL, not after the fact. `events()` JSON.parses every row it
  // returns, so pulling all 20,000 retained events to keep the turn_ends meant
  // parsing the whole log — on every /api/metrics, which the dashboard polls
  // every 5s while the cost panel is open (ui/panels.js).
  const rows = agenticos.bus.events({ limit: 100_000, type: 'turn_end' });
  const addRows = agenticos.bus.events({ limit: 100_000, type: 'added' });
  const prev = new Map();
  const by = new Map();
  const byCli = new Map();   // cli -> tokens burned, for quota-billed backends (see below)
  const def = agenticos.config.agentDefaults ?? {};
  const table = tableFrom(agenticos.config);

  for (const ev of rows) {
    let p;
    try { p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload; } catch { continue; }
    const u = p?.usage ?? {};
    // Via usage.js, like ctx.js and agenticos.js. This was a THIRD hand-rolled
    // copy of the rule and it had drifted the same way the first one did: it
    // knew codex's and Anthropic's names for the cache read but not agy's, so
    // the dashboard's cost panel scored the orchestrator — the one member on agy —
    // as having replayed nothing at all.
    // The delta rule now lives in usage.js beside the cache rule, because this
    // was the ONLY copy of it: ctx.js and agenticos.js summed raw and reported a
    // 25% overcount on real data. Same class of drift as the cache-field names.
    const d = deltaOf(prev.get(ev.agent), u);
    if (hasUsage(u)) prev.set(ev.agent, totalsOf(u));

    const spec = agenticos.specOf(ev.agent) ?? {};
    const cli = p?.cli ?? spec.cli ?? def.cli ?? 'claude';
    const model = p?.model ?? spec.model ?? def.model ?? null;
    const effort = p?.effort ?? spec.effort ?? def.effort ?? null;
    const priced = metricCost(p, d, cli, model, table);
    const m = by.get(ev.agent) ?? blankMember(ev, { cli, model, effort });
    m.turns++;
    m.in += d.in;
    m.out += d.out;
    m.cached += d.cached;
    m.written += d.written;
    m.fresh += d.fresh;
    m.cli = cli;
    m.model = model;
    m.effort = effort;
    for (const key of ['fresh', 'cached', 'written', 'output']) {
      m._cost[key] += priced.parts[key] ?? 0;
    }
    m._cost.total += priced.total;
    m._classes.add(priced.classification);
    m.ctx = p?.ctx ?? m.ctx;                     // latest, not a sum
    m.last = ev.ts;
    by.set(ev.agent, m);

    byCli.set(cli, (byCli.get(cli) ?? 0) + d.in + d.out);
  }

  for (const ev of addRows) {
    const m = by.get(ev.agent) ?? blankMember(ev, { cli: null, model: null, effort: null });
    m.adds++;
    m.last = Math.max(m.last ?? 0, ev.ts);
    by.set(ev.agent, m);
  }

  const members = [...by.values()].map(({ _cost, _classes, ...m }) => ({
    ...m,
    perTurn: m.turns ? Math.round(m.in / m.turns) : 0,
    cacheRate: m.in > 0 ? m.cached / m.in : null,
    cost: { ..._cost, classification: classOf(_classes) },
    costClassification: classOf(_classes),
  })).sort((a, b) => b.in - a.in);

  const total = members.reduce((t, m) => ({
    turns: t.turns + m.turns, adds: t.adds + m.adds,
    in: t.in + m.in, out: t.out + m.out, cached: t.cached + m.cached,
    written: t.written + m.written, fresh: t.fresh + m.fresh,
    cost: {
      fresh: t.cost.fresh + m.cost.fresh,
      cached: t.cost.cached + m.cost.cached,
      written: t.cost.written + m.cost.written,
      output: t.cost.output + m.cost.output,
      total: t.cost.total + m.cost.total,
      _classes: new Set([...t.cost._classes, m.cost.classification]),
    },
  }), {
    turns: 0, adds: 0, in: 0, out: 0, cached: 0, written: 0, fresh: 0,
    cost: { fresh: 0, cached: 0, written: 0, output: 0, total: 0, _classes: new Set() },
  });
  total.cacheRate = total.in > 0 ? total.cached / total.in : null;
  total.cost.classification = classOf(total.cost._classes);
  delete total.cost._classes;

  const aux = { calls: 0, failures: 0, input: 0, cached: 0, written: 0, fresh: 0, output: 0, latencyMs: { p50: 0, p95: 0 }, byPurpose: {} };
  const auxLatency = [];
  for (const ev of agenticos.bus.events({ limit: 100_000, type: 'aux_call' })) {
    const p = ev.payload ?? {};
    const purpose = p.purpose ?? 'unknown';
    const bucket = aux.byPurpose[purpose] ?? {
      calls: 0, failures: 0, input: 0, cached: 0, written: 0, fresh: 0, output: 0, _latency: [],
    };
    const latency = Math.max(0, finiteNumber(p.elapsedMs));
    aux.calls++;
    aux.failures += p.success ? 0 : 1;
    for (const key of ['input', 'cached', 'written', 'fresh', 'output']) {
      aux[key] += finiteNumber(p[key]);
      bucket[key] += finiteNumber(p[key]);
    }
    auxLatency.push(latency);
    bucket.calls++;
    bucket.failures += p.success ? 0 : 1;
    bucket._latency.push(latency);
    aux.byPurpose[purpose] = bucket;
  }
  aux.latencyMs = { p50: percentile(auxLatency, 0.5), p95: percentile(auxLatency, 0.95) };
  for (const bucket of Object.values(aux.byPurpose)) {
    bucket.latencyMs = { p50: percentile(bucket._latency, 0.5), p95: percentile(bucket._latency, 0.95) };
    delete bucket._latency;
  }

  // A subscription CLI (codex on a ChatGPT plan, say) has no $/token at all —
  // `spent` above is at best a reference-rate guess for it, built from a price
  // table meant for metered API keys. The real ceiling is the plan's own
  // token allowance, so a cli named in `quotas` gets tracked against THAT
  // instead: config names the plan's size, this sums what every member on
  // that cli actually burned (already deltaed above, same as everything else
  // in this function), never invents a dollar figure for it.
  const quotas = Object.entries(agenticos.config.quotas ?? {}).map(([cli, q]) => {
    const used = byCli.get(cli) ?? 0;
    const limit = q.limitTokens ?? 0;
    return { cli, label: q.label ?? cli, used, limit, pct: limit ? Math.min(100, Math.round((used / limit) * 100)) : null };
  });

  return { members, total, quotas, auxiliary: aux };
}

/** The cached aggregate plus the fields that move without a new event. */
function metrics() {
  const mark = `${agenticos.bus.lastEventId()}:${agenticos.lastPrune ?? 0}`;
  if (metricsCache.mark !== mark) metricsCache = { mark, value: buildMetrics() };
  const base = metricsCache.value;
  // Live, not cached: a recycle or compaction zeroes a session without
  // logging a turn, so the event mark above would not move for it.
  const context = agenticos.contextAll();
  const contextBy = new Map(context.map((c) => [c.name, c]));
  return {
    ...base,
    members: base.members.map((m) => ({
      ...m,
      role: agenticos.roleOf(m.name),
      spent: Number(agenticos.bus.get(`spent:${m.name}`) ?? 0),
      awake: agenticos.processes.has(m.name),
      context: contextBy.get(m.name) ?? null,
    })),
    // Every member's session against its model's window, orchestrator first.
    context,
    // Spend per local day (named zone) from the ledger clearSpend leaves alone.
    spendByDay: agenticos.spendByDay(),
    spent: Number(agenticos.bus.get('spentUsd') ?? 0),
    cap: agenticos.config.maxTotalUsd ?? 0,
    perMemberCap: agenticos.config.maxBudgetUsd ?? 0,
    messages: agenticos.bus.countMessages(),   // count(*), not "load every body and take .length"
    mcp: {
      maskedCalls: finiteNumber(agenticos.bus.get('mask:calls')),
      maskedChars: finiteNumber(agenticos.bus.get('mask:chars')),
    },
  };
}

/** Ends the team for real. The window closing no longer does this. */
async function shutdown(code = 0) {
  speech.stop();
  await agenticos.stop();
  // Best-effort: a clean exit should not leave a corpse for the next
  // listTeams() to have to detect and prune itself, but shutdown must never
  // hang on this — the registry file could be locked by another launch.
  try { await unregisterTeam({ port, pid: process.pid }); } catch { /* next prune catches it */ }
  process.exit(code);
}

// Binding to 127.0.0.1 keeps the outside world off this port, but not the
// browser sitting on it: any page open in the same browser can still POST
// here, and a POST with no preflight (content-type: text/plain, say) needs
// no CORS header back at all. The team's own agents run unconfined by
// design — bypassPermissions, danger-full-access, --dangerously-skip-
// permissions (src/agent.js) — so a drive-by POST to /api/command is not a
// UI bug, it is arbitrary code execution. Two checks kill the whole class:
// an Origin that doesn't match this server (browsers send Origin on every
// cross-origin POST; a same-origin fetch sends the server's own origin, and
// a non-browser caller sends none, so both legitimate cases pass) and a
// Content-Type that isn't application/json (forces a preflight for anything
// cross-origin, and the preflight has no matching header to pass it).
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // no browser sends a POST with no Origin
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

// Loopback classification is by CONNECTION, not by the configured bind —
// binding 0.0.0.0 still accepts connections that arrive via 127.0.0.1, and
// those must keep working exactly as they do today (rule 7's whole point).
// Only a connection that actually arrived over a non-loopback interface is
// gated below.
function remoteConnection(req) {
  if (process.env.AGENTICOS_TEST_FORCE_REMOTE === '1') return true; // test seam only, see above
  const ip = req.socket.remoteAddress ?? '';
  return ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1';
}

function bearerAuthorized(req) {
  if (!authToken) return false;
  const [scheme, value] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !value) return false;
  // Fixed-length compare: a phone token is worth guarding against timing.
  const presented = Buffer.from(value);
  const expected = Buffer.from(authToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

// The one surface a bearer-authenticated, non-loopback request may reach:
// the approval queue, and the three actions it can act on. Run controls,
// repo switching, asset uploads and the UI itself stay loopback-only no
// matter what token is presented — "the write surface stays limited to
// approvals" is explicit in the backlog's acceptance clause.
const REMOTE_READS = new Set(['/api/ping', '/api/approvals']);
const REMOTE_ACTIONS = new Set(['approve', 'reject', 'answerQuestion']);

/**
 * null: not a remote connection — the existing loopback/origin path below
 *   applies completely unchanged.
 * 'authorized': a valid token AND an allowed route — proceed, and skip the
 *   origin/CSRF check for this one request (the bearer token already is
 *   one: a cross-site page can neither read nor attach it).
 * otherwise: {status, error} — refuse verbatim, before any route runs.
 */
function remoteGate(req, url) {
  if (!remoteConnection(req)) return null;
  if (!bearerAuthorized(req)) return { status: 401, error: 'missing or invalid bearer token' };
  const allowedRead = req.method === 'GET' && REMOTE_READS.has(url.pathname);
  const allowedAction = req.method === 'POST' && url.pathname.startsWith('/api/')
    && REMOTE_ACTIONS.has(url.pathname.slice(5));
  return allowedRead || allowedAction ? 'authorized'
    : { status: 403, error: 'this route is not available for remote approval' };
}

// Every GET that answers with JSON, keyed by path.
//
// This mirrors ACTIONS above. The POST side has had a dispatch table since it
// was written; the GET side was sixteen sequential `url.pathname ===` compares
// inside handle(), which is how that one function reached 554 lines. Each
// handler returns [status, body] and handle()'s one `send` serialises it.
//
// Routes that are not a plain JSON read stay as explicit blocks in handle():
// /stream (SSE), /api/workflows and /api/assets and /api/transcribe (GET and
// POST on one path), /assets/* (bytes) and /modes.js (JavaScript).
const READS = {
  // How a launching window discovers whether a team is already up, and which
  // repo it is serving — attaching to the wrong repo would be silent and bad.
  '/api/ping': async (url, req) => {
    // `port` lets a launcher that started this daemon WITHOUT a pinned port
    // (teams.firstFreePort() picked one) discover which one it actually
    // got — the multi-team switcher polls the registry for this same fact,
    // but a page/window that already knows its own origin still wants the
    // number for display.
    return [ready ? 200 : 503, { ok: ready, starting: !ready, repo: agenticos.repo, base: agenticos.base, pid: process.pid, port }];
  },

  // The same probes `npm run doctor` prints, structured — this is what a
  // freshly installed app shows FIRST, since there is no terminal it can
  // assume the user will open. Answerable whether or not the team is up:
  // runDoctor() only shells out to CLI binaries, it never touches `agenticos`.
  '/api/doctor': async (url, req) => {
    // ponytail: runDoctor() spawns each configured CLI for a real auth probe.
    // On a machine with none installed that fails in well under a second —
    // fast enough to consistently win the race against the UI's own first
    // action, no matter how the client times its reaction (see ui/main.js's
    // maybeOpenDoctor). t-electron.js sets this because it promises never to
    // spawn a CLI at all; honouring that promise here removes the race
    // instead of chasing tighter and tighter timing on the client.
    if (process.env.AGENTICOS_SKIP_DOCTOR) return [200, { checks: [], failures: 0, ready: true }];
    const report = await runDoctor({ repo: agenticos.repo ?? undefined });
    return [200, report];
  },

  // ---- what the user has been asked, and what they answered -------
  // Pending AND decided. Approvals used to exist only while unanswered, so
  // with an empty queue there was no sign the feature existed at all, and no
  // record of what had already been agreed to.
  '/api/approvals': async (url, req) => {
    // An approval whose body will not parse used to come through as `{}` —
    // an entry with an id, a sender, and no `kind`. The dashboard renders
    // one with `TITLES[a.kind] ?? a.kind.toUpperCase()` (`ui/app.js`), so an
    // undefined kind threw, and the throw took the whole approvals pass with
    // it: one unreadable row and the user stopped being shown ANY of
    // them, including the ones still waiting on a decision. Drop what cannot
    // be rendered, and say on stderr that it was dropped — a bad row must
    // cost its own line and nothing else.
    const rows = [];
    for (const m of agenticos.bus.approvals()) {
      const p = readApproval(m.body);
      if (!p) {
        process.stderr.write(`daemon: approval #${m.id} from ${m.sender} is unreadable — skipped\n`);
        continue;
      }
      const resolved = agenticos.bus.get(`resolved:${m.id}`) ?? null;
      const row = { id: m.id, ts: m.ts, from: m.sender, runId: m.runId ?? p.runId ?? null, ...p, resolved };
      if (p.kind === 'push') {
        try { row.push = JSON.parse(agenticos.bus.get(`push:${m.id}`) ?? 'null'); } catch { /* card still renders */ }
      }
      if (p.kind === 'merge') {
        try { row.merge = JSON.parse(agenticos.bus.get(`merge:${m.id}`) ?? 'null'); } catch { /* card still renders */ }
      }
      // The cost of the crew being proposed, and ONLY while it is still
      // being proposed. A forecast is a trimming aid and there is nothing
      // left to trim once the add is answered — which also keeps this
      // off the 2,000 historical rows the loop above walks on every poll.
      //
      // Guarded because this is the one line here that reads the event log:
      // AGENTS.md rule 4, degrade rather than wedge. A card with no number
      // on it is a worse card; a card that never renders is a team the
      // user cannot answer at all.
      if (!resolved && p.kind === 'add') {
        try {
          row.forecast = agenticos.forecast(p.names);
        } catch (e) {
          process.stderr.write(`daemon: forecast for approval #${m.id} failed — ${e.message}\n`);
        }
      }
      rows.push(row);
    }
    rows.reverse();
    return [200, { ok: true, approvals: rows, pending: [...agenticos.approvals.keys()] }];
  },

  // ---- the shared task list --------------------------------------------
  // The one question the panels could not answer: what is still outstanding.
  // Approvals show what the user must decide and the log shows what
  // was said, but an assignment nobody acted on appeared in neither.
  '/api/tasks': async (url, req) => {
    const runId = url.searchParams.get('runId') ?? url.searchParams.get('run_id');
    const tasks = agenticos.bus.tasks(runId ? { runId } : {});
    return [200, {
      ok: true,
      tasks,
      open: tasks.filter((t) => !TASK_CLOSED.has(t.state)).length,
      available: agenticos.bus.availableTasks().length,
    }];
  },

  // Everything waiting on the user inside the app, ranked (src/inbox.js).
  // Unreadable approvals are skipped here exactly as /api/approvals skips them.
  '/api/inbox': async (url, req) => [200, { ok: true, items: inboxNow() }],

  '/api/runTemplates': async (url, req) => [200, { ok: true, templates: readRunTemplates() }],

  '/api/myTasks': async (url, req) => [200, { ok: true, tasks: agenticos.bus.myTasks(), due: agenticos.bus.dueMyTasks().length }],

  '/api/run': async (url, req) => [200, { ok: true, run: agenticos.bus.currentRun() }],
  '/api/runs': async (url, req) => {
    const state = url.searchParams.get('state');
    return [200, { ok: true, runs: agenticos.bus.runs(state ? { state } : {}) }];
  },

  // What a run has spent, from its own ledger: the requested run (default:
  // the current one, else the most recent), against maxRunUsd, plus recent
  // runs' totals for the history table.
  '/api/runSpend': async (url, req) => {
    const all = agenticos.bus.runs();
    const id = url.searchParams.get('id');
    const run = id ? agenticos.bus.run(id) : agenticos.bus.currentRun() ?? all.at(-1) ?? null;
    if (id && !run) return [404, { ok: false, error: `No run ${id}.` }];
    const totals = agenticos.bus.runSpendTotals();
    const agents = agenticos.bus.runAgents();
    const runs = all.slice(-20).reverse().map((r) => ({
      id: r.id, state: r.state, objective: r.objective, createdTs: r.createdTs,
      endedTs: r.completedTs ?? r.cancelledTs ?? null,
      usd: totals[r.id]?.usd ?? 0, turns: totals[r.id]?.turns ?? 0,
      // Who drove it: the recorded lead (null on runs older than the column)
      // and every member that spent on it, highest spend first.
      lead: r.lead ?? null,
      agents: (agents[r.id] ?? []).map((m) => m.name),
    }));
    return [200, {
      ok: true, cap: Number(agenticos.config.maxRunUsd ?? 0) || 0,
      run: run ? { id: run.id, state: run.state, objective: run.objective, createdTs: run.createdTs } : null,
      spend: run ? agenticos.bus.runSpend(run.id) : null,
      runs,
    }];
  },

  '/api/campaigns': async (url, req) => {
    return [200, { ok: true, campaigns: agenticos.bus.campaigns() }];
  },

  // Sidebar boot: the list of threads for one member, without waiting on the
  // stream. `?member=` defaults to the orchestrator — the only member Chat
  // mode talks to today.
  '/api/conversations': async (url, req) => {
    const member = url.searchParams.get('member') || agenticos.config.orchestrator.name;
    return [200, {
      ok: true,
      active: agenticos.activeConversation.get(member) ?? 'default',
      conversations: agenticos.bus.conversations(member),
    }];
  },

  // ---- the log: everything that happened, in order ----------------------
  // The bus panel shows messages; a member's panel shows one transcript. There
  // was no view of the team as a whole over time, and no way to find which of
  // sixteen members said a thing. This is both.
  '/api/log': async (url, req) => {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const requestedLimit = Number(url.searchParams.get('limit') ?? 200);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
    const kinds = new Set((url.searchParams.get('kinds') ?? 'summary,message,error,done')
      .split(',').filter(Boolean));
    const requestedCampaign = url.searchParams.get('campaign');
    const campaign = requestedCampaign ? agenticos.bus.campaign(requestedCampaign) : null;
    if (requestedCampaign && !campaign) {
      return [404, { ok: false, error: 'No such campaign.' }];
    }
    const inCampaign = (id, start, end) => !campaign || (id > start && (end == null || id <= end));

    const rows = [];

    // Summaries and errors — one line per turn, which is the readable layer.
    if (kinds.has('summary') || kinds.has('error')) {
      for (const e of agenticos.bus.events({ limit: 20_000, tail: true })) {
        if (!inCampaign(e.id, campaign?.eventStart, campaign?.eventEnd)) continue;
        if (e.type !== 'summary' && e.type !== 'error') continue;
        if (!kinds.has(e.type)) continue;
        let p;
        try { p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload; } catch { continue; }
        const text = p?.text ?? p?.message ?? '';
        if (!text) continue;
        rows.push({ id: `e${e.id}`, ts: e.ts, who: e.agent, kind: e.type, text });
      }
    }

    if (kinds.has('message') || kinds.has('done')) {
      for (const m of agenticos.bus.history({ limit: 20_000, tail: true })) {
        if (!inCampaign(m.id, campaign?.messageStart, campaign?.messageEnd)) continue;
        const kind = m.kind === 'done' ? 'done' : 'message';
        if (!kinds.has(kind)) continue;
        // Approvals and notices are machinery, not narrative.
        if (m.kind === 'approval' || m.kind === 'notice' || m.kind === 'milestone') continue;
        rows.push({
          id: `m${m.id}`, ts: m.ts, who: m.sender, to: m.recipient ?? null,
          kind, text: m.body,
        });
      }
    }

    // A name matches BOTH directions. Searching "tester" and being shown only
    // what the tester said — not what was said to them — is half an answer,
    // and the half you usually wanted is the conversation.
    const hits = q
      ? rows.filter((r) => r.text.toLowerCase().includes(q)
        || r.who.toLowerCase().includes(q)
        || (r.to ?? '').toLowerCase().includes(q))
      : rows;
    hits.sort((a, b) => b.ts - a.ts);

    return [200, {
      ok: true,
      query: q,
      campaign,
      total: hits.length,
      // Bodies can be enormous; the log is for scanning, and the member's
      // own panel is where you go for the whole thing.
      rows: hits.slice(0, limit).map((r) => ({
        ...r,
        text: r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text,
      })),
    }];
  },

  '/api/metrics': async (url, req) => {
    return [200, { ok: true, ...metrics() }];
  },

  // ---- an agent's work, before you merge it ---------------------------
  '/api/diff': async (url, req) => {
    const agent = url.searchParams.get('agent');
    // roleOf is a CLASSIFIER, not a membership test — it answers "agent" for
    // any name that is not the orchestrator or the briefer, including one that does not
    // exist. specOf is the question actually being asked here.
    if (!agent || !agenticos.specOf(agent) || agenticos.roleOf(agent) !== 'agent') {
      return [400, { ok: false, error: `"${agent}" is not an agent of this team.` }];
    }
    if (!existsSync(worktreePath(agenticos.repo, agent))) {
      return [200, { ok: true, agent, none: true, reason: 'This member has no worktree yet.' }];
    }
    try {
      const file = url.searchParams.get('file');
      const [stat, diff] = await Promise.all([
        statOf(agenticos.repo, agent, agenticos.base),
        diffOf(agenticos.repo, agent, agenticos.base, file),
      ]);
      // The diff is the expensive part, and an enormous one helps nobody read
      // it — the panel offers per-file diffs for anything past this.
      const CAP = 120_000;
      return [200, {
        ok: true, agent, base: agenticos.base, stat,
        diff: diff.length > CAP ? `${diff.slice(0, CAP)}\n\n[truncated — open a single file to see the rest]` : diff,
        truncated: diff.length > CAP,
      }];
    } catch (e) {
      return [502, { ok: false, error: e.message }];
    }
  },

  // ---- who has unmerged work waiting ------------------------------------
  // The overview's "ready to review" block. /api/diff answers this one member
  // at a time and returns up to 120KB of patch to do it, which is the wrong
  // shape for a list — the question here is only "who has anything", and the
  // stat line is enough to answer it. The client parses it with the same
  // parseStat() the diff panel already uses.
  '/api/changes': async (url, req) => {
    const names = [...agenticos.added].filter((n) => agenticos.roleOf(n) === 'agent');
    const changed = [];
    for (const agent of names) {
      if (!existsSync(worktreePath(agenticos.repo, agent))) continue;
      try {
        const stat = await statOf(agenticos.repo, agent, agenticos.base);
        if (stat?.trim()) changed.push({ agent, stat });
      } catch {
        // One member's worktree being mid-rebase must not blank the whole
        // block — degrade, never wedge.
      }
    }
    return [200, { ok: true, base: agenticos.base, changed }];
  },

  // ---- the user's vault, from the dashboard ---------------------
  '/api/vault': async (url, req) => {
    const root = agenticos.config.vault || null;
    if (!root) return [200, { ok: true, configured: false, notes: [] }];

    const path = url.searchParams.get('path');
    if (path) {
      const body = readNote(root, path);
      // readNote returns null both for "escaped the vault" and "no such note".
      // The browser does not need to be told which.
      return body === null
        ? [404, { ok: false, error: 'No such note.' }]
        : [200, { ok: true, path, body }];
    }
    const q = url.searchParams.get('q');
    return [200, {
      ok: true, configured: true, query: q ?? '',
      notes: q?.trim() ? searchVault(root, q) : recentNotes(root),
    }];
  },

  // ---- recall: search everything the team has said or done ------------
  '/api/recall': async (url, req) => {
    const q = url.searchParams.get('q');
    if (!q?.trim()) return [200, { ok: true, query: '', hits: [] }];
    return [200, { ok: true, query: q, hits: agenticos.bus.recall(q, { limit: 40 }) }];
  },

};

// Named, so createServer can wrap the WHOLE thing in one catch. Anything that
// throws in here is an unhandled rejection, and Node's default for those is to
// kill the process — so a single malformed request body took the entire team
// down. One guard where every route passes through beats a try/catch per route
// that the next route forgets.
const handle = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, o) =>
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));

  const remote = remoteGate(req, url);
  if (remote && remote !== 'authorized') return send(remote.status, { ok: false, error: remote.error });
  const bearerAuthed = remote === 'authorized';

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!bearerAuthed && !originAllowed(req)) return send(403, { ok: false, error: 'origin not allowed' });
    // /api/transcribe and /api/assets (upload, not /delete) post a raw file
    // as the body with its own mime type, by design (ui/assets.js's own
    // comment: a multipart boundary parser is a lot of code for one file) —
    // every other POST /api/* is a JSON action and gets the preflight-forcing
    // check the raw-body routes cannot.
    const rawBody = url.pathname === '/api/transcribe'
      || (url.pathname === '/api/assets' && url.searchParams.has('name'));
    const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
    if (!rawBody && ct !== 'application/json') {
      return send(415, { ok: false, error: 'expected content-type: application/json' });
    }
  }

  const runMatch = req.method === 'GET' && url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const run = agenticos.bus.run(decodeURIComponent(runMatch[1]));
    return send(run ? 200 : 404, run ? { ok: true, run } : { ok: false, error: 'No such run.' });
  }
  const read = READS[url.pathname];
  if (read) {
    return send(...await read(url, req));
  }

  if (url.pathname === '/stream') {
    if (!ready) return res.writeHead(503).end('starting');
    // No conversation param: an unfiltered subscriber (every non-Chat panel).
    const conversation = url.searchParams.get('conversation') || null;
    // Reconnecting with a cursor wants only what it missed, oldest first — a
    // fresh tab wants the room repainted from the newest rows backward. Same
    // distinction bus.js's own tail flag exists for.
    const requestedSince = Number(url.searchParams.get('since') || 0);
    const since = Number.isSafeInteger(requestedSince) && requestedSince > 0 ? requestedSince : 0;
    let roster = [];
    try {
      const savedRoster = JSON.parse(agenticos.bus.get('roster') ?? '[]');
      roster = Array.isArray(savedRoster) ? savedRoster : [];
    } catch {
      process.stderr.write('daemon: persisted roster is unreadable — stream sent an empty roster\n');
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    clients.set(res, conversation);
    res.write(`data: ${JSON.stringify({
      type: 'snapshot',
      repo: agenticos.repo,
      base: agenticos.base,
      roster,
      models: agenticos.models(),
      efforts: agenticos.efforts(),
      advisor: agenticos.advisor(),
      domains: agenticos.domains(),
      // Names and descriptions only — this is the `/` menu, and the bodies are
      // what the team fetches on demand. Sent in the snapshot rather than as
      // its own endpoint because it is a few hundred bytes the UI needs before
      // the first keystroke.
      skills: agenticos.skills(),
      summarizer: agenticos.summarizer(),
      goal: agenticos.goal(),
      // #41: the header's turn counter otherwise reads blank until this
      // session's first 'spend' event, even though the count itself is
      // durable (agenticos.turnsThisSession()/turnsLifetime() both survive a
      // restart) — a reconnect or a fresh tab must show what has already
      // happened this session, not zero.
      spend: {
        turns: agenticos.turnsThisSession(), lifetimeTurns: agenticos.turnsLifetime(),
        turnBudget: agenticos.sessionTurnCap(),
        today: agenticos.spendToday(),
      },
      // The context meter: every member's session against its model's window.
      context: agenticos.contextAll(),
      paused: agenticos.paused ?? false,
      pausedWhy: agenticos.paused ? (agenticos.bus.get('pausedWhy') ?? '') : '',
      mode: agenticos.mode(),
      run: agenticos.bus.currentRun(),
      events: since
        ? agenticos.bus.events({ since, limit: 2000, conversation })
        : agenticos.bus.events({ limit: 400, tail: true, conversation }),
      messages: since
        ? agenticos.bus.history({ since, limit: 2000, conversation })
        : agenticos.bus.history({ limit: 200, tail: true, conversation }),
      approvals: [...agenticos.approvals].map(([id, p]) => ({ id, ...p })),
    })}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  // ---- automation workflows, n8n-style ----------------------------------
  // GET  /api/workflows            list them all
  // GET  /api/workflows/runs?id=x  last 20 run outcomes for one workflow
  // POST /api/workflows            create/update {id?, name, trigger, nodes, enabled}
  // POST /api/workflows/delete     {id}
  // POST /api/workflows/run        {id} -> run once now, return the trace
  // POST /api/workflows/hook?id=x  fire a trigger:"webhook" workflow now; the
  //                                 request body becomes ctx.input
  if (url.pathname.startsWith('/api/workflows')) {
    if (req.method === 'GET' && url.pathname === '/api/workflows') {
      return send(200, { ok: true, workflows: await listWorkflows(WORKFLOWS_DIR) });
    }
    if (req.method === 'GET' && url.pathname === '/api/workflows/templates') {
      return send(200, { ok: true, templates: WORKFLOW_TEMPLATES.map(({ workflow, ...t }) => ({ ...t, trigger: workflow.trigger })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/workflows/runs') {
      const id = url.searchParams.get('id');
      if (!id) return send(400, { ok: false, error: 'id required' });
      return send(200, { ok: true, runs: runHistory(agenticos.bus, id) });
    }

    let body;
    try { body = (await readBody(req, 2 * 1024 * 1024)).toString('utf8'); }
    catch (e) { return res.writeHead(e.status ?? 500).end(); }

    if (url.pathname === '/api/workflows/hook') {
      if (req.method !== 'POST') return res.writeHead(405).end();
      const id = url.searchParams.get('id');
      const wf = (await listWorkflows(WORKFLOWS_DIR)).find((w) => w.id === id);
      if (!wf) return send(404, { ok: false, error: 'no such workflow' });
      if (wf.trigger?.type !== 'webhook') return send(400, { ok: false, error: 'not a webhook-triggered workflow' });
      if (wf.enabled === false) return send(409, { ok: false, error: 'workflow is disabled' });
      let input; try { input = body ? JSON.parse(body) : {}; } catch { input = body; }
      const result = await runWorkflow(wf, { bus: agenticos.bus, input, services: WORKFLOW_SERVICES });
      logRun(agenticos.bus, wf, result);
      return send(200, { ok: true, result });
    }

    if (req.method !== 'POST') return res.writeHead(405).end();
    let b;
    try { b = body ? JSON.parse(body) : {}; }
    catch { return send(400, { ok: false, error: 'invalid JSON' }); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return send(400, { ok: false, error: 'invalid workflow body' });

    if (url.pathname === '/api/workflows/delete') {
      if (!b.id) return send(400, { ok: false, error: 'id required' });
      if (!validWorkflowId(b.id)) return send(400, { ok: false, error: 'invalid workflow id' });
      await deleteWorkflow(WORKFLOWS_DIR, b.id);
      return send(200, { ok: true });
    }
    // Install a built-in template as an ordinary, editable, enabled workflow.
    if (url.pathname === '/api/workflows/install') {
      const wf = instantiateTemplate(String(b.template ?? ''));
      if (!wf) return send(404, { ok: false, error: `No template "${b.template}".` });
      await saveWorkflow(WORKFLOWS_DIR, wf);
      return send(200, { ok: true, workflow: wf });
    }
    if (url.pathname === '/api/workflows/run') {
      const wf = (await listWorkflows(WORKFLOWS_DIR)).find((w) => w.id === b.id);
      if (!wf) return send(404, { ok: false, error: 'no such workflow' });
      const result = await runWorkflow(wf, { bus: agenticos.bus, services: WORKFLOW_SERVICES });
      logRun(agenticos.bus, wf, result);
      return send(200, { ok: true, result });
    }
    if (url.pathname === '/api/workflows') {
      if (!b.name) return send(400, { ok: false, error: 'name required' });
      const wf = { ...b, id: b.id || `wf-${Date.now()}` };
      if (!validWorkflowId(wf.id)) return send(400, { ok: false, error: 'invalid workflow id' });
      await saveWorkflow(WORKFLOWS_DIR, wf);
      return send(200, { ok: true, workflow: wf });
    }
    return res.writeHead(404).end();
  }

  // ---- backgrounds and music -------------------------------------------
  // GET  /api/assets            list what has been uploaded
  // POST /api/assets?name=x.jpg store a file (raw body)
  // POST /api/assets/delete     remove one  {name}
  // GET  /assets/<file>         serve it
  if (url.pathname === '/api/assets' || url.pathname === '/api/assets/delete') {
    if (req.method === 'GET') {
      try {
        const files = (await readdir(ASSETS)).filter(kindOf);
        return send(200, { ok: true, assets: files.map((f) => ({ name: f, kind: kindOf(f) })) });
      } catch (e) {
        if (e.code === 'ENOENT') return send(200, { ok: true, assets: [] });   // nothing uploaded yet
        throw e;
      }
    }
    if (req.method !== 'POST') return res.writeHead(405).end();

    if (url.pathname.endsWith('/delete')) {
      let body;
      try { body = (await readBody(req, 2 * 1024 * 1024)).toString('utf8'); }
      catch (e) { return res.writeHead(e.status ?? 500).end(); }
      let request;
      try { request = JSON.parse(body || '{}'); }
      catch { return send(400, { ok: false, error: 'invalid JSON' }); }
      const name = safeAsset(request.name);
      if (!name) return send(400, { ok: false, error: 'not a media file' });
      try { await unlink(join(ASSETS, name)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      return send(200, { ok: true });
    }

    const name = safeAsset(url.searchParams.get('name'));
    if (!name) return send(400, { ok: false, error: 'unsupported file type' });
    // A wallpaper or a track, not a video library. Refuse rather than fill
    // the disk silently.
    let buf;
    try { buf = await readBody(req, 80 * 1024 * 1024); }
    catch (e) { return send(e.status ?? 500, { ok: false, error: 'over 80MB' }); }
    await mkdir(ASSETS, { recursive: true });
    try { await writeFile(join(ASSETS, name), buf, { flag: 'wx' }); }
    catch (e) {
      if (e.code === 'EEXIST') return send(409, { ok: false, error: 'an asset with that name already exists' });
      throw e;
    }
    return send(200, { ok: true, name, kind: kindOf(name) });
  }

  if (url.pathname.startsWith('/assets/')) {
    let name;
    try { name = safeAsset(decodeURIComponent(url.pathname.slice(8))); }
    catch { return res.writeHead(404).end(); }
    if (!name) return res.writeHead(404).end();
    try {
      const buf = await readFile(join(ASSETS, name));
      return res.writeHead(200, {
        'content-type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      }).end(buf);
    } catch {
      return res.writeHead(404).end();
    }
  }

  // Dictation, via SpeechBird's local Whisper. Nothing leaves the machine.
  if (url.pathname === '/api/transcribe') {
    // The UI asks first, so it can fall back to the browser recogniser rather
    // than record a clip nothing can transcribe.
    if (req.method === 'GET') return send(200, { ok: true, available: speech.available() });
    if (req.method !== 'POST') return res.writeHead(405).end();

    if (!speech.available()) {
      return send(400, { ok: false, error: 'SpeechBird not found. Set "speechbird" in '
        + 'agenticos.config.json to the folder holding its .venv.' });
    }
    let buf;
    try { buf = await readBody(req, 25 * 1024 * 1024); } // a voice note, not a podcast
    catch (e) { return res.writeHead(e.status ?? 500).end(); }
    // audio/webm;codecs=opus -> webm
    const ext = (req.headers['content-type'] ?? '').split(';')[0].split('/')[1] || 'webm';
    try {
      return send(200, { ok: true, text: await speech.transcribe(buf, ext) });
    } catch (e) {
      return send(502, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const action = ACTIONS[url.pathname.slice(5)];
    if (!action) return res.writeHead(404).end();
    let body;
    try { body = (await readBody(req, 2 * 1024 * 1024)).toString('utf8'); }
    catch (e) { return res.writeHead(e.status ?? 500).end(); }
    let input;
    try { input = body ? JSON.parse(body) : {}; }
    catch { return send(400, { ok: false, error: 'invalid JSON' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return send(400, { ok: false, error: 'invalid action body' });
    }
    try {
      const result = await action(input);
      return send(200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (e) {
      // An action may refuse with a status of its own (409 when a member's
      // state forbids it) and a machine-readable reason beside the message.
      const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
      return send(status, { ok: false, error: e.message, ...(e.reason ? { reason: e.reason } : {}) });
    }
  }

  // The mode table is SHARED with the browser, not copied into it. The labels,
  // the blurbs and which blocks each mode drops are all the same table the
  // orchestrator enforces, and a second copy in ui/ would drift the first time
  // a crew changed — quietly, because a stale label still renders.
  if (url.pathname === '/modes.js') {
    const buf = await readFile(join(HERE, 'modes.js'));
    return res.writeHead(200, {
      'content-type': 'text/javascript', 'cache-control': 'no-cache',
    }).end(buf);
  }

  // static
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const buf = await readFile(join(PUBLIC, file));
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'text/plain',
      // The team has write access to its own config by design, and that config
      // reaches the DOM. This is the backstop for the whole class: even if some
      // field is interpolated into markup somewhere, there is no origin that may
      // run a script but this one, and no inline script may run at all.
      // 'unsafe-inline' for styles only, which pet.html's <style> block and the
      // inline style attributes in win.js/assets.js require; it grants no script.
      'content-security-policy': "default-src 'self'; script-src 'self'; "
        + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; "
        + "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    }).end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
};

const server = createServer((req, res) => handle(req, res).catch((e) => {
  console.error(e?.stack ?? e);
  if (!res.headersSent) res.writeHead(e?.status ?? 500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
}));

// A clean, visible error either way: a PINNED port that is busy names itself
// and refuses rather than binding somewhere the launcher never asked for; an
// auto-picked port racing another process for the exact same one (the one
// window between teams.firstFreePort()'s probe and this real bind) gets the
// same message instead of a raw Node stack trace nobody watching a detached,
// unref'd child process would ever see (see startDaemon()'s comment in
// electron/main.js for why nothing else is watching).
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`daemon: port ${port} is already in use.`
      + (explicitPort ? ' Pass a different --port (or unset AGENTICOS_PORT) to use another one.'
        : ' Another process claimed it between the free-port check and this bind — try again.'));
  } else {
    console.error(e?.stack ?? e);
  }
  process.exitCode = 1;
  process.exit();
});

(async () => {
  if (explicitPort == null) {
    try {
      port = await firstFreePort(basePort, await listTeams());
    } catch (e) {
      console.error(`daemon: ${e.message}`);
      process.exitCode = 1;
      process.exit();
      return;
    }
  }
  server.listen(port, bindAddr, async () => {
  try {
    // One daemon PROCESS per repository (issue #42): a repo that already has
    // a live team elsewhere is refused here, after the bind (so the busy-
    // port case above still wins first) but before any real work — AgenticOS
    // .start() below is what actually spawns the team's members, and this
    // must come first or a refused daemon would spawn a whole team just to
    // throw it away. A repo-less daemon (Chat/Cowork with nothing attached
    // yet) still registers, keyed by its port — see teams.js's sameRepo()
    // doc comment for why two repo-less entries never conflict with each
    // other; that is an accepted gap, not a promise this checks.
    try {
      await registerTeam({ repo, port, pid: process.pid });
    } catch (e) {
      if (e instanceof TeamConflictError) {
        console.error(`daemon: refusing to start — ${e.message}`);
        process.exitCode = 1;
        process.exit();
        return;
      }
      throw e;
    }

    // A saved repo (found via savedRepo(), not named on the CLI) boots from
    // the workspace home above — re-attach it now, live, exactly as the UI's
    // POST /api/attachRepo would, so agenticos.repo/base and Code mode come up
    // the same way this session left them.
    //
    // BEFORE start(), not after. attachRepo now restarts any member stranded in
    // the repo-less home, because a live process cannot change directory — so
    // attaching after start() would spawn the whole team into the workspace
    // and immediately throw it away again, one wasted turn each. Attaching
    // first means start() spawns everyone already pointed at the repo.
    if (!repoArg && repo) {
      try {
        await agenticos.attachRepo(repo);
      } catch (e) {
        // Degrade, never wedge. The repo is remembered from a PREVIOUS session
        // and may since have moved, been deleted, or become unreadable — and
        // this whole path exists so the dashboard opens without one. Dying
        // here would make a stale config line the reason the app will not boot.
        console.error(`saved repository unusable, starting without one: ${e.message}`);
        // The registerTeam() call above already claimed `repo` in the
        // registry, optimistically, before this attach was attempted — a
        // failed attach must not leave that claim standing (agenticos.repo is
        // still null here), or the registry would report a repo this daemon
        // never actually attached, exactly the staleness this whole feature
        // exists to prevent.
        try { await registerTeam({ repo: agenticos.repo, port, pid: process.pid }); } catch { /* best effort rollback */ }
      }
    }
    await agenticos.start();
    ready = true;
    console.log(`dashboard: http://${bindAddr}:${port}  (repo: ${agenticos.repo})`);
    // Interval-triggered workflows. 5s resolution, not per-workflow timers —
    // same tradeoff bus.js's own poll makes: fewer moving parts, and a newly
    // saved or edited workflow is picked up on the very next tick for free.
    setInterval(() => {
      tickScheduler(WORKFLOWS_DIR, {
        bus: agenticos.bus,
        services: WORKFLOW_SERVICES,
        onRun: (wf, result) => push('workflow_run', { id: wf.id, name: wf.name, ok: result.ok }),
      }).catch((e) => console.error('workflow scheduler:', e?.stack ?? e));
    }, 5000);
  } catch (e) {
    console.error(e?.stack ?? e);
    process.exitCode = 1;
    process.exit();
  }
  });
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

// A team that is mostly working is worth more than a clean exit. Node's
// default for an unhandled rejection is to kill the process, which takes every
// live member's session with it over one stray promise — the SSE stream, the
// summariser and the advisor are all fire-and-forget from here.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.stack ?? e));

// The same argument, for a synchronous throw. Without this the daemon dies and
// the reason goes nowhere the user can see: electron/main.js spawns this
// process detached and unref'd, so after boot nothing is watching the exit
// code, and the log it writes to sits next to the repo root unread.
//
// The UI does notice the socket go — ui/main.js:165 flips the connection dot to
// `down` and retries every second — so this was never a wedge. It was a team
// that stopped with no stated cause, which rule 4 counts as the same failure.
// So: say so on the stream first, while the stream is still open, then log.
process.on('uncaughtException', (e) => {
  try { push('error', { message: `The team hit an unhandled error: ${e?.message ?? e}` }); }
  catch { /* the stream is already gone; the log below is all that is left */ }
  console.error('uncaught exception:', e?.stack ?? e);
});
