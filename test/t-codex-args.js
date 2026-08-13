// `codex exec resume` accepts a strict SUBSET of `codex exec`'s flags.
//
// This has now bitten twice. First -C/--cd, fixed in isolation. Then
// -s/--sandbox, which every resumed turn passed: codex died with
// `unexpected argument '--sandbox'` before printing anything, so the member
// flashed a console window and then simply never answered. Nothing in the
// kingdom said a word.
//
// So: assert the flag sets directly, and assert that a turn producing no
// output at all is reported rather than mistaken for thinking.
//
//   node test/t-codex-args.js
import { strict as a } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-codexargs-'));

/* ---------- 1. the flags the real CLI accepts ---------- */
// Found independently of resolveCli: this test stubs the CLI later, and
// resolveCli memoises, so asking it would hand back the stub.
function realCodex() {
  const { existsSync } = require('node:fs');
  const { homedir } = require('node:os');
  const cands = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) ?? null;
}
const CODEX = realCodex();

function flagsOf(...argv) {
  if (!CODEX) return null;
  const r = spawnSync(process.execPath, [CODEX, ...argv, '--help'], { encoding: 'utf8' });
  if (!r.stdout) return null;
  return new Set(r.stdout.match(/--[a-z][a-z-]+/g) ?? []);
}

/* ---------- 2. what the Agent actually builds for a resumed turn ---------- */
// A stub records argv instead of being codex, so this runs everywhere.
const stub = join(dir, 'codex-stub.js');
writeFileSync(stub, `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thr-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n');
`);
process.env.KINGDOM_CODEX_BIN = stub;
const { Agent } = await import('../src/agent.js');
const { readFileSync } = await import('node:fs');

const turn = (agent) => new Promise((res) => agent.once('turn_end', res));

// A RESUMED turn — the case that was broken.
const resumed = new Agent({ name: 'king', cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
  { cwd: dir, sessionId: 'thr-existing' });
resumed.start();
const done = turn(resumed);
resumed.send('resume');
await done;
const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'));

a.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'thr-existing'], 'resume must come first');
for (const banned of ['--sandbox', '-s', '-C', '--cd', '--profile', '-p', '--oss']) {
  a.ok(!argv.includes(banned), `a resumed turn must not pass ${banned} — codex rejects it`);
}
a.ok(argv.includes('--json'), 'we still need the JSON protocol');

// Measured against codex 0.145.0: ANY confining sandbox makes `codex exec`
// deny every MCP tool call ("user cancelled MCP tool call"), under every
// approval policy, with or without writable_roots. The MCP server starts and
// stays alive, so it is a denial and not a connection failure. A member with
// no send_message and no declare_done is not a court member, so the default
// must be the mode where the tools work.
const sandboxArg = argv.find((x) => x.startsWith('sandbox_mode='));
a.ok(sandboxArg, 'the sandbox mode must be passed explicitly, not left to config.toml');
a.equal(sandboxArg, 'sandbox_mode="danger-full-access"',
  'a confining default silently kills every kingdom tool');
console.log(`  sandbox: ${sandboxArg}`);
console.log('  resumed argv is clean:', argv.filter((x) => x.startsWith('-') || x.includes('=')).join(' '));

/* ---------- 2b. a long brief must not go on the command line ------------- */
// Windows caps a command line at 32,767 chars. The sovereign's briefs are
// routinely longer, and passing one as argv made spawn throw ENAMETOOLONG
// SYNCHRONOUSLY — so proc.on('exit') never ran, `busy` never cleared, and the
// king was wedged for the rest of the session with its order already acked.
// Observed for real: a 53k-char brief vanished without a word.
const big = new Agent({ name: 'king', cli: 'codex' }, { cwd: dir, sessionId: 'thr-big' });
big.start();
const bigDone = turn(big);
big.send('x'.repeat(100_000));
await bigDone;   // hangs forever if the prompt ever goes back onto argv

const bigArgv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'));
a.equal(bigArgv.at(-1), '-', 'the prompt must be read from stdin, not passed as an argument');
a.ok(bigArgv.join(' ').length < 2000, 'nothing prompt-sized may reach the command line');
console.log(`  100k-char brief sent over stdin; command line stayed ${bigArgv.join(' ').length} chars`);

/* ---------- 3. and the real CLI must agree that those flags are absent ---- */
const execFlags = flagsOf('exec');
const resumeFlags = flagsOf('exec', 'resume');
if (execFlags && resumeFlags) {
  a.ok(execFlags.has('--sandbox'), 'sanity: plain exec should have --sandbox');
  for (const f of ['--sandbox', '--cd', '--profile', '--oss']) {
    a.ok(!resumeFlags.has(f), `codex exec resume unexpectedly accepts ${f} now — revisit the split`);
  }
  a.ok(resumeFlags.has('--json') && resumeFlags.has('--config'),
    'resume must still accept --json and -c, which is how we pass everything else');
  console.log('  real codex agrees: resume rejects --sandbox/--cd/--profile/--oss');
} else {
  console.log('  (codex not installed — skipped the live flag check)');
}

/* ---------- 4. a turn that says nothing must not look like thinking ------ */
const silent = join(dir, 'silent-stub.js');
writeFileSync(silent, `
process.stderr.write("error: unexpected argument '--sandbox' found\\n");
process.exit(2);
`);
process.env.KINGDOM_CODEX_BIN = silent;
const { Agent: A2 } = await import('../src/agent.js?silent');   // fresh CLI cache

const mute = new A2({ name: 'king', cli: 'codex' }, { cwd: dir, sessionId: 'thr-x' });
mute.start();
const errors = [];
mute.on('error', (m) => errors.push(m));
const ended = turn(mute);
mute.send('resume');
await ended;

a.equal(errors.length, 1, 'a turn with no output must raise exactly one error');
a.match(errors[0], /no output \(exit 2\)/, 'the error must say the turn produced nothing');
a.match(errors[0], /unexpected argument/, "and must carry codex's own words");
console.log(`  silent failure reported: "${errors[0].trim().slice(0, 70)}…"`);

/* ---------- 5. a turn that hangs forever must be stopped ---------------- */
// The failure that hides best of all: the process is alive, the CPU is idle,
// and it is indistinguishable from thinking. codex accepts no timeout flag, so
// without this the member holds `busy` forever and never takes another message.
{
  const hang = join(dir, 'hang-stub.js');
  writeFileSync(hang, `
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thr-h' }) + '\\n');
setInterval(() => {}, 1000);   // never completes the turn, never exits
`);
  process.env.KINGDOM_CODEX_BIN = hang;
  process.env.KINGDOM_TURN_TIMEOUT_MS = '1500';
  const { Agent: A3 } = await import('../src/agent.js?hang');

  const stuck = new A3({ name: 'king', cli: 'codex' }, { cwd: dir, sessionId: 'thr-h' });
  stuck.start();
  const said = [];
  stuck.on('error', (m) => said.push(m));
  await new Promise((res) => { stuck.once('turn_end', res); stuck.send('go'); });

  a.equal(stuck.busy, false, 'a killed turn must release the member');
  a.match(said.join(' '), /turn exceeded/, 'and must say why, not just go quiet');
  console.log(`  hung turn stopped: "${said[0]}"`);
  delete process.env.KINGDOM_TURN_TIMEOUT_MS;
}

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
console.log('t-codex-args.js OK — resume gets only flags it accepts, and silence is reported');

/* ---------- a confined codex member must be reported, not silently mute ---- */
{
  const { MUTES_KINGDOM_TOOLS } = await import('../src/agent.js?silent');
  a.ok(MUTES_KINGDOM_TOOLS.has('workspace-write'), 'workspace-write mutes the tools');
  a.ok(MUTES_KINGDOM_TOOLS.has('read-only'), 'so does read-only');
  a.ok(!MUTES_KINGDOM_TOOLS.has('danger-full-access'), 'and full access does not');
  console.log('  confining sandboxes flagged as tool-muting');
}

/* ---------- a member the orchestrator KILLED did not fail ------------------ */
// stop() kills the process, but its `exit` lands a tick later and the turn
// handler reads "no output" — indistinguishable, from inside, from a crash.
// The error that followed had nobody left listening on a shutdown path, so
// Node promoted it to an unhandled 'error' event and took the process down.
// It failed the suite about half the time; it was only ever visible as flake.
//
// Asserted on emit directly rather than by racing a real process exit: the
// gate is one method that every exit handler passes through, and a test that
// has to sleep to observe a bug is a test that will one day sleep too little.
{
  const ghost = new Agent({ name: 'ghost', cli: 'codex' }, { cwd: dir, sessionId: 'thr-ghost' });
  const heard = [];
  ghost.on('error', (e) => heard.push(String(e)));
  ghost.on('turn_end', () => heard.push('turn_end'));

  ghost.emit('error', 'codex produced no output (exit 1)');
  a.equal(heard.length, 1, 'sanity: a live agent must report a failed turn');

  ghost.stop();
  ghost.emit('error', 'codex produced no output (exit 1)');
  ghost.emit('turn_end', { usage: null });
  a.equal(heard.length, 1,
    `a stopped agent must stay silent — a kill is not a failure. Heard: ${heard.join(' | ')}`);

  console.log('  a killed member goes quiet; a live one still speaks up');
}
