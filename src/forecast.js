// What the crew you are about to approve costs per turn.
//
// Every cost tool in this repo is post-hoc: ctx.js, recycle.js, replay.js and
// the Usage panel all answer "where did the money go". The one moment the
// user can actually change the bill — approving an add — showed names
// and a paragraph of prose and no number at all, even though README.md names
// the roster as the biggest lever there is and says to trim it right there.
// This is the number that was missing from that card.
//
// A RATE, AND NOW ALSO A TOTAL WHEN THE DATA SUPPORTS ONE. This used to report
// dollars per turn only, because nothing in the bus marked where one order
// began and ended — any total would have been a guess wearing a
// measurement's clothes, the exact thing HANDOFF.md rule 2 exists to stop.
// `campaigns` now marks that boundary (src/bus.js beginCampaign/campaigns),
// so the projected total is the measured per-turn rate times the MEASURED
// mean turns-per-closed-campaign — never an invented multiplier. Zero closed
// campaigns still reports the rate alone, honestly, with a `why`.
//
// MEAN, NOT MEDIAN, and that is a correctness choice rather than a lazy one.
// The crew line has to be the sum of the member lines — one round in which
// everybody takes one turn — and means add while medians do not. A p50 crew
// rate would be a number with no arithmetic behind it.
//
// Pure: no fs, no bus, no clock, no process. Everything it needs is an
// argument, which is what lets the self-check at the foot of this file drive
// the whole thing in milliseconds.
import { deltaOf, totalsOf } from './usage.js';
import { costOf, PRICES } from './price.js';

/**
 * Per-member observed cost, from this team's own `turn_end` log.
 *
 * @param rows      turn_end events, oldest first, payload already parsed
 *                  (exactly what `bus.events({type:'turn_end'})` returns)
 * @param specOf    name -> {cli, model}, i.e. agenticos.specOf
 * @param table     price table, i.e. tableFrom(config)
 * @param quotaClis clis billed by subscription, i.e. Object.keys(config.quotas)
 * @returns Map name -> {name, cli, model, turns, usd, tokens, metered}
 */
export function rates(rows, { specOf, table = PRICES, quotaClis = [] } = {}) {
  const quota = new Set(quotaClis);
  const prev = new Map();
  const by = new Map();

  for (const ev of rows) {
    // A payload that will not parse must cost itself one turn and nothing
    // else — the same rule readApproval() enforces for approvals, and for the
    // same reason: one bad row must never take the whole panel with it.
    let p = ev?.payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { continue; } }
    const usage = p?.usage;
    if (!usage || !ev?.agent) continue;

    // deltaOf, never a raw sum. codex reports usage cumulatively per thread,
    // so summing raw turned a real 1.89M-token session into 2.37M in ctx.js
    // and 65M into 420M in another. This rule has been hand-rolled and has
    // drifted three separate times; usage.js is the only copy that counts.
    const d = deltaOf(prev.get(ev.agent), usage);
    prev.set(ev.agent, totalsOf(usage));

    const spec = specOf?.(ev.agent) ?? {};
    const cli = spec.cli ?? null;
    const model = spec.model ?? null;

    const m = by.get(ev.agent)
      ?? { name: ev.agent, cli, model, turns: 0, usd: 0, tokens: 0, metered: true };
    // A member on a subscription plan has no marginal dollar cost at all, and
    // a member on an unpriced model has no published one. Neither may be
    // given an invented rate — that is the precedent the quota feature set,
    // and costOf() already refuses by returning null rather than 0.
    const usd = quota.has(cli) ? null : costOf(d, cli, model, table);
    if (usd === null) m.metered = false;
    else m.usd += usd;
    m.turns++;
    m.tokens += d.in + d.out;
    // The spec is read fresh each turn so a member whose model changed
    // mid-session is reported under what it runs on NOW, which is what the
    // next turn will actually be billed at.
    m.cli = cli;
    m.model = model;
    by.set(ev.agent, m);
  }
  return by;
}

/**
 * Turns actually spent inside each CLOSED campaign, counted from the real
 * event-id bracket `bus.campaigns()` hands back — never a guessed multiplier.
 * The open campaign (the one still accruing) is excluded: it has not
 * finished yet, so counting it would undercount every campaign that happens
 * to still be running at the moment this is read.
 *
 * @param campaigns   bus.campaigns() rows — {eventStart, eventEnd, current}
 * @param turnEndRows the same rows forecast() takes, each carrying the real
 *                    `id` bus.events() returns them with
 * @returns one integer per closed campaign, oldest first
 */
export function turnsPerClosedCampaign(campaigns, turnEndRows) {
  const rows = turnEndRows ?? [];
  return (campaigns ?? [])
    .filter((c) => !c.current)
    .map((c) => rows.filter((e) => e.id > c.eventStart && e.id <= c.eventEnd).length);
}

/**
 * The card. One line per proposed member, plus the crew's per-turn burn and,
 * when history supports it, a projected total for the whole order.
 *
 * Three states a member can be in, and they are deliberately different:
 *   turns === 0     never run in this team — no history, no number
 *   metered false   subscription or unpriced — tokens per turn, no dollars
 *   otherwise       dollars and tokens per turn
 *
 * The projected total needs BOTH a priced crew rate and at least one closed
 * campaign to measure turns-per-order from; either missing degrades to
 * `crew.projectedTotalUsd === null` plus a `crew.projectedWhy`, never a
 * fabricated number standing in for one.
 */
export function forecast(rows, names, opts = {}) {
  const seen = rates(rows, opts);
  const members = (names ?? []).map((name) => {
    const m = seen.get(name);
    const spec = opts.specOf?.(name) ?? {};
    if (!m || !m.turns) {
      return {
        name,
        cli: spec.cli ?? null,
        model: spec.model ?? null,
        turns: 0,
        perTurnUsd: null,
        perTurnTokens: 0,
        metered: true,
        why: 'no history',
      };
    }
    return {
      name,
      cli: m.cli,
      model: m.model,
      turns: m.turns,
      perTurnUsd: m.metered ? m.usd / m.turns : null,
      perTurnTokens: Math.round(m.tokens / m.turns),
      metered: m.metered,
      why: m.metered ? null : 'no published rate',
    };
  });

  const priced = members.filter((m) => m.perTurnUsd !== null);
  const perTurnUsd = priced.length ? priced.reduce((t, m) => t + m.perTurnUsd, 0) : null;

  // The mean, not the median — same reason the crew rate above is a mean:
  // this multiplies against a sum, so it has to be an arithmetic quantity.
  const samples = turnsPerClosedCampaign(opts.campaigns, rows);
  const turnsPerCampaign = samples.length
    ? samples.reduce((t, n) => t + n, 0) / samples.length
    : null;
  const projectedTotalUsd = perTurnUsd !== null && turnsPerCampaign !== null
    ? perTurnUsd * turnsPerCampaign
    : null;
  const projectedWhy = projectedTotalUsd !== null ? null
    : perTurnUsd === null ? 'crew has no priced rate'
    : 'no closed campaign yet';

  return {
    members,
    crew: {
      // Null, not zero, when NOTHING is priced. Zero would read as "this crew
      // is free", which is the one thing it certainly is not.
      perTurnUsd,
      perTurnTokens: members.reduce((t, m) => t + m.perTurnTokens, 0),
      // Named, not just counted: the user is deciding whom to cut, and
      // "one member is unpriced" does not tell them which one.
      unpriced: members.filter((m) => m.turns && !m.metered).map((m) => m.name),
      unknown: members.filter((m) => !m.turns).map((m) => m.name),
      // The measurement, kept beside the value it produced: how many closed
      // campaigns the mean rests on, so a projection from one thin sample
      // reads as exactly that thin, not as false confidence.
      campaignsSampled: samples.length,
      turnsPerCampaign,
      projectedTotalUsd,
      projectedWhy,
    },
  };
}

/** One line per member, for the CLI and any other plain-text surface. */
export function fmt(f) {
  const money = (n) => `$${n.toFixed(n < 0.01 ? 4 : 3)}`;
  const rateOfMember = (m) => (m.perTurnUsd !== null
    ? `${money(m.perTurnUsd)}/turn`
    : m.turns ? `${m.perTurnTokens.toLocaleString('en-US')} tok/turn` : 'no history');

  const lines = f.members.map((m) => {
    const note = m.turns ? `(${m.turns} turn${m.turns === 1 ? '' : 's'} observed)` : '';
    return `  ${m.name.padEnd(18)} ${rateOfMember(m).padEnd(16)} ${note}`.trimEnd();
  });
  const c = f.crew;
  const crew = c.perTurnUsd !== null
    ? `${money(c.perTurnUsd)}/turn`
    : `${c.perTurnTokens.toLocaleString('en-US')} tok/turn`;
  lines.push(`  ${'crew'.padEnd(18)} ${crew}`);
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('forecast.js')) {
  const { strict: a } = await import('node:assert');
  const near = (got, want, why) => a.ok(Math.abs(got - want) < 1e-9, `${why}: got ${got}, want ${want}`);

  const specs = {
    coder: { cli: 'codex', model: 'gpt-5.6-luna' },
    reviewer: { cli: 'claude', model: 'sonnet' },
    ghost: { cli: 'claude', model: 'model-nobody-prices' },
    plebe: { cli: 'codex', model: 'gpt-5.6-luna' }, // put on a quota plan below
  };
  const specOf = (n) => specs[n];
  const ev = (agent, usage) => ({ agent, payload: { usage } });

  // --- the delta rule, which is the whole reason this file imports usage.js.
  // codex reports CUMULATIVELY per thread. Two readings of 1000 then 3000
  // input are one turn of 1000 and one of 2000 — never 4000.
  const cumulative = [
    ev('coder', { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 }),
    ev('coder', { input_tokens: 3000, cached_input_tokens: 0, output_tokens: 300 }),
  ];
  const cum = rates(cumulative, { specOf });
  a.equal(cum.get('coder').turns, 2, 'two events are two turns');
  a.equal(cum.get('coder').tokens, 3300,
    'a cumulative reading must be deltaed, not summed: 1000+100 then 2000+200');
  // luna: $0.20/M in, $1.20/M out.
  near(cum.get('coder').usd, (3000 * 0.20 + 300 * 1.20) / 1e6,
    'the priced total must follow the deltas');

  // --- an unpriced model reports tokens and refuses to report dollars.
  const ghostRows = [ev('ghost', { input_tokens: 500, output_tokens: 50 })];
  a.equal(rates(ghostRows, { specOf }).get('ghost').metered, false,
    'an unpriced model is not metered');
  const gf = forecast(ghostRows, ['ghost'], { specOf });
  a.equal(gf.members[0].perTurnUsd, null, 'an unpriced member must never show a dollar figure');
  a.equal(gf.members[0].perTurnTokens, 550, 'but it must still show its tokens');
  a.equal(gf.crew.perTurnUsd, null, 'a wholly unpriced crew is unpriced, not free');
  a.deepEqual(gf.crew.unpriced, ['ghost'], 'and it must say WHICH member');

  // --- a quota-billed cli reports tokens even though its model IS priced.
  // The precedent from a9dd393: a subscription has no price per token, so do
  // not pretend one just because the rate card happens to have a row.
  const q = forecast([ev('plebe', { input_tokens: 1000, output_tokens: 100 })],
    ['plebe'], { specOf, quotaClis: ['codex'] });
  a.equal(q.members[0].perTurnUsd, null,
    'a subscription-billed cli must not be priced from the metered rate card');
  a.equal(q.members[0].perTurnTokens, 1100, 'it is tracked in tokens instead');

  // --- a member that has never run says so, and is not given a borrowed rate.
  const fresh = forecast([], ['coder'], { specOf });
  a.equal(fresh.members[0].turns, 0, 'no events is no history');
  a.equal(fresh.members[0].perTurnUsd, null, 'no history must never price to $0.000');
  a.deepEqual(fresh.crew.unknown, ['coder'], 'and the card must name it as unknown');
  a.equal(fresh.crew.perTurnUsd, null, 'a crew of unknowns has no rate at all');

  // --- the crew line is the SUM of the member lines. This is why the rate is
  // a mean: one round in which everybody takes one turn.
  const mixed = [
    ev('coder', { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 }),
    ev('reviewer', {
      input_tokens: 200, cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0, output_tokens: 20,
    }),
  ];
  const mf = forecast(mixed, ['coder', 'reviewer'], { specOf });
  near(mf.crew.perTurnUsd, mf.members[0].perTurnUsd + mf.members[1].perTurnUsd,
    'the crew rate must be the sum of the member rates');
  // claude's cache read sits ALONGSIDE input_tokens, so this turn read 300.
  a.equal(mf.members[1].perTurnTokens, 320, "claude's alongside cache must be added in");

  // --- a member outside the add must not leak into the card, and an
  // unparseable row must cost only itself.
  const noisy = forecast(
    [...mixed, { agent: 'coder', payload: '{not json' }, ev('stranger', { input_tokens: 9e9 })],
    ['coder'], { specOf },
  );
  a.equal(noisy.members.length, 1, 'only the proposed crew is reported');
  a.equal(noisy.members[0].turns, 1, 'an unparseable payload is skipped, not counted');

  // --- the printed card, checked rather than assumed.
  a.match(fmt(mf), /coder\s+\$0\.000\d+\/turn\s+\(1 turn observed\)/,
    'the card prints a per-turn rate and the sample size it rests on');
  a.match(fmt(fresh), /coder\s+no history/, 'and prints "no history" rather than a number');

  // --- a projected total is the crew rate times a MEASURED mean, never a
  // guessed multiplier. Event ids, not array position, are what bracket a
  // campaign — exactly what bus.campaigns()/events() hand back for real.
  const evId = (id, agent, usage) => ({ id, agent, payload: { usage } });
  const camRows = [1, 2, 3, 4, 5].map((id) => evId(id, 'coder', { input_tokens: 1000, output_tokens: 100 }));
  const closedTwo = [
    { eventStart: 0, eventEnd: 2, current: false },   // 2 turns: ids 1,2
    { eventStart: 2, eventEnd: 4, current: false },   // 2 turns: ids 3,4
    { eventStart: 4, eventEnd: null, current: true }, // open — must not count
  ];
  a.deepEqual(turnsPerClosedCampaign(closedTwo, camRows), [2, 2],
    'turn counts come from the real event-id bracket, and the open campaign is excluded');

  const projectedForecast = forecast(camRows, ['coder'], { specOf, campaigns: closedTwo });
  a.equal(projectedForecast.crew.campaignsSampled, 2, 'the sample size travels beside the value');
  a.equal(projectedForecast.crew.turnsPerCampaign, 2, 'mean turns per CLOSED campaign');
  near(projectedForecast.crew.projectedTotalUsd, projectedForecast.crew.perTurnUsd * 2,
    'the projected total is the measured rate times the measured mean, nothing invented');
  a.equal(projectedForecast.crew.projectedWhy, null);

  // --- no closed campaign yet: the rate still shows, the total honestly does not.
  const noCampaigns = forecast(camRows, ['coder'],
    { specOf, campaigns: [{ eventStart: 4, eventEnd: null, current: true }] });
  a.equal(noCampaigns.crew.projectedTotalUsd, null, 'one open campaign is not a measurement');
  a.equal(noCampaigns.crew.projectedWhy, 'no closed campaign yet');
  a.ok(noCampaigns.crew.perTurnUsd > 0, 'the per-turn rate must still show even with no total');

  // --- an unpriced crew never gets a projected total, for the same reason it
  // never gets a per-turn dollar figure.
  const unpricedProjected = forecast(ghostRows, ['ghost'], { specOf, campaigns: closedTwo });
  a.equal(unpricedProjected.crew.projectedTotalUsd, null);
  a.equal(unpricedProjected.crew.projectedWhy, 'crew has no priced rate');

  console.log('forecast.js self-check OK — deltas not sums, no invented rates, crew = sum of members, '
    + 'projected total = measured rate x measured mean turns-per-campaign');
}
