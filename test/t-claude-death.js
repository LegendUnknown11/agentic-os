// A claude member whose process dies mid-turn must not wedge, and must not eat
// the order it was carrying.
//
// This is the worst bug the review found, and it had no test. `proc.on('exit')`
// cleared `alive` and `proc` and emitted `exit`, and stopped there:
//
//   - `busy` stayed TRUE forever. Only the `result` event clears it, and a
//     process that died never sends one. The ripeness gate skips a busy member
//     until the backstop fires, at which point every later batch is handed to a
//     corpse and acked. The user's orders vanished with nothing logged.
//   - `spec.resume` kept its construction-time value, so the next #startClaude
//     passed `--session-id <an id the CLI has already created>` instead of
//     `--resume`. claude refuses that, so the member was permanently dead while
//     #publishRoster still reported it awake.
//   - No `error` was emitted, so #rewindForRetry — the mechanism that exists
//     precisely to put a dead turn's batch back — could never fire.
//
// A stub records its argv and then exits without answering, which is exactly
// what a claude that dies mid-turn looks like from the outside.
//
//   node test/t-claude-death.js
import { strict as a } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenticos-claudedeath-'));
const argvPath = (n) => join(dir, `argv${n}.json`);

// Turn 1 announces its session (so sessionId is the CLI's, as in real life) and
// then dies without a `result`. Turn 2 records argv and stays alive.
const stub = join(dir, 'claude-stub.js');
writeFileSync(stub, `
const { writeFileSync, existsSync } = require('node:fs');
const n = existsSync(${JSON.stringify(argvPath(1))}) ? 2 : 1;
writeFileSync(n === 1 ? ${JSON.stringify(argvPath(1))} : ${JSON.stringify(argvPath(2))},
  JSON.stringify(process.argv.slice(2)));
if (n === 1) {
  process.stdout.write(JSON.stringify(
    { type: 'system', subtype: 'init', session_id: 'sess-from-the-cli' }) + '\\n');
  // Die mid-turn: no 'result', no text, nothing. The real failure.
  setTimeout(() => process.exit(9), 120);
} else {
  setInterval(() => {}, 1000);   // alive, waiting for input
}
`);
process.env.AGENTICOS_CLAUDE_BIN = stub;

const { AgentProcess } = await import('../src/agent.js');

const agent = new AgentProcess({ name: 'coder', cli: 'claude', model: 'haiku' }, { cwd: dir });
const errors = [];
const turnEnds = [];
agent.on('error', (e) => errors.push(String(e)));
agent.on('turn_end', (u) => turnEnds.push(u));

const exited = new Promise((res) => agent.once('exit', res));
agent.start();
agent.send('do the important thing');
a.equal(agent.busy, true, 'the turn is in flight');

const code = await exited;
await new Promise((r) => setImmediate(r));   // let the exit handler's emits land

/* ---------- the member must not be wedged ---------- */
a.equal(code, 9, 'the stub died as intended');
a.equal(agent.busy, false,
  'busy must be cleared: left true, the backstop feeds every later batch to a corpse and acks it');
a.equal(agent.alive, false);

/* ---------- the failure must be AUDIBLE ---------- */
a.equal(errors.length, 1, 'exactly one error for one death');
a.match(errors[0], /no output/i,
  'the message must match #rewindForRetry\'s regex, or the batch is never redelivered — '
  + 'that redelivery is the whole reason this error exists');
a.match(errors[0], /9/, 'and it must name the exit code, which is the only clue to why');

a.equal(turnEnds.length, 1,
  'a turn_end must close the turn too — the roster and the spend readout both wait on it');
a.equal(turnEnds[0].costUsd, 0, 'a turn that produced nothing cost nothing to report');

/* ---------- the restart must RESUME, not re-create ---------- */
const first = JSON.parse(readFileSync(argvPath(1), 'utf8'));
a.ok(first.includes('--session-id'), 'the first start creates the session');
a.ok(!first.includes('--resume'));

agent.send('try again');
// Waited on the condition, not on a clock: a fixed sleep here was long enough
// alone and not long enough with three other suites spawning processes beside it.
// existsSync alone is not that condition: writeFileSync in the stub is open,
// write, close as three separate syscalls, so existsSync can see the file the
// moment open() lands, before its bytes are on disk. Under normal load the gap
// is too narrow to hit; a 2026-09-22 CI run at reduced (2-wide) concurrency hit
// it — same commit passed at 4-wide seconds earlier. Poll the actual thing this
// test needs, a file that parses, not the proxy for it.
let second;
for (let i = 0; i < 200 && !second; i++) {
  if (existsSync(argvPath(2))) {
    try { second = JSON.parse(readFileSync(argvPath(2), 'utf8')); } catch { /* still being written */ }
  }
  if (!second) await new Promise((r) => setTimeout(r, 50));
}
a.ok(second, 'the member must be restartable at all, with argv2.json fully written');
a.ok(second.includes('--resume'),
  'the restart must --resume: the CLI already created this session, and --session-id with an '
  + 'existing id is refused, which left the member dead while the roster called it awake');
a.ok(!second.includes('--session-id'), 'and must not try to create it a second time');
a.equal(second[second.indexOf('--resume') + 1], 'sess-from-the-cli',
  'resuming the id the CLI reported, not the one we invented before it spoke');

agent.stop();
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-claude-death.js OK — a dead turn clears busy, reports itself, and resumes its session');
