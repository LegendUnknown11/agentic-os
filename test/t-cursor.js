import { strict as a } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-cursor-'));
const record = join(dir, 'argv.json');
const stub = join(dir, 'cursor-stub.js');
writeFileSync(stub, `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'cursor-session' });
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } });
// No final newline: the framing layer must flush on process close.
process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 4 } }));
`);
process.env.KINGDOM_CURSOR_BIN = stub;
const { Agent } = await import('../src/agent.js');
const agent = new Agent({ name: 'coder', cli: 'cursor', model: 'fixture', mode: 'plan', sandbox: 'enabled', skipPermissions: false }, { cwd: dir });
agent.start();
const texts = [], ends = [], errors = [];
agent.on('text', (t) => texts.push(t));
agent.on('turn_end', (e) => ends.push(e));
agent.on('error', (e) => errors.push(e));
async function turn(prompt) {
  const done = new Promise((resolve) => agent.once('turn_end', resolve));
  agent.send(prompt);
  return done;
}
try {
  await turn('inspect');
  a.deepEqual(texts, ['answer']);
  a.equal(agent.sessionId, 'cursor-session');
  a.equal(ends[0].usage.input_tokens, 4);
  let recorded = JSON.parse(readFileSync(record, 'utf8'));
  a.equal(recorded.cwd, dir);
  a.ok(recorded.args.includes('--workspace'));
  a.ok(recorded.args.includes('enabled'));
  a.ok(!recorded.args.includes('--force'));
  await turn('next');
  recorded = JSON.parse(readFileSync(record, 'utf8'));
  a.deepEqual(recorded.args.slice(recorded.args.indexOf('--resume'), recorded.args.indexOf('--resume') + 2), ['--resume', 'cursor-session']);
  await turn('x'.repeat(100000));
  recorded = JSON.parse(readFileSync(record, 'utf8'));
  a.ok(recorded.args.join(' ').length < 2000);
  a.match(recorded.args.at(-1), /full instructions are in a file/);
  a.equal(agent.briefFile, null);
  a.equal(ends.length, 3);
  a.deepEqual(errors, []);

  const freebuff = new Agent({ name: 'unsupported', cli: 'freebuff' }, { cwd: dir });
  const failures = [];
  freebuff.on('error', (e) => failures.push(e));
  freebuff.start();
  const done = new Promise((resolve) => freebuff.once('turn_end', resolve));
  freebuff.send('hello');
  await done;
  a.equal(freebuff.busy, false);
  a.equal(freebuff.proc, null);
  a.match(failures[0], /interactive UI only/);
} finally {
  agent.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log('t-cursor.js OK — headless turns, cwd, resume, permission flags, JSON tail and unsupported Freebuff');
