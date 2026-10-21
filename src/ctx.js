#!/usr/bin/env node
// Where the team's context actually goes.
//
//   node src/ctx.js <repo>
//
// Every message delivered to a member replays that member's whole context, so
// the cost of a session is driven by TURN COUNT and CONTEXT SIZE, not by how
// much anyone says. This prints the numbers that decide which of those to
// attack — measured, so nobody has to guess at it (this project has twice
// tuned the wrong knob from an estimate).
//
// Read-only. Safe to run while the team is working.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { dbPath } from './worktree.js';
import { totalsOf, deltaOf, hasUsage } from './usage.js';
import { costOf, tableFrom } from './price.js';

const M = (n) => (n / 1e6).toFixed(2) + 'M';
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
const $ = (n) => (n === null ? '  —  ' : '$' + n.toFixed(3));

export function audit(db, since = 0, { config = null } = {}) {
  const ev = db.prepare('select id,agent,type,payload from events where id > ? order by id').all(since);
  const msgs = db.prepare('select recipient,kind,length(body) len from messages').all();

  const rates = tableFrom(config);
  const specs = specsOf(config);

  const per = {};
  const seq = {};
  const prev = new Map();
  let inTok = 0, cached = 0, outTok = 0, turns = 0, usd = 0, unpriced = 0;
  const split = { cached: 0, fresh: 0, out: 0 };

  for (const e of ev) {
    if (e.type !== 'turn_end') continue;
    const p = JSON.parse(e.payload);
    const u = p.usage ?? {};
    // All of this comes from usage.js, so this and agenticos.js and daemon.js
    // cannot drift apart again. They already had: counting Anthropic's
    // alongside-cache against an input_tokens-only denominator reported
    // "replay 107.6% of all input" and "genuinely new: -37.94M".
    //
    // And DELTAS, because codex reports cumulatively per thread. Summing raw
    // read this very database as 2.37M input when the truth is 1.89M.
    const d = deltaOf(prev.get(e.agent), u);
    if (hasUsage(u)) prev.set(e.agent, totalsOf(u));

    const spec = specs.get(e.agent);
    // A member's cost is what the CLI charged, when it says so (only claude
    // does), and otherwise what its rate card says. Null when unpriced — an
    // invented number here would be worse than a blank.
    const cost = p.costUsd || costOf(d, spec?.cli, spec?.model, rates);
    if (cost === null) unpriced++; else usd += cost;

    // Which KIND of token the money went on. This is the whole reason the
    // report exists: a token count cannot tell you, because the three kinds
    // differ by 12.5x, and the lever is different for each.
    // costOf does its OWN `in - cached - written` subtraction, so `in` here is
    // the raw total. Pre-subtracting `written` took it off twice and understated
    // the fresh line by exactly the cache writes — worst in the cold-prefix case
    // this report exists to detect, where `written` IS the whole context.
    split.cached += costOf({ cached: d.cached }, spec?.cli, spec?.model, rates) ?? 0;
    split.fresh += costOf({ in: d.in - d.cached, written: d.written },
      spec?.cli, spec?.model, rates) ?? 0;
    split.out += costOf({ out: d.out }, spec?.cli, spec?.model, rates) ?? 0;

    inTok += d.in; cached += d.cached; outTok += d.out; turns++;
    (per[e.agent] ??= { turns: 0, in: 0, cached: 0, out: 0, usd: 0, unpriced: 0 });
    Object.assign(per[e.agent], {
      turns: per[e.agent].turns + 1,
      in: per[e.agent].in + d.in,
      cached: per[e.agent].cached + d.cached,
      out: per[e.agent].out + d.out,
      usd: per[e.agent].usd + (cost ?? 0),
      unpriced: per[e.agent].unpriced + (cost === null ? 1 : 0),
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

  return { per, seq, mail, inTok, cached, outTok, turns, handovers, usd, unpriced, split };
}

/** name -> {cli, model}, so a turn can be priced. Empty without a config. */
function specsOf(config) {
  const m = new Map();
  if (!config) return m;
  const def = config.agentDefaults ?? {};
  for (const s of [config.orchestrator, config.briefer, ...(config.agents ?? [])]) {
    if (s?.name) m.set(s.name, { cli: s.cli ?? def.cli, model: s.model ?? def.model });
  }
  return m;
}

export function report(a) {
  const lines = [];
  const say = (s = '') => lines.push(s);

  say(`${a.turns} turns · ${M(a.inTok)} in · ${M(a.outTok)} out`
    + (a.unpriced === a.turns ? '' : ` · ${$(a.usd)}`)
    + (a.unpriced ? `  (${a.unpriced} turn(s) unpriced)` : ''));
  say();
  say(`replayed context : ${M(a.cached).padStart(8)}  ${pct(a.cached, a.inTok)} of all input`);
  say(`genuinely new    : ${M(a.inTok - a.cached).padStart(8)}  ${pct(a.inTok - a.cached, a.inTok)}`);
  say(`output produced  : ${M(a.outTok).padStart(8)}  ${pct(a.outTok, a.inTok + a.outTok)} of all traffic`);
  say();
  say('member        turns     input   replay    output   in/turn      cost   msgs  fyi');
  const rows = Object.entries(a.per).sort((x, y) => y[1].in - x[1].in);
  for (const [n, d] of rows) {
    const m = a.mail[n] ?? { n: 0, notices: 0 };
    say([
      n.padEnd(13), String(d.turns).padStart(5), M(d.in).padStart(10),
      pct(d.cached, d.in).padStart(8), M(d.out).padStart(9),
      M(d.in / d.turns).padStart(9),
      (d.unpriced === d.turns ? '—' : $(d.usd)).padStart(10),
      String(m.n).padStart(6), String(m.notices).padStart(4),
    ].join(''));
  }
  say();
  say('context per turn (a drop by half is a recycle — a turn spent on a handover)');
  for (const [n, s] of Object.entries(a.seq)) {
    say(`  ${n.padEnd(12)} ${s.map((x) => Math.round(x / 1000) + 'k').join(' → ')}`);
  }
  say();
  say(`handovers: ${a.handovers} of ${a.turns} turns (${pct(a.handovers, a.turns)})`);

  // The one conclusion worth drawing automatically — and it must be drawn from
  // the BILL, not the token count.
  //
  // This used to fire on `cached/inTok > 0.8` and say "recycle sooner". That
  // was backwards twice over. A high cached SHARE is the cache working: those
  // tokens are billed at a tenth of fresh ones, so a 95%-cached session is a
  // cheap session, not a wasteful one. And recycling is the one action that
  // destroys the cached prefix — it converts 0.1x tokens into 1.0x tokens and
  // buys a handover turn at the member's maximum context to do it.
  const s = a.split;
  const bill = s.cached + s.fresh + s.out;
  if (bill > 0) {
    const share = (x) => pct(x, bill);
    say();
    say(`the bill: ${share(s.cached)} replay · ${share(s.fresh)} new input · ${share(s.out)} output`);
    if (s.cached >= s.fresh && s.cached >= s.out) {
      say('Replay dominates the BILL, not just the token count: every turn re-reads');
      say('the whole context at the cache rate. The lever is FEWER TURNS — batch');
      say('harder, fewer notices, a smaller crew. Recycling makes this worse.');
    } else if (s.fresh >= s.out) {
      say('NEW input dominates: contexts are being rebuilt from scratch, so the');
      say('cache is not being reused. Look at recycles and at anything that');
      say('changes a system prompt mid-session — both discard the cached prefix.');
    } else {
      say('OUTPUT dominates: the team is thinking, not re-reading. The lever is');
      say('`effort` per role, and a smaller crew — not batching or recycling.');
    }
    if (a.handovers) {
      say(`${a.handovers} of ${a.turns} turns went on handovers. Each one is a full turn at`);
      say('maximum context AND a cold cache on the successor. Raise recycleAtTokens');
      say('if that share is climbing.');
    }
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

  // These are codex-shaped, so the readings are CUMULATIVE: three turns of
  // 100/90/10 each arrive as 100, 200, 300. Written flat (100,100,100) — as
  // they were before deltas — they would mean two turns that did nothing.
  turn('orchestrator', 100, 90, 10, 20_000);
  turn('orchestrator', 200, 180, 20, 50_000);
  turn('orchestrator', 300, 270, 30, 5_000);    // a drop by more than half = a recycle
  db.prepare('insert into messages (ts,sender,recipient,kind,body) values (?,?,?,?,?)')
    .run(0, 'orchestrator', 'orchestrator', 'notice', 'fyi');

  const r = audit(db);
  a.equal(r.turns, 3);
  a.equal(r.inTok, 300, 'a cumulative climb must total the last reading, not the sum of readings');
  a.equal(r.cached, 270, 'cached tokens must be counted, not double-counted with input');
  a.equal(r.outTok, 30);
  a.equal(r.handovers, 1, 'a context that halves between turns is a recycle');
  a.equal(r.mail.orchestrator.notices, 1);
  a.equal(r.per.orchestrator.turns, 3);
  // The bug this replaced: summing the readings raw reports 600, double the truth.
  a.equal(100 + 200 + 300, 600, 'sanity: the raw sum this avoids');

  // Priced, with a config that names the orchestrator's model.
  const cfg = { orchestrator: { name: 'orchestrator', cli: 'codex', model: 'gpt-5.6-luna' }, agents: [] };
  const priced = audit(db, 0, { config: cfg });
  a.equal(priced.unpriced, 0, 'a member whose model is in the table must be priced');
  a.ok(priced.usd > 0, 'a priced session costs something');
  // The headline the old report got backwards: 90% of the TOKENS were replay,
  // but replay is not even the largest share of the BILL (270 cached at 0.02
  // = $5.4e-6; 30 fresh at 0.20 = $6.0e-6). A share of tokens is not a share
  // of money, and only one of them is worth tuning against.
  a.ok(priced.cached / priced.inTok === 0.9, 'nine tenths of the tokens are replay');
  a.ok(priced.split.cached < priced.split.fresh,
    'yet replay is NOT the biggest line on the bill: '
    + `${priced.split.cached} cached vs ${priced.split.fresh} fresh`);
  // Without a config nothing can be priced, and that must be said, not guessed.
  a.equal(r.unpriced, 3, 'no config means no prices, reported as unpriced');
  a.equal(r.usd, 0);

  // Anthropic names the same field differently; both must land in `cached`.
  const db2 = new DatabaseSync(':memory:');
  db2.exec('create table events (id integer primary key autoincrement, ts integer, agent text, type text, payload text); create table messages (id integer primary key autoincrement, ts integer, sender text, recipient text, kind text, body text);');
  db2.prepare('insert into events (ts,agent,type,payload) values (?,?,?,?)')
    .run(0, 'coder', 'turn_end', JSON.stringify({
      ctx: 1, usage: { input_tokens: 50, cache_read_input_tokens: 40, output_tokens: 5 },
    }));
  a.equal(audit(db2).cached, 40, "claude's cache_read_input_tokens must count too");

  // ...and agy/Gemini's third name for it. Missing this scored the orchestrator — the
  // one member that runs on agy, and 61% of the team's output — as having
  // replayed NOTHING, in the audit the whole cost discipline is built on.
  const db3 = new DatabaseSync(':memory:');
  db3.exec('create table events (id integer primary key autoincrement, ts integer, agent text, type text, payload text); create table messages (id integer primary key autoincrement, ts integer, sender text, recipient text, kind text, body text);');
  db3.prepare('insert into events (ts,agent,type,payload) values (?,?,?,?)')
    .run(0, 'orchestrator', 'turn_end', JSON.stringify({
      ctx: 1, usage: { input_tokens: 17711, cache_read_tokens: 9000, output_tokens: 1, total_tokens: 17712 },
    }));
  a.equal(audit(db3).cached, 9000, "agy's cache_read_tokens must count too");
  // It is NESTED in input_tokens (agy's own total = input + output), so the
  // replay share must not exceed what actually came in.
  a.ok(audit(db3).cached <= audit(db3).inTok,
    'a nested cached count must never exceed input_tokens');

  // The three split lines are a PARTITION of the bill, so they must add up to
  // it exactly. They did not: `fresh` pre-subtracted `written` and costOf
  // subtracted it again, understating the fresh line by the whole cache write —
  // maximally in the cold-prefix case (written IS the context) that is the one
  // case this report exists to detect. Only claude reports cache writes, so
  // only a claude turn can catch it.
  const db4 = new DatabaseSync(':memory:');
  db4.exec('create table events (id integer primary key autoincrement, ts integer, agent text, type text, payload text); create table messages (id integer primary key autoincrement, ts integer, sender text, recipient text, kind text, body text);');
  db4.prepare('insert into events (ts,agent,type,payload) values (?,?,?,?)')
    .run(0, 'orchestrator', 'turn_end', JSON.stringify({
      ctx: 1,
      usage: {
        input_tokens: 1000, cache_read_input_tokens: 600,
        cache_creation_input_tokens: 300, output_tokens: 50,
      },
    }));
  const cw = audit(db4, 0, {
    config: { orchestrator: { name: 'orchestrator', cli: 'claude', model: 'haiku' }, agents: [] },
  });
  const sum = cw.split.cached + cw.split.fresh + cw.split.out;
  a.ok(Math.abs(sum - cw.usd) < 1e-12,   // float, so "exactly" means to the cent's cent
    `the three split lines must partition the bill exactly: ${sum} vs ${cw.usd}`);
  a.ok(cw.split.fresh > 0, 'a turn that wrote a cache prefix has a fresh line');

  a.match(report(r), /replayed context/);
  // The conclusion must be drawn from the bill and must no longer tell the
  // user to recycle because the cache is working.
  const said = report(priced);
  a.match(said, /the bill:/, 'the report prices the three kinds of token');
  a.doesNotMatch(said, /recycle sooner/,
    'a high cached share must never be answered with "recycle sooner" — that is '
    + 'the one action that discards the cached prefix');
  console.log('ctx.js self-check OK — deltas, priced replay, and recycle detection');
}

if (process.argv[1]?.endsWith('ctx.js') && process.argv[2]) {
  const repo = resolve(process.argv[2]);
  const db = new DatabaseSync(dbPath(repo), { readOnly: true });
  // The config is what says which model each member runs, and therefore what a
  // turn cost. Without it the audit still counts tokens, it just cannot price
  // them — so a missing or unreadable config degrades the report, never fails it.
  let config = null;
  try {
    const { defaultConfigPath } = await import('./agenticos.js');
    const { readFileSync } = await import('node:fs');
    config = JSON.parse(readFileSync(defaultConfigPath(repo), 'utf8'));
  } catch { /* unpriced, and the report says so */ }
  console.log(report(audit(db, Number(process.argv[3] ?? 0), { config })));
  db.close();
}
