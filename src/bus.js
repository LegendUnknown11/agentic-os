// The kingdom's message bus + event log. node:sqlite, no native deps.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const RUN_STATES = new Set([
  'planning', 'running', 'paused', 'blocked', 'verifying',
  'ready_for_review', 'completed', 'cancelled',
]);

const RUN_ACTIVE_STATES = new Set(['planning', 'running', 'paused', 'blocked', 'verifying', 'ready_for_review']);
const json = (value, fallback) => JSON.stringify(value ?? fallback);
const parsed = (value, fallback) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

const SCHEMA = `
create table if not exists messages (
  id        integer primary key autoincrement,
  ts        integer not null,
  sender    text    not null,
  recipient text,                       -- null = broadcast to all awake agents
  kind      text    not null,           -- message | escalation | done | brief | system
  body      text    not null,
  attachments text not null default '[]', -- json array of uploaded asset references
  conversation_id text not null default 'default',
  run_id    text
);
create table if not exists events (
  id      integer primary key autoincrement,
  ts      integer not null,
  agent   text    not null,
  type    text    not null,             -- text | tool | turn_end | ready | error
  payload text    not null,             -- json
  conversation_id text not null default 'default'
);
create table if not exists conversations (
  id         text primary key,          -- 'default', or c-<ts>-<rand> for a new/forked thread
  member     text not null,             -- which court member this thread belongs to
  title      text not null default '',
  parent_id  text,                      -- set when forked from another conversation
  fork_at    integer,                   -- message id this was forked from, when parent_id is set
  created_ts integer not null,
  archived   integer not null default 0
);
create table if not exists state (
  k text primary key,
  v text not null
);
create table if not exists tasks (
  id         integer primary key autoincrement,
  ts         integer not null,
  title      text    not null,
  detail     text    not null default '',
  owner      text,                          -- null = nobody has claimed it
  state      text    not null default 'pending', -- pending|planning|active|done|dropped
  needs      text    not null default '[]', -- json array of task ids that must finish first
  needs_plan integer not null default 0,    -- 1 = the plan must be approved before work
  plan       text,
  by         text    not null,
  done_ts    integer,
  run_id     text
);
create table if not exists runs (
  id                    text primary key,
  created_ts            integer not null,
  updated_ts            integer not null,
  state                 text not null,
  objective             text not null default '',
  source_snapshot      text not null default '{}',
  approved_plan        text not null default '{}',
  acceptance_criteria  text not null default '[]',
  allowed_models       text not null default '[]',
  task_ids             text not null default '[]',
  recovery_history     text not null default '[]',
  verification_evidence text not null default '[]',
  baseline_revision     text,
  branch                text,
  approved_ts           integer,
  final_approved        integer not null default 0,
  final_approved_ts     integer,
  applied_ts            integer,
  completed_ts          integer,
  cancelled_ts          integer,
  blocker               text
);
-- One row per priced turn taken while a run is current. A run's spend is the
-- sum of its own rows, never lifetime spend minus a baseline: clearSpend()
-- zeroes the lifetime counter and made that subtraction go negative.
create table if not exists run_spend (
  id      integer primary key autoincrement,
  run_id  text    not null,
  ts      integer not null,
  agent   text    not null,
  usd     real    not null
);
create table if not exists campaigns (
  id            integer primary key autoincrement,
  ts            integer not null,
  title         text    not null,
  message_start integer not null,
  event_start   integer not null,
  spent_usd     real    not null,
  tokens        integer not null
);
create table if not exists memory_proposals (
  campaign integer primary key,
  count    integer not null default 0
);
create virtual table if not exists messages_fts using fts5(
  body, content='messages', content_rowid='id'
);
create virtual table if not exists events_fts using fts5(
  payload, content='events', content_rowid='id'
);
create trigger if not exists messages_fts_insert after insert on messages begin
  insert into messages_fts(rowid, body) values (new.id, new.body);
end;
create trigger if not exists messages_fts_delete after delete on messages begin
  insert into messages_fts(messages_fts, rowid, body) values ('delete', old.id, old.body);
end;
create trigger if not exists events_fts_insert after insert on events begin
  insert into events_fts(rowid, payload) values (new.id, new.payload);
end;
create trigger if not exists events_fts_delete after delete on events begin
  insert into events_fts(events_fts, rowid, payload) values ('delete', old.id, old.payload);
end;
create index if not exists idx_msg_recipient on messages(recipient, id);
create index if not exists idx_evt_agent on events(agent, id);
create index if not exists idx_task_state on tasks(state, owner);
create index if not exists idx_conv_member on conversations(member, created_ts);
create index if not exists idx_run_spend on run_spend(run_id, id);
`;

// A pre-conversations db's messages/events tables don't have conversation_id
// yet at SCHEMA-exec time — #migrateConversations() adds it — so these two
// indexes must be created AFTER that migration runs, not as part of SCHEMA.
const CONVERSATION_INDEXES = `
create index if not exists idx_msg_conv on messages(conversation_id, id);
create index if not exists idx_evt_conv on events(conversation_id, id);
`;

const RUN_INDEXES = `
create index if not exists idx_msg_run on messages(run_id, id);
create index if not exists idx_task_run on tasks(run_id, id);
create index if not exists idx_run_state on runs(state, updated_ts);
`;

// Attachments are references to files already accepted by the asset endpoint,
// never file contents. Keep only the small public shape needed by the thread;
// rejecting separators also keeps a malformed row from becoming a traversal
// link when it is rendered.
const cleanAttachments = (value) => (Array.isArray(value) ? value : [])
  .map((item) => {
    const name = typeof item === 'string' ? item : item?.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\\/\0]/.test(name)) return null;
    const out = { name: name.trim() };
    if (typeof item === 'object' && typeof item.kind === 'string' && item.kind.trim()) out.kind = item.kind.trim();
    return out;
  })
  .filter(Boolean)
  .slice(0, 32);

const readAttachments = (value) => {
  try { return cleanAttachments(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return []; }
};

export class Bus {
  constructor(dbPath) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // MUST be first. WAL lets readers and ONE writer coexist, but concurrent
    // writers still contend, and SQLite's default busy timeout is 0 — so the
    // second writer fails instantly with "database is locked" instead of
    // waiting. With one MCP server process per agent that is a certainty, not
    // an edge case. This pragma makes them queue.
    this.db.exec('pragma busy_timeout = 15000');
    // Setting journal_mode itself needs a brief exclusive lock, so several
    // agents starting at once can collide here. It is persistent, so once any
    // process has set WAL the rest can safely fail.
    try {
      this.db.exec('pragma journal_mode = WAL');
    } catch {}
    this.db.exec('pragma synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.#migrateAll();
    this.db.exec(CONVERSATION_INDEXES);
    this.db.exec(RUN_INDEXES);
  }

  /** Run `fn` once per database, atomically, recorded under `flag`. */
  #migrate(flag, fn) {
    this.db.exec('begin immediate');
    try {
      if (this.get(flag) !== '1') {
        fn();
        this.set(flag, '1');
      }
      this.db.exec('commit');
    } catch (e) {
      this.db.exec('rollback');
      throw e;
    }
  }

  #columns(table) {
    return this.db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
  }

  #migrateAll() {
    // Existing courts get one FTS rebuild; new rows stay current by trigger.
    this.#migrate('fts:transcript:v1', () => {
      this.db.exec("insert into messages_fts(messages_fts) values ('rebuild')");
      this.db.exec("insert into events_fts(events_fts) values ('rebuild')");
    });
    // A court that existed before conversations did has `messages`/`events`
    // tables with no `conversation_id` column. `CREATE TABLE IF NOT EXISTS`
    // only helps a brand-new db — an existing table needs an explicit ALTER,
    // and SQLite backfills every existing row with the column's DEFAULT, which
    // is exactly "everything before conversations is the 'default' one."
    this.#migrate('schema:conversations:v1', () => {
      for (const table of ['messages', 'events']) {
        if (!this.#columns(table).includes('conversation_id')) {
          this.db.exec(`alter table ${table} add column conversation_id text not null default 'default'`);
        }
      }
    });
    // Structured asset references, without rewriting the existing transcript.
    this.#migrate('schema:messages:attachments:v1', () => {
      if (!this.#columns('messages').includes('attachments')) {
        this.db.exec("alter table messages add column attachments text not null default '[]'");
      }
    });
    // Run storage and nullable run associations, without rewriting old rows.
    this.#migrate('schema:runs:v1', () => {
      if (!this.#columns('messages').includes('run_id')) this.db.exec('alter table messages add column run_id text');
      if (!this.#columns('tasks').includes('run_id')) this.db.exec('alter table tasks add column run_id text');
      const runColumns = this.#columns('runs');
      if (!runColumns.includes('final_approved')) this.db.exec('alter table runs add column final_approved integer not null default 0');
      if (!runColumns.includes('final_approved_ts')) this.db.exec('alter table runs add column final_approved_ts integer');
    });
    // The blocker used to travel only on the live 'run' event, so a reload
    // showed a blocked run with no reason and no next action.
    this.#migrate('schema:runs:blocker:v1', () => {
      if (!this.#columns('runs').includes('blocker')) this.db.exec('alter table runs add column blocker text');
    });
    // Approval payloads moved out of the message log so they survive pruning;
    // post() writes new ones there directly.
    this.#migrate('schema:approvals:v1', () => {
      for (const row of this.db.prepare("select id, ts, sender, recipient, body, conversation_id, run_id from messages where kind = 'approval'").all()) {
        if (!this.get(`approval:${row.id}`)) this.set(`approval:${row.id}`, JSON.stringify({ ...row, runId: row.run_id ?? null }));
      }
    });
  }

  #messageRows(rows) {
    return rows.map((row) => ({ ...row, attachments: readAttachments(row.attachments) }));
  }

  // --- messages -------------------------------------------------------

  /** recipient=null broadcasts. Returns the new message id. */
  post(sender, recipient, body, kind = 'message', conversationId = 'default', attachments = [], runId = null) {
    const ts = Date.now();
    // Approval records created during an active run inherit it; ordinary court
    // traffic remains unassociated so the old transcript keeps its meaning.
    if (kind === 'approval' && runId == null) runId = this.currentRun()?.id ?? null;
    const { lastInsertRowid } = this.db
      .prepare('insert into messages (ts, sender, recipient, kind, body, attachments, conversation_id, run_id) values (?,?,?,?,?,?,?,?)')
      .run(ts, sender, recipient, kind, body, JSON.stringify(cleanAttachments(attachments)), conversationId, runId);
    const id = Number(lastInsertRowid);
    if (kind === 'approval') {
      this.set(`approval:${id}`, JSON.stringify({
        id, ts, sender, recipient, body, conversation_id: conversationId, runId,
      }));
    }
    return id;
  }

  approvals({ since = 0 } = {}) {
    return this.db.prepare("select v from state where k like 'approval:%' and cast(substr(k, 10) as integer) > ? order by cast(substr(k, 10) as integer)")
      .all(since).flatMap(({ v }) => {
        try {
          const row = JSON.parse(v);
          return [{ ...row, runId: row.runId ?? row.run_id ?? null }];
        } catch { return []; }
      });
  }

  /**
   * Drop `recipient`'s still-undelivered notices whose body starts with
   * `prefix`, so a rapid run of the same kind of notice (a mode flipped five
   * times before anyone was awake to read it) collapses to just the latest
   * instead of queuing every intermediate one into that member's next turn.
   * A message already past the recipient's cursor is left alone — it may
   * already be mid-delivery.
   */
  supersede(recipient, prefix) {
    const cursor = Number(this.get(`cursor:${recipient}`) ?? 0);
    this.db.prepare(
      `delete from messages where id > ? and recipient = ? and kind = 'notice' and substr(body, 1, ?) = ?`
    ).run(cursor, recipient, prefix.length, prefix);
  }

  /**
   * Everything addressed to `agent` (or broadcast) since its cursor, and it
   * never receives its own messages. Cursor-based so broadcast delivery is
   * exactly-once per agent without a deliveries table.
   *
   * `limit` because the caller concatenates the whole result into ONE turn.
   *
   * A member asleep across a long stretch of broadcasts woke to every message
   * at once, in a single prompt, with no cap — the orchestrator's own posts
   * bypass the 4000-char limit mcp.js puts on member messages, so nothing else
   * bounded it. The oldest are taken first, so the remainder simply rides the
   * next tick: 300ms later, and in order.
   *
   * `conversation`, when given, scopes only `assignment` rows (the sovereign's
   * actual chat turns, posted by kingdom.js#command/#speakTo) to one thread.
   * Everything else — notices, approvals, system, escalation, done, brief,
   * and plain inter-member `message` chatter — is court-wide and must reach a
   * member regardless of which conversation it currently has active (a member
   * only ever has one live session at a time, see kingdom.js#switchConversation,
   * so this is the delivery-side half of that: a stray "mode: research" notice
   * must not wait for the sovereign to switch back to whatever thread happened
   * to be active when it was sent). An inclusion list, not an exclusion one —
   * new kinds default to court-wide, which is the safer failure mode.
   */
  pending(agent, limit = 200, conversation = null) {
    const cursor = Number(this.get(`cursor:${agent}`) ?? 0);
    const where = ['id > ?', 'sender != ?', '(recipient = ? or recipient is null)'];
    const args = [cursor, agent, agent];
    if (conversation) { where.push("(kind != 'assignment' or conversation_id = ?)"); args.push(conversation); }
    args.push(limit);
    return this.#messageRows(this.db
      .prepare(`select * from messages where ${where.join(' and ')} order by id limit ?`)
      .all(...args));
  }

  ack(agent, messageId) {
    this.set(`cursor:${agent}`, String(messageId));
  }

  /**
   * Full log for the briefer, or the orchestrator's escape hatch.
   *
   * `tail` decides WHICH end the limit cuts from, and the two callers want
   * opposite ends. A cursor reader ("what is new since id 40, 60 rows please")
   * must get the OLDEST 60 after the cursor or it silently skips everything
   * between — that is the default. A snapshot ("the last 200, I am repainting
   * the room") must get the NEWEST 200. Only the first was implemented, so the
   * throne room's reload replayed the FIRST 200 messages of a session and
   * nothing since — which reads, correctly, as messages not being saved at all.
   */
  history({ since = 0, limit = 200, agent = null, tail = false, conversation = null } = {}) {
    const args = [since];
    let where = 'id > ?';
    if (agent) { where += ' and (sender = ? or recipient = ?)'; args.push(agent, agent); }
    if (conversation) { where += ' and conversation_id = ?'; args.push(conversation); }
    args.push(limit);
    return this.#messageRows(this.db.prepare(
      tail
        ? `select * from (select * from messages where ${where} order by id desc limit ?)
             order by id`
        : `select * from messages where ${where} order by id limit ?`
    ).all(...args));
  }

  // --- raw agent events (briefer firehose + UI replay) -----------------

  logEvent(agent, type, payload, conversationId = 'default') {
    this.db
      .prepare('insert into events (ts, agent, type, payload, conversation_id) values (?,?,?,?,?)')
      .run(Date.now(), agent, type, JSON.stringify(payload ?? {}), conversationId);
  }

  // `type` filters in SQL rather than after the fact, because every row this
  // returns is JSON.parsed: /api/metrics wants only the turn_ends, and pulling
  // all 20,000 retained events to keep a handful of them parsed the whole log
  // every 5 seconds.
  // `tail` as in history(): the newest `limit` rows rather than the oldest.
  events({ since = 0, agent = null, type = null, limit = 500, tail = false, conversation = null } = {}) {
    const where = ['id > ?'];
    const args = [since];
    if (agent) { where.push('agent = ?'); args.push(agent); }
    if (type) { where.push('type = ?'); args.push(type); }
    if (conversation) { where.push('conversation_id = ?'); args.push(conversation); }
    args.push(limit);
    const w = where.join(' and ');
    const rows = this.db.prepare(
      tail
        ? `select * from (select * from events where ${w} order by id desc limit ?) order by id`
        : `select * from events where ${w} order by id limit ?`
    ).all(...args);
    return rows.flatMap((r) => {
      try { return [{ ...r, payload: JSON.parse(r.payload) }]; }
      catch { return []; }
    });
  }

  /**
   * The newest event id, or 0. An O(1) primary-key probe — this exists so a
   * caller can tell whether the log has moved WITHOUT paying for events(),
   * which JSON.parses every row it returns.
   */
  lastEventId() {
    return this.db.prepare('select max(id) as id from events').get().id ?? 0;
  }

  lastMessageId() {
    return this.db.prepare('select max(id) as id from messages').get().id ?? 0;
  }

  /** A sovereign order is a chronological interval, never a guessed project plan. */
  beginCampaign(title) {
    const row = {
      ts: Date.now(), title: String(title ?? '').trim(),
      messageStart: this.lastMessageId(), eventStart: this.lastEventId(),
      spentUsd: Number(this.get('spentUsd') ?? 0), tokens: Number(this.get('tokens') ?? 0),
    };
    const { lastInsertRowid } = this.db.prepare(
      'insert into campaigns (ts,title,message_start,event_start,spent_usd,tokens) values (?,?,?,?,?,?)'
    ).run(row.ts, row.title, row.messageStart, row.eventStart, row.spentUsd, row.tokens);
    return { id: Number(lastInsertRowid), ...row };
  }

  campaigns() {
    const rows = this.db.prepare('select * from campaigns order by id').all();
    const now = { spentUsd: Number(this.get('spentUsd') ?? 0), tokens: Number(this.get('tokens') ?? 0) };
    return rows.map((r, i) => {
      const next = rows[i + 1];
      const end = next
        ? { spentUsd: Number(next.spent_usd), tokens: Number(next.tokens) }
        : now;
      return {
        id: r.id, ts: r.ts, title: r.title,
        messageStart: r.message_start, messageEnd: next?.message_start ?? null,
        eventStart: r.event_start, eventEnd: next?.event_start ?? null,
        spentUsd: end.spentUsd - Number(r.spent_usd), tokens: end.tokens - Number(r.tokens),
        current: !next,
      };
    });
  }

  campaign(id) {
    return this.campaigns().find((c) => c.id === Number(id)) ?? null;
  }

  /**
   * Reserve one of a closed campaign's three retrospective slots.
   *
   * This is deliberately an INSERT/UPDATE rather than a history() count: the
   * bus is retained only to a finite length, and two MCP processes can propose
   * at once. SQLite makes this one statement atomic, so a busy court cannot
   * sneak a fourth proposed memory through a read-then-write race.
   */
  takeMemoryProposal(campaign, limit = 3) {
    const id = Number(campaign);
    const cap = Number(limit);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(cap) || cap < 1) return false;
    const r = this.db.prepare(
      `insert into memory_proposals (campaign,count) values (?,1)
       on conflict(campaign) do update set count = count + 1 where count < ?`,
    ).run(id, cap);
    return r.changes === 1;
  }

  /** How many messages there are. Counting them by loading every body is not that. */
  countMessages() {
    return this.db.prepare('select count(*) as n from messages').get().n;
  }

  /**
   * FTS5 search across everything the court has said or done: event
   * text/tool/summary payloads and posted messages, merged and ranked by
   * recency. This IS the "remembers everything" system — events/messages
   * already are a complete log, so recall is a read, not a new capture
   * pipeline. Retrieval stays pull-based (searched on demand, here and via
   * the `recall` MCP tool) rather than injected into every prompt, matching
   * memoryIndex()'s index/search-don't-inject approach in memory.js.
   */
  recall(query, { limit = 20 } = {}) {
    // The query is data, not FTS syntax. Quoting each word keeps punctuation
    // from turning a member's literal search into an operator expression.
    const terms = String(query ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    const events = this.db.prepare(
      `select events.ts, events.agent as who, events.type as kind, events.payload from events_fts
        join events on events.id = events_fts.rowid
        where events_fts match ? and events.type in ('text','tool','summary','error','workflow_run')
        order by id desc limit ?`
    ).all(match, limit).flatMap((r) => {
      try {
        const p = JSON.parse(r.payload);
        const text = r.kind === 'tool' ? `${p.name} ${JSON.stringify(p.input ?? p)}`
          : r.kind === 'workflow_run' ? `workflow "${p.name}" ${p.ok ? 'succeeded' : `failed: ${p.error}`}`
          : (p.text ?? p.message ?? JSON.stringify(p));
        return [{ ts: r.ts, who: r.who, kind: r.kind, text, source: 'event' }];
      } catch { return []; }
    });
    const messages = this.db.prepare(
      `select messages.ts, messages.sender as who, messages.kind, messages.body as text from messages_fts
        join messages on messages.id = messages_fts.rowid
        where messages_fts match ? order by messages.id desc limit ?`
    ).all(match, limit).map((r) => ({ ...r, source: 'message' }));
    return [...events, ...messages].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // --- conversations ----------------------------------------------------
  //
  // A conversation is a named thread scoped to one court member. Creation is
  // idempotent (`on conflict do nothing`) so callers with a well-known id —
  // 'default', or one minted client-side before the round-trip completes —
  // never need a separate existence check first.

  createConversation(member, { id = null, title = '', parentId = null, forkAt = null } = {}) {
    const cid = id || `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.db.prepare(
      `insert into conversations (id, member, title, parent_id, fork_at, created_ts)
       values (?,?,?,?,?,?) on conflict(id) do nothing`
    ).run(cid, member, title, parentId, forkAt ?? null, Date.now());
    return this.conversation(cid);
  }

  conversation(id) {
    return this.db.prepare('select * from conversations where id = ?').get(id) ?? null;
  }

  conversations(member) {
    return this.db.prepare(
      'select * from conversations where member = ? and archived = 0 order by created_ts'
    ).all(member);
  }

  renameConversation(id, title) {
    this.db.prepare('update conversations set title = ? where id = ?').run(title, id);
    return this.conversation(id);
  }

  /** Soft delete — a transcript is the court's record, never hard-deleted. */
  archiveConversation(id) {
    this.db.prepare('update conversations set archived = 1 where id = ?').run(id);
  }

  /** Every conversation (including `id` itself) that forked from the same point. */
  siblingsOf(id) {
    const c = this.conversation(id);
    if (!c) return [];
    if (!c.parent_id) return [c];
    return this.db.prepare(
      'select * from conversations where parent_id = ? and fork_at = ? order by created_ts'
    ).all(c.parent_id, c.fork_at);
  }

  forkConversation(parentId, forkAt, member, title = '') {
    return this.createConversation(member, { title, parentId, forkAt });
  }

  // --- durable improvement runs -----------------------------------------

  #runRow(row) {
    if (!row) return null;
    const blocker = parsed(row.blocker, null);
    return {
      id: row.id,
      createdTs: row.created_ts,
      updatedTs: row.updated_ts,
      state: row.state,
      objective: row.objective,
      sourceSnapshot: parsed(row.source_snapshot, {}),
      approvedPlan: parsed(row.approved_plan, {}),
      acceptanceCriteria: parsed(row.acceptance_criteria, []),
      allowedModels: parsed(row.allowed_models, []),
      taskIds: parsed(row.task_ids, []),
      recoveryHistory: parsed(row.recovery_history, []),
      verificationEvidence: parsed(row.verification_evidence, []),
      baselineRevision: row.baseline_revision,
      branch: row.branch,
      approvedTs: row.approved_ts,
      finalApproval: !!row.final_approved,
      finalApprovedTs: row.final_approved_ts,
      appliedTs: row.applied_ts,
      completedTs: row.completed_ts,
      cancelledTs: row.cancelled_ts,
      blocker,
      blockers: blocker ? [blocker] : [],
    };
  }

  /** Create one durable run; a workspace has at most one non-terminal run. */
  createRun({
    id = null, objective = '', state = 'planning', sourceSnapshot = {}, approvedPlan = {},
    acceptanceCriteria = [], allowedModels = [], taskIds = [], recoveryHistory = [],
    verificationEvidence = [], baselineRevision = null, branch = null,
  } = {}) {
    if (!RUN_STATES.has(state)) throw new Error(`Unknown run state: ${state}`);
    if (this.currentRun()) throw new Error('An improvement run is already active.');
    const runId = id || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db.prepare(
      `insert into runs
       (id,created_ts,updated_ts,state,objective,source_snapshot,approved_plan,acceptance_criteria,
        allowed_models,task_ids,recovery_history,verification_evidence,baseline_revision,branch)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      runId, now, now, state, String(objective ?? ''), json(sourceSnapshot, {}), json(approvedPlan, {}),
      json(acceptanceCriteria, []), json(allowedModels, []), json(taskIds, []), json(recoveryHistory, []),
      json(verificationEvidence, []), baselineRevision, branch,
    );
    return this.run(runId);
  }

  run(id) {
    if (id == null) return this.currentRun();
    return this.#runRow(this.db.prepare('select * from runs where id = ?').get(String(id)));
  }

  runs({ state = null } = {}) {
    const rows = state
      ? this.db.prepare('select * from runs where state = ? order by created_ts, rowid').all(state)
      : this.db.prepare('select * from runs order by created_ts, rowid').all();
    return rows.map((row) => this.#runRow(row));
  }

  currentRun() {
    return this.#runRow(this.db.prepare(
      `select * from runs where state in (${[...RUN_ACTIVE_STATES].map(() => '?').join(',')}) order by updated_ts desc limit 1`,
    ).get(...RUN_ACTIVE_STATES));
  }

  updateRun(id, fields = {}) {
    const run = this.run(id);
    if (!run) return null;
    const columns = {
      state: 'state', objective: 'objective', sourceSnapshot: 'source_snapshot', approvedPlan: 'approved_plan',
      acceptanceCriteria: 'acceptance_criteria', allowedModels: 'allowed_models', taskIds: 'task_ids',
      recoveryHistory: 'recovery_history', verificationEvidence: 'verification_evidence',
      baselineRevision: 'baseline_revision', branch: 'branch', approvedTs: 'approved_ts', appliedTs: 'applied_ts',
      finalApproval: 'final_approved', finalApprovedTs: 'final_approved_ts',
      completedTs: 'completed_ts', cancelledTs: 'cancelled_ts', blocker: 'blocker',
    };
    // A blocker describes the blocked state and nothing else: leaving it (a
    // recovery back to running, a stop) clears it unless the caller sets one.
    if (fields.state !== undefined && fields.state !== 'blocked' && fields.blocker === undefined) {
      fields = { ...fields, blocker: null };
    }
    const arrays = new Set(['acceptanceCriteria', 'allowedModels', 'taskIds', 'recoveryHistory', 'verificationEvidence']);
    const objects = new Set(['sourceSnapshot', 'approvedPlan']);
    const set = [], args = [];
    for (const [key, column] of Object.entries(columns)) {
      if (fields[key] === undefined) continue;
      if (key === 'state' && !RUN_STATES.has(fields[key])) throw new Error(`Unknown run state: ${fields[key]}`);
      set.push(`${column} = ?`);
      args.push(key === 'finalApproval' ? (fields[key] ? 1 : 0)
        : key === 'blocker' ? (fields[key] == null ? null : json(fields[key], null))
        : arrays.has(key) || objects.has(key) ? json(fields[key], arrays.has(key) ? [] : {}) : fields[key]);
    }
    if (!set.length) return run;
    set.push('updated_ts = ?');
    args.push(Date.now(), String(id));
    this.db.prepare(`update runs set ${set.join(', ')} where id = ?`).run(...args);
    return this.run(id);
  }

  transitionRun(id, state, fields = {}) {
    const run = this.run(id);
    if (!run) throw new Error(`No run ${id}`);
    const allowed = {
      planning: ['running', 'cancelled'],
      running: ['paused', 'blocked', 'verifying', 'cancelled'],
      paused: ['running', 'cancelled'],
      blocked: ['running', 'cancelled'],
      verifying: ['blocked', 'ready_for_review', 'cancelled'],
      ready_for_review: ['completed', 'blocked', 'cancelled'],
      completed: [], cancelled: [],
    };
    if (!RUN_STATES.has(state)) throw new Error(`Unknown run state: ${state}`);
    if (state !== run.state && !allowed[run.state].includes(state)) {
      throw new Error(`Run ${id} cannot move from ${run.state} to ${state}.`);
    }
    const now = Date.now();
    const timestamps = {
      ...(state === 'running' && run.state === 'planning' ? { approvedTs: now } : {}),
      ...(state === 'completed' ? { completedTs: now } : {}),
      ...(state === 'cancelled' ? { cancelledTs: now } : {}),
    };
    const out = this.updateRun(id, { ...fields, state, ...timestamps });
    this.logEvent('run', 'run_state', { runId: id, from: run.state, state });
    return out;
  }

  approveRun(id, fields = {}) {
    const run = this.run(id ?? this.currentRun()?.id);
    if (run?.state === 'ready_for_review') {
      const now = Date.now();
      const out = this.updateRun(run.id, { finalApproval: true, finalApprovedTs: now });
      this.logEvent('run', 'run_final_approval', { runId: run.id });
      return out;
    }
    return this.transitionRun(run?.id, 'running', fields);
  }
  pauseRun(id) { return this.transitionRun(id ?? this.currentRun()?.id, 'paused'); }
  stopRun(id) { return this.transitionRun(id ?? this.currentRun()?.id, 'cancelled'); }
  resumeRun(id) { return this.transitionRun(id ?? this.currentRun()?.id, 'running'); }
  applyRun(id) {
    const run = this.run(id ?? this.currentRun()?.id);
    if (!run) throw new Error(`No run ${id}`);
    if (run.state !== 'ready_for_review' && run.state !== 'completed') {
      throw new Error(`Run ${run.id} is ${run.state}; only a ready-for-review run can be applied.`);
    }
    if (run.state === 'ready_for_review' && !run.finalApproval) {
      throw new Error(`Run ${run.id} needs final approval before it can be applied.`);
    }
    return run.state === 'completed' ? this.updateRun(run.id, { appliedTs: Date.now() })
      : this.transitionRun(run.id, 'completed', { appliedTs: Date.now() });
  }

  recordRunSpend(runId, agent, usd, ts = Date.now()) {
    this.db.prepare('insert into run_spend (run_id, ts, agent, usd) values (?,?,?,?)')
      .run(String(runId), ts, String(agent), Number(usd) || 0);
  }

  runSpentUsd(runId) {
    return this.db.prepare('select coalesce(sum(usd), 0) as usd from run_spend where run_id = ?').get(String(runId)).usd;
  }

  /**
   * One run's spend: total, per member, and a cumulative series thinned to at
   * most `maxPoints` (always keeping the last point, so the line ends on the
   * total).
   */
  runSpend(runId, { maxPoints = 400 } = {}) {
    const rows = this.db.prepare('select ts, agent, usd from run_spend where run_id = ? order by id').all(String(runId));
    const members = new Map();
    const series = [];
    let total = 0;
    for (const row of rows) {
      total += row.usd;
      const m = members.get(row.agent) ?? { name: row.agent, usd: 0, turns: 0 };
      m.usd += row.usd; m.turns += 1;
      members.set(row.agent, m);
      series.push({ ts: row.ts, usd: total });
    }
    const step = Math.ceil(series.length / Math.max(2, maxPoints));
    const thinned = step <= 1 ? series
      : series.filter((_, i) => i % step === 0 || i === series.length - 1);
    return {
      runId: String(runId), usd: total, turns: rows.length,
      members: [...members.values()].sort((x, y) => y.usd - x.usd),
      series: thinned,
    };
  }

  /** Spend and turn totals for every run that has any, keyed by run id. */
  runSpendTotals() {
    const out = {};
    for (const row of this.db.prepare('select run_id, sum(usd) as usd, count(*) as turns from run_spend group by run_id').all()) {
      out[row.run_id] = { usd: row.usd, turns: row.turns };
    }
    return out;
  }

  // --- the shared task list -------------------------------------------
  //
  // Before this, the orchestrator assigned by message and nothing tracked the result.
  // An assignment that a peasant never acted on left no trace: not in a queue,
  // not in a count, nowhere the sovereign could see it. So the court could not
  // answer "what is still outstanding" — the single question an orchestrator
  // exists to answer.
  //
  // Claiming is one `begin immediate` transaction rather than the file lock
  // Claude Code's agent teams use for the same job. Every member's MCP server
  // is a separate process against one SQLite file, which is exactly the race
  // the transaction was designed for, and busy_timeout (set in the
  // constructor) makes the loser wait instead of failing.

  /** Deps are stored as json because a task has none or two, never a join. */
  addTask({ title, detail = '', needs = [], needsPlan = false, by, runId = null }) {
    const { lastInsertRowid } = this.db.prepare(
      'insert into tasks (ts, title, detail, needs, needs_plan, by, run_id) values (?,?,?,?,?,?,?)'
    ).run(Date.now(), title, detail, JSON.stringify(needs.map(Number)), needsPlan ? 1 : 0, by, runId);
    return Number(lastInsertRowid);
  }

  /**
   * The whole list, each row told whether it is blocked and by what.
   *
   * `blockedBy` is computed here rather than stored, because "done" moves
   * underneath it: a task unblocks the moment its last dependency finishes,
   * with nobody having to remember to go and update it. Agent teams cite the
   * opposite failure — "teammates sometimes fail to mark tasks as completed,
   * which blocks dependent tasks" — as a live limitation.
   */
  tasks({ state = null, owner = null, id = null, runId = null } = {}) {
    // Filter in SQL, not in JS. This ran `select *` and discarded the rest —
    // so idx_task_state was never used, and every caller (availableTasks, both
    // halves of updateTask, claimTask inside its own transaction, /api/tasks)
    // paid a full scan and a JSON.parse per row to look at a handful.
    // `done` still needs the whole set, but only the ids, and only from the
    // rows that can block anything.
    const done = new Set(this.db.prepare("select id from tasks where state = 'done'")
      .all().map((t) => t.id));
    const where = [], args = [];
    if (state) { where.push('state = ?'); args.push(state); }
    if (owner) { where.push('owner = ?'); args.push(owner); }
    if (id != null) { where.push('id = ?'); args.push(Number(id)); }
    if (runId != null) { where.push('run_id = ?'); args.push(String(runId)); }
    const rows = this.db.prepare(
      `select * from tasks${where.length ? ` where ${where.join(' and ')}` : ''} order by id`
    ).all(...args);
    return rows.map((t) => {
      let needs = [];
      try { needs = JSON.parse(t.needs); } catch { /* a corrupt dep list blocks nothing */ }
      return {
        ...t,
        needs,
        needsPlan: !!t.needs_plan,
        runId: t.run_id ?? null,
        blockedBy: needs.filter((n) => !done.has(n)),
      };
    });
  }

  /** Unclaimed, unblocked, oldest first — what an idle member could pick up. */
  availableTasks() {
    return this.tasks({ state: 'pending' }).filter((t) => !t.owner && !t.blockedBy.length);
  }

  /**
   * Take a task, or say precisely why not. `id` null means "the next one".
   *
   * The read and the write are one transaction: two peasants asking at the
   * same instant must not both be told yes. The refusal reasons are separated
   * because "somebody else has it" and "its dependency is not finished" call
   * for opposite behaviour from the member reading them.
   */
  claimTask(owner, id = null) {
    // `began`, because the rollback used to be unconditional. If `begin
    // immediate` ITSELF throws — SQLITE_BUSY past the busy_timeout, which is
    // the precise contention this transaction exists for — no transaction is
    // open, so the rollback threw too and replaced the real error with
    // "cannot rollback - no transaction is active".
    let began = false;
    try {
      this.db.exec('begin immediate');
      began = true;
      const t = id == null ? this.availableTasks()[0] : this.task(id);
      if (!t) { this.db.exec('commit'); return { ok: false, why: id == null ? 'No task is available.' : `No task #${id}.` }; }
      if (t.owner) { this.db.exec('commit'); return { ok: false, why: `Task #${t.id} is already ${t.owner}'s.` }; }
      if (t.state !== 'pending') { this.db.exec('commit'); return { ok: false, why: `Task #${t.id} is ${t.state}.` }; }
      if (t.blockedBy.length) {
        this.db.exec('commit');
        return { ok: false, why: `Task #${t.id} waits on ${t.blockedBy.map((n) => `#${n}`).join(', ')}.` };
      }
      const state = t.needs_plan ? 'planning' : 'active';
      this.db.prepare('update tasks set owner = ?, state = ? where id = ?').run(owner, state, t.id);
      this.db.exec('commit');
      return { ok: true, task: { ...t, owner, state } };
    } catch (e) {
      if (began) { try { this.db.exec('rollback'); } catch {} }
      throw e;
    }
  }

  /** One task by id, with the same computed fields as tasks(). */
  task(id) {
    return this.tasks({ id: Number(id) })[0] ?? null;
  }

  /** Returns the updated row, or null if there is no such task. */
  updateTask(id, fields) {
    const cols = { state: 'state', plan: 'plan', owner: 'owner', doneTs: 'done_ts', runId: 'run_id' };
    const set = [], args = [];
    for (const [k, col] of Object.entries(cols)) {
      if (fields[k] !== undefined) { set.push(`${col} = ?`); args.push(fields[k]); }
    }
    // Was a full table scan plus a JSON.parse of every row, TWICE, to return
    // one task.
    if (!set.length) return this.task(id);
    args.push(Number(id));
    this.db.prepare(`update tasks set ${set.join(', ')} where id = ?`).run(...args);
    return this.task(id);
  }

  // --- kv state (session ids, roster, cursors) ------------------------

  get(k) {
    return this.db.prepare('select v from state where k = ?').get(k)?.v;
  }

  set(k, v) {
    this.db.prepare('insert into state (k,v) values (?,?) on conflict(k) do update set v = ?').run(k, v, v);
  }

  increment(k, amount = 1) {
    const delta = Number(amount) || 0;
    this.db.prepare(`
      insert into state (k, v) values (?, ?)
      on conflict(k) do update set v = cast(state.v as integer) + cast(excluded.v as integer)
    `).run(k, String(delta));
    return Number(this.get(k) ?? 0);
  }

  /**
   * Keep the newest `keep` rows of each log. A day-long session accumulates
   * tens of thousands of tool events; nothing reads that far back, and the
   * briefer's read_events would happily drag it all into context.
   * Messages are kept longer than events — they are the kingdom's record.
   */
  prune({ keepMessages = 5000, keepEvents = 20000, keepApprovals = 2000 } = {}) {
    const before = this.db.prepare('select count(*) c from events').get().c;
    this.db.prepare(
      'delete from events where id <= (select max(id) - ? from events)'
    ).run(keepEvents);
    this.db.prepare(
      'delete from messages where id <= (select max(id) - ? from messages)'
    ).run(keepMessages);
    // Per-message state keys: `done:<id>`, `doneretry:<id>`, `retried:<id>`,
    // `resolved:<id>`. Each is a one-shot flag guarding work on ONE message, so
    // once that message is pruned the flag can never be read again — but it was
    // never deleted, so `state` grew by several rows per message forever while
    // the logs above stayed bounded. Drop the ones whose message is gone —
    // except an approval's decision, which lives as long as the approval
    // itself does (below); without it a retained approval reads as pending.
    const oldest = this.db.prepare('select min(id) m from messages').get().m;
    if (oldest != null) {
      this.db.prepare(
        "delete from state where instr(k, ':') > 0"
        + " and substr(k, 1, instr(k, ':') - 1) in ('done','doneretry','retried','resolved')"
        + ' and cast(substr(k, instr(k, \':\') + 1) as integer) < ?'
        + " and not exists (select 1 from state a where a.k = 'approval:' || substr(state.k, instr(state.k, ':') + 1))"
      ).run(oldest);
    }
    // Approval payloads live outside the message log so pending decisions
    // survive message pruning. Resolved payloads still need a finite history;
    // otherwise /api/approvals scans one state row forever per decision.
    this.db.prepare(
      "delete from state where (k like 'approval:%' or k like 'resolved:%')"
      + ' and cast(substr(k, instr(k, \':\') + 1) as integer) in ('
      + "select cast(substr(a.k, 10) as integer) from state a"
      + " where a.k like 'approval:%'"
      + " and exists (select 1 from state r where r.k = 'resolved:' || substr(a.k, 10))"
      + ' order by cast(substr(a.k, 10) as integer) desc limit -1 offset ?)'
    ).run(keepApprovals);
    const after = this.db.prepare('select count(*) c from events').get().c;
    return before - after;
  }

  close() {
    this.db.close();
  }
}

// Multi-process by design: the orchestrator plus one MCP server per agent all
// write here. WAL mode handles that. The orchestrator polls for new rows
// instead of being called back — one less moving part than a socket.
// ponytail: polling at 300ms; switch to a socket only if agent counts make the
// poll show up in a profile.

if (process.argv[1]?.endsWith('bus.js')) {
  const { strict: a } = await import('node:assert');
  const b = new Bus(':memory:');

  b.post('orchestrator', 'coder', 'build the thing');
  b.post('coder', null, 'i have started');

  // coder sees the orchestrator's order but not its own broadcast
  const forCoder = b.pending('coder');
  a.equal(forCoder.length, 1);
  a.equal(forCoder[0].body, 'build the thing');

  // reviewer sees only the broadcast
  a.deepEqual(b.pending('reviewer').map((m) => m.body), ['i have started']);

  // ack advances the cursor; redelivery stops
  b.ack('coder', forCoder[0].id);
  a.equal(b.pending('coder').length, 0);

  // ...but a later broadcast still lands
  b.post('reviewer', null, 'looks wrong');
  a.deepEqual(b.pending('coder').map((m) => m.body), ['looks wrong']);

  // supersede: a run of the same undelivered notice collapses to the latest.
  b.post('orchestrator', 'coder', 'mode: research', 'notice');
  b.post('orchestrator', 'coder', 'other notice', 'notice');
  b.supersede('coder', 'mode: ');
  b.post('orchestrator', 'coder', 'mode: build', 'notice');
  a.deepEqual(b.pending('coder').filter((m) => m.kind === 'notice').map((m) => m.body),
    ['other notice', 'mode: build'],
    'only the superseded-prefix notice is dropped, and only the stale one');
  // A message already delivered (past the cursor) is untouched by a later supersede.
  const delivered = b.post('orchestrator', 'coder', 'mode: delivered', 'notice');
  b.ack('coder', delivered);
  b.supersede('coder', 'mode: ');
  a.equal(b.history({ agent: 'coder' }).some((m) => m.body === 'mode: delivered'), true,
    'supersede must never rewrite history, only trim what has not been read yet');
  b.pending('coder').forEach((m) => b.ack('coder', m.id));

  b.logEvent('coder', 'tool', { name: 'Edit' });
  a.equal(b.events({ agent: 'coder' })[0].payload.name, 'Edit');

  // Filtering by type happens in SQL, so the rows never returned are never parsed.
  b.logEvent('coder', 'turn_end', { usage: { input_tokens: 1 } });
  b.logEvent('reviewer', 'turn_end', { usage: { input_tokens: 2 } });
  a.equal(b.events({ type: 'turn_end' }).length, 2, 'type filters across agents');
  a.equal(b.events({ type: 'tool' }).length, 1);
  a.equal(b.events({ agent: 'coder', type: 'turn_end' }).length, 1, 'agent and type compose');
  a.equal(b.events({ type: 'nothing-logs-this' }).length, 0);
  a.equal(b.events({ agent: 'coder' }).length, 2, 'no type means every type, as before');

  b.logEvent('coder', 'summary', { text: 'the readable event survives' });
  b.db.prepare('insert into events (ts, agent, type, payload, conversation_id) values (?,?,?,?,?)')
    .run(Date.now(), 'coder', 'summary', '{broken', 'default');
  a.deepEqual(b.events({ type: 'summary' }).map((e) => e.payload.text), ['the readable event survives'],
    'one corrupt event payload must not break every event reader');
  b.logEvent('coder', 'text', { text: 'broken payload recovery remains searchable' });
  a.equal(b.recall('broken')[0].text, 'broken payload recovery remains searchable',
    'one corrupt indexed event must not break recall of its readable sibling');

  // Counting messages must not mean loading every body.
  a.equal(b.countMessages(), b.history({ limit: 100_000 }).length,
    'count(*) must agree with the old load-and-measure it replaces');

  // Court transcript search must use SQLite's index, not a `%LIKE%` scan over
  // a session-long log. Both durable transcript tables need their own FTS5
  // mirror because recall merges messages with agent events.
  a.match(b.db.prepare("select sql from sqlite_master where name = 'messages_fts'").get()?.sql ?? '', /fts5/i,
    'messages must have an FTS5 index');
  a.match(b.db.prepare("select sql from sqlite_master where name = 'events_fts'").get()?.sql ?? '', /fts5/i,
    'events must have an FTS5 index');

  // Opening an old court must build indexes for the transcript it already
  // retained; otherwise FTS only works from the first post-upgrade message.
  const legacyDir = mkdtempSync(join(tmpdir(), 'kingdom-fts-legacy-'));
  const legacyPath = join(legacyDir, 'kingdom.db');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`create table messages (id integer primary key autoincrement, ts integer not null, sender text not null, recipient text, kind text not null, body text not null);
    create table events (id integer primary key autoincrement, ts integer not null, agent text not null, type text not null, payload text not null);
    create table state (k text primary key, v text not null);`);
  legacy.prepare('insert into messages (ts,sender,recipient,kind,body) values (?,?,?,?,?)')
    .run(Date.now(), 'coder', 'reviewer', 'message', 'preupgrade transcript message');
  legacy.prepare('insert into events (ts,agent,type,payload) values (?,?,?,?)')
    .run(Date.now(), 'coder', 'text', JSON.stringify({ text: 'preupgrade transcript event' }));
  legacy.close();
  const migrated = new Bus(legacyPath);
  const migratedHits = migrated.recall('preupgrade transcript');
  a.equal(migratedHits.length, 2,
    'the first FTS open must rebuild both tables from retained legacy rows');
  migrated.close();
  rmSync(legacyDir, { recursive: true, force: true });

  // recall: finds a hit in event text, in a tool call, and in a message body —
  // and ranks the most recent hit first regardless of which table it came from.
  b.logEvent('coder', 'text', { text: 'the parser handles nested quotes now' });
  b.logEvent('coder', 'tool', { name: 'Grep', input: { pattern: 'quotes' } });
  b.post('reviewer', 'coder', 'nested quotes broke the old parser', 'message');
  const hits = b.recall('quotes');
  a.equal(hits.length, 3, 'all three mentions across events and messages are found');
  a.equal(hits[0].text.includes('quotes') || hits[0].text.includes('Grep'), true);
  a.equal(b.recall('quotes', { limit: 1 }).length, 1, 'limit is honored after merging sources');
  a.equal(b.recall('nothing-anyone-said').length, 0);

  // workflow runs are recorded as events too, and recall finds them by name
  b.logEvent('workflow:deploy', 'workflow_run', { name: 'nightly deploy', ok: true, steps: 4 });
  a.equal(b.recall('nightly deploy')[0].text, 'workflow "nightly deploy" succeeded');

  // --- durable improvement runs ---------------------------------------
  {
    const runs = new Bus(':memory:');
    const run = runs.createRun({
      id: 'run-test', objective: 'prove the run contract', sourceSnapshot: { revision: 'abc' },
      acceptanceCriteria: ['tests'], allowedModels: ['codex/gpt-5'],
    });
    a.equal(run.state, 'planning');
    const task = runs.addTask({ title: 'run task', by: 'orchestrator', runId: run.id });
    a.equal(runs.task(task).runId, run.id, 'tasks carry an optional run association');
    runs.post('orchestrator', null, JSON.stringify({ kind: 'merge', peasant: 'coder' }), 'approval');
    a.equal(runs.approvals()[0].runId, run.id, 'new approvals inherit the active run');
    a.equal(runs.approveRun(run.id).state, 'running');
    a.equal(runs.pauseRun(run.id).state, 'paused');
    a.equal(runs.resumeRun(run.id).state, 'running');
    a.equal(runs.transitionRun(run.id, 'verifying').state, 'verifying');
    a.equal(runs.transitionRun(run.id, 'ready_for_review').state, 'ready_for_review');
    a.equal(runs.approveRun(run.id).finalApproval, true);
    a.equal(runs.applyRun(run.id).state, 'completed');
    a.equal(runs.currentRun(), null, 'completed runs are no longer current');

    // The spend ledger: totals per run, a cumulative series thinned to a cap
    // that still ends on the total.
    for (let i = 1; i <= 10; i++) runs.recordRunSpend(run.id, i % 2 ? 'coder' : 'reviewer', 0.5, i);
    runs.recordRunSpend('run-other', 'coder', 3, 11);
    const spend = runs.runSpend(run.id, { maxPoints: 4 });
    a.equal(spend.usd, 5);
    a.equal(spend.turns, 10);
    a.deepEqual(spend.members.map((m) => [m.name, m.usd, m.turns]), [['coder', 2.5, 5], ['reviewer', 2.5, 5]]);
    a.ok(spend.series.length <= 5, `series thinned toward the cap, got ${spend.series.length}`);
    a.deepEqual(spend.series.at(-1), { ts: 10, usd: 5 }, 'the thinned series still ends on the total');
    a.equal(runs.runSpentUsd(run.id), 5);
    a.equal(runs.runSpentUsd('run-none'), 0, 'a run with no ledger rows has spent nothing');
    a.deepEqual(runs.runSpendTotals(), { [run.id]: { usd: 5, turns: 10 }, 'run-other': { usd: 3, turns: 1 } });
    runs.close();
  }

  // --- a run's blocker survives a restart, and leaving blocked clears it --
  {
    const blockDir = mkdtempSync(join(tmpdir(), 'kingdom-run-blocker-'));
    const blockPath = join(blockDir, 'kingdom.db');
    const first = new Bus(blockPath);
    const run = first.createRun({ id: 'run-blocked', objective: 'prove a blocker is durable' });
    first.approveRun(run.id);
    const blocker = { operation: 'verification of coder', next: 'fix the failing test', at: 1 };
    a.deepEqual(first.updateRun(run.id, { state: 'blocked', blocker }).blocker, blocker);
    first.close();

    const reopened = new Bus(blockPath);
    a.deepEqual(reopened.run(run.id).blocker, blocker, 'a reload must still say why the run is blocked');
    a.deepEqual(reopened.currentRun().blockers, [blocker], 'the UI reads blockers as a list');
    const resumed = reopened.resumeRun(run.id);
    a.equal(resumed.blocker, null, 'recovering a run clears its blocker');
    a.deepEqual(resumed.blockers, []);
    reopened.close();

    // A court whose runs table predates the column gains it on open, and its
    // existing runs read back with no blocker rather than failing.
    const legacy = new DatabaseSync(blockPath);
    legacy.exec('alter table runs drop column blocker');
    legacy.prepare("delete from state where k = 'schema:runs:blocker:v1'").run();
    legacy.close();
    const upgraded = new Bus(blockPath);
    a.equal(upgraded.run(run.id).blocker, null, 'a pre-blocker run reads back with no blocker');
    a.deepEqual(upgraded.updateRun(run.id, { state: 'blocked', blocker }).blocker, blocker,
      'the migration adds a writable blocker column');
    upgraded.close();
    rmSync(blockDir, { recursive: true, force: true });
  }

  // Pruning deletes old source rows. The mirrors must delete with them or a
  // later FTS hit points at a transcript row that no longer exists.
  const prunedSearch = new Bus(':memory:');
  prunedSearch.post('coder', 'reviewer', 'remove this searchable transcript', 'message');
  prunedSearch.logEvent('coder', 'text', { text: 'remove this searchable event' });
  prunedSearch.prune({ keepMessages: 0, keepEvents: 0 });
  a.equal(prunedSearch.recall('searchable').length, 0, 'pruned transcript rows must leave both FTS indexes');
  prunedSearch.close();

  b.set('session:coder', 'abc');
  a.equal(b.get('session:coder'), 'abc');
  b.set('session:coder', 'def');
  a.equal(b.get('session:coder'), 'def');

  // Per-message one-shot flags must not outlive their message. `state` was the
  // one table with no bound at all: several rows per message, forever, while
  // the logs they refer to were being trimmed out from under them.
  {
    const p = new Bus(':memory:');
    const keep = [];
    for (let i = 0; i < 30; i++) keep.push(p.post('orchestrator', 'coder', `m${i}`));
    for (const id of keep) { p.set(`done:${id}`, '1'); p.set(`resolved:${id}`, 'approved'); }
    p.set('session:coder', 'not-a-message-key');
    p.prune({ keepMessages: 10, keepEvents: 10 });
    a.equal(p.get(`done:${keep[0]}`), undefined, 'a flag for a pruned message must go with it');
    a.equal(p.get(`resolved:${keep[0]}`), undefined, 'both prefixes, not just the first');
    a.equal(p.get(`done:${keep.at(-1)}`), '1', 'but a live message keeps its flag');
    a.equal(p.get('session:coder'), 'not-a-message-key',
      'and a key that is not per-message must be untouched — sessions live across prunes');

    // An approval outlives its message on purpose, so its decision must too:
    // with the resolved flag gone, a restart re-offered it as pending.
    const approval = p.post('orchestrator', null, JSON.stringify({ kind: 'push' }), 'approval');
    p.set(`resolved:${approval}`, 'approved');
    for (let i = 0; i < 20; i++) p.post('orchestrator', 'coder', `later ${i}`);
    p.prune({ keepMessages: 10, keepEvents: 10 });
    a.equal(p.approvals().some((m) => m.id === approval), true, 'sanity: the approval is retained');
    a.equal(p.get(`resolved:${approval}`), 'approved', 'a retained approval keeps its decision');
    p.close();
  }

  // --- the task list ---------------------------------------------------
  const t1 = b.addTask({ title: 'write the parser', by: 'orchestrator' });
  const t2 = b.addTask({ title: 'test the parser', needs: [t1], by: 'orchestrator' });
  const t3 = b.addTask({ title: 'risky migration', needsPlan: true, by: 'orchestrator' });

  a.deepEqual(b.availableTasks().map((t) => t.id), [t1, t3],
    'a task waiting on an unfinished one is not available to claim');

  const first = b.claimTask('coder');
  a.equal(first.task.id, t1, 'the next available task is the oldest unblocked one');
  a.equal(first.task.state, 'active');

  a.equal(b.claimTask('refactoring-engineer', t1).ok, false, 'two members must not hold one task');
  a.match(b.claimTask('refactoring-engineer', t1).why, /already coder's/);

  a.equal(b.claimTask('refactoring-engineer', t2).ok, false, 'and a blocked task cannot be claimed at all');
  a.match(b.claimTask('refactoring-engineer', t2).why, new RegExp(`waits on #${t1}`),
    'the refusal must name what it is waiting for, or the member cannot act on it');

  a.equal(b.claimTask('refactoring-engineer', t3).task.state, 'planning',
    'a task that needs a plan is claimed into planning, not straight into work');

  b.updateTask(t1, { state: 'done', doneTs: Date.now() });
  a.deepEqual(b.availableTasks().map((t) => t.id), [t2],
    'finishing a dependency unblocks its dependents with nobody updating them by hand');
  a.deepEqual(b.tasks({ owner: 'coder' }).map((t) => t.id), [t1]);
  a.deepEqual(b.tasks().find((t) => t.id === t2).blockedBy, [],
    'and blockedBy is recomputed, never a stale stored flag');

  a.equal(b.claimTask('coder', 9999).ok, false, 'a task that does not exist is a refusal, not a throw');

  // --- conversations ----------------------------------------------------
  {
    const c = new Bus(':memory:');
    const convA = c.createConversation('orchestrator', { id: 'default', title: 'General' });
    const convB = c.createConversation('orchestrator', { title: 'Side quest' });
    a.equal(convA.id, 'default');
    a.notEqual(convB.id, convA.id);

    c.post('sovereign', 'orchestrator', 'hello in A', 'message', convA.id);
    c.post('sovereign', 'orchestrator', 'hello in B', 'message', convB.id);
    a.deepEqual(c.history({ conversation: convA.id }).map((m) => m.body), ['hello in A'],
      'history() must isolate one conversation from another');
    a.deepEqual(c.history({ conversation: convB.id }).map((m) => m.body), ['hello in B']);

    c.logEvent('orchestrator', 'text', { text: 'in A' }, convA.id);
    c.logEvent('orchestrator', 'text', { text: 'in B' }, convB.id);
    a.equal(c.events({ conversation: convA.id }).length, 1, 'events() must isolate too');

    // pending(): a real sovereign chat turn (kind 'assignment', what
    // kingdom.js#command actually posts) is scoped to the active conversation,
    // but a court-wide notice reaches the member regardless of which
    // conversation they were last in.
    c.post('orchestrator', 'coder', 'mode: research', 'notice', convA.id);
    c.post('sovereign', 'coder', 'only for B', 'assignment', convB.id);
    const forCoderInA = c.pending('coder', 200, convA.id);
    a.deepEqual(forCoderInA.map((m) => m.body), ['mode: research'],
      'an assignment() posted to a different conversation must not leak into this one');
    const forCoderInB = c.pending('coder', 200, convB.id);
    a.deepEqual(forCoderInB.map((m) => m.body).sort(), ['mode: research', 'only for B'].sort(),
      'the notice reaches every conversation; the chat assignment reaches only its own');

    // idempotent creation: re-creating 'default' must not throw or duplicate
    const again = c.createConversation('orchestrator', { id: 'default', title: 'ignored' });
    a.equal(again.title, 'General', 'creation is idempotent — the first title wins');
    a.equal(c.conversations('orchestrator').length, 2);

    c.renameConversation(convB.id, 'Renamed');
    a.equal(c.conversation(convB.id).title, 'Renamed');
    c.archiveConversation(convB.id);
    a.deepEqual(c.conversations('orchestrator').map((x) => x.id), [convA.id],
      'an archived conversation drops out of the active list without deleting its transcript');
    a.equal(c.history({ conversation: convB.id }).length, 2,
      'archiving must not touch the transcript itself');

    // branching: a fork shares its parent/fork-point with its siblings
    const fork1 = c.forkConversation(convA.id, 1, 'orchestrator', 'branch 1');
    const fork2 = c.forkConversation(convA.id, 1, 'orchestrator', 'branch 2');
    const sibs = c.siblingsOf(fork1.id);
    a.deepEqual(sibs.map((s) => s.id).sort(), [fork1.id, fork2.id].sort(),
      'siblingsOf must return every conversation forked from the same point');
    a.deepEqual(c.siblingsOf(convA.id).map((s) => s.id), [convA.id],
      'a root conversation with no parent is its own only sibling');
    c.close();
  }

  // legacy schema (pre-conversations) must migrate: old rows become 'default'
  {
    const legacyDir = mkdtempSync(join(tmpdir(), 'kingdom-conv-legacy-'));
    const legacyPath = join(legacyDir, 'kingdom.db');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`create table messages (id integer primary key autoincrement, ts integer not null, sender text not null, recipient text, kind text not null, body text not null);
      create table events (id integer primary key autoincrement, ts integer not null, agent text not null, type text not null, payload text not null);
      create table state (k text primary key, v text not null);
      create table tasks (id integer primary key autoincrement, ts integer not null, title text not null, detail text not null default '', owner text, state text not null default 'pending', needs text not null default '[]', needs_plan integer not null default 0, plan text, by text not null, done_ts integer);`);
    legacy.prepare('insert into messages (ts,sender,recipient,kind,body) values (?,?,?,?,?)')
      .run(Date.now(), 'coder', 'reviewer', 'message', 'a pre-conversations message');
    legacy.prepare('insert into tasks (ts,title,by) values (?,?,?)').run(Date.now(), 'legacy task', 'orchestrator');
    legacy.close();
    const migrated = new Bus(legacyPath);
    const rows = migrated.history({ conversation: 'default' });
    a.equal(rows.length, 1, 'a pre-existing row must be readable as the default conversation');
    a.equal(rows[0].body, 'a pre-conversations message');
    a.equal(migrated.task(1).runId, null, 'pre-run tasks remain readable without an association');
    a.equal(migrated.currentRun(), null, 'legacy courts open with no synthetic run');
    migrated.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }

  console.log('bus.js self-check OK — messages, events, state, a task list two members cannot both claim, and conversations');
}
