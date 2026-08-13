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
create index if not exists idx_msg_recipient on messages(recipient, id);
create index if not exists idx_evt_agent on events(agent, id);
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
    this.watchers = new Set();
  }

  // --- messages -------------------------------------------------------

  /** recipient=null broadcasts. Returns the new message id. */
  post(sender, recipient, body, kind = 'message') {
    const ts = Date.now();
    const { lastInsertRowid } = this.db
      .prepare('insert into messages (ts, sender, recipient, kind, body) values (?,?,?,?,?)')
      .run(ts, sender, recipient, kind, body);
    const msg = { id: Number(lastInsertRowid), ts, sender, recipient, kind, body };
    for (const w of this.watchers) w(msg);
    return msg.id;
  }

  /**
   * Everything addressed to `agent` (or broadcast) since its cursor, and it
   * never receives its own messages. Cursor-based so broadcast delivery is
   * exactly-once per agent without a deliveries table.
   */
  pending(agent) {
    const cursor = Number(this.get(`cursor:${agent}`) ?? 0);
    return this.db
      .prepare(
        `select * from messages
          where id > ? and sender != ? and (recipient = ? or recipient is null)
          order by id`
      )
      .all(cursor, agent, agent);
  }

  ack(agent, messageId) {
    this.set(`cursor:${agent}`, String(messageId));
  }

  /** Full log for the jester, or the king's escape hatch. */
  history({ since = 0, limit = 200, agent = null } = {}) {
    return agent
      ? this.db
          .prepare(
            `select * from messages where id > ? and (sender = ? or recipient = ?)
              order by id limit ?`
          )
          .all(since, agent, agent, limit)
      : this.db
          .prepare('select * from messages where id > ? order by id limit ?')
          .all(since, limit);
  }

  // --- raw agent events (jester firehose + UI replay) -----------------

  logEvent(agent, type, payload) {
    this.db
      .prepare('insert into events (ts, agent, type, payload) values (?,?,?,?)')
      .run(Date.now(), agent, type, JSON.stringify(payload ?? {}));
  }

  events({ since = 0, agent = null, limit = 500 } = {}) {
    const rows = agent
      ? this.db
          .prepare('select * from events where id > ? and agent = ? order by id limit ?')
          .all(since, agent, limit)
      : this.db.prepare('select * from events where id > ? order by id limit ?').all(since, limit);
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
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
   * jester's read_events would happily drag it all into context.
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
    const after = this.db.prepare('select count(*) c from events').get().c;
    return before - after;
  }

  /** Live tap for the orchestrator/UI. Returns an unsubscribe fn. */
  watch(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
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

  b.post('king', 'coder', 'build the thing');
  b.post('coder', null, 'i have started');

  // coder sees the king's order but not its own broadcast
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

  b.set('session:coder', 'abc');
  a.equal(b.get('session:coder'), 'abc');
  b.set('session:coder', 'def');
  a.equal(b.get('session:coder'), 'def');

  let seen = 0;
  const off = b.watch(() => seen++);
  b.post('king', null, 'hear ye');
  off();
  b.post('king', null, 'unheard');
  a.equal(seen, 1);

  console.log('bus.js self-check OK');
}
