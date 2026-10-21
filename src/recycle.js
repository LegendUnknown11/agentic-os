#!/usr/bin/env node
// What should `recycleAtTokens` be?
//
//   node src/recycle.js <repo> [cli] [model]
//
// This is the measurement ctx.js's correction was supposed to unlock. Once
// cache reads are priced at 0.1x instead of at par, the whole case for
// recycling changes shape, so the threshold has to be re-derived rather than
// inherited — 80,000 was chosen against the old, wrong arithmetic.
//
// THE MODEL. Between recycles a member's context grows by roughly `g` tokens a
// turn from `c0`. Each turn replays its whole context at the CACHE rate `r`;
// the new tokens are fresh at `R` (= 10r for every model in price.js). At the
// threshold it spends one extra turn writing a handover — a full replay that
// produces no work — and the successor starts back at c0.
//
// Per turn of real work, the part that depends on the threshold is
//
//     r · [ (c0+T)/2  +  g·(T + 12.5·c0·b) / (T − c0) ]
//                ^^^ carrying a bigger context      ^^^ amortised handover
//
// where b is 1 if cache WRITES are billed and 0 if not. Those two pull opposite
// ways, so there is an interior optimum, and it falls out in closed form:
//
//     T* = c0 + sqrt( 2·g·c0·(1 + 12.5b) )
//
// Note what is NOT in it: the price level cancels. A luna agent and a terra
// orchestrator have the same optimal threshold. Only c0, g, and whether writes are
// billed matter — which also means this cannot be tuned per-model, only
// per-growth-rate.
//
// WHAT THE MODEL CANNOT SEE, and the reason T* is a FLOOR rather than an
// answer: a successor does not resume, it rediscovers. It re-reads the files
// its predecessor had already read, and those re-reads are FRESH input at 10x
// the cache rate, on a cold prefix. Nothing in the event log records how much
// of a member's next turns go on catching up, so that cost is unmeasured here
// and deliberately not guessed at. Read T* as "below this, recycling loses
// money even if catching up were free."
//
// Read-only, apart from the one-time move of pre-rename state (src/legacy.js)
// on first use. Safe to run while the team is working.
import './legacy-boot.js'; // first: legacy env fallback and home migration, before any module reads env
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { dbPath } from './worktree.js';
import { rateOf, tableFrom } from './price.js';

// toLocaleString() would group by the machine's locale, and this is read next
// to dollar figures — "1,60,000" beside "$17.57" is a misread waiting to happen.
const N = (n) => Math.round(n).toLocaleString('en-US');

// Anthropic bills cache writes at 1.25x input; OpenAI's caching is automatic
// and free to write, which is why `cache_creation_input_tokens` is a claude-only
// field in usage.js. The factor is 1.25·(R/r) = 12.5.
const WRITE_PENALTY = 12.5;
const billsWrites = (cli) => cli === 'claude';

/** The threshold below which recycling cannot pay, even ignoring rediscovery. */
export function optimalThreshold({ c0, growth, cli }) {
  if (!(c0 > 0) || !(growth > 0)) return null;
  return Math.round(c0 + Math.sqrt(2 * growth * c0 * (1 + WRITE_PENALTY * (billsWrites(cli) ? 1 : 0))));
}

/**
 * Dollars per turn of real work spent on replay and handovers at threshold T.
 *
 * Threshold-dependent terms ONLY. The fresh tokens a turn generates and the
 * output it produces cost the same whatever T is, so including them would just
 * add a constant to every row and make the differences look smaller than they
 * are.
 */
export function costPerTurn(T, { c0, growth, cli, model, table }) {
  const rate = rateOf(cli, model, table);
  if (!rate || !(T > c0)) return null;
  const r = rate[1] / 1e6;                       // cache-read rate, $ per token
  const b = billsWrites(cli) ? 1 : 0;
  return r * ((c0 + T) / 2 + (growth * (T + WRITE_PENALTY * c0 * b)) / (T - c0));
}

/**
 * How fast a member's context actually grows, from its ctx sequence.
 *
 * `c0` is the first reading, which OVERSTATES a fresh start — it already
 * includes turn one's work. That biases T* upward, which is the safe direction
 * for a floor.
 */
export function growthOf(seq) {
  if (seq.length < 2) return null;
  const steps = [];
  for (let i = 1; i < seq.length; i++) {
    // A drop is a recycle, not negative growth; it starts a new run.
    if (seq[i] >= seq[i - 1]) steps.push(seq[i] - seq[i - 1]);
  }
  if (!steps.length) return null;
  return { c0: seq[0], growth: Math.round(steps.reduce((a, b) => a + b) / steps.length), n: steps.length };
}

/** Read each member's ctx-per-turn sequence out of the event log. */
export function sequences(db, since = 0) {
  const rows = db
    .prepare("select agent, payload from events where id > ? and type = 'turn_end' order by id")
    .all(since);
  const seq = {};
  for (const r of rows) {
    const ctx = JSON.parse(r.payload)?.ctx;
    if (ctx > 0) (seq[r.agent] ??= []).push(ctx);
  }
  return seq;
}

export function report(seq, { cli, model, current, table } = {}) {
  const out = [];
  const $ = (n) => (n === null ? '     —' : `$${n.toFixed(4)}`);

  for (const [name, s] of Object.entries(seq)) {
    const g = growthOf(s);
    out.push(`${name} — ${s.length} turns, ctx ${s.map((x) => Math.round(x / 1000) + 'k').join(' → ')}`);
    if (!g) { out.push('  too few turns to measure growth'); continue; }
    out.push(`  starts at ${N(g.c0)}, grows ~${N(g.growth)}/turn `
      + `(mean of ${g.n} step${g.n === 1 ? '' : 's'})`);

    const star = optimalThreshold({ ...g, cli });
    out.push(`  floor: T* = ${N(star)} — below this, recycling loses money even `
      + 'if catching up were free');
    out.push('');
    out.push('  threshold   turns/cycle   replay+handover, per 1000 turns of work');
    for (const T of [10_000, 20_000, 40_000, 80_000, 160_000, current].filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)) {
      const c = costPerTurn(T, { ...g, cli, model, table });
      const k = (T - g.c0) / g.growth;
      out.push(`  ${N(T).padStart(9)}   ${k.toFixed(1).padStart(11)}   `
        + `${$(c === null ? null : c * 1000).padStart(12)}${T === current ? '   <- current' : ''}`);
    }
    out.push('');

    // The decisive local fact is not the optimum — it is whether the threshold
    // is reached at all. A setting the team never touches cannot be costing
    // anything, and "tune it" would be advice about a branch that never runs.
    const peak = Math.max(...s);
    if (current && peak < current) {
      out.push(`  OBSERVED PEAK ${N(peak)} vs threshold ${N(current)}: `
        + 'this member never came close to');
      out.push(`  recycling — ${Math.ceil((current - peak) / g.growth)} more turns of growth away. `
        + 'On this evidence the threshold is');
      out.push('  inert, and lowering it would be a change to behaviour nobody has observed.');
      out.push('  Re-run this after a session long enough to actually hit it.');
    } else if (current) {
      const now = costPerTurn(current, { ...g, cli, model, table });
      const at = costPerTurn(Math.max(star, g.c0 + 1000), { ...g, cli, model, table });
      if (now !== null && at !== null) {
        out.push(`  At ${N(current)} the replay+handover bill is ${$(now * 1000)} per `
          + `1000 turns; at the floor it is ${$(at * 1000)}`);
        out.push(`  — ${(((now - at) / now) * 100).toFixed(0)}% of it is carrying context the model `
          + 'says is not paying for itself.');
        out.push('  That gap is the whole allowance for rediscovery, which this cannot measure.');
        out.push('  Spend it deliberately, not by default.');
      }
    }
  }
  return out.join('\n');
}

if (process.argv[1]?.endsWith('recycle.js') && !process.argv[2]) {
  const { strict: a } = await import('node:assert');

  // Growth: a drop is a recycle, not a negative turn.
  a.deepEqual(growthOf([1000, 2000, 3000]), { c0: 1000, growth: 1000, n: 2 });
  a.equal(growthOf([1000, 3000, 500, 1500]).n, 2, 'a recycle must not count as growth');
  a.equal(growthOf([5000]), null, 'one turn cannot show a trend');

  // The closed form must actually BE the minimum of the cost curve, or the
  // headline number is decoration. Check it against a brute-force sweep.
  for (const cli of ['codex', 'claude']) {
    const p = { c0: 2585, growth: 6400, cli, model: cli === 'codex' ? 'gpt-5.6-luna' : 'sonnet' };
    const star = optimalThreshold(p);
    let best = null, bestT = 0;
    for (let T = p.c0 + 100; T < 400_000; T += 100) {
      const c = costPerTurn(T, p);
      if (best === null || c < best) { best = c; bestT = T; }
    }
    a.ok(Math.abs(star - bestT) < 200,
      `${cli}: the closed form (${star}) must match the swept minimum (${bestT})`);
  }

  // Billing cache writes makes recycling more expensive, so the floor rises.
  const base = { c0: 2585, growth: 6400 };
  a.ok(optimalThreshold({ ...base, cli: 'claude' }) > optimalThreshold({ ...base, cli: 'codex' }),
    'a vendor that charges for cache writes must want to recycle LESS often');

  // The price level cancels: two models on the same CLI share a threshold.
  a.equal(optimalThreshold({ ...base, cli: 'codex' }), optimalThreshold({ ...base, cli: 'codex' }));

  // Faster growth means a bigger window is affordable, because the handover is
  // amortised over the same number of turns either way.
  a.ok(optimalThreshold({ c0: 2585, growth: 20_000, cli: 'codex' })
     > optimalThreshold({ c0: 2585, growth: 6400, cli: 'codex' }),
    'a faster-growing context must justify a higher threshold, not a lower one');

  // Above the floor the curve must rise, or the floor is not a floor and every
  // conclusion drawn from it is backwards. This assertion replaced one claiming
  // the spread was negligible — it is not: on the measured growth rate, 20k vs
  // 160k is a 4.7x difference in the replay bill, which is 60% of the whole
  // bill per ctx.js. The knob is small in dollars and large in proportion, and
  // conflating those two is how it got set against the old arithmetic.
  const p = { c0: 2585, growth: 6400, cli: 'codex', model: 'gpt-5.6-luna' };
  const star = optimalThreshold(p);
  a.ok(costPerTurn(160_000, p) > costPerTurn(80_000, p),
    'above the floor, a higher threshold must cost more');
  a.ok(costPerTurn(80_000, p) > costPerTurn(star, p),
    'and the floor must be cheaper than the current setting, or it is misnamed');
  a.ok(costPerTurn(160_000, p) / costPerTurn(20_000, p) > 3,
    'the range must be a LARGE proportional difference — a report calling it '
    + 'negligible would be talking the user out of a real lever');

  a.equal(costPerTurn(1000, { c0: 5000, growth: 100, cli: 'codex', model: 'gpt-5.6-luna' }), null,
    'a threshold below the starting context is not a setting, it is a bug');
  a.equal(costPerTurn(80_000, { c0: 2585, growth: 6400, cli: 'agy', model: 'gemini-3.6-flash-high' }),
    null, 'an unpriced model must not be given a modelled cost');

  console.log('recycle.js self-check OK — closed form matches the swept minimum, '
    + 'writes raise the floor, the range is a real proportional difference');
}

if (process.argv[1]?.endsWith('recycle.js') && process.argv[2]) {
  const repo = resolve(process.argv[2]);
  const db = new DatabaseSync(dbPath(repo), { readOnly: true });
  // A worked repo usually has NO agenticos.config.json of its own — the team is
  // driven from the orchestrator's. Falling back to it is what makes `current`
  // land, and without `current` the report cannot say the one thing that
  // matters most: whether the threshold was ever reached.
  const { readFileSync } = await import('node:fs');
  const { defaultConfigPath } = await import('./agenticos.js');
  let cfg = {};
  const { LEGACY } = await import('./legacy.js');
  // A repo's own config may still carry its pre-rename name: read, never moved, it is the user's file.
  for (const p of [resolve(repo, 'agenticos.config.json'), resolve(repo, LEGACY.config), defaultConfigPath(repo)]) {
    try { cfg = JSON.parse(readFileSync(p, 'utf8')); break; } catch { /* try the next */ }
  }
  const cli = process.argv[3] ?? cfg.orchestrator?.cli ?? 'codex';
  const model = process.argv[4] ?? cfg.orchestrator?.model ?? 'gpt-5.6-luna';
  console.log(`modelled for ${cli}/${model}\n`);
  console.log(report(sequences(db), {
    cli, model, current: cfg.recycleAtTokens, table: tableFrom(cfg),
  }));
  db.close();
}
