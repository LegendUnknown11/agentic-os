#!/usr/bin/env node
// Headless driver. The Electron app is the real interface, but this runs the
// whole AgenticOS from a terminal — useful for testing and for headless boxes.
//
//   node src/cli.js <repo> [--config path] ["initial command to the orchestrator"]
//
// Type at the prompt to speak to the orchestrator. `@name text` speaks to one member.
// `/approve <id>`, `/reject <id>`, `/roster`, `/quit`.
import './legacy-boot.js'; // first: legacy env fallback and home migration, before any module reads env
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { AgenticOS, defaultConfigPath } from './agenticos.js';
import { fmt as fmtForecast } from './forecast.js';

const argv = process.argv.slice(2);
const repo = resolve(argv[0] ?? '.');
const ci = argv.indexOf('--config');
const configPath = ci !== -1 ? argv[ci + 1] : defaultConfigPath(repo);
const initial = argv.find((a, i) => i > 0 && !a.startsWith('--') && argv[i - 1] !== '--config');

const k = new AgenticOS(repo, configPath);
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

k.on('started', (i) => console.log(c.dim(`AgenticOS up · base=${i.base} · ${i.dir}`)));
k.on('agent', (a) => console.log(c.dim(`  · ${a.name} ${a.state}`)));
k.on('event', ({ name, kind, payload }) => {
  if (kind === 'text') console.log(`${c.b(name)}: ${payload.text.trim()}`);
  else if (kind === 'tool') console.log(c.dim(`  ${name} → ${payload.name}`));
  else if (kind === 'error') console.log(`\x1b[31m${name} ERROR: ${payload.message}\x1b[0m`);
});
k.on('delivered', ({ to, msg }) => console.log(c.dim(`  ✉ ${msg.sender} → ${to}`)));
k.on('verified', ({ agent, tests }) =>
  console.log(c.dim(`  ⚑ ${agent} tests: ${tests.ran ? (tests.ok ? 'PASS' : 'FAIL') : 'none'}`)));
k.on('approval', (a) => {
  // The same per-turn burn the dashboard puts on the card. A terminal
  // user trims the crew from exactly the same decision and deserves
  // exactly the same number — and it must not be able to stop the printout:
  // an approval nobody can read is an approval nobody can answer.
  let cost = null;
  if (a.kind === 'add') {
    try {
      cost = fmtForecast(k.forecast(a.names));
    } catch (e) {
      cost = c.dim(`  (no forecast: ${e.message})`);
    }
  }
  console.log(`\n\x1b[33m▲ APPROVAL #${a.id} (${a.kind})\x1b[0m ${JSON.stringify(a, null, 2)}\n`
    + (cost ? `${cost}\n` : '')
    + c.dim(`  /approve ${a.id}   /reject ${a.id}`));
});
k.on('merged', ({ agent }) => console.log(`\x1b[32m✔ merged ${agent}\x1b[0m`));
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
