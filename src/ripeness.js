// When a batch of pending messages is ready to become a turn.
//
// This decision was four lines inside #deliver, and four separate bugs lived in
// it — a notice that spawned a sleeping member to read "TAKE NO ACTION", a
// batch delivered into a member mid-handover and thrown away with it, a
// consistency check that fired per member per tick, and no way to test any of
// it without spawning real CLIs. It is pure: no `this`, no clock of its own, no
// bus. Everything it needs is an argument, so t-ripeness.js can drive the whole
// state space in milliseconds.
//
// The constants stay in kingdom.js — they are the sovereign's tuning, and
// passing them in is what lets a test sweep them.

/**
 * @param deliverable  the batch, oldest first, already deduped and filtered
 * @param now          ms
 * @param awake        is the member currently spawned?
 * @param busy         is it mid-turn?
 * @param recycling    is its session being replaced right now?
 * @param settleMs     quiet window that coalesces agent-to-agent chatter
 * @param backstopMs   never hold a batch longer than this
 * @param noticeHoldMs how long pure FYI waits to ride along with real traffic,
 *                     once it is even eligible to fire on its own (see hadRealTurn)
 * @param hadRealTurn  has this member EVER actually been handed a non-notice
 *                     message — this session or a previous one? A member with no
 *                     real turn behind it has no conversation to "keep current",
 *                     so a lone notice must never be the first thing it ever says.
 * @returns {{ripe: boolean, why: string}}
 */
export function ripeness(deliverable, {
  now, awake, busy, recycling = false, settleMs, backstopMs, noticeHoldMs, hadRealTurn = false,
}) {
  if (!deliverable.length) return { ripe: false, why: 'nothing to deliver' };

  // A member whose session is being torn down and replaced still sits in the
  // roster for as long as the handover takes — up to 120s. Delivering into it
  // acks the batch and then stop() discards it, which is how a 53k-char brief
  // vanished with the court reporting nothing at all. It is not gone, it is
  // busy in a way `busy` does not describe.
  if (recycling) return { ripe: false, why: 'member is being recycled' };

  const oldest = deliverable[0].ts;
  const newest = deliverable[deliverable.length - 1].ts;

  // Pure FYI must never buy a turn of its own, and waking a SLEEPING member is
  // the most expensive way to buy one: a worktree validation, a CLI process and
  // a full context replay, so it can read "AWARENESS ONLY — TAKE NO ACTION".
  // The age test alone let exactly that happen — one broadcast milestone woke
  // every idle peasant in the court. A notice for a sleeping member waits for
  // whatever wakes it next; there is always something, and if there is not,
  // then nobody needed to know.
  if (deliverable.every((m) => m.kind === 'notice')) {
    // Even for an AWAKE, idle member, a lone notice must not fire on its own
    // unless this member has a real conversation behind it already. Without
    // that guard, a member spawned at daemon boot — with nothing in its inbox
    // but housekeeping ("still in service from a previous session", "nobody
    // is working on this task any more") — would sit for noticeHoldMs and then
    // take a full unprompted turn: a message the sovereign never sent, answered
    // by a member the sovereign never addressed. Reported as "the orchestrator
    // is talking to itself. I didn't give it a command yet." (issue #40).
    return hadRealTurn && awake && !busy && now - oldest > noticeHoldMs
      ? { ripe: true, why: 'notices held long enough for an awake member with real history' }
      : {
        ripe: false,
        why: !hadRealTurn ? 'no real turn has happened yet — a notice must never be the first word'
          : !awake ? 'notice will not wake a sleeper'
            : busy ? 'notices do not interrupt a turn in flight'
              : 'notices still settling',
      };
  }

  // The sovereign is sitting there watching. The settle window exists to
  // coalesce agents talking to each other, and a human typing is not that.
  const urgent = deliverable.some((m) => m.sender === 'sovereign');
  if (!busy && (urgent || now - newest >= settleMs)) {
    return { ripe: true, why: urgent ? 'the sovereign is waiting' : 'quiet and idle' };
  }
  if (now - oldest > backstopMs) return { ripe: true, why: 'backstop: held long enough' };
  return { ripe: false, why: busy ? 'member is mid-turn' : 'still settling' };
}

/**
 * The backstop must never be tighter than the window it backs up, or the window
 * is silently capped and tuning it does nothing. This used to be checked inside
 * the per-member loop, so a misconfiguration emitted roughly three errors per
 * second per member for the life of the session. It depends only on two
 * constants, so it belongs where they are read once.
 */
export function checkTiming(backstopMs, settleMs) {
  return backstopMs <= settleMs
    ? `BATCH_MAX_WAIT_MS (${backstopMs}) must exceed the settle window (${settleMs}) — `
      + 'batches are being cut short by the backstop.'
    : null;
}

if (process.argv[1]?.endsWith('ripeness.js')) {
  const { strict: a } = await import('node:assert');
  const S = 90_000, B = 180_000, N = 180_000;
  const msg = (over, extra = {}) => ({ ts: 1_000_000 - over, kind: 'assignment', sender: 'coder', ...extra });
  const at = (deliverable, o = {}) => ripeness(deliverable, {
    now: 1_000_000, awake: true, busy: false, settleMs: S, backstopMs: B, noticeHoldMs: N, ...o,
  });

  a.equal(at([]).ripe, false, 'an empty batch is never ripe');

  // The settle window.
  a.equal(at([msg(S + 1)]).ripe, true, 'a quiet idle member delivers after the window');
  a.equal(at([msg(S - 1)]).ripe, false, 'and not before it');
  a.equal(at([msg(S + 1)], { busy: true }).ripe, false,
    'interrupting a busy member wastes a replay on a partial thought');
  a.equal(at([msg(B + 1)], { busy: true }).ripe, true, 'but the backstop still fires');

  // The sovereign does not wait out a window built for agent chatter.
  a.equal(at([msg(1, { sender: 'sovereign' })]).ripe, true, 'the sovereign is urgent');
  a.equal(at([msg(1, { sender: 'sovereign' })], { busy: true }).ripe, false,
    'urgent still does not interrupt a turn in flight');

  // The bug: a notice must not spawn a sleeper.
  const notice = [msg(N + 1, { kind: 'notice' })];
  a.equal(at(notice, { awake: false, hadRealTurn: true }).ripe, false,
    'a notice must NEVER wake a sleeping member — it costs a whole turn to read "take no action"');
  a.equal(at(notice, { awake: true, hadRealTurn: true }).ripe, true,
    'but an awake member WITH REAL HISTORY reads it once it is held');
  a.equal(at([msg(N - 1, { kind: 'notice' })], { hadRealTurn: true }).ripe, false,
    'a fresh notice waits for real traffic');
  // The same bug, one step further: a notice must not interrupt a turn in
  // flight either — an awake-but-busy member is not a free member.
  a.equal(at(notice, { awake: true, busy: true, hadRealTurn: true }).ripe, false,
    'held notices must not interrupt a busy member — that still buys a turn of its own, just a delayed one');
  // Mixed batches are NOT notices: one real message carries the notices with it.
  // This must work even with NO real history yet — the real message in the
  // batch IS the first real turn.
  a.equal(at([msg(S + 1, { kind: 'notice' }), msg(S + 1)], { hadRealTurn: false }).ripe, true,
    'a notice riding along with real traffic goes when the real traffic goes');

  // issue #40 — "the orchestrator is talking to itself. I didn't give it a
  // command yet." A member spawned at daemon boot is AWAKE and IDLE the moment
  // it is spawned, well before the sovereign has said anything. If its only
  // mail is housekeeping notices (inherited crew, orphaned tasks) and nothing
  // has ever addressed it directly, holding those past noticeHoldMs must NOT
  // manufacture a turn — there is no conversation to keep current, and nobody
  // asked it anything.
  a.equal(at(notice, { awake: true, busy: false, hadRealTurn: false }).ripe, false,
    'a member with no real turn behind it must never be given one by a lone notice, '
    + 'no matter how long it waits');

  // The handover window.
  a.equal(at([msg(B + 1, { sender: 'sovereign' })], { recycling: true }).ripe, false,
    'nothing is delivered into a member whose session is being replaced — not even the backstop');

  a.equal(checkTiming(B, S), null, 'the shipped constants are consistent');
  a.match(checkTiming(10, 20), /must exceed/, 'and an inverted pair is reported');

  console.log('ripeness.js self-check OK — notices never wake sleepers, handovers never lose mail');
}
