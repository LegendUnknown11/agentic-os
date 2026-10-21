// The doctor's job is to tell the user the truth about their setup. A
// false BLOCKING failure is the worst outcome it can produce: it sends them to
// fix something that is not broken, and it trains them to disbelieve the next
// one — which will be real.
//
// This pins the one piece of the doctor that parses a third-party CLI's output,
// because that is the part that changes without warning. It did: agy started
// printing `id<TAB>Display Name` and the whole-line matcher rejected every
// model, so a signed-in CLI with 11 models was reported as "probably not
// signed in" and the doctor declared the team unusable.
//
//   node test/t-doctor.js
import { strict as a } from 'node:assert';
import { parseModels } from '../src/cli-parse.js';

// The format that broke it: real output, captured verbatim.
const tabbed = `Fetching available models...
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;

const models = parseModels(tabbed);
a.equal(models.length, 5, `id<TAB>name lines must parse, got ${models.length}: ${models}`);
a.ok(models.includes('gemini-3.6-flash-high'), 'the id must be the first field');
a.ok(!models.some((m) => /\s/.test(m)), 'no display name may leak into an id');
a.ok(!models.includes('Fetching'), 'the progress line must not be counted as a model');

// The older bare-id format must keep working — the fix tolerates both rather
// than swapping one brittle assumption for another.
a.deepEqual(parseModels('gemini-3.6-flash-high\ngemini-3.1-pro-high'),
  ['gemini-3.6-flash-high', 'gemini-3.1-pro-high'], 'bare ids must still parse');

// Columns aligned with spaces instead of tabs are the obvious next variant.
a.deepEqual(parseModels('gemini-3.1-pro-high   Gemini 3.1 Pro (High)'),
  ['gemini-3.1-pro-high'], 'space-aligned columns must parse too');

// And the case the check exists for: genuinely signed out must still fail.
// Without this the fix could "work" by accepting anything.
a.deepEqual(parseModels(''), [], 'empty output means no models');
a.deepEqual(parseModels('Error: not authenticated. Please run agy to sign in.'), [],
  'an error message must not be mistaken for a model list');
a.deepEqual(parseModels('Fetching available models...'), [],
  'a progress line alone must not look like success');

console.log('t-doctor.js OK — model parsing survives both output formats and still detects sign-out');
