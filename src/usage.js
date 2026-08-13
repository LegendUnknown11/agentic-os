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
  console.log('usage.js self-check OK — nested vs alongside cache accounting across three CLIs');
}
