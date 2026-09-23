// #41/#40/#43: "the orchestrator is draining my usage like crazy" / "the
// orchestrator is talking to itself. I didn't give it a command yet." / "I
// thought it was only one prompt, but it kept going."
//
// ripeness.js (self-checking, see its own file) already closes the sharpest
// form of this: a lone notice can never be a member's first turn, and never
// wakes a sleeper. This suite covers the rest of the audit the issue asks
// for — every OTHER path that can hand the orchestrator (or any member) a
// turn it did not ask for — as static, source-level guards, since the actual
// defect class here is a missing 'notice' tag, not a runtime state a live
// court reaches.
//
//   node test/t-turn-guardrails.js
import { strict as a } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const kingdomSource = readFileSync(join(ROOT, 'src', 'kingdom.js'), 'utf8');
const workflowsSource = readFileSync(join(ROOT, 'src', 'workflows.js'), 'utf8');

/* ---- every AWARENESS-styled post must actually be a notice ------------- */
// A message that says "AWARENESS ONLY — TAKE NO ACTION" is, by its own text,
// FYI: it must ride ripeness.js's notice gate (never a member's first turn,
// never wakes a sleeper, never interrupts a turn in flight) rather than
// firing as ordinary real traffic on the settle window or the backstop —
// which is exactly what a bus.post() with no kind argument does (default
// kind is 'message', not 'notice' — src/bus.js). This is a real class of bug,
// not a hypothetical: #enforceBudget's per-member spend-ceiling message
// said "AWARENESS ONLY" in spirit (do not wait on it, the sovereign must
// act) but was posted as ordinary traffic, so a member's OWN spend crossing
// a threshold — nothing the sovereign said, nothing the orchestrator did —
// could buy the orchestrator a full unprompted turn on its own.
{
  // One `bus.post(CROWN, ...)` statement per match, oldest-argument-first;
  // walk forward from each occurrence of "AWARENESS" to the statement's
  // closing `);` (at most a handful of lines away in this file) and check
  // the whole call carries 'notice'.
  const lines = kingdomSource.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('bus.post(CROWN')) continue;
    let stmt = '';
    let j = i;
    while (j < lines.length && j < i + 10) {
      stmt += lines[j] + '\n';
      if (lines[j].includes(');')) break;
      j++;
    }
    if (!/AWARENESS/.test(stmt)) continue;
    if (!/'notice'/.test(stmt)) offenders.push(`line ${i + 1}: ${stmt.trim().slice(0, 120)}`);
  }
  a.deepEqual(offenders, [],
    `every "AWARENESS" post to a member must pass 'notice' as its kind, or it is real traffic that can buy `
    + `an unprompted turn on the settle window or backstop alone:\n${offenders.join('\n')}`);
  console.log(`  every AWARENESS-styled post in kingdom.js (${lines.filter((l) => l.includes('bus.post(CROWN')).length} `
    + 'bus.post(CROWN, ...) call sites scanned) is tagged \'notice\'');
}

/* ---- the notice/hadRealTurn gate is still the one #deliver relies on --- */
// This is the actual mechanism closing #40 ("talking to itself. I didn't
// give it a command yet."); ripeness.js's own self-check drives its full
// state space. This just proves #deliver() has not quietly stopped wiring
// hadRealTurn through — a regression here would silently reopen #40 while
// ripeness.js itself kept passing (it only tests what it's handed).
{
  a.match(kingdomSource, /hadRealTurn:\s*this\.bus\.get\(`hadReal:\$\{name\}`\)\s*===\s*'1'/,
    '#deliver must still pass the durable hadRealTurn flag into ripeness() — this is what stops a notice-only '
    + 'inbox from manufacturing a member\'s first turn');
  a.match(kingdomSource, /if \(!allNotices\) this\.bus\.set\(`hadReal:\$\{name\}`, '1'\);/,
    'hadRealTurn must only ever be set true by an actual non-notice batch, never by a notice itself');
  console.log('  #deliver still wires ripeness.js\'s hadRealTurn gate — a lone notice cannot manufacture a first turn');
}

/* ---- scheduled workflows cannot loop unboundedly within one firing ----- */
// A workflow's own bus node can address any member with any kind (#52: the
// SENDER is always the workflow's own namespace so it cannot forge
// 'sovereign', but the sovereign who built the graph does choose the kind
// and target) — that is the sovereign's own automation, not an unprompted
// path, but only as long as one firing cannot loop forever and flood a
// member with turns the sovereign scheduled once, not indefinitely.
{
  a.match(workflowsSource, /MAX_STEPS/, 'the workflow interpreter must cap steps per run');
  a.match(workflowsSource, /guard > MAX_STEPS/,
    'the graph walker must actually enforce the step cap on every step, not just on foreach');
  console.log('  a scheduled workflow cannot loop unboundedly within one firing (MAX_STEPS)');
}

/* ---- the per-member spend ceiling regression this suite exists for ----- */
{
  a.match(kingdomSource,
    /reached its spend ceiling[\s\S]{0,300}'notice'\);/,
    '#enforceBudget\'s per-member cap message must be a notice — proven failing without the fix by reverting '
    + 'just the trailing \'notice\' argument');
  console.log('  #enforceBudget\'s per-member spend-ceiling message rides the notice gate, not real traffic');
}

console.log('t-turn-guardrails.js OK — every AWARENESS post is gated, the hadRealTurn wiring holds, '
  + 'workflows cannot loop unboundedly');
