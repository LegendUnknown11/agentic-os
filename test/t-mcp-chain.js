// The orchestrator's real MCP summon call must travel through the bus into the
// Kingdom approval flow before the designer joins the standing crew.
//
//   node test/t-mcp-chain.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { dbPath, kingdomDir } from '../src/worktree.js';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-mcp-chain-'));
const repo = join(dir, 'repo');
const vault = join(dir, 'vault');
let kingdom;

function invokeOrchestratorMcp(db, extraEnv = {}) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-mcp-chain', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'summon', arguments: { names: ['designer'], reason: 'black-box MCP chain' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'assign', arguments: { to: 'designer', task: 'must be blocked until approval' } } },
    ...['first', 'second', 'third', 'fourth'].map((word, i) => ({
      jsonrpc: '2.0', id: i + 5, method: 'tools/call', params: {
        name: 'remember', arguments: {
          campaign: 1, title: `${word} campaign lesson`,
          body: i === 3 ? 'This must be refused.' : `The ${word} durable lesson.`,
        },
      },
    })),
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc,
    encoding: 'utf8',
    env: {
      ...process.env, KINGDOM_AGENT: 'orchestrator', KINGDOM_ROLE: 'orchestrator', KINGDOM_DB: db,
      ...extraEnv,
    },
  });
  const messages = r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  a.equal(r.status, 0, `orchestrator MCP exited ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);
  return {
    tools: messages.find((m) => m.id === 2),
    summon: messages.find((m) => m.id === 3),
    assign: messages.find((m) => m.id === 4),
    memories: [5, 6, 7, 8].map((id) => messages.find((m) => m.id === id)),
  };
}

execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: repo });
writeFileSync(join(repo, 'README.md'), '# MCP chain\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

const configPath = join(dir, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'designer', cli: 'codex' }],
  rolesSeeded: true,
  vault,
  advisor: { promptEngineer: false, autoModel: false },
}));

try {
  kingdom = new Kingdom(repo, configPath);
  const approvalPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP summon did not surface an approval')), 4000);
    kingdom.on('approval', (p) => {
      if (p.kind !== 'summon' || !p.names.includes('designer')) return;
      clearTimeout(timer);
      resolve(p);
    });
  });

  await kingdom.start();
  await kingdom.command('first order');
  kingdom.bus.post('reviewer', 'orchestrator', 'This work was sent back. Add the missing regression.', 'assignment');
  kingdom.bus.logEvent('coder', 'error', { message: 'formatter failed on all-empty records' });
  await kingdom.command('next order closes the first');
  a.ok(kingdom.bus.pending('briefer').some((m) => /RETROSPECTIVE.*campaign #1/.test(m.body)),
    'opening a new order must offer the briefer the campaign that just closed');
  const { tools, summon, assign, memories } = invokeOrchestratorMcp(dbPath(repo), {
    KINGDOM_VAULT: vault, KINGDOM_REPO: repo,
  });
  a.ok(tools?.result?.tools?.some((t) => t.name === 'summon'),
    'the orchestrator MCP tool list must expose summon');
  a.equal(summon?.result?.isError, undefined,
    `orchestrator summon failed: ${summon?.result?.content?.[0]?.text ?? 'no reply'}`);
  a.match(summon?.result?.content?.[0]?.text ?? '', /Proposal sent to the sovereign/);
  a.match(assign?.result?.content?.[0]?.text ?? '', /not summoned/,
    'the orchestrator must not assign work before summon approval');
  a.ok(tools?.result?.tools?.some((t) => t.name === 'campaign_history'),
    'a retrospective must have a bounded, campaign-scoped evidence source');
  for (const proposal of memories.slice(0, 3)) {
    a.match(proposal?.result?.content?.[0]?.text ?? '', /Memory proposal for campaign #1/,
      'the first three memories must enter approval, never the vault');
  }
  a.match(memories[3]?.result?.content?.[0]?.text ?? '', /maximum of three/,
    'a campaign cannot overflow its retrospective memory cap');

  const approval = await approvalPromise;
  a.equal(kingdom.approvals.get(approval.id)?.kind, 'summon',
    'the Kingdom API must retain the pending summon');
  a.deepEqual(approval.names, ['designer']);

  await kingdom.approve(approval.id);
  a.equal(kingdom.bus.get(`resolved:${approval.id}`), 'approved');
  a.ok(kingdom.summoned.has('designer'), 'approval must add designer to the standing crew');
  a.ok(kingdom.agents.has('designer'), 'approval must wake designer');

  await new Promise((resolve) => setTimeout(resolve, 700));
  const memoryApprovals = [...kingdom.approvals.entries()].filter(([, p]) => p.kind === 'memory');
  a.equal(memoryApprovals.length, 3, 'exactly three durable proposals survive in the approval queue');
  await kingdom.approve(memoryApprovals[0][0]);
  await kingdom.approve(memoryApprovals[1][0]);
  kingdom.reject(memoryApprovals[2][0], 'too transient');
  for (const [, p] of memoryApprovals.slice(0, 2)) {
    const file = join(vault, 'Kingdom', 'Memories', `${p.title}.md`);
    a.ok(existsSync(file), `approved memory "${p.title}" must be written`);
    a.match(readFileSync(file, 'utf8'), /recorded_by: orchestrator/,
      'approved memory preserves the proposing member');
  }
  a.ok(!existsSync(join(vault, 'Kingdom', 'Memories', `${memoryApprovals[2][1].title}.md`)),
    'a rejected proposal must leave no memory behind');

  kingdom.sleep('designer');
  a.equal(kingdom.agents.has('designer'), false, 'sleep must stop designer');
  await kingdom.wake('designer');
  a.ok(kingdom.summoned.has('designer'), 'a woken designer must remain summoned');
  a.ok(kingdom.agents.has('designer'), 'a summoned designer must be wakeable');

  await kingdom.stop();
  kingdom = new Kingdom(repo, configPath);
  await kingdom.start();
  for (const [, p] of memoryApprovals.slice(0, 2)) {
    a.ok(existsSync(join(vault, 'Kingdom', 'Memories', `${p.title}.md`)),
      'approved memories must survive a daemon restart');
  }

  console.log('t-mcp-chain.js OK — approvals gate campaign memories, cap proposals, and survive restart');
} finally {
  try { await kingdom?.stop(); } catch {}
  for (const target of [repo, kingdomDir(repo), dir]) {
    try { rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
