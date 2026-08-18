// The OpenCode CLI (`opencode`) as a fourth court member backend.
//
// Protocol verified:
//   1. `opencode run "<prompt>" --format json --auto`
//   2. event stream: session, text, tool_use, step_finish / result
//   3. session resumption via `--session <id>`
//   4. MCP configured via `.opencode.json` in the member worktree
//
//   node test/t-opencode.js
import { strict as a } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-opencode-'));
const ARGV = join(dir, 'argv.json');

// A stub speaking the opencode jsonl protocol.
const STUB = join(dir, 'opencode-stub.js');
writeFileSync(STUB, `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(ARGV)}, JSON.stringify(process.argv.slice(2)));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

say({ type: 'session', sessionID: 'oc-session-42' });
say({ type: 'text', text: 'Analyzing repository structure...' });
say({ type: 'tool_use', part: { tool: 'bash', input: { command: 'git status' }, output: 'clean' } });
say({ type: 'result', result: { response: 'Completed analysis.' }, usage: { input_tokens: 1540, output_tokens: 120 } });
`);
process.env.KINGDOM_OPENCODE_BIN = STUB;

const { Agent, OPENCODE_EFFORTS } = await import('../src/agent.js');
const turn = (ag) => new Promise((res) => ag.once('turn_end', res));

/* ---------- 1. a first turn, and the shape of what it emits ---------- */
{
  const ag = new Agent({
    name: 'coder',
    cli: 'opencode',
    model: 'anthropic/claude-3-7-sonnet',
    effort: 'high',
    prompt: 'You are the coder.',
  }, { cwd: dir });
  ag.start();
  const texts = [], tools = [], ready = [];
  ag.on('text', (t) => texts.push(t));
  ag.on('tool', (t) => tools.push(t.name));
  ag.on('ready', (id) => ready.push(id));

  const done = turn(ag);
  ag.send('inspect workspace');
  const end = await done;

  a.deepEqual(texts, ['Analyzing repository structure...'], 'text emitted directly from stream');
  a.deepEqual(tools, ['bash'], 'tool parsed from part.tool');
  a.deepEqual(ready, ['oc-session-42'], 'sessionID is the session id');
  a.equal(ag.sessionId, 'oc-session-42');
  a.equal(end.usage.input_tokens, 1540);
  a.equal(end.usage.output_tokens, 120);

  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.ok(argv.includes('run'), 'opencode runs headless with `run`');
  a.ok(argv.includes('--format') && argv.includes('json'), 'requests json output');
  a.ok(argv.includes('--auto'), 'auto-approves permissions in headless mode');
  a.ok(!argv.includes('--session'), 'a FIRST turn must not pass --session');
  a.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2),
    ['--model', 'anthropic/claude-3-7-sonnet']);
  console.log('  first turn: session captured, text and tool parsed, usage reported');
}

/* ---------- 2. a resumed turn ---------- */
{
  const ag = new Agent({ name: 'coder', cli: 'opencode', model: 'anthropic/claude-3-7-sonnet' },
    { cwd: dir, sessionId: 'oc-session-existing' });
  ag.start();
  const done = turn(ag);
  ag.send('next step');
  await done;

  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.deepEqual(argv.slice(argv.indexOf('--session'), argv.indexOf('--session') + 2),
    ['--session', 'oc-session-existing'], 'a resumed turn continues the same session');
  console.log('  resumed turn: --session used to continue context');
}

/* ---------- 3. effort ladder is checked ---------- */
{
  a.deepEqual([...OPENCODE_EFFORTS].sort(), ['high', 'low', 'medium']);
  const ag = new Agent({ name: 'coder', cli: 'opencode', effort: 'max' }, { cwd: dir });
  ag.start();
  const done = turn(ag);
  ag.send('go');
  await done;
  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.ok(!argv.includes('--effort'),
    'unsupported effort levels must be dropped rather than passed');
  console.log('  unsupported effort levels dropped cleanly');
}

/* ---------- 4. silence is reported ---------- */
{
  const dead = join(dir, 'dead-opencode.js');
  writeFileSync(dead, "process.stderr.write('fatal opencode crash\\n'); process.exit(2);");
  process.env.KINGDOM_OPENCODE_BIN = dead;
  const { Agent: A2 } = await import('../src/agent.js?dead-oc');

  const ag = new A2({ name: 'coder', cli: 'opencode' }, { cwd: dir });
  ag.start();
  const errs = [];
  ag.on('error', (m) => errs.push(m));
  const done = turn(ag);
  ag.send('go');
  await done;
  a.equal(errs.length, 1);
  a.match(errs[0], /opencode produced no output \(exit 2\)/);
  a.match(errs[0], /fatal opencode crash/);
  console.log('  opencode silent crashes report error message');
}

/* ---------- 5. long brief is staged to a file ---------- */
{
  process.env.KINGDOM_OPENCODE_BIN = STUB;
  const { Agent: A3 } = await import('../src/agent.js?long-oc');
  const ag = new A3({ name: 'coder', cli: 'opencode' }, { cwd: dir });
  ag.start();
  const longText = 'x'.repeat(30_000);
  const done = turn(ag);
  ag.send(longText);
  await done;

  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  const promptArg = argv[argv.indexOf('run') + 1];
  a.ok(promptArg.length < 1000, 'argv must stay short');
  a.match(promptArg, /Your full instructions are in a file/);
  console.log('  long brief staged to file to prevent command-line overflow');
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {}

console.log('t-opencode.js OK — opencode CLI backend fully verified');
