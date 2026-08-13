// The king's real MCP summon call must travel through the bus into the
// Kingdom approval flow before the designer joins the standing crew.
//
//   node test/t-mcp-chain.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { dbPath, kingdomDir } from '../src/worktree.js';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-mcp-chain-'));
const repo = join(dir, 'repo');
let kingdom;

function invokeKingMcp(db) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-mcp-chain', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'summon', arguments: { names: ['designer'], reason: 'black-box MCP chain' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'assign', arguments: { to: 'designer', task: 'must be blocked until approval' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc,
    encoding: 'utf8',
    env: { ...process.env, KINGDOM_AGENT: 'king', KINGDOM_ROLE: 'king', KINGDOM_DB: db },
  });
  const messages = r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  a.equal(r.status, 0, `king MCP exited ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);
  return {
    tools: messages.find((m) => m.id === 2),
    summon: messages.find((m) => m.id === 3),
    assign: messages.find((m) => m.id === 4),
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
  king: { name: 'king', cli: 'codex' },
  jester: { name: 'jester', cli: 'codex' },
  peasants: [{ name: 'designer', cli: 'codex' }],
  rolesSeeded: true,
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
  const { tools, summon, assign } = invokeKingMcp(dbPath(repo));
  a.ok(tools?.result?.tools?.some((t) => t.name === 'summon'),
    'the king MCP tool list must expose summon');
  a.equal(summon?.result?.isError, undefined,
    `king summon failed: ${summon?.result?.content?.[0]?.text ?? 'no reply'}`);
  a.match(summon?.result?.content?.[0]?.text ?? '', /Proposal sent to the sovereign/);
  a.match(assign?.result?.content?.[0]?.text ?? '', /not summoned/,
    'the king must not assign work before summon approval');

  const approval = await approvalPromise;
  a.equal(kingdom.approvals.get(approval.id)?.kind, 'summon',
    'the Kingdom API must retain the pending summon');
  a.deepEqual(approval.names, ['designer']);

  await kingdom.approve(approval.id);
  a.equal(kingdom.bus.get(`resolved:${approval.id}`), 'approved');
  a.ok(kingdom.summoned.has('designer'), 'approval must add designer to the standing crew');
  a.ok(kingdom.agents.has('designer'), 'approval must wake designer');

  kingdom.sleep('designer');
  a.equal(kingdom.agents.has('designer'), false, 'sleep must stop designer');
  await kingdom.wake('designer');
  a.ok(kingdom.summoned.has('designer'), 'a woken designer must remain summoned');
  a.ok(kingdom.agents.has('designer'), 'a summoned designer must be wakeable');

  console.log('t-mcp-chain.js OK — king MCP summon, approval, summon, and wake');
} finally {
  try { await kingdom?.stop(); } catch {}
  for (const target of [repo, kingdomDir(repo), dir]) {
    try { rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
