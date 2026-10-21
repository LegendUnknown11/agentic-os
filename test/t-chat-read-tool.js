// Chat mode has no crew (modes.js: crew: []), so an uploaded file the
// user attaches has nobody to delegate to. The orchestrator's tools:''
// (agenticos.config.json, agent.js:352-355) is otherwise correct — it enforces
// "delegates rather than edits" — but with no exception it can never open
// what it was just handed. Confirmed live: granting a bare Read tool, and
// only while the team is in chat mode, lets the orchestrator actually read
// an uploaded image; it still cannot Bash/Write/escape its role anywhere else.
//
//   node test/t-chat-read-tool.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { stateDir } from '../src/worktree.js';

process.env.AGENTICOS_CLAUDE_BIN = process.execPath;
process.env.AGENTICOS_CODEX_BIN = process.execPath;
process.env.AGENTICOS_SETTLE_MS = '150';

async function teamIn(mode) {
  const repo = mkdtempSync(join(tmpdir(), 'agenticos-chatread-'));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@agenticos');
  git('config', 'user.name', 'agenticos');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const cfg = join(repo, 'agenticos.config.json');
  writeFileSync(cfg, JSON.stringify({
    mode,
    orchestrator: { name: 'orchestrator', cli: 'claude', tools: '' },
    briefer: { name: 'briefer', cli: 'claude', tools: '' },
    agents: [],
    rolesSeeded: true,
    advisor: { promptEngineer: false, autoModel: false },
    summarizer: { enabled: false },
  }));

  const k = new AgenticOS(repo, cfg);
  k.on('error', () => {});
  await k.start();
  return { k, repo };
}

const { k: kChat, repo: repoChat } = await teamIn('chat');
a.equal(kChat.processes.get('orchestrator').spec.tools, 'Read',
  'in chat mode, with no crew to delegate an attachment to, the orchestrator gets a bare Read tool');
await kChat.stop();

const { k: kCode, repo: repoCode } = await teamIn('code');
a.equal(kCode.processes.get('orchestrator').spec.tools, '',
  'outside chat mode the orchestrator keeps its normal zero-tools, delegate-only role');
await kCode.stop();

for (const d of [repoChat, repoCode, stateDir(repoChat), stateDir(repoCode)]) {
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}
console.log('t-chat-read-tool.js OK — chat-mode orchestrator gets Read, every other mode stays tools-free');
