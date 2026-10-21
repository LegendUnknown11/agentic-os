// ask_question: any role can ask the sovereign a structured, multiple-choice
// question, and the answer must route back to whoever actually asked — not
// hardcoded to the orchestrator the way approve/reject's replies are.
//
//   node test/t-questions.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/agenticos.js';
import { dbPath, kingdomDir } from '../src/worktree.js';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-questions-'));
const repo = join(dir, 'repo');
let kingdom;

function invokeDesignerMcp(db) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-questions', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'ask_question',
      arguments: {
        questions: [{
          question: 'Which store should the cart use?',
          header: 'Store',
          options: [{ label: 'Redux', description: 'more boilerplate' }, { label: 'Zustand', description: 'less boilerplate' }],
        }],
      } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc,
    encoding: 'utf8',
    env: { ...process.env, KINGDOM_AGENT: 'designer', KINGDOM_ROLE: 'peasant', KINGDOM_DB: db },
  });
  const messages = r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  a.equal(r.status, 0, `designer MCP exited ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);
  return messages.find((m) => m.id === 2);
}

execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: repo });
writeFileSync(join(repo, 'README.md'), '# questions\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

const configPath = join(dir, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'designer', cli: 'codex' }],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
}));

try {
  // A question posted BEFORE start() goes through #reloadApprovals, a separate
  // reader from #surfaceApprovals (the live polling path) — both must carry
  // `sender` through, or answering a question restored at startup throws a raw
  // SQLite bind error instead of routing the reply anywhere.
  kingdom = new Kingdom(repo, configPath);
  kingdom.bus.post('designer', null, JSON.stringify({
    kind: 'question',
    questions: [{ question: 'Restored on restart?', header: 'Restart', options: [{ label: 'Yes' }, { label: 'No' }] }],
  }), 'approval');
  await kingdom.start();
  const restored = [...kingdom.approvals.values()].find((p) => p.kind === 'question');
  a.equal(restored?.from, 'designer',
    '#reloadApprovals must carry sender through too, not just #surfaceApprovals');
  const restoredId = [...kingdom.approvals.entries()].find(([, p]) => p.kind === 'question')[0];
  await kingdom.answerQuestion(restoredId, [['Yes']]);
  a.ok(kingdom.bus.history({ agent: 'designer' }).some((m) => m.body.startsWith('The sovereign answered')),
    'a question restored at startup must still be answerable');
  await kingdom.stop();

  kingdom = new Kingdom(repo, configPath);
  const approvalPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ask_question did not surface an approval')), 4000);
    kingdom.on('approval', (p) => {
      if (p.kind !== 'question') return;
      clearTimeout(timer);
      resolve(p);
    });
  });

  await kingdom.start();
  const call = invokeDesignerMcp(dbPath(repo));
  a.equal(call?.result?.isError, undefined,
    `designer's ask_question failed: ${call?.result?.content?.[0]?.text ?? 'no reply'}`);
  a.match(call?.result?.content?.[0]?.text ?? '', /posted to the sovereign/i);

  const approval = await approvalPromise;
  a.equal(approval.from, 'designer', 'a peasant asking must be attributed to that peasant, not the orchestrator');
  a.equal(approval.questions[0].header, 'Store');
  a.equal(kingdom.approvals.get(approval.id)?.from, 'designer',
    'the Kingdom API must retain who asked, so the answer can route back to them');

  await kingdom.answerQuestion(approval.id, [['Zustand']]);
  a.equal(kingdom.bus.get(`resolved:${approval.id}`), 'answered');
  a.equal(kingdom.approvals.has(approval.id), false, 'a resolved question must leave the pending map');

  // findLast, not find: the startup-reload phase above already left one "The
  // sovereign answered" reply in designer's mailbox on this same repo/db.
  const reply = kingdom.bus.history({ agent: 'designer' })
    .findLast((m) => m.body.startsWith('The sovereign answered'));
  a.ok(reply, 'the answer must land in the asking peasant\'s own mailbox');
  a.match(reply.body, /Zustand/);
  // CROWN, not the asker: bus.pending() drops rows where sender === reader,
  // so a self-addressed answer was stored but never delivered (#54).
  a.equal(reply.sender, 'crown', 'the reply must come from the crown, not be self-addressed or misattributed to the orchestrator');
  a.equal(reply.recipient, 'designer');
  a.ok(kingdom.bus.pending('designer').some((m) => m.id === reply.id),
    'the answer must actually be delivered to the asker, not just stored');

  a.throws(() => kingdom.answerQuestion(approval.id, [['Zustand']]), /No pending question/,
    'answering twice must not silently succeed');

  console.log('t-questions.js OK — any role can ask, and the answer routes back to whoever actually asked');
} finally {
  try { await kingdom?.stop(); } catch {}
  for (const target of [repo, kingdomDir(repo), dir]) {
    try { rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
