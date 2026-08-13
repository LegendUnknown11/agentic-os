// Invalid summon requests must not become approval records.
//
//   node test/t-summon-validation.js
import { strict as a } from 'node:assert';
import { spawn } from 'node:child_process';
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
  { name: 'king', role: 'king' },
  { name: 'coder', role: 'peasant' },
  { name: 'tester', role: 'peasant' },
]));
seed.close();

const child = spawn(process.execPath, [join(HERE, '..', 'src', 'mcp.js')], {
  cwd: join(HERE, '..'),
  env: { ...process.env, KINGDOM_AGENT: 'king', KINGDOM_ROLE: 'king', KINGDOM_DB: db },
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
} finally {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  const check = new Bus(db);
  const approvals = check.history({ limit: 20 }).filter((m) => m.kind === 'approval');
  a.equal(approvals.length, 1, 'only the valid summon may post an approval');
  a.deepEqual(JSON.parse(approvals[0].body).names, ['coder', 'tester']);
  check.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('t-summon-validation.js OK — invalid summon payloads are rejected');
