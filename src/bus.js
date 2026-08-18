// The kingdom's message bus + event log. node:sqlite, no native deps.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
create table if not exists messages (
  id        integer primary key autoincrement,
  ts        integer not null,
  sender    text    not null,
  recipient text,                       -- null = broadcast to all awake agents
  kind      text    not null,           -- message | escalation | done | brief | system
  body      text    not null
);
create table if not exists events (
  id      integer primary key autoincrement,
  ts      integer not null,
  agent   text    not null,
  type    text    not null,             -- text | tool | turn_end | ready | error
  payload text    not null              -- json
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
  done_ts    integer
);
create index if not exists idx_msg_recipient on messages(recipient, id);
create index if not exists idx_evt_agent on events(agent, id);
create index if not exists idx_task_state on tasks(state, owner);
`;

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
  }

  // --- messages -------------------------------------------------------

  /** recipient=null broadcasts. Returns the new message id. */
  post(sender, recipient, body, kind = 'message') {
    const ts = Date.now();
    const { lastInsertRowid } = this.db
      .prepare('insert into messages (ts, sender, recipient, kind, body) values (?,?,?,?,?)')
      .run(ts, sender, recipient, kind, body);
    return Number(lastInsertRowid);
  }

  /**
   * Everything addressed to `agent` (or broadcast) since its cursor, and it
   * never receives its own messages. Cursor-based so broadcast delivery is
   * exactly-once per agent without a deliveries table.
   */
  /**
   * `limit` because the caller concatenates the whole result into ONE turn.
   *
   * A member asleep across a long stretch of broadcasts woke to every message
   * at once, in a single prompt, with no cap — the orchestrator's own posts
   * bypass the 4000-char limit mcp.js puts on member messages, so nothing else
   * bounded it. The oldest are taken first, so the remainder simply rides the
   * next tick: 300ms later, and in order.
   */
  pending(agent, limit = 200) {
    const cursor = Number(this.get(`cursor:${agent}`) ?? 0);
    return this.db
      .prepare(
        `select * from messages
          where id > ? and sender != ? and (recipient = ? or recipient is null)
          order by id limit ?`
      )
      .all(cursor, agent, agent, limit);
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
  history({ since = 0, limit = 200, agent = null, tail = false } = {}) {
    const args = [since];
    let where = 'id > ?';
    if (agent) { where += ' and (sender = ? or recipient = ?)'; args.push(agent, agent); }
    args.push(limit);
    return this.db.prepare(
      tail
        ? `select * from (select * from messages where ${where} order by id desc limit ?)
             order by id`
        : `select * from messages where ${where} order by id limit ?`
    ).all(...args);
  }

  // --- raw agent events (briefer firehose + UI replay) -----------------

  logEvent(agent, type, payload) {
    this.db
      .prepare('insert into events (ts, agent, type, payload) values (?,?,?,?)')
      .run(Date.now(), agent, type, JSON.stringify(payload ?? {}));
  }

  // `type` filters in SQL rather than after the fact, because every row this
  // returns is JSON.parsed: /api/metrics wants only the turn_ends, and pulling
  // all 20,000 retained events to keep a handful of them parsed the whole log
  // every 5 seconds.
  // `tail` as in history(): the newest `limit` rows rather than the oldest.
  events({ since = 0, agent = null, type = null, limit = 500, tail = false } = {}) {
    const where = ['id > ?'];
    const args = [since];
    if (agent) { where.push('agent = ?'); args.push(agent); }
    if (type) { where.push('type = ?'); args.push(type); }
    args.push(limit);
    const w = where.join(' and ');
    const rows = this.db.prepare(
      tail
        ? `select * from (select * from events where ${w} order by id desc limit ?) order by id`
        : `select * from events where ${w} order by id limit ?`
    ).all(...args);
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  /** How many messages there are. Counting them by loading every body is not that. */
  countMessages() {
    return this.db.prepare('select count(*) as n from messages').get().n;
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
  addTask({ title, detail = '', needs = [], needsPlan = false, by }) {
    const { lastInsertRowid } = this.db.prepare(
      'insert into tasks (ts, title, detail, needs, needs_plan, by) values (?,?,?,?,?,?)'
    ).run(Date.now(), title, detail, JSON.stringify(needs.map(Number)), needsPlan ? 1 : 0, by);
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
  tasks({ state = null, owner = null, id = null } = {}) {
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
    const cols = { state: 'state', plan: 'plan', owner: 'owner', doneTs: 'done_ts' };
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

  /**
   * Keep the newest `keep` rows of each log. A day-long session accumulates
   * tens of thousands of tool events; nothing reads that far back, and the
   * briefer's read_events would happily drag it all into context.
   * Messages are kept longer than events — they are the kingdom's record.
   */
  prune({ keepMessages = 5000, keepEvents = 20000 } = {}) {
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
    // the logs above stayed bounded. Drop the ones whose message is gone.
    const oldest = this.db.prepare('select min(id) m from messages').get().m;
    if (oldest != null) {
      this.db.prepare(
        "delete from state where instr(k, ':') > 0"
        + " and substr(k, 1, instr(k, ':') - 1) in ('done','doneretry','retried','resolved')"
        + ' and cast(substr(k, instr(k, \':\') + 1) as integer) < ?'
      ).run(oldest);
    }
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

  // Counting messages must not mean loading every body.
  a.equal(b.countMessages(), b.history({ limit: 100_000 }).length,
    'count(*) must agree with the old load-and-measure it replaces');

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

  console.log('bus.js self-check OK — messages, events, state, and a task list two members cannot both claim');
}
