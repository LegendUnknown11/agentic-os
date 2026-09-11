// The summariser condenses each turn into one line, so the sovereign reads a
// sentence instead of a wall of tool calls.
//
// Two things must hold. It must never cost more than it saves — so the raw
// turn is collapsed before it is sent, not shipped whole. And it must never
// break anything — a failed summary is a cosmetic loss, and the court must not
// notice it happened.
//
//   node test/t-summarize.js
import { strict as a } from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-sum-'));
const STUB = join(dir, 'stub.js');
process.env.KINGDOM_CODEX_BIN = STUB;
const stub = (body) => writeFileSync(STUB, body);
const says = (reply) => stub(`
process.stdout.write(JSON.stringify({ type: 'item.completed',
  item: { type: 'agent_message', text: ${JSON.stringify(reply)} } }) + '\\n');
`);

const { transcriptOf, clean, fastSummary, summarize, settingsOf, DEFAULTS, EFFORTS } = await import('../src/summarize.js');

/* ---------- 1. the turn is collapsed before it is sent ---------- */
{
  const t = transcriptOf([
    { kind: 'tool', payload: { name: 'Read' } },
    { kind: 'tool', payload: { name: 'Read' } },
    { kind: 'tool', payload: { name: 'Read' } },
    { kind: 'text', payload: { text: 'Found the race in session.dart' } },
    { kind: 'tool', payload: { name: 'Edit' } },
    { kind: 'tool', payload: { name: 'Edit' } },
  ]);
  // Fifteen consecutive Reads are ONE fact. Sending them individually would
  // make the summary cost a real fraction of the turn it is summarising.
  a.equal(t, '[Read x3]\nFound the race in session.dart\n[Edit x2]');

  const long = transcriptOf([{ kind: 'text', payload: { text: 'x'.repeat(40_000) } }]);
  a.ok(long.length < 15_000, 'a runaway turn must be capped');
  a.ok(long.startsWith('…'), 'and must say it was cut');
  a.ok(long.endsWith('x'), 'keeping the TAIL — what the turn ended up doing');
  console.log('  tool runs collapsed, long turns capped from the front');
}

/* ---------- 2. whatever shape the model answers in ---------- */
{
  a.equal(clean('Fixed the race.', 16), 'Fixed the race.');
  a.equal(clean('Summary: Fixed the race.', 16), 'Fixed the race.');
  a.equal(clean('- Fixed the race.', 16), 'Fixed the race.');
  a.equal(clean('"Fixed the race."', 16), 'Fixed the race.');
  // The one that was wrong: a quoted answer followed by commentary used to
  // keep a dangling quote in the middle of the line.
  a.equal(clean('"Fixed the race." It was in session.dart.', 16), 'Fixed the race.');
  a.equal(clean('Fixed the race.\nThen I also checked the tests.', 16), 'Fixed the race.',
    'only the first line survives');
  a.equal(clean(`${'word '.repeat(40)}`, 10), `${'word '.repeat(10).trim()}…`,
    'a hard word cap the model cannot talk past');
  a.equal(clean('   ', 16), null);
  console.log('  prefixes, bullets, quotes, extra lines and runaway length all stripped');
}

/* ---------- 3. a real call, and what it is asked ---------- */
{
  says('Fixed the token-refresh race in session.dart with a mutex.');
  const line = await summarize({ ...DEFAULTS }, {
    name: 'coder', role: 'peasant',
    events: [
      { kind: 'tool', payload: { name: 'Read' } },
      { kind: 'text', payload: { text: 'The refresh races with logout; adding a mutex to session.dart.' } },
    ],
  }, { cwd: dir });
  a.equal(line, 'Fixed the token-refresh race in session.dart with a mutex.');
  console.log(`  summarised: "${line}"`);
}

/* ---------- 3a. a good final action is free ------------------------------ */
{
  const marker = join(dir, 'fast-path-called');
  stub(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
  const events = [{ kind: 'text', payload: { text: 'Fixed the refresh race in session.dart.' } }];
  a.equal(fastSummary(events, DEFAULTS.maxWords), 'Fixed the refresh race in session.dart.');
  a.equal(await summarize({ ...DEFAULTS }, { name: 'coder', role: 'peasant', events }),
    'Fixed the refresh race in session.dart.');
  a.equal(existsSync(marker), false, 'an already-good action sentence must not spawn a model');
  console.log('  final action sentence takes the free summary path');
}

/* ---------- 3b. a turn that only ANSWERS is not an empty turn ---------- */
{
  // Found on a real run: the scribe gave a perfectly good answer and the
  // summary read "Accomplished nothing." The prompt asked only what the member
  // DID, so a turn that produced prose instead of edits looked idle. The
  // prompt must name both kinds of turn.
  const { summarize: s2 } = await import(`../src/summarize.js?p=${Math.random()}`);
  says('Described the Kingdom project as a coordinated agentic software court.');
  const line = await s2({ ...DEFAULTS }, {
    name: 'scribe', role: 'peasant',
    events: [{ kind: 'text', payload: { text: 'The Kingdom project is a coordinated agentic software court.' } }],
  }, { cwd: dir });
  a.ok(line && !/nothing|no work|idle/i.test(line),
    `an answer-only turn must not be reported as empty, got: ${line}`);

  const prompt = (await import('node:fs')).readFileSync(new URL('../src/summarize.js', import.meta.url), 'utf8');
  a.match(prompt, /only answered or explained/, 'the prompt must name the answer-only case');
  a.match(prompt, /Producing\s*\n?an answer is not nothing/,
    'and must say explicitly that answering counts');
  console.log('  answer-only turns are summarised by their substance, not called empty');
}

/* ---------- 4. it must never break the court ---------- */
{
  // Disabled: no call at all.
  stub('process.exit(1);');
  a.equal(await summarize({ ...DEFAULTS, enabled: false },
    { name: 'coder', role: 'peasant', events: [{ kind: 'text', payload: { text: 'a'.repeat(50) } }] },
    { cwd: dir }), null);

  // A crash returns null rather than throwing into the turn cycle.
  a.equal(await summarize({ ...DEFAULTS },
    { name: 'coder', role: 'peasant', events: [{ kind: 'text', payload: { text: 'a'.repeat(50) } }] },
    { cwd: dir }), null, 'a dead summariser is silent, not fatal');

  // A turn of nothing but tool calls has no sentence in it; do not pay for one.
  says('SHOULD NOT BE CALLED');
  a.equal(await summarize({ ...DEFAULTS },
    { name: 'coder', role: 'peasant', events: [{ kind: 'tool', payload: { name: 'Read' } }] },
    { cwd: dir }), null, 'tools with no prose must not trigger a call');
  a.equal(await summarize({ ...DEFAULTS }, { name: 'coder', role: 'peasant', events: [] },
    { cwd: dir }), null);
  console.log('  disabled, crashed, and empty turns all cost nothing and raise nothing');
}

/* ---------- 5. the model's effort ladder ---------- */
{
  // Measured against the live API: gpt-5.4-mini rejects "max" outright
  //   "Unsupported value: 'max' is not supported with the gpt-5.4-mini model.
  //    Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."
  // The rest of the court runs at max, so defaulting to it here would have made
  // every summary fail with an invalid_request_error.
  a.ok(!EFFORTS.includes('max'), 'mini has no "max"');
  a.ok(EFFORTS.includes('none'), 'but it does have "none", which is what summarising wants');
  a.equal(DEFAULTS.effort, 'none');
  a.equal(DEFAULTS.model, 'gpt-5.4-mini');
  console.log(`  effort ladder pinned: ${EFFORTS.join(', ')}`);

  // Asserting DEFAULTS is not asserting what the summariser RUNS AT. The live
  // config carried `effort: ""` and `style: ""`; a plain spread let both
  // through, advisor.js drops a falsy effort flag, and codex then ran the
  // summariser at its own default — medium reasoning, billed as output, on a
  // one-line cosmetic summary. Assert the RESOLVED value.
  a.equal(settingsOf({ summarizer: { effort: '' } }).effort, 'none',
    'a cleared key means the default, not empty — an empty effort silently ran at medium');
  a.equal(settingsOf({ summarizer: { style: '' } }).style, DEFAULTS.style,
    'an empty style rendered a blank line where the instruction belongs');
  a.equal(settingsOf({ summarizer: { maxWords: undefined } }).maxWords, DEFAULTS.maxWords);
  a.equal(settingsOf({ summarizer: { effort: 'high' } }).effort, 'high',
    'but a real override still overrides');
  a.equal(settingsOf({ summarizer: { enabled: false } }).enabled, false,
    'and false is a VALUE, not an absence — the sovereign turning it off must stick');
}

try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-summarize.js OK — turns collapse, answers clean up, failure is silent');
