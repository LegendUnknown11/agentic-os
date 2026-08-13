#!/usr/bin/env node
// Where the court's context actually goes.
//
//   node src/ctx.js <repo>
//
// Every message delivered to a member replays that member's whole context, so
// the cost of a session is driven by TURN COUNT and CONTEXT SIZE, not by how
// much anyone says. This prints the numbers that decide which of those to
// attack — measured, so nobody has to guess at it (this project has twice
// tuned the wrong knob from an estimate).
//
// Read-only. Safe to run while the court is working.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { dbPath } from './worktree.js';
import { inputTokens, cachedTokens } from './usage.js';

const M = (n) => (n / 1e6).toFixed(2) + 'M';
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');

export function audit(db, since = 0) {
  const ev = db.prepare('select id,agent,type,payload from events where id > ? order by id').all(since);
  const msgs = db.prepare('select recipient,kind,length(body) len from messages').all();

  const per = {};
  const seq = {};
  let inTok = 0, cached = 0, outTok = 0, turns = 0;

  for (const e of ev) {
    if (e.type !== 'turn_end') continue;
    const p = JSON.parse(e.payload);
    const u = p.usage ?? {};
    // Both from usage.js, so this and kingdom.js cannot drift apart again.
    // They already had: counting Anthropic's alongside-cache against an
    // input_tokens-only denominator reported "replay 107.6% of all input" and
    // "genuinely new: -37.94M".
    const i = inputTokens(u);
    const c = cachedTokens(u);
    const o = u.output_tokens ?? 0;
    inTok += i; cached += c; outTok += o; turns++;
    (per[e.agent] ??= { turns: 0, in: 0, cached: 0, out: 0 });
    Object.assign(per[e.agent], {
      turns: per[e.agent].turns + 1,
      in: per[e.agent].in + i,
      cached: per[e.agent].cached + c,
      out: per[e.agent].out + o,
    });
    (seq[e.agent] ??= []).push(p.ctx ?? 0);
  }

  const mail = {};
  for (const m of msgs) {
    if (!m.recipient) continue;
    (mail[m.recipient] ??= { n: 0, notices: 0 });
    mail[m.recipient].n++;
    if (m.kind === 'notice') mail[m.recipient].notices++;
  }

  // A context that drops by more than half between turns is a recycle: the
  // session was thrown away and a successor started from a handover note.
  let handovers = 0;
  for (const s of Object.values(seq)) {
    for (let i = 1; i < s.length; i++) if (s[i] < s[i - 1] / 2) handovers++;
  }

  return { per, seq, mail, inTok, cached, outTok, turns, handovers };
}

export function report(a) {
  const lines = [];
  const say = (s = '') => lines.push(s);

  say(`${a.turns} turns · ${M(a.inTok)} in · ${M(a.outTok)} out`);
  say();
  say(`replayed context : ${M(a.cached).padStart(8)}  ${pct(a.cached, a.inTok)} of all input`);
  say(`genuinely new    : ${M(a.inTok - a.cached).padStart(8)}  ${pct(a.inTok - a.cached, a.inTok)}`);
  say(`output produced  : ${M(a.outTok).padStart(8)}  ${pct(a.outTok, a.inTok + a.outTok)} of all traffic`);
  say();
  say('member        turns     input   replay    output   in/turn   msgs  fyi');
  const rows = Object.entries(a.per).sort((x, y) => y[1].in - x[1].in);
  for (const [n, d] of rows) {
    const m = a.mail[n] ?? { n: 0, notices: 0 };
    say([
      n.padEnd(13), String(d.turns).padStart(5), M(d.in).padStart(10),
      pct(d.cached, d.in).padStart(8), M(d.out).padStart(9),
      M(d.in / d.turns).padStart(9), String(m.n).padStart(6), String(m.notices).padStart(4),
    ].join(''));
  }
  say();
  say('context per turn (a drop by half is a recycle — a turn spent on a handover)');
  for (const [n, s] of Object.entries(a.seq)) {
    say(`  ${n.padEnd(12)} ${s.map((x) => Math.round(x / 1000) + 'k').join(' → ')}`);
  }
  say();
  say(`handovers: ${a.handovers} of ${a.turns} turns (${pct(a.handovers, a.turns)})`);

  // The one conclusion worth drawing automatically. Replay is what a long
  // session costs; if it dominates, no amount of shorter messages will help.
  if (a.inTok && a.cached / a.inTok > 0.8) {
    say();
    say(`Replay is ${pct(a.cached, a.inTok)} of input: this session is paying to re-read`);
    say('itself, not to do work. The levers are FEWER TURNS (batch harder, fewer');
    say('notices) and SMALLER CONTEXTS (recycle sooner) — not shorter messages.');
  }
  return lines.join('\n');
}

// Bare `node src/ctx.js` self-checks the arithmetic; given a repo it audits it.
// Same shape as bus.js, so run-all.js can point straight at this file.
if (process.argv[1]?.endsWith('ctx.js') && !process.argv[2]) {
  const { strict: a } = await import('node:assert');
  const db = new DatabaseSync(':memory:');
  db.exec(`create table events (id integer primary key autoincrement, ts integer, agent text, type text, payload text);
           create table messages (id integer primary key autoincrement, ts integer, sender text, recipient text, kind text, body text);`);
  const turn = (agent, input, cachedTok, out, ctx) => db
    .prepare('insert into events (ts,agent,type,payload) values (?,?,?,?)')
    .run(0, agent, 'turn_end', JSON.stringify({
      ctx, usage: { input_tokens: input, cached_input_tokens: cachedTok, output_tokens: out },
    }));

  turn('king', 100, 90, 10, 20_000);
  turn('king', 100, 90, 10, 50_000);
  turn('king', 100, 90, 10, 5_000);     // a drop by more than half = a recycle
  db.prepare('insert into messages (ts,sender,recipient,kind,body) values (?,?,?,?,?)')
    .run(0, 'orchestrator', 'king', 'notice', 'fyi');

  const r = audit(db);
  a.equal(r.turns, 3);
  a.equal(r.inTok, 300);
  a.equal(r.cached, 270, 'cached tokens must be counted, not double-counted with input');
  a.equal(r.handovers, 1, 'a context that halves between turns is a recycle');
  a.equal(r.mail.king.notices, 1);
  a.equal(r.per.king.turns, 3);

  // Anthropic names the same field differently; both must land in `cached`.
  const db2 = new DatabaseSync(':memory:');
  db2.exec('create table events (id integer primary key autoincrement, ts integer, agent text, type text, payload text); create table messages (id integer primary key autoincrement, ts integer, sender text, recipient text, kind text, body text);');
  db2.prepare('insert into events (ts,agent,type,payload) values (?,?,?,?)')
    .run(0, 'coder', 'turn_end', JSON.stringify({
      ctx: 1, usage: { input_tokens: 50, cache_read_input_tokens: 40, output_tokens: 5 },
    }));
  a.equal(audit(db2).cached, 40, "claude's cache_read_input_tokens must count too");

  // ...and agy/Gemini's third name for it. Missing this scored the king — the
  // one member that runs on agy, and 61% of the court's output — as having
  // replayed NOTHING, in the audit the whole cost discipline is built on.
  const db3 = new DatabaseSync(':memory:');
  db3.exec('create table events (id integer primary key autoincrement, ts integer, agent text, type text, payload text); create table messages (id integer primary key autoincrement, ts integer, sender text, recipient text, kind text, body text);');
  db3.prepare('insert into events (ts,agent,type,payload) values (?,?,?,?)')
    .run(0, 'king', 'turn_end', JSON.stringify({
      ctx: 1, usage: { input_tokens: 17711, cache_read_tokens: 9000, output_tokens: 1, total_tokens: 17712 },
    }));
  a.equal(audit(db3).cached, 9000, "agy's cache_read_tokens must count too");
  // It is NESTED in input_tokens (agy's own total = input + output), so the
  // replay share must not exceed what actually came in.
  a.ok(audit(db3).cached <= audit(db3).inTok,
    'a nested cached count must never exceed input_tokens');

  a.match(report(r), /replayed context/);
  console.log('ctx.js self-check OK — replay accounting and recycle detection');
}

if (process.argv[1]?.endsWith('ctx.js') && process.argv[2]) {
  const repo = resolve(process.argv[2]);
  const db = new DatabaseSync(dbPath(repo), { readOnly: true });
  console.log(report(audit(db, Number(process.argv[3] ?? 0))));
  db.close();
}
