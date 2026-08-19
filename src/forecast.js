// What the crew you are about to approve costs per turn.
//
// Every cost tool in this repo is post-hoc: ctx.js, recycle.js, replay.js and
// the Usage panel all answer "where did the money go". The one moment the
// sovereign can actually change the bill — approving a summon — showed names
// and a paragraph of prose and no number at all, even though README.md names
// the roster as the biggest lever there is and says to trim it right there.
// This is the number that was missing from that card.
//
// A RATE, NOT A TOTAL. This reports dollars per turn, never dollars for the
// job. A total needs turns-per-summon, and nothing in the bus marks where one
// order begins and ends, so any total would be a guess wearing a
// measurement's clothes — the exact thing AGENTS.md rule 2 exists to stop.
// ponytail: upgrade to a projected total once a campaign boundary exists.
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
 * Per-member observed cost, from this court's own `turn_end` log.
 *
 * @param rows      turn_end events, oldest first, payload already parsed
 *                  (exactly what `bus.events({type:'turn_end'})` returns)
 * @param specOf    name -> {cli, model}, i.e. kingdom.specOf
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
 * The card. One line per proposed member, plus the crew's per-turn burn.
 *
 * Three states a member can be in, and they are deliberately different:
 *   turns === 0     never run in this court — no history, no number
 *   metered false   subscription or unpriced — tokens per turn, no dollars
 *   otherwise       dollars and tokens per turn
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
  return {
    members,
    crew: {
      // Null, not zero, when NOTHING is priced. Zero would read as "this crew
      // is free", which is the one thing it certainly is not.
      perTurnUsd: priced.length ? priced.reduce((t, m) => t + m.perTurnUsd, 0) : null,
      perTurnTokens: members.reduce((t, m) => t + m.perTurnTokens, 0),
      // Named, not just counted: the sovereign is deciding whom to cut, and
      // "one member is unpriced" does not tell them which one.
      unpriced: members.filter((m) => m.turns && !m.metered).map((m) => m.name),
      unknown: members.filter((m) => !m.turns).map((m) => m.name),
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

  // --- a member outside the summon must not leak into the card, and an
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

  console.log('forecast.js self-check OK — deltas not sums, no invented rates, crew = sum of members');
}
