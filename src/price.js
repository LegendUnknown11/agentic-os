// What a turn actually cost, in dollars.
//
// Why this exists: codex and agy report NO cost at all (agent.js hardcodes
// `costUsd: 0` on both paths), and the live court is 107 codex members. So
// `spentUsd` sat frozen while the court burned tokens, `maxBudgetUsd` and
// `maxKingdomUsd` could never fire, and every cost decision was being made
// against a token count instead of a price.
//
// A token count is the wrong unit, because the three kinds of token do not
// cost the same thing:
//
//   fresh input   1.0x      cache write  1.25x      cache read  0.1x
//
// Measured on a real 3-turn session (E:\AI\.kingdom\Sant Dnyaneshwar), 95.2%
// of all input was cache READ. Counted as tokens that looks like a session
// paying to re-read itself; priced, those tokens are ~34% of the input bill —
// the session cost $0.604 on the king's terra, against $3.93 if those same
// tokens had been fresh. Tuning `recycleAtTokens` against the token count
// therefore optimises the cheapest thing in the system — and pays for it with
// a handover turn at full context plus a destroyed cache prefix.
//
// Prices are $ per MILLION tokens, [fresh input, cache read, output]. The
// cache WRITE rate is derived (1.25x fresh) rather than being a fourth column:
// it is a published multiplier, not an independent price, and only claude
// reports the field at all.
//
// Verified 2026-08-15 against platform.claude.com/docs/en/about-claude/pricing
// and developers.openai.com/api/docs/pricing.

export const PRICES = {
  // OpenAI, via the codex CLI
  'codex/gpt-5.6-sol':    [5.00, 0.50, 30.00],
  'codex/gpt-5.6-terra':  [2.00, 0.20, 12.00],
  'codex/gpt-5.6-luna':   [0.20, 0.02,  1.20],
  'codex/gpt-5.5':        [5.00, 0.50, 30.00],
  'codex/gpt-5.4':        [2.50, 0.25, 15.00],
  'codex/gpt-5.4-mini':   [0.75, 0.075, 4.50],
  'codex/gpt-5.4-nano':   [0.20, 0.02,  1.25],
  'codex/gpt-5.2':        [2.50, 0.25, 15.00],

  // Anthropic, via the claude CLI. The config names these by alias
  // ("opus", "sonnet"), so both the alias and the full id are listed.
  'claude/fable':         [10.00, 1.00, 50.00],
  'claude/opus':          [5.00, 0.50, 25.00],
  'claude/sonnet':        [2.00, 0.20, 10.00],
  'claude/haiku':         [1.00, 0.10,  5.00],
  'claude/claude-fable-5':      [10.00, 1.00, 50.00],
  'claude/claude-opus-5':       [5.00, 0.50, 25.00],
  'claude/claude-sonnet-5':     [2.00, 0.20, 10.00],
  'claude/claude-haiku-4-5':    [1.00, 0.10,  5.00],
};

const CACHE_WRITE_MULTIPLIER = 1.25;

/** The rate card for one member, or null when we have no published price. */
export function rateOf(cli, model, table = PRICES) {
  if (!cli || !model) return null;
  return table[`${cli}/${model}`] ?? null;
}

/**
 * Dollars for one turn's usage, or **null** when the model has no price.
 *
 * Null, never a guess. A fabricated number here would flow straight into
 * `spentUsd` and the budget cap, and a cap enforced against an invented price
 * is worse than no cap at all — it stops members for reasons nobody can audit.
 *
 * `usage` is one turn's DELTA (see usage.js `deltaOf`), not a cumulative
 * codex reading. Passing a cumulative total here prices every earlier turn
 * again.
 */
export function costOf(usage = {}, cli, model, table = PRICES) {
  const rate = rateOf(cli, model, table);
  if (!rate) return null;
  const [inRate, cachedRate, outRate] = rate;

  const total = usage.in ?? 0;
  const cached = usage.cached ?? 0;
  const written = usage.written ?? 0;          // claude's cache_creation; 0 elsewhere
  const fresh = Math.max(0, total - cached - written);

  return (fresh * inRate
    + cached * cachedRate
    + written * inRate * CACHE_WRITE_MULTIPLIER
    + (usage.out ?? 0) * outRate) / 1e6;
}

/** The sovereign's `prices` config layered over the defaults. */
export function tableFrom(config) {
  return { ...PRICES, ...(config?.prices ?? {}) };
}

if (process.argv[1]?.endsWith('price.js')) {
  const { strict: a } = await import('node:assert');
  const near = (got, want, why) =>
    a.ok(Math.abs(got - want) < 1e-9, `${why}: got ${got}, want ${want}`);

  // A million fresh input tokens on luna is exactly the input rate.
  near(costOf({ in: 1e6, cached: 0, out: 0 }, 'codex', 'gpt-5.6-luna'), 0.20,
    'fresh input priced at the input rate');

  // The whole point: a cached token is a TENTH of a fresh one, not the same.
  near(costOf({ in: 1e6, cached: 1e6, out: 0 }, 'codex', 'gpt-5.6-luna'), 0.02,
    'a fully cached turn costs the cache rate, not the input rate');
  a.ok(costOf({ in: 1e6, cached: 1e6, out: 0 }, 'codex', 'gpt-5.6-luna')
     < costOf({ in: 1e6, cached: 0, out: 0 }, 'codex', 'gpt-5.6-luna'),
    'cached must be cheaper than fresh, or the whole exercise is pointless');

  // Mixed, with output.
  near(costOf({ in: 1e6, cached: 900_000, out: 1e6 }, 'codex', 'gpt-5.6-luna'),
    0.1 * 0.20 + 0.9 * 0.02 + 1.20, 'fresh + cached + output add up');

  // claude's cache_creation is billed at 1.25x input.
  near(costOf({ in: 1e6, cached: 0, written: 1e6, out: 0 }, 'claude', 'sonnet'),
    2.00 * 1.25, 'cache writes cost 1.25x the input rate');

  // An unpriced model must refuse to answer rather than invent a number.
  a.equal(costOf({ in: 1e6 }, 'codex', 'gpt-9-unreleased'), null,
    'an unknown model prices to null, never to zero');
  a.equal(costOf({ in: 1e6 }, 'agy', 'gemini-3.6-flash-high'), null,
    'agy publishes no price here, so it must return null');
  a.equal(rateOf(undefined, undefined), null, 'a member with no cli/model is unpriced');

  // Zero usage is free, not NaN.
  a.equal(costOf({}, 'codex', 'gpt-5.6-luna'), 0, 'an empty turn costs nothing');

  // The sovereign can add a price without editing this file.
  const custom = tableFrom({ prices: { 'agy/gemini-3.6-flash-high': [1, 0.1, 4] } });
  near(costOf({ in: 1e6, cached: 0, out: 0 }, 'agy', 'gemini-3.6-flash-high', custom), 1,
    'a config price must override/extend the built-in table');

  // The claim this whole file rests on, checked against a REAL measured
  // session: 1.89M input (deltas), 1.82M of it cache reads, 12k output.
  // Pricing the cache reads correctly rather than at the fresh-input rate is
  // the difference between $0.65 and $3.93 on terra — so a token count cannot
  // stand in for a bill, whatever the model.
  const realUsage = { in: 1_886_235, cached: 1_816_064, out: 12_073 };
  const real = costOf(realUsage, 'codex', 'gpt-5.6-terra');
  const atPar = costOf({ ...realUsage, cached: 0 }, 'codex', 'gpt-5.6-terra');
  a.ok(real < atPar / 4,
    `a cache-dominated session must cost far less than the same tokens at par: ${real} vs ${atPar}`);

  console.log('price.js self-check OK — cached at 0.1x, writes at 1.25x, unknown models null');
}
