// Invalid summon requests must not become approval records.
//
//   node test/t-summon-validation.js
import { strict as a } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from '../src/bus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kingdom-summon-'));
const db = join(dir, 'bus.db');
const seed = new Bus(db);
seed.set('roster', JSON.stringify([
  { name: 'orchestrator', role: 'orchestrator' },
  { name: 'coder', role: 'peasant' },
  { name: 'tester', role: 'peasant' },
]));
seed.close();

const child = spawn(process.execPath, [join(HERE, '..', 'src', 'mcp.js')], {
  cwd: join(HERE, '..'),
  env: { ...process.env, KINGDOM_AGENT: 'orchestrator', KINGDOM_ROLE: 'orchestrator', KINGDOM_DB: db },
  stdio: ['pipe', 'pipe', 'ignore'],
});
let buffer = '';
const waiting = [];
const fail = (e) => { while (waiting.length) waiting.shift().reject(e); };
child.on('error', fail);
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    try { waiting.shift()?.resolve(JSON.parse(line)); } catch (e) { fail(e); }
  }
});
const request = (message) => new Promise((resolve, reject) => {
  waiting.push({ resolve, reject });
  child.stdin.write(JSON.stringify(message) + '\n');
});
const resultText = (response) => response.result?.content?.[0]?.text ?? '';

try {
  await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const call = (id, names) => request({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'summon', arguments: { names, reason: 'validation' } },
  });
  a.match(resultText(await call(2, [])), /non-empty array/);
  a.match(resultText(await call(3, [''])), /non-empty strings/);
  a.match(resultText(await call(4, ['ghost'])), /unknown roster name/);
  a.match(resultText(await call(5, ['coder', 'coder'])), /duplicate name/);
  a.match(resultText(await call(6, Array(33).fill('coder'))), /too many names/);
  a.match(resultText(await call(7, ['coder', 'tester'])), /Proposal sent/);

  // --- a message to nobody must not be reported as sent ------------------
  // send_message and send_back posted whatever name they were handed and
  // answered "Sent to X." either way. pending() matches on recipient, so a
  // name that is not on the roster produced a row nobody could ever be
  // delivered, while the sender was told it had arrived.
  const tool = (id, name, args) => request({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });

  const ghost = resultText(await tool(8, 'send_message', { to: 'ghost', body: 'hello?' }));
  a.match(ghost, /No member named "ghost"/, 'an unknown recipient must be refused');
  a.match(ghost, /nothing was sent/, 'and the refusal must say nothing was sent');

  // A near miss names the candidates rather than only saying no.
  a.match(resultText(await tool(9, 'send_message', { to: 'code', body: 'hi' })),
    /Did you mean: coder/, 'a near miss must suggest the real name');

  // send_back is the orchestrator's other addressed tool and had the same hole.
  a.match(resultText(await tool(10, 'send_back', { peasant: 'ghost', notes: 'redo it' })),
    /No member named "ghost"/, 'send_back must validate too');

  // A real name still goes through untouched.
  a.match(resultText(await tool(11, 'send_message', { to: 'coder', body: 'carry on' })),
    /Sent to coder\./);
} finally {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  const check = new Bus(db);
  const approvals = check.history({ limit: 20 }).filter((m) => m.kind === 'approval');
  a.equal(approvals.length, 1, 'only the valid summon may post an approval');
  a.deepEqual(JSON.parse(approvals[0].body).names, ['coder', 'tester']);
  // Exactly one message left the orchestrator: the one addressed to a real member.
  const sent = check.history({ limit: 50 }).filter((m) => m.sender === 'orchestrator' && m.kind !== 'approval');
  a.deepEqual(sent.map((m) => m.recipient), ['coder'],
    'refused messages must not be on the bus at all');
  check.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- the orchestrator is whoever the roster says, not the string "orchestrator" ---------
// declare_done and brief_orchestrator posted to the literal name "orchestrator". The orchestrator's
// name is configuration (`kingdom.config.json` orchestrator.name), delivery is by
// recipient, and kingdom.js only treats a `done` as a completion when it
// reaches the orchestrator — so renaming the orchestrator silently threw every completion
// and every briefing away while the tool answered that it had been notified.
{
  const dir2 = mkdtempSync(join(tmpdir(), 'kingdom-office-'));
  const db2 = join(dir2, 'bus.db');
  const seed2 = new Bus(db2);
  seed2.set('roster', JSON.stringify([
    { name: 'sovereign-regent', role: 'orchestrator' },
    { name: 'fool', role: 'briefer' },
    { name: 'coder', role: 'peasant' },
  ]));
  seed2.close();

  const once = (agent, role, name, args) => {
    const rpc = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n';
    const r = spawnSync(process.execPath, [join(HERE, '..', 'src', 'mcp.js')], {
      input: rpc, encoding: 'utf8',
      env: { ...process.env, KINGDOM_AGENT: agent, KINGDOM_ROLE: role, KINGDOM_DB: db2 },
    });
    const reply = r.stdout.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((m) => m && m.id === 2);
    a.ok(reply, `no reply for ${name}: ${r.stderr.slice(0, 300)}`);
    return reply.result?.content?.[0]?.text ?? '';
  };

  a.match(once('coder', 'peasant', 'declare_done', { summary: 'built it' }),
    /sovereign-regent has been notified/, 'declare_done must name the real orchestrator');
  once('fool', 'briefer', 'brief_orchestrator', { summary: 'all quiet' });

  const check2 = new Bus(db2);
  const done = check2.history({ limit: 20 }).find((m) => m.kind === 'done');
  a.equal(done.recipient, 'sovereign-regent', 'a completion must be addressed to the real orchestrator');
  const brief = check2.history({ limit: 20 }).find((m) => m.kind === 'brief');
  a.equal(brief.recipient, 'sovereign-regent', 'a briefing must be addressed to the real orchestrator');
  check2.close();
  try { rmSync(dir2, { recursive: true, force: true }); } catch {}
}

console.log('t-summon-validation.js OK — invalid payloads rejected, messages reach a real member');
