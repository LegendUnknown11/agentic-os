#!/usr/bin/env node
// Headless driver. The Electron app is the real interface, but this runs the
// whole kingdom from a terminal — useful for testing and for headless boxes.
//
//   node src/cli.js <repo> [--config path] ["initial command to the orchestrator"]
//
// Type at the prompt to speak to the orchestrator. `@name text` speaks to one member.
// `/approve <id>`, `/reject <id>`, `/roster`, `/quit`.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Kingdom, defaultConfigPath } from './kingdom.js';

const argv = process.argv.slice(2);
const repo = resolve(argv[0] ?? '.');
const ci = argv.indexOf('--config');
const configPath = ci !== -1 ? argv[ci + 1] : defaultConfigPath(repo);
const initial = argv.find((a, i) => i > 0 && !a.startsWith('--') && argv[i - 1] !== '--config');

const k = new Kingdom(repo, configPath);
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

k.on('started', (i) => console.log(c.dim(`kingdom up · base=${i.base} · ${i.dir}`)));
k.on('agent', (a) => console.log(c.dim(`  · ${a.name} ${a.state}`)));
k.on('event', ({ name, kind, payload }) => {
  if (kind === 'text') console.log(`${c.b(name)}: ${payload.text.trim()}`);
  else if (kind === 'tool') console.log(c.dim(`  ${name} → ${payload.name}`));
  else if (kind === 'error') console.log(`\x1b[31m${name} ERROR: ${payload.message}\x1b[0m`);
});
k.on('delivered', ({ to, msg }) => console.log(c.dim(`  ✉ ${msg.sender} → ${to}`)));
k.on('verified', ({ peasant, tests }) =>
  console.log(c.dim(`  ⚑ ${peasant} tests: ${tests.ran ? (tests.ok ? 'PASS' : 'FAIL') : 'none'}`)));
k.on('approval', (a) =>
  console.log(`\n\x1b[33m▲ APPROVAL #${a.id} (${a.kind})\x1b[0m ${JSON.stringify(a, null, 2)}\n` +
    c.dim(`  /approve ${a.id}   /reject ${a.id}`)));
k.on('merged', ({ peasant }) => console.log(`\x1b[32m✔ merged ${peasant}\x1b[0m`));
k.on('recycled', ({ name }) => console.log(c.dim(`  ♻ ${name} recycled`)));
k.on('error', (e) => console.error('\x1b[31morchestrator:', e.message, '\x1b[0m'));

await k.start();
if (initial) k.command(initial);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '👑 ' });
rl.prompt();
rl.on('line', async (line) => {
  const s = line.trim();
  try {
    if (!s) {/* skip */}
    else if (s === '/quit') { await k.stop(); process.exit(0); }
    else if (s === '/roster') console.log(k.bus.get('roster'));
    else if (s.startsWith('/approve')) await k.approve(Number(s.split(/\s+/)[1]));
    else if (s.startsWith('/reject')) k.reject(Number(s.split(/\s+/)[1]));
    else if (s.startsWith('@')) {
      const [, name, ...rest] = s.match(/^@(\S+)\s+([\s\S]+)$/) ?? [];
      if (name) k.speakTo(name, rest.join(' '));
      else console.log('usage: @name your message');
    } else k.command(s);
  } catch (e) {
    console.error('\x1b[31m' + e.message + '\x1b[0m');
  }
  rl.prompt();
});
rl.on('close', () => k.stop().then(() => process.exit(0)));
