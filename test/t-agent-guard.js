// send() must not crash a claude member whose CLI process failed to spawn.
//
// `if (!this.proc) return;` in send() (src/agent.js) is the only thing
// standing between a spawn failure and a crash: without it, `this.proc` stays
// null but execution falls through to `this.proc.stdin.write(...)`, which
// throws. spawnGuarded already catches the synchronous throw and leaves
// `proc` null — an oversized `--mcp-config` blows Windows' argv limit and
// throws ENAMETOOLONG synchronously (the same mechanism spawnGuarded's own
// comment and t-agy.js's brief-to-file test document), so no real claude
// binary and no network/quota are needed to reach that state.
//
//   node test/t-agent-guard.js
import { strict as a } from 'node:assert';

process.env.AGENTICOS_CLAUDE_BIN = process.execPath;

const { AgentProcess } = await import('../src/agent.js');

const errors = [];
const agent = new AgentProcess(
  { name: 'coder', cli: 'claude' },
  { mcp: { command: 'x', args: [], env: { HUGE: 'x'.repeat(200_000) } } }
);
agent.on('error', (e) => errors.push(String(e)));

agent.start();
a.equal(agent.proc, null, 'the oversized --mcp-config must have failed to spawn');
a.equal(errors.length, 1, 'the spawn failure must be reported, not swallowed');
a.match(errors[0], /could not be started/);

a.doesNotThrow(() => agent.send('go'),
  'send() must return quietly when the CLI never came up, not throw on a null proc');
a.equal(agent.busy, false, 'a turn that never started must not be left marked busy');
a.equal(agent.proc, null);

console.log('t-agent-guard.js OK — send() does not crash a member whose CLI failed to spawn');
