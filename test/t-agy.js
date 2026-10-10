// The Antigravity CLI (`agy`) as a third court member backend.
//
// Its protocol differs from codex in three ways that each break something if
// mishandled, so all three are pinned here:
//   1. text arrives as `text_delta` FRAGMENTS, not whole messages
//   2. the session id is `conversation_id`, resumed with --conversation
//   3. MCP cannot be passed as a flag at all, and headless agy reads only the
//      GLOBAL config — so identity travels by working directory, not by env
//
//   node test/t-agy.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PROBE = join(HERE, 'fixtures', 'mcp-identity-probe.js');
const dir = mkdtempSync(join(tmpdir(), 'kingdom-agy-'));
const ARGV = join(dir, 'argv.json');

// A stub speaking the real protocol, captured from agy 1.1.10.
const STUB = join(dir, 'agy-stub.js');
writeFileSync(STUB, `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(ARGV)}, JSON.stringify(process.argv.slice(2)));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ event: 'init', conversation_id: 'conv-abc',
      init: { model: 'gemini-3.6-flash-low', tools: ['call_mcp_tool'], permission_mode: 'bypass' } });
say({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } });
// Text in fragments, exactly as the real CLI streams it.
say({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Fixed the ' } });
say({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'race in ' } });
say({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'session.dart' } });
say({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'run_command' } });
say({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'checkpoint' } });
say({ event: 'result', result: { conversation_id: 'conv-abc', status: 'SUCCESS',
      response: 'Fixed the race in session.dart', num_turns: 1,
      usage: { input_tokens: 18211, output_tokens: 4, total_tokens: 18215 } } });
`);
process.env.KINGDOM_AGY_BIN = STUB;

const { Agent, AGY_EFFORTS } = await import('../src/agent.js');
const turn = (ag) => new Promise((res) => ag.once('turn_end', res));

/* ---------- 1. a first turn, and the shape of what it emits ---------- */
{
  const ag = new Agent({ name: 'coder', cli: 'agy', model: 'gemini-3.6-flash-low', effort: 'high',
    prompt: 'You are the smith.' }, { cwd: dir });
  ag.start();
  const texts = [], tools = [], ready = [];
  ag.on('text', (t) => texts.push(t));
  ag.on('tool', (t) => tools.push(t.name));
  ag.on('ready', (id) => ready.push(id));

  const done = turn(ag);
  ag.send('fix the race');
  const end = await done;

  a.deepEqual(texts, ['Fixed the race in session.dart'],
    'the three text_delta fragments must arrive as ONE line, not three');
  a.deepEqual(tools, ['run_command'], 'a command step is a tool; checkpoint and user_input are not');
  a.deepEqual(ready, ['conv-abc'], 'conversation_id is the session id');
  a.equal(ag.sessionId, 'conv-abc');
  a.equal(end.usage.total_tokens, 18215);
  a.equal(end.costUsd, 0, 'agy bills against a plan, not per call');

  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.ok(argv.includes('--print') && argv.includes('--output-format') && argv.includes('stream-json'));
  a.ok(!argv.includes('--conversation'), 'a FIRST turn must not try to resume');
  a.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2),
    ['--model', 'gemini-3.6-flash-low']);
  a.ok(argv.includes('--dangerously-skip-permissions'),
    'without this every tool call is soft-denied in print mode and the member is mute');
  // The prompt is --print's VALUE, not a trailing positional. agy 1.1.11
  // changed this (--print used to be a boolean) and the old form made its Go
  // flag parser take the NEXT FLAG as the prompt: the orchestrator answered a chat
  // question about --output-format, emitted no JSONL, and was declared failed.
  const prompt = argv[argv.indexOf('--print') + 1];
  a.ok(prompt.includes('fix the race'), 'the prompt is the value of --print');
  a.ok(prompt.includes('You are the smith.'), 'persona rides the first turn');
  a.ok(!argv.some((x, i) => i > argv.indexOf('--print') + 1 && !x.startsWith('-')
    && !argv[i - 1].startsWith('-')), 'nothing may trail as a bare positional');
  console.log('  first turn: deltas joined, tools classified, conversation_id captured');
}

/* ---------- 2. a resumed turn ---------- */
{
  const ag = new Agent({ name: 'coder', cli: 'agy', model: 'gemini-3.6-flash-low' },
    { cwd: dir, sessionId: 'conv-existing' });
  ag.start();
  const done = turn(ag);
  ag.send('and now the tests');
  await done;

  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.deepEqual(argv.slice(argv.indexOf('--conversation'), argv.indexOf('--conversation') + 2),
    ['--conversation', 'conv-existing'], 'a resumed turn continues the same conversation');
  a.equal(argv[argv.indexOf('--print') + 1], 'and now the tests',
    'the persona is NOT repeated on a resumed turn — the conversation already has it');
  console.log('  resumed turn: --conversation, no repeated persona');
}

/* ---------- 3. installed agy publishes xhigh and max ---------- */
{
  a.deepEqual([...AGY_EFFORTS].sort(), ['high', 'low', 'max', 'medium', 'xhigh']);
  a.ok(!AGY_EFFORTS.has('none'));
  const ag = new Agent({ name: 'coder', cli: 'agy', effort: 'max' }, { cwd: dir });
  ag.start();
  const done = turn(ag);
  ag.send('go');
  await done;
  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'max']);
  console.log('  max reaches agy as advertised by the installed CLI');
}

/* ---------- 4. silence is reported ---------- */
{
  const dead = join(dir, 'dead.js');
  writeFileSync(dead, "process.stderr.write('boom\\n'); process.exit(3);");
  process.env.KINGDOM_AGY_BIN = dead;
  const { Agent: A2 } = await import('../src/agent.js?dead');

  const ag = new A2({ name: 'coder', cli: 'agy' }, { cwd: dir });
  ag.start();
  const errs = [];
  ag.on('error', (m) => errs.push(m));
  const done = turn(ag);
  ag.send('go');
  await done;
  a.equal(errs.length, 1);
  a.match(errs[0], /agy produced no output \(exit 3\)/);
  a.match(errs[0], /boom/, "and carries the CLI's own words");
  console.log('  a turn that says nothing is reported, not mistaken for thinking');
}

/* ---------- 5. MCP reaches an agy member only through the workspace file --- */
{
  const repo = mkdtempSync(join(tmpdir(), 'kingdom-agyrepo-'));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const vault = mkdtempSync(join(tmpdir(), 'kingdom-agyvault-'));
  const cfg = join(repo, 'kingdom.config.json');
  writeFileSync(cfg, JSON.stringify({
    vault,
    orchestrator: { name: 'orchestrator', cli: 'agy' },
    briefer: { name: 'briefer', cli: 'codex' },
    peasants: [],
    rolesSeeded: true,
    advisor: { promptEngineer: false, autoModel: false },
    summarizer: { enabled: false },
  }));

  process.env.KINGDOM_AGY_BIN = STUB;
  process.env.KINGDOM_CODEX_BIN = process.execPath;
  const { Kingdom } = await import('../src/kingdom.js?agy');
  const k = new Kingdom(repo, cfg);
  k.on('error', () => {});
  await k.start();
  await new Promise((r) => setTimeout(r, 400));

  // Headless agy IGNORES a workspace mcp_config.json and honours only the
  // global one, so identity cannot ride in the server's env — it rides in the
  // member's working directory instead.
  const idFile = join(repo, '.agents', 'kingdom-id.json');
  a.ok(existsSync(idFile), 'an agy member must get .agents/kingdom-id.json');
  const id = JSON.parse(readFileSync(idFile, 'utf8'));
  a.equal(id.agent, 'orchestrator', 'the file names the member, because the shared config cannot');
  a.equal(id.role, 'orchestrator');
  a.equal(id.vault, vault);

  // And the real mcp.js must resolve that identity with NOTHING in the env —
  // which is the whole point, since the shared global config supplies none.
  // Started with a bare cwd and asked who it is; a wrong answer here means
  // every Antigravity member posts to the bus as the same agent.
  const probe = execFileSync(process.execPath, [MCP_PROBE, repo], {
    encoding: 'utf8',
    cwd: repo,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  }).trim();
  a.equal(probe, 'orchestrator|orchestrator', 'identity must resolve from the working directory alone');

  // The global declaration is what headless agy actually reads, and it must
  // MERGE — this file belongs to the user's Antigravity install, not to us.
  a.ok(typeof k.constructor === 'function');

  await k.stop();
  for (const d of [repo, vault]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8 }); } catch {} }
  console.log('  identity travels by directory: mcp.js resolves "orchestrator" from cwd alone');
}

/* ---------- a brief too long for a command line goes to a FILE ---------- */
// agy has no stdin prompt and no --prompt-file, so a 53,214-char sovereign
// brief died in 0.2s with ENAMETOOLONG on a real run. It is an agentic CLI
// with file tools, so it gets the brief as a file instead.
{
  const { existsSync: ex, rmSync: rm } = await import('node:fs');
  // Clear the recorded argv FIRST. Without the fix the spawn throws
  // ENAMETOOLONG and never records anything, so a stale file from an earlier
  // sub-test would let every assertion below pass against the wrong turn.
  const argvFile = join(dir, 'argv.json');
  rm(argvFile, { force: true });

  const big = new Agent({ name: 'orchestrator', cli: 'agy', prompt: 'p' }, { cwd: dir });
  // EventEmitter throws an unhandled 'error' at the process, which would crash
  // this file with a stack trace instead of the assertion that explains why.
  const oops = [];
  big.on('error', (e) => oops.push(String(e)));
  big.start();
  const done = turn(big);
  big.send('B'.repeat(60_000));
  await done;

  a.ok(ex(argvFile),
    `agy must actually have been started — a 60k brief must not throw. Errors: ${oops.join('; ')}`);
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  const printed = argv[argv.indexOf('--print') + 1];
  a.ok(printed.length < 2000, `the command line must stay short, got ${printed.length} chars`);
  a.ok(argv.join(' ').length < 30_000, 'and the whole argv must fit under the Windows cap');
  a.ok(!printed.includes('BBBB'), 'the brief itself must NOT be on the command line');

  const path = printed.match(/(\S*kingdom-brief-\S*\.md)/)?.[1];
  a.ok(path, `the prompt must point at the staged file, got: ${printed.slice(0, 120)}`);
  a.ok(!path.startsWith(dir),
    'the brief must NOT be staged in the member cwd — a peasant cwd is a worktree '
    + 'and commitAll would sweep it into the sovereign repository');
  // turn_end comes from the `result` event on stdout, which arrives BEFORE the
  // process exits — and the cleanup hangs off exit. Wait for it rather than
  // racing, and rather than sleeping a guessed amount.
  for (let i = 0; i < 100 && ex(path); i++) await new Promise((r) => setTimeout(r, 20));
  a.equal(ex(path), false, 'the staged brief must be cleaned up when the turn exits');
  console.log(`  60k brief staged to a file; command line stayed ${printed.length} chars`);
}

// --- the MCP server outside a kingdom must not crash the client -------
// agy reads ONE GLOBAL mcp_config.json, so the kingdom server is spawned by
// EVERY agy session on the machine, including ones in directories with no
// court in them. Those have no KINGDOM_* env and no .agents/kingdom-id.json,
// and `new Bus(undefined)` threw ERR_INVALID_ARG_TYPE out of node:path before
// any handler ran — which the sovereign saw as a stack trace plus
// `connection closed: calling "initialize": client is closing: EOF`.
//
// Not being in a kingdom is a normal state, not an error, and it must never
// take down the client's whole MCP connection.
{
  const elsewhere = mkdtempSync(join(tmpdir(), 'not-a-kingdom-'));
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agy', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'send_message', arguments: { to: 'orchestrator', body: 'hi' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('KINGDOM_')) delete env[k];

  const r = spawnSync(process.execPath, [join(HERE, '..', 'src', 'mcp.js')], {
    input: rpc, encoding: 'utf8', cwd: elsewhere, env,
  });

  a.ok(!/ERR_INVALID_ARG_TYPE|validateString/.test(r.stderr ?? ''),
    `the server must not crash outside a kingdom:\n${(r.stderr ?? '').slice(0, 400)}`);
  a.equal(r.status, 0, `it must exit cleanly, got ${r.status}`);

  const replies = r.stdout.split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  a.ok(replies.find((m) => m.id === 1), 'initialize must be answered, not dropped');

  const list = replies.find((m) => m.id === 2);
  a.ok(list, 'tools/list must be answered');
  a.equal(list.result.tools.length, 0, 'and must offer no court tools where there is no court');

  // A client that calls a tool it was never offered must still get an answer.
  const call = replies.find((m) => m.id === 3);
  a.ok(call, 'a tool call must be answered rather than killing the transport');
  a.equal(call.result.isError, true, 'and must report the tool as unavailable');
  a.match(call.result.content[0].text, /no kingdom in this directory/i,
    'the reason must say what is actually wrong');

  try { rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }); } catch {}
}

/* ---------- the advisor on agy passes its prompt the same way ---------- */
// advisor.js built agy's argv in the pre-1.1.11 shape — `--print` bare and the
// prompt trailing — so agy read `--output-format` as the prompt and the
// advisor and summariser silently gave no answer.
{
  const { ask } = await import('../src/advisor.js');
  rmSync(ARGV, { force: true });
  await ask({ cli: 'agy', model: 'gemini-3.6-flash-low' }, 'rewrite this brief', { cwd: dir });
  const argv = JSON.parse(readFileSync(ARGV, 'utf8'));
  a.equal(argv[argv.indexOf('--print') + 1], 'rewrite this brief', 'the advisor prompt is the value of --print');
  a.ok(!argv.some((x, i) => i > argv.indexOf('--print') + 1 && !x.startsWith('-')
    && !argv[i - 1].startsWith('-')), 'nothing may trail as a bare positional');
  console.log('  the advisor hands agy its prompt as --print\'s value');
}

// Cleanup only — never wrap assertions in this, a swallowed assertion is
// worse than no test at all.
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-agy.js OK — antigravity speaks the court protocol, and degrades outside one');
