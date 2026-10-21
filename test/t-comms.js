// The test that matters: can two agents talk to EACH OTHER, without the
// orchestrator relaying? Uses an all-codex team because claude's OAuth is expired.
//   node test/t-comms.js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';

const repo = mkdtempSync(join(tmpdir(), 'agenticos-test-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# test repo\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex', prompt: 'You rule.' },
  briefer: { name: 'briefer', cli: 'codex', prompt: 'You watch.' },
  agents: [
    {
      name: 'alpha', cli: 'codex',
      prompt: 'You are terse. Do exactly what you are told, using your AgenticOS tools.',
    },
    {
      name: 'beta', cli: 'codex',
      prompt:
        'You are terse. If you receive a message containing PING, immediately ' +
        'reply by calling send_message to that sender with the body exactly "PONG". ' +
        'Do nothing else.',
    },
  ],
}, null, 2));

const k = new AgenticOS(repo, configPath);
const seen = [];
k.on('event', ({ name, type, payload }) => {
  if (type === 'tool') console.log(`  ${name} → ${payload.name}`);
  if (type === 'error') console.log(`  !! ${name}: ${payload.message}`);
});
k.on('delivered', ({ to, msg }) => {
  console.log(`  ✉ ${msg.sender} → ${to}: ${msg.body.slice(0, 60)}`);
  seen.push(`${msg.sender}->${to}:${msg.body}`);
});

await k.start();
await k.wake('alpha');
await k.wake('beta');
console.log('team awake, worktrees created');

k.speakTo('alpha', 'Call send_message with to="beta" and body="PING". Then stop.');

const done = await new Promise((res) => {
  const iv = setInterval(() => {
    const pinged = seen.some((s) => s.startsWith('alpha->beta') && s.includes('PING'));
    const ponged = seen.some((s) => s.startsWith('beta->alpha') && s.includes('PONG'));
    if (pinged && ponged) { clearInterval(iv); res(true); }
  }, 500);
  setTimeout(() => { clearInterval(iv); res(false); }, 300_000);
});

console.log('\n--- bus ---');
for (const m of k.bus.history({ limit: 50 })) {
  console.log(`#${m.id} ${m.sender} -> ${m.recipient ?? '*'} [${m.kind}] ${m.body.slice(0, 80)}`);
}
console.log('\nAGENT-TO-AGENT:', done ? 'PASS' : 'FAIL');

await k.stop();
try { rmSync(repo, { recursive: true, force: true }); } catch {}
process.exit(done ? 0 : 1);
