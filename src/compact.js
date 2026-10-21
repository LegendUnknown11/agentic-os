// The compaction window: how big a member's context gets before the court
// throws it away and reseeds the successor from a handover note.
//
// The kingdom already compacted — `recycleAtTokens` in agenticos.config.json —
// but the only way to change it was to edit the file and restart, and the
// number was arrived at by a one-off measurement that nothing re-checks. This
// is the runtime control: `/autocompact 300k` from the throne room, or
// `/autocompact auto` to re-derive it from what the court has actually done.
//
// Note what compaction means HERE. Claude Code summarises the old turns and
// keeps going in the same session; the court retires the session and writes a
// handover. That difference is deliberate and measured — see the vault note
// "Do not add summarization to the recycle path": summarisation elongated
// trajectories by 13-15% in the published sweeps, and this court's cost is
// driven by TURN COUNT, so buying extra turns to save tokens per turn trades
// the expensive currency for the cheap one.

/** Below this a member cannot hold a brief; above it, replay dwarfs the work. */
export const MIN = 10_000;
export const MAX = 500_000;

/**
 * `80000` → `80k`. Deliberately not `toLocaleString`: this machine's locale
 * groups by lakh, so the same window printed as "3,00,000" in a toast and
 * "300000" in agenticos.config.json. A window is an order of magnitude, not an
 * accounting figure — print it the way it is typed.
 */
export const fmtTokens = (n) => (n % 1000 ? `${Math.round(n / 100) / 10}k` : `${n / 1000}k`);
export const USAGE = `'auto' or ${fmtTokens(MIN)}-${fmtTokens(MAX)} tokens `
  + '(e.g. 80k, 120000, or 300 as shorthand)';

/**
 * `300k` · `300000` · `300` · `300k tokens` · `auto` — and `[300k]`, because
 * the usage line shows the argument in brackets and the sovereign pasted it
 * back verbatim five times in a row before finding the form that parsed.
 * Anything else returns an `error` string rather than throwing: a mistyped
 * setting must not take the throne room down.
 */
export function parseWindow(arg) {
  const s = String(arg ?? '').trim().toLowerCase()
    .replace(/^[[<(]+|[\]>)]+$/g, '')       // pasted straight out of the usage line
    .replace(/\s*tokens?$/, '')
    .trim();

  if (!s) return { error: `Expected ${USAGE}` };
  if (s === 'auto') return { auto: true };

  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
  if (!m) return { error: `Couldn't parse '${arg}'. Expected ${USAGE}` };

  let n = Number(m[1]);
  if (m[2] === 'k') n *= 1_000;
  else if (m[2] === 'm') n *= 1_000_000;
  // A bare number under a thousand is shorthand for thousands. Only under a
  // THOUSAND: `9000` stays 9,000 and is then rejected as out of range, which
  // is the honest answer. Treating it as 9M would silently disable compaction.
  else if (n < 1_000) n *= 1_000;

  n = Math.round(n);
  if (n < MIN || n > MAX) {
    return { error: `${fmtTokens(n)} is outside the usable range — expected ${USAGE}` };
  }
  return { tokens: n };
}

/** p90 of a list, the point where the tail begins. */
function p90(xs) {
  return xs[Math.ceil(xs.length * 0.9) - 1];
}

/**
 * What the window SHOULD be, from what this member's contexts have actually
 * measured. Returns null when the data cannot answer, and the caller keeps the
 * current value rather than inventing one.
 *
 * p90, not the median: a threshold in the middle of the distribution fires on
 * half of all turns, which makes it the default path rather than an exception,
 * and every firing buys a full handover turn. Measured on 111 real turns, a
 * 45k window sat just above the median and tripped on 38.7% of them; 80k trips
 * 7.5%. (A published sweep, arXiv 2606.11213, put the frontier at 80k-120k on
 * a different workload — same answer.)
 *
 * The trap this has to avoid is CENSORING. Compaction truncates the very tail
 * we are trying to measure: at a window of T, contexts above T barely exist,
 * so a p90 that hugs T is an artefact of the current setting, not evidence
 * about it. Re-running `auto` on censored data would ratchet the window down a
 * little every time until the court did nothing but write handovers.
 */
export function autoWindow(contexts, current = 0, minSamples = 20) {
  const xs = contexts
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (xs.length < minSamples) return null;      // p90 of eight numbers is one number

  const at = p90(xs);
  if (current && at > current * 0.9) return null; // censored: no honest answer

  // A window is a judgement call, not a measurement — round it so it reads
  // like one and does not churn by 300 tokens on every re-derivation.
  const want = Math.round(at / 5_000) * 5_000;
  return Math.min(MAX, Math.max(MIN, want));
}

// Basename, not endsWith: `test/t-compact.js` also ends with "compact.js", and
// an importer that runs a self-check on import is a test that passes for the
// wrong file.
if (process.argv[1] && /(^|[\\/])compact\.js$/.test(process.argv[1])) {
  const { strict: a } = await import('node:assert');

  a.deepEqual(parseWindow('auto'), { auto: true });
  a.deepEqual(parseWindow('  AUTO  '), { auto: true });
  a.deepEqual(parseWindow('300k'), { tokens: 300_000 });
  a.deepEqual(parseWindow('300K tokens'), { tokens: 300_000 });
  a.deepEqual(parseWindow('300000'), { tokens: 300_000 });
  a.deepEqual(parseWindow('300'), { tokens: 300_000 }, 'a bare number under 1000 is thousands');
  a.deepEqual(parseWindow('80'), { tokens: 80_000 });
  a.deepEqual(parseWindow('0.5m'), { tokens: 500_000 });
  // The exact five failures the sovereign hit: the usage line is bracketed and
  // gets pasted back with the brackets still on it.
  a.deepEqual(parseWindow('[300k]'), { tokens: 300_000 }, 'a pasted usage placeholder must work');
  a.deepEqual(parseWindow('[auto]'), { auto: true });

  a.ok(parseWindow('').error, 'no argument is a help message, not a crash');
  a.ok(parseWindow('soon').error);
  a.ok(parseWindow('9000').error, '9000 is out of range — never silently read as 9M');
  a.ok(parseWindow('2m').error, 'a window nothing could reach is a disabled one');
  a.ok(parseWindow('1k').error);
  a.match(parseWindow('soon').error, /auto/, 'the error must name the forms that do work');

  /* ---------- auto ---------- */
  const spread = Array.from({ length: 100 }, (_, i) => 20_000 + i * 500); // 20k..69.5k
  a.equal(autoWindow(spread), 65_000, 'auto lands at p90, rounded');
  a.equal(autoWindow(spread, 200_000), 65_000, 'a roomy current window does not block a tighter one');
  a.equal(autoWindow(spread, 70_000), null,
    'p90 hugging the current window is censorship by the window itself, not evidence');
  a.equal(autoWindow(spread.slice(0, 5)), null, 'p90 of five samples is one sample');
  a.equal(autoWindow([]), null);
  a.equal(autoWindow([0, -1, NaN, null].concat(spread)), 65_000, 'junk readings are dropped');

  // The ratchet this guard exists to stop: derive, apply, derive again.
  let w = 100_000;
  for (let i = 0; i < 10; i++) {
    const next = autoWindow(spread.map((x) => Math.min(x, w)), w);
    if (next === null) break;
    a.ok(next >= MIN);
    w = next;
  }
  a.ok(w >= 60_000, `re-deriving auto must converge, not spiral down (ended at ${w})`);

  console.log('compact.js self-check OK — window parsing and censoring-aware auto-derivation');
}
