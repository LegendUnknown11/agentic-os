// Three CLIs, three ways of reporting the same two numbers.
//
// This existed twice — once in ctx.js and once in kingdom.js — and the copies
// drifted, which is exactly how the audit came to report "replayed context:
// 107.6% of all input" and "genuinely new: -37.94M". A negative quantity of
// new tokens is not a rounding error, it is a sign the numerator and the
// denominator were measuring different things.
//
// The difference that matters is NESTING:
//
//   OpenAI / codex   `cached_input_tokens` is PART OF `input_tokens`
//   agy / Gemini     `cache_read_tokens`   is PART OF `input_tokens`
//                    (its own total_tokens = input + output confirms this)
//   Anthropic        `cache_read_input_tokens` is ALONGSIDE `input_tokens`
//
// So for Anthropic the true input is input + cache_read + cache_creation,
// while for the other two it is input_tokens alone. Add the Anthropic cache
// read to a codex-shaped denominator and you double-count; leave it out of an
// Anthropic denominator and the cached share exceeds 100%.

/** Everything the model read this turn, cached or not. */
export function inputTokens(usage = {}) {
  const input = usage.input_tokens ?? 0;
  // Nested shapes: the cache read is already inside input_tokens.
  if (usage.cached_input_tokens !== undefined) return input;
  if (usage.cache_read_tokens !== undefined) return input;
  // Alongside shape: add the parts back together.
  return input + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** The part of that which was replayed from cache rather than read afresh. */
export function cachedTokens(usage = {}) {
  return usage.cached_input_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cache_read_tokens
    ?? 0;
}

/** The three numbers a turn reports, normalised. `written` is claude-only. */
export function totalsOf(usage = {}) {
  return {
    in: inputTokens(usage),
    out: usage.output_tokens ?? 0,
    cached: cachedTokens(usage),
    written: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Is this reading CUMULATIVE for the session, or just this turn?
 *
 * codex reports `usage` in `turn.completed` cumulatively per thread: it climbs
 * all session and resets when the thread restarts. Summing it across turns
 * counts every earlier turn again — measured on a real run, that turned 65M
 * input tokens into an apparent 420M. claude and agy both report per turn.
 *
 * The CLI is not recorded on the event, so the shape is the discriminator —
 * the same nesting distinction the top of this file already turns on.
 * `cached_input_tokens`/`cache_write_input_tokens` are codex's names and
 * nobody else's.
 *
 * This lived only in daemon.js. ctx.js and kingdom.js summed raw, which is why
 * `node src/ctx.js` reported 2.37M for a session whose true total is 1.89M —
 * a 25% overcount that grows with turn count, in the tool the court's whole
 * cost discipline is built on.
 */
export function isCumulative(usage = {}) {
  return usage.cached_input_tokens !== undefined
    || usage.cache_write_input_tokens !== undefined;
}

export const ZERO = { in: 0, out: 0, cached: 0, written: 0 };

/**
 * What one turn actually added, given the previous reading from the same
 * member. A DROP means the session restarted, so the new reading is the whole
 * delta. Per-turn CLIs pass straight through.
 */
export function deltaOf(prev, usage = {}) {
  const now = totalsOf(usage);
  if (!isCumulative(usage)) return now;
  const d = (a, b) => (a >= b ? a - b : a);
  const was = prev ?? ZERO;
  return {
    in: d(now.in, was.in ?? 0),
    out: d(now.out, was.out ?? 0),
    cached: d(now.cached, was.cached ?? 0),
    written: d(now.written, was.written ?? 0),
  };
}

if (process.argv[1]?.endsWith('usage.js')) {
  const { strict: a } = await import('node:assert');

  // codex: cached is nested, so total input is just input_tokens.
  const codex = { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 };
  a.equal(inputTokens(codex), 100, 'a nested cache must not be added twice');
  a.equal(cachedTokens(codex), 90);

  // agy: same nesting, different name. Real payload shape from agy 1.1.12,
  // whose total_tokens (17712) = input + output, proving the nesting.
  const agy = { input_tokens: 17711, cache_read_tokens: 9000, output_tokens: 1, total_tokens: 17712 };
  a.equal(inputTokens(agy), 17711, "agy's cache read is inside input_tokens");
  a.equal(cachedTokens(agy), 9000, "agy's third name for it must still count");

  // claude: alongside, so the parts must be summed for the true input.
  const claude = { input_tokens: 50, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 };
  a.equal(inputTokens(claude), 100, 'an alongside cache must be added to input');
  a.equal(cachedTokens(claude), 40);

  // The invariant that the drift broke: the replayed share is a SHARE.
  for (const u of [codex, agy, claude, {}]) {
    a.ok(cachedTokens(u) <= inputTokens(u),
      `cached must never exceed input: ${JSON.stringify(u)}`);
  }

  a.equal(inputTokens({}), 0, 'a turn with no usage at all is zero, not NaN');
  a.equal(cachedTokens({}), 0);

  // --- cumulative vs per-turn ---------------------------------------------

  a.ok(isCumulative(codex), 'codex reports cumulatively');
  a.ok(!isCumulative(claude), 'claude reports per turn');
  a.ok(!isCumulative(agy), 'agy reports per turn');
  // A codex turn that happened to read nothing from cache is still codex.
  a.ok(isCumulative({ input_tokens: 5, cache_write_input_tokens: 0 }),
    "codex's write field identifies it even when nothing was cached");

  // The real numbers from E:\AI\.kingdom\Sant Dnyaneshwar — three codex turns,
  // climbing. Summed raw they read 2.37M; the truth is the last reading, 1.89M.
  const climb = [
    { input_tokens: 122_491, cached_input_tokens: 106_240, output_tokens: 1_217 },
    { input_tokens: 364_735, cached_input_tokens: 337_664, output_tokens: 2_485 },
    { input_tokens: 1_886_235, cached_input_tokens: 1_816_064, output_tokens: 8_371 },
  ];
  let prev = ZERO, sum = 0;
  for (const u of climb) { sum += deltaOf(prev, u).in; prev = totalsOf(u); }
  a.equal(sum, 1_886_235, 'a cumulative climb must total the last reading, not the sum of all');
  a.equal(climb.reduce((t, u) => t + inputTokens(u), 0), 2_373_461,
    'and summing raw is exactly the 2.37M overcount this prevents');

  // A drop means a new thread: that reading is the whole delta.
  a.equal(deltaOf({ in: 900, out: 9, cached: 800, written: 0 },
    { input_tokens: 100, cached_input_tokens: 90, output_tokens: 1 }).in, 100,
    'a reading below the previous one is a restarted thread, not a negative turn');

  // claude grows per turn too, but each reading is already just that turn.
  // Delta-ing it would silently discard most of the bill.
  const c1 = { input_tokens: 100, cache_read_input_tokens: 40 };
  const c2 = { input_tokens: 150, cache_read_input_tokens: 90 };
  a.equal(deltaOf(totalsOf(c1), c2).in, 240,
    'a per-turn CLI must pass through untouched, not be differenced');

  console.log('usage.js self-check OK — nested vs alongside cache, cumulative vs per-turn');
}
