// The OpenCode CLI (`opencode`) as a fourth team member backend.
//
// Protocol verified:
//   1. `opencode run "<prompt>" --format json --auto`
//   2. event stream: session, text, tool_use, step_finish / result
//   3. session resumption via `--session <id>`
//   4. MCP configured via `.opencode.json` in the member worktree
//
//   node test/t-opencode.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRepo } from './cleanup.js';

const dir = mkdtempSync(join(tmpdir(), 'agenticos-opencode-'));
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
process.env.AGENTICOS_OPENCODE_BIN = STUB;

const { AgentProcess } = await import('../src/agent.js');
const turn = (ag) => new Promise((res) => ag.once('turn_end', res));

/* ---------- 1. a first turn, and the shape of what it emits ---------- */
{
  const ag = new AgentProcess({
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
  a.deepEqual(argv.slice(argv.indexOf('--variant'), argv.indexOf('--variant') + 2),
    ['--variant', 'high'], 'opencode\'s reasoning-effort flag is --variant, not --effort — confirmed against the real CLI\'s own --help');
  a.deepEqual(argv.slice(argv.indexOf('--title'), argv.indexOf('--title') + 2),
    ['--title', 'coder'], 'a title skips opencode\'s own separate title-generating LLM call on every turn');
  console.log('  first turn: session captured, text and tool parsed, usage reported');
}

/* ---------- 2. a resumed turn ---------- */
{
  const ag = new AgentProcess({ name: 'coder', cli: 'opencode', model: 'anthropic/claude-3-7-sonnet' },
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

/* ---------- 3. effort is forwarded, not locally re-validated ---------- */
{
  // opencode publishes a different reasoning-effort ladder per model (e.g.
  // openrouter/stealth/ox-alpha's is low/high/max, no "medium") — the same
  // shape as codex's per-model ladder (agenticos.js's effortsFor()). A local
  // low/medium/high allowlist here would silently drop a model's own "max",
  // so — matching claude/codex — whatever agenticos.js already decided to hand
  // this member is forwarded as-is, trusting that single source of truth.
  const ag = new AgentProcess({ name: 'coder', cli: 'opencode', effort: 'max' }, { cwd: dir });
  ag.start();
  const done = turn(ag);
  ag.send('go');
  await done;
  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.deepEqual(argv.slice(argv.indexOf('--variant'), argv.indexOf('--variant') + 2),
    ['--variant', 'max'], 'an effort agenticos.js already approved for this model must reach opencode, not get re-filtered');
  console.log('  effort reaches opencode via --variant, unfiltered — agenticos.js is the one place that validates it');
}

/* ---------- 4. silence is reported ---------- */
{
  const dead = join(dir, 'dead-opencode.js');
  writeFileSync(dead, "process.stderr.write('fatal opencode crash\\n'); process.exit(2);");
  process.env.AGENTICOS_OPENCODE_BIN = dead;
  const { AgentProcess: A2 } = await import('../src/agent.js?dead-oc');

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
  process.env.AGENTICOS_OPENCODE_BIN = STUB;
  const { AgentProcess: A3 } = await import('../src/agent.js?long-oc');
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

/* ---------- 6. orchestrator and briefer do not clobber each other's identity --- */
{
  // opencode has no --tools flag and no per-process --mcp-config: it reads a
  // FIXED `.opencode.json` from its cwd. Orchestrator and briefer are officers
  // and historically share the repo root as their cwd (see agenticos.js's
  // #doSpawn) — so without per-officer isolation, whichever spawns second
  // overwrites the first's identity file, and the first quietly runs every
  // future turn AS the second (wrong role, wrong toolset, wrong sender on
  // every bus post). Reproduced live before this fix: an orchestrator lost
  // its add_agent tool this way and built six projects itself, single-threaded,
  // in the base repo with no worktree, no review, no merge gate.
  process.env.AGENTICOS_OPENCODE_BIN = STUB;
  const repo = mkdtempSync(join(tmpdir(), 'agenticos-oc-officers-'));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@agenticos');
  git('config', 'user.name', 'agenticos');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const cfg = join(repo, 'agenticos.config.json');
  writeFileSync(cfg, JSON.stringify({
    orchestrator: { name: 'orchestrator', cli: 'opencode' },
    briefer: { name: 'briefer', cli: 'opencode' },
    agents: [],
    rolesSeeded: true,
    advisor: { promptEngineer: false, autoModel: false },
    summarizer: { enabled: false },
  }));

  const { AgenticOS } = await import('../src/agenticos.js?opencode-officers');
  const { stateDir } = await import('../src/worktree.js?opencode-officers');
  const k = new AgenticOS(repo, cfg);
  k.on('error', () => {});
  await k.start();
  await new Promise((r) => setTimeout(r, 400));

  const orchFile = join(stateDir(repo), 'officers', 'orchestrator', '.opencode.json');
  const briefFile = join(stateDir(repo), 'officers', 'briefer', '.opencode.json');
  a.ok(existsSync(orchFile), 'orchestrator gets its own .opencode.json, not the shared repo root');
  a.ok(existsSync(briefFile), 'briefer gets its own .opencode.json, not the shared repo root');

  const orchId = JSON.parse(readFileSync(orchFile, 'utf8'));
  const briefId = JSON.parse(readFileSync(briefFile, 'utf8'));
  a.equal(orchId.mcp.agenticos.environment.AGENTICOS_AGENT, 'orchestrator',
    'the orchestrator\'s own file must still name the orchestrator after the briefer spawns');
  a.equal(briefId.mcp.agenticos.environment.AGENTICOS_AGENT, 'briefer');

  await k.stop();
  removeRepo(repo);
  console.log('  orchestrator and briefer keep separate .opencode.json identities, no clobbering');
}

/* ---------- 7. model steps complete one process turn; flush JSON tail ----- */
{
  const multi = join(dir, 'multi-opencode.js');
  writeFileSync(multi, `
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'text', sessionID: 'multi', part: { type: 'text', text: 'working' } });
say({ type: 'step_finish', part: { tokens: { input: 3, output: 2 }, cost: 0.01 } });
process.stdout.write(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 4, output: 1 }, cost: 0.02 } }));
`);
  process.env.AGENTICOS_OPENCODE_BIN = multi;
  const { AgentProcess: Multi } = await import('../src/agent.js?multi-oc');
  const ag = new Multi({ name: 'coder', cli: 'opencode' }, { cwd: dir });
  const ends = [];
  ag.on('turn_end', (event) => ends.push(event));
  ag.start();
  const done = turn(ag);
  ag.send('go');
  await done;
  a.equal(ends.length, 1, 'intermediate model steps must not end the agent turn');
  a.equal(ends[0].usage.input_tokens, 7);
  a.equal(ends[0].costUsd, 0.03);
  a.equal(ag.busy, false);
  console.log('  multiple steps yield one turn with aggregate usage and a flushed JSON tail');
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {}

console.log('t-opencode.js OK — opencode CLI backend fully verified');
