// Context measurement. Both CLIs report a `usage` block at the end of a turn
// that is SUMMED over every model call in that turn. Reading it as "how big is
// this conversation" produced a coder sitting at 30,378k tokens — 7.5 million
// on the low end, more than any window in existence — which also meant the
// recycle threshold fired on every single turn and the budget check after it
// never ran at all.
//
//   node test/t-context.js
import { strict as a } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenticos-ctx-'));

/* ---------- a fake `claude` that behaves like the real transport ---------- */
// Two model calls in one turn, each replaying ~120k of context, then a result
// whose usage is the sum of both. Context is 120k; the sum says 220k. On a
// hundred-tool-call turn that same arithmetic is what reached 30M.
const claudeStub = join(dir, 'claude-stub.js');
writeFileSync(claudeStub, `
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'sess-1' });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    buf = buf.slice(i + 1);
    const call = (input, cread) => say({ type: 'assistant', message: {
      content: [{ type: 'text', text: 'working' }],
      usage: { input_tokens: input, cache_read_input_tokens: cread, cache_creation_input_tokens: 0, output_tokens: 50 },
    }});
    call(1000, 99000);    // first call:  100k of context
    call(2000, 118000);   // second call: 120k of context  <- the real answer
    say({ type: 'result', subtype: 'success', total_cost_usd: 0.05,
      usage: { input_tokens: 3000, cache_read_input_tokens: 217000, cache_creation_input_tokens: 0, output_tokens: 100 } });
  }
});
`);

/* ---------- a fake `codex`: one process per turn, no per-call usage ------- */
const codexStub = join(dir, 'codex-stub.js');
writeFileSync(codexStub, `
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'thread.started', thread_id: 'thr-1' });
say({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'x'.repeat(4000) } });
say({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
// Turn aggregate, and note OpenAI counts cached tokens INSIDE input_tokens.
say({ type: 'turn.completed', usage: { input_tokens: 9000000, cached_input_tokens: 8000000, output_tokens: 400 } });
`);

process.env.AGENTICOS_CLAUDE_BIN = claudeStub;
process.env.AGENTICOS_CODEX_BIN = codexStub;
const { AgentProcess } = await import('../src/agent.js');

const turnEnd = (agent) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('no turn_end within 10s')), 10_000);
  agent.once('turn_end', (u) => { clearTimeout(t); res(u); });
});

/* ---------- claude: exact, from the last per-call usage ------------------- */
{
  const agent = new AgentProcess({ name: 'coder', cli: 'claude', prompt: 'p' }, { cwd: tmpdir() });
  agent.start();
  const done = turnEnd(agent);
  agent.send('do the thing');
  const u = await done;
  agent.stop();

  a.equal(u.ctx, 120_000, `context should be the last call's input, got ${u.ctx}`);
  a.notEqual(u.ctx, 220_000, 'context must not be the turn-aggregate usage');
  console.log(`  claude: ctx ${u.ctx} (aggregate would have said 220000)`);
}

/* ---------- codex: estimated, and nowhere near the aggregate -------------- */
{
  const agent = new AgentProcess({ name: 'architect', cli: 'codex', prompt: 'p' }, { cwd: tmpdir() });
  agent.start();
  const done = turnEnd(agent);
  agent.send('survey');
  const u = await done;
  agent.stop();

  // ~4000 chars of command output plus the prompt, at 4 chars to a token.
  a.ok(u.ctx > 500 && u.ctx < 20_000, `estimate out of range: ${u.ctx}`);
  a.ok(u.ctx < 100_000, 'codex context must not come from the turn aggregate');
  console.log(`  codex: ctx ~${u.ctx} (aggregate would have said 17000000)`);
}

/* ---------- the clamp: an implausible exact value is not believed --------- */
{
  const agent = new AgentProcess({ name: 'x', cli: 'claude' }, { cwd: tmpdir() });
  agent.ctxChars = 40_000;          // 10k tokens of real traffic
  agent.ctxExact = 30_378_000;      // the number the user actually saw
  a.equal(agent.ctxTokens(), 10_000, 'a >2M context should fall back to the estimate');
  console.log('  clamp: 30378k rejected, fell back to 10000');
}

/* ---------- a recycle threshold is only meaningful if ctx is sane --------- */
{
  const agent = new AgentProcess({ name: 'y', cli: 'claude' }, { cwd: tmpdir() });
  agent.ctxExact = 41_000;
  a.ok(agent.ctxTokens() < 70_000, 'a healthy member must not trip the 70k recycle');
}

// Windows can still hold the stub script open just after the kill. The checks
// are done by now, so a stuck temp dir is litter, not a failure.
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
catch (e) { console.log(`  (left ${dir} behind: ${e.code})`); }
console.log('t-context.js OK — context is measured per call, not per turn');
