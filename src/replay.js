#!/usr/bin/env node
// What would a different delivery setting have cost?
//
//   node src/replay.js <repo> [settleMs] [backstopMs]
//
// Turn count drives this team's bill, and the settle window is the main knob
// over it. The temptation is to justify a change by grouping message timestamps
// and counting clusters — that is easy, and it was 4× wrong: clustering said a
// 60s window would cut the orchestrator from 131 turns to 85, while replaying the same
// traffic through the REAL rule gave 7.6%. The gap is everything clustering
// leaves out — the user bypasses the window entirely, a busy member's
// queue already drains as one batch, and all-notice batches wait on their own
// hold. So this replays the actual decision instead of approximating it.
//
// Read-only. Safe to run while the team is working.
import './legacy-boot.js'; // first: legacy env fallback and home migration, before any module reads env
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { dbPath } from './worktree.js';
import { settleMs, BATCH_MAX_WAIT_MS, NOTICE_HOLD_MS } from './agenticos.js';

// The RULE below is a deliberate mirror (see replay() ). The NUMBERS are not:
// they are imported, because a hand-kept copy of them had already drifted —
// this read `settle: 45_000, backstop: 150_000` while the team had been
// running 90s/180s for some time, so the tool the windows are tuned with was
// sweeping against a baseline that no longer existed. Defaults are read lazily
// so AGENTICOS_SETTLE_MS still works.
export const DEFAULTS = {
  get settle() { return settleMs(); },
  get backstop() { return BATCH_MAX_WAIT_MS; },
  get noticeHold() { return NOTICE_HOLD_MS; },
  turnMs: 60_000,        // a modelling assumption, not a live constant
};

/**
 * Replay a message log through the ripeness rule in AgenticOS#deliver.
 *
 * Kept deliberately as a mirror rather than importing the real function: the
 * real one is a private method that also spawns agents and writes to the bus.
 * If the rule there changes, this must change with it — the shape is small
 * enough that the duplication costs less than the coupling would.
 */
export function replay(msgs, opts = {}) {
  const { settle, backstop, noticeHold, turnMs } = { ...DEFAULTS, ...opts };
  if (!msgs.length) return { turns: 0, delivered: 0 };

  const queues = new Map();
  const busyUntil = new Map();
  // Mirrors agenticos.js's `hadReal:` bus flag (see ripeness.js's `hadRealTurn`):
  // a lone notice may only ripen on its own once this recipient has actually
  // been delivered a real turn — otherwise a member's very first "turn" would
  // be manufactured from housekeeping traffic nobody sent it (#40).
  const hadReal = new Set();
  let turns = 0;
  let delivered = 0;
  // The saving is turns; the price is waiting. Accounting for both here stops
  // a sweep from optimising one and quietly ignoring the other.
  let waitTotal = 0;
  let waitMax = 0;

  const TICK = 300;                       // the orchestrator's real poll interval
  let t = msgs[0].ts;
  const end = msgs[msgs.length - 1].ts + backstop + noticeHold + 1000;
  let next = 0;

  while (t <= end) {
    while (next < msgs.length && msgs[next].ts <= t) {
      const m = msgs[next++];
      if (!m.recipient) continue;          // broadcasts have no single queue
      const q = queues.get(m.recipient) ?? queues.set(m.recipient, []).get(m.recipient);
      q.push(m);
    }
    for (const [name, q] of queues) {
      if (!q.length) continue;
      if ((busyUntil.get(name) ?? 0) > t) continue;      // never interrupt a turn
      const oldest = q[0].ts;
      const newest = q[q.length - 1].ts;
      const allNotices = q.every((m) => m.kind === 'notice');
      const urgent = q.some((m) => m.sender === 'user');
      const ripe = allNotices
        ? hadReal.has(name) && t - oldest > noticeHold
        : (urgent || t - newest >= settle) || t - oldest > backstop;
      if (!ripe) continue;
      if (!allNotices) hadReal.add(name);
      turns++;
      delivered += q.length;
      for (const m of q) {
        const waited = t - m.ts;
        waitTotal += waited;
        if (waited > waitMax) waitMax = waited;
      }
      busyUntil.set(name, t + turnMs);
      q.length = 0;
    }
    t += TICK;
  }
  return {
    turns,
    delivered,
    // Mean wait is the number that matters for a team working for hours; max
    // is the one that matters for the member sitting blocked on an answer.
    waitMeanMs: delivered ? Math.round(waitTotal / delivered) : 0,
    waitMaxMs: waitMax,
  };
}

/** Compare two settings over the same log, with a sensitivity sweep. */
export function compare(msgs, a, b) {
  const rows = [];
  for (const turnMs of [15_000, 30_000, 60_000, 120_000]) {
    const x = replay(msgs, { ...a, turnMs });
    const y = replay(msgs, { ...b, turnMs });
    rows.push({
      turnMs, before: x.turns, after: y.turns, saved: x.turns - y.turns,
      waitBefore: x.waitMeanMs, waitAfter: y.waitMeanMs, waitMaxAfter: y.waitMaxMs,
    });
  }
  return rows;
}

export function report(msgs, a, b) {
  const rows = compare(msgs, a, b);
  const mid = rows.find((r) => r.turnMs === 60_000) ?? rows[0];
  const out = [
    `${msgs.length} messages replayed`,
    `before  settle ${a.settle / 1000}s / backstop ${a.backstop / 1000}s`,
    `after   settle ${b.settle / 1000}s / backstop ${b.backstop / 1000}s`,
    '',
    'turn len   before    after    saved     mean wait    worst wait',
  ];
  for (const r of rows) {
    const pct = r.before ? ((r.saved / r.before) * 100).toFixed(1) : '0.0';
    out.push(`${String(r.turnMs / 1000).padStart(7)}s ${String(r.before).padStart(8)} `
      + `${String(r.after).padStart(8)} ${String(r.saved).padStart(8)} (${pct.padStart(5)}%)`
      + ` ${(r.waitBefore / 1000).toFixed(0).padStart(5)}s->${(r.waitAfter / 1000).toFixed(0)}s`
      + ` ${(r.waitMaxAfter / 1000).toFixed(0).padStart(11)}s`);
  }
  // The modelled turn length is the one number not taken from the log, so the
  // spread across it is the honest confidence interval on the change.
  const best = Math.max(...rows.map((r) => r.saved));
  const worst = Math.min(...rows.map((r) => r.saved));
  out.push('', worst > 0
    ? `Consistently positive: ${worst}–${best} turns saved across every modelled turn length.`
    : `NOT consistently positive (${worst} to ${best}) — the gain depends on turn length, `
      + `which is modelled rather than measured. Treat it as unproven.`);
  out.push(`Headline (60s turns): ${mid.saved} of ${mid.before} turns, `
    + `${mid.before ? ((mid.saved / mid.before) * 100).toFixed(1) : '0'}%.`);
  return out.join('\n');
}

if (process.argv[1]?.endsWith('replay.js') && !process.argv[2]) {
  const { strict: a } = await import('node:assert');

  // The drift guard. A sweep is only meaningful against what the team is
  // actually running, and this file used to hard-code a baseline that had gone
  // stale (45s/150s against a live 90s/180s) — silently, because nothing
  // compared them. Now they are the same numbers by construction, and this
  // fails loudly if that stops being true.
  a.equal(DEFAULTS.settle, settleMs(), 'the replay baseline must be the live settle window');
  a.equal(DEFAULTS.backstop, BATCH_MAX_WAIT_MS, 'and the live backstop');
  a.equal(DEFAULTS.noticeHold, NOTICE_HOLD_MS, 'and the live notice hold');
  a.ok(DEFAULTS.backstop > DEFAULTS.settle,
    'a backstop at or below the window silently clamps it — the same invariant '
    + 'agenticos.js asserts at delivery time');

  // A quiet log: messages far apart, so no window folds anything and both
  // settings cost one turn each.
  const spaced = [0, 600_000, 1_200_000].map((ts) => ({ ts, sender: 'coder', recipient: 'orchestrator', kind: 'message' }));
  a.equal(replay(spaced, { settle: 15_000 }).turns, 3, 'messages minutes apart cannot fold');
  a.equal(replay(spaced, { settle: 45_000 }).turns, 3, 'and a wider window cannot invent folding');

  // A burst inside the wider window but outside the narrow one: this is the
  // only shape where the change can pay, and it must.
  const burst = [0, 20_000, 40_000].map((ts) => ({ ts, sender: 'coder', recipient: 'orchestrator', kind: 'message' }));
  const narrow = replay(burst, { settle: 15_000, turnMs: 1_000 }).turns;
  const wide = replay(burst, { settle: 45_000, turnMs: 1_000 }).turns;
  a.ok(wide < narrow, `a wider window must fold a burst it covers (${wide} vs ${narrow})`);

  // The user must never wait, at any window.
  const human = [{ ts: 0, sender: 'user', recipient: 'orchestrator', kind: 'assignment' }];
  a.equal(replay(human, { settle: 600_000 }).turns, 1,
    "the user's mail must be delivered regardless of the window");

  // A notice must RIDE ALONG rather than buy its own turn. Stating it as "a
  // lone notice costs 0 turns" is untestable here — the replay runs past any
  // hold and eventually delivers, which is correct behaviour. The claim that
  // matters is that a notice followed by real traffic costs ONE turn, not two.
  const ride = [
    { ts: 0, sender: 'orchestrator', recipient: 'orchestrator', kind: 'notice' },
    { ts: 60_000, sender: 'coder', recipient: 'orchestrator', kind: 'message' },
  ];
  const together = replay(ride, { settle: 45_000, noticeHold: 180_000, turnMs: 1_000 });
  a.equal(together.turns, 1, `a notice must ride along with the next real message, got ${together.turns} turns`);
  a.equal(together.delivered, 2, 'and both must actually be delivered in it');

  // Waiting must be accounted, or a sweep optimises turns and hides the price.
  // The notice above waited for the message plus the window; the message waited
  // only the window. Both are real costs and both must be reported.
  a.ok(together.waitMaxMs >= 45_000,
    `the held notice's wait must be counted, got ${together.waitMaxMs}ms`);
  a.ok(together.waitMeanMs > 0 && together.waitMeanMs <= together.waitMaxMs,
    'mean wait must sit between zero and the max');
  const nowait = replay(human, { settle: 600_000, turnMs: 1_000 });
  a.ok(nowait.waitMaxMs < 1_000,
    `the user must not be recorded as waiting, got ${nowait.waitMaxMs}ms`);

  // issue #40 — a member with NO real turn behind it must never be given one
  // by a lone notice, however long it waits: that is a turn the user
  // never asked for, answered by a member the user never addressed.
  const alone = [{ ts: 0, sender: 'orchestrator', recipient: 'orchestrator', kind: 'notice' }];
  a.equal(replay(alone, { noticeHold: 5_000 }).turns, 0,
    'a lone notice with no real history behind it must never manufacture a turn');

  // Once a real turn HAS happened, a later lone notice still rides the
  // original rule: delayed, never dropped.
  const realThenAlone = [
    { ts: 0, sender: 'user', recipient: 'orchestrator', kind: 'assignment' },
    { ts: 10_000, sender: 'orchestrator', recipient: 'orchestrator', kind: 'notice' },
  ];
  a.equal(replay(realThenAlone, { settle: 1_000, noticeHold: 5_000, turnMs: 1_000 }).turns, 2,
    'once real history exists, a later lone notice still eventually lands on its own');

  // The backstop must release a batch even when messages keep arriving inside
  // the window forever, or a chatty pair could starve a member indefinitely.
  const chatty = Array.from({ length: 40 }, (_, i) => (
    { ts: i * 5_000, sender: 'coder', recipient: 'orchestrator', kind: 'message' }));
  a.ok(replay(chatty, { settle: 45_000, backstop: 150_000, turnMs: 1_000 }).turns >= 1,
    'the backstop must release a batch that the window would hold forever');

  a.match(report(spaced, { settle: 15_000, backstop: 45_000 }, { settle: 45_000, backstop: 150_000 }),
    /messages replayed/);
  console.log('replay.js self-check OK — folding, user bypass, notice hold, backstop');
}

if (process.argv[1]?.endsWith('replay.js') && process.argv[2]) {
  const repo = resolve(process.argv[2]);
  const db = new DatabaseSync(dbPath(repo), { readOnly: true });
  const msgs = db.prepare('select ts, sender, recipient, kind from messages order by ts, id').all();
  const settle = Number(process.argv[3] ?? DEFAULTS.settle);
  const backstop = Number(process.argv[4] ?? DEFAULTS.backstop);
  console.log(report(msgs, { settle: 15_000, backstop: 45_000 }, { settle, backstop }));
  db.close();
}
