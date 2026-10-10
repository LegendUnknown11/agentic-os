import { strict as a } from 'node:assert';
import { adapterFor, adapters, jsonStream } from '../src/cli-adapters.js';
import { detectCli } from '../src/cli-detection.js';
import { Agent, claudeEnv, resolveCli as resolveBinary } from '../src/agent.js';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const build = (cli, spec = {}, sessionId = null) => adapterFor(cli).buildArgs({
  spec: { name: 'coder', model: 'fixture-model', ...spec }, cwd: '/workspace', sessionId, prompt: 'hello',
});
for (const cli of ['codex', 'claude', 'agy', 'opencode', 'cursor']) {
  const args = build(cli, {}, 'existing');
  a.ok(args.includes('fixture-model'), `${cli} selects its model`);
  a.ok(args.includes('existing'), `${cli} resumes its session`);
}
a.deepEqual(build('codex', {}, 'existing').slice(0, 3), ['exec', 'resume', 'existing']);
a.ok(!build('codex', {}, 'existing').includes('-C'));
a.equal(build('codex').at(-1), '-');
a.ok(build('codex', { continue: true }).includes('--last'));
a.ok(build('claude', { continue: true }).includes('--continue'));
a.ok(build('claude', { permissionMode: 'plan' }).includes('plan'));
a.ok(!build('claude', { outputFormat: 'json' }).includes('--input-format'));
a.ok(!build('opencode', { skipPermissions: false }).includes('--auto'));
a.ok(build('agy', { effort: 'max', mode: 'plan', sandbox: true }).includes('--sandbox'));
a.ok(!build('agy', { effort: 'none', skipPermissions: false }).includes('--effort'));
a.ok(!build('agy', { skipPermissions: false }).includes('--dangerously-skip-permissions'));
a.deepEqual(build('cursor-agent', { mode: 'plan', sandbox: 'enabled' }), build('cursor', { mode: 'plan', sandbox: 'enabled' }));
a.ok(build('cursor', { continue: true }).includes('--continue'));
a.ok(!build('cursor', { skipPermissions: false }).includes('--force'));
a.throws(() => build('freebuff'), /interactive UI only/);
a.throws(() => adapterFor('unknown'), /Unsupported/);
const currentMcp = { extra: true, mcpServers: { existing: { command: 'fixture' } } };
const mergedMcp = adapterFor('cursor').mcpConfig({ command: 'member' }, currentMcp);
a.equal(mergedMcp.extra, true);
a.deepEqual(mergedMcp.mcpServers.existing, currentMcp.mcpServers.existing);
a.equal(mergedMcp.mcpServers.kingdom.command, 'member');
a.ok(!currentMcp.mcpServers.kingdom, 'merging must not mutate the source object');

function parse(cli, objects, spec = {}) {
  const agent = new Agent({ cli, ...spec });
  const events = [];
  for (const type of ['ready', 'text', 'tool', 'turn_end', 'error']) agent.on(type, (value) => events.push([type, value]));
  const state = new Map();
  for (const object of objects) adapterFor(cli).parseEvent.call(agent, object, state);
  return { agent, events };
}
let parsed = parse('codex', [
  { type: 'thread.started', thread_id: 'thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } },
  { type: 'turn.completed', usage: { input_tokens: 3 } },
]);
a.equal(parsed.agent.sessionId, 'thread');
a.equal(parsed.events.find(([t]) => t === 'text')[1], 'answer');
parsed = parse('claude', [
  { type: 'system', subtype: 'init', session_id: 'session' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a' } }] } },
  { type: 'result', usage: { input_tokens: 2 }, total_cost_usd: 0.01 },
]);
a.equal(parsed.agent.sessionId, 'session');
a.equal(parsed.events.find(([t]) => t === 'tool')[1].name, 'Read');
a.equal(parsed.events.find(([t]) => t === 'turn_end')[1].costUsd, 0.01);
parsed = parse('claude', [{ type: 'result', session_id: 'json-session', result: 'answer' }], { outputFormat: 'json' });
a.equal(parsed.agent.sessionId, 'json-session');
a.deepEqual(parsed.events.find(([t]) => t === 'text'), ['text', 'answer']);
parsed = parse('agy', [
  { event: 'init', conversation_id: 'conversation' },
  { event: 'step_update', step_update: { step_index: 0, text_delta: 'one ', step_type: 'agent_response' } },
  { event: 'step_update', step_update: { step_index: 0, text_delta: 'answer', step_type: 'agent_response', state: 'DONE' } },
  { event: 'result', result: { response: 'one answer', status: 'SUCCESS', usage: { input_tokens: 2 } } },
]);
a.deepEqual(parsed.events.filter(([t]) => t === 'text'), [['text', 'one answer']]);
a.equal(parsed.agent.sessionId, 'conversation');
parsed = parse('agy', [{ conversation_id: 'json-id', status: 'SUCCESS', response: 'JSON answer' }]);
a.equal(parsed.agent.sessionId, 'json-id');
a.deepEqual(parsed.events.find(([t]) => t === 'text'), ['text', 'JSON answer']);
parsed = parse('opencode', [
  { type: 'text', sessionID: 'oc', part: { type: 'text', text: 'answer' } },
  { type: 'tool_use', part: { tool: 'bash', state: { input: { command: 'pwd' } } } },
  { type: 'step_finish', part: { tokens: { input: 3, output: 2 }, cost: 0.01 } },
  { type: 'step_finish', part: { tokens: { input: 4, output: 1 }, cost: 0.02 } },
]);
a.equal(parsed.agent.sessionId, 'oc');
a.equal(parsed.events.find(([t]) => t === 'tool')[1].input.command, 'pwd');
a.equal(parsed.events.at(-1)[1].usage.input_tokens, 7);
a.equal(parsed.events.at(-1)[1].costUsd, 0.03);
parsed = parse('cursor', [
  { type: 'system', subtype: 'init', session_id: 'cursor-id' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
  { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'pwd' } } } },
  { type: 'result', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 3 } },
]);
a.equal(parsed.agent.sessionId, 'cursor-id');
a.equal(parsed.events.find(([t]) => t === 'tool')[1].name, 'shellToolCall');
a.equal(parsed.events.find(([t]) => t === 'turn_end')[1].usage.cache_read_input_tokens, 7);
parsed = parse('cursor', [{ type: 'result', session_id: 'json', result: 'answer' }], { outputFormat: 'json' });
a.deepEqual(parsed.events.find(([t]) => t === 'text'), ['text', 'answer']);
for (const cli of ['codex', 'claude', 'agy', 'opencode', 'cursor']) {
  const event = cli === 'agy' ? { event: 'result', result: { status: 'FAILED', error: 'fixture failure' } }
    : cli === 'claude' ? { type: 'result', is_error: true, result: 'fixture failure' }
      : { type: 'error', message: 'fixture failure' };
  a.ok(parse(cli, [event]).events.some(([t]) => t === 'error'), `${cli} reports errors`);
}

const decoded = [];
const stream = jsonStream((o) => decoded.push(o));
stream.write('banner\n{invalid}\n{"type":');
stream.write('"first"}\n{\n  "type": "pretty"\n}\n{"type":"tail"}');
stream.end();
a.deepEqual(decoded.map((o) => o.type), ['first', 'pretty', 'tail']);
const broken = jsonStream(() => { throw new Error('callback error'); });
a.throws(() => broken.write('{}\n'), /callback error/, 'parser must not hide callback failures');

const resolveCli = () => ({ command: 'fixture', prefixArgs: [] });
for (const [cli, output] of Object.entries({ codex: 'Logged in using ChatGPT', claude: '{"loggedIn":true}',
  agy: 'gemini-fixture\tFixture', opencode: '2 credentials', cursor: '{"isAuthenticated":true}' })) {
  const calls = [];
  const result = await detectCli(cli, { resolveCli, env: {}, run: async (_, args) => {
    calls.push(args); return { ok: true, output: args[0] === '--version' ? '1.0' : output };
  } });
  a.equal(result.authenticated, true, `${cli} status parsed`);
  a.deepEqual(calls, [['--version'], adapters[cli].authArgs]);
}
const result = await detectCli('claude', { resolveCli, env: { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-fixture' },
  run: async () => ({ ok: true, output: '1.0' }) });
a.equal(result.authenticated, null, 'presence of an env token does not prove validity');
a.doesNotMatch(JSON.stringify(result), /synthetic-fixture/);
a.equal((await detectCli('codex', { resolveCli: () => { throw Error('missing'); } })).installed, false);
a.equal((await detectCli('codex', { resolveCli, env: {}, run: async () => ({ ok: true, output: 'unknown' }) })).authenticated, null);
a.equal((await detectCli('freebuff', { resolveCli, run: async () => ({ ok: true, output: '1.0' }) })).authenticated, null);
a.equal(claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-fixture', CLAUDECODE: 'host' }).CLAUDECODE, undefined);

// Exercise the actual Agent lifecycle with in-process child streams: no CLI,
// auth, model calls, filesystem fixtures or platform process timing required.
const childProcess = createRequire(import.meta.url)('node:child_process');
const originalSpawn = childProcess.spawn;
const originalOverride = process.env.KINGDOM_OPENCODE_BIN;
const originalCursor = process.env.KINGDOM_CURSOR_BIN;
const originalClaude = process.env.KINGDOM_CLAUDE_BIN;
process.env.KINGDOM_OPENCODE_BIN = process.execPath;
process.env.KINGDOM_CURSOR_BIN = process.execPath;
process.env.KINGDOM_CLAUDE_BIN = process.execPath;
a.equal(resolveBinary('cursor-agent').command, process.execPath, 'alias honors the canonical Cursor override');
const spawned = [];
let protocol = [
  { type: 'text', sessionID: 'multi', part: { type: 'text', text: 'answer' } },
  { type: 'step_finish', part: { tokens: { input: 3, output: 2 }, cost: 0.01 } },
  { type: 'step_finish', part: { tokens: { input: 4, output: 1 }, cost: 0.02 } },
];
childProcess.spawn = (command, args, options) => {
  spawned.push({ args, options });
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null);
  const output = protocol.map((object) => JSON.stringify(object)).join('\n');
  setImmediate(() => {
    child.stdout.write(output.slice(0, 13));
    child.stdout.end(output.slice(13));
    child.emit('close', 0);
  });
  return child;
};
syncBuiltinESMExports();
try {
  const agent = new Agent({ name: 'coder', cli: 'opencode' }, { cwd: '/workspace' });
  const ends = [], failures = [];
  agent.on('turn_end', (event) => ends.push(event));
  agent.on('error', (error) => failures.push(error));
  agent.start();
  const done = new Promise((resolve) => agent.once('turn_end', resolve));
  agent.send('hello');
  await done;
  a.equal(ends.length, 1, 'two step_finish events must complete one process turn');
  a.equal(ends[0].usage.input_tokens, 7);
  a.equal(ends[0].costUsd, 0.03);
  a.equal(agent.sessionId, 'multi');
  a.equal(agent.busy, false);
  a.deepEqual(failures, []);
  a.equal(spawned[0].options.cwd, '/workspace');
  a.equal(spawned[0].options.windowsHide, true);

  protocol = [{ type: 'session', sessionID: 'incomplete' }];
  const incomplete = new Promise((resolve) => agent.once('turn_end', resolve));
  agent.send('next');
  await incomplete;
  a.equal(ends.length, 2, 'even an incomplete protocol must release and close its turn');
  a.match(failures[0], /no completed turn/);
  a.equal(agent.busy, false);

  for (const cli of ['cursor', 'claude']) {
    protocol = [
      { type: 'system', subtype: 'init', session_id: `${cli}-session` },
      { type: 'result', session_id: `${cli}-session`, result: 'JSON answer', usage: { input_tokens: 2 } },
    ];
    const member = new Agent({ name: 'fixture', cli, outputFormat: 'json', skipPermissions: false }, { cwd: '/workspace' });
    member.start();
    const texts = [], completed = [];
    member.on('text', (text) => texts.push(text));
    member.on('turn_end', (event) => completed.push(event));
    member.on('error', (error) => { throw Error(error); });
    const first = new Promise((resolve) => member.once('turn_end', resolve));
    member.send('one');
    member.send('two'); // queued while first process is busy
    await first;
    const second = new Promise((resolve) => member.once('turn_end', resolve));
    await second;
    a.equal(completed.length, 2);
    a.deepEqual(texts, ['JSON answer', 'JSON answer']);
    a.equal(member.sessionId, `${cli}-session`);
    a.equal(member.busy, false);
    const last = spawned.at(-1).args;
    a.ok(last.includes('--resume'));
    a.ok(last.includes(`${cli}-session`));
  }
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  if (originalOverride === undefined) delete process.env.KINGDOM_OPENCODE_BIN;
  else process.env.KINGDOM_OPENCODE_BIN = originalOverride;
  if (originalCursor === undefined) delete process.env.KINGDOM_CURSOR_BIN;
  else process.env.KINGDOM_CURSOR_BIN = originalCursor;
  if (originalClaude === undefined) delete process.env.KINGDOM_CLAUDE_BIN;
  else process.env.KINGDOM_CLAUDE_BIN = originalClaude;
}
console.log('t-cli-adapters.js OK — arguments, all protocols, JSON framing and private non-billing detection');
