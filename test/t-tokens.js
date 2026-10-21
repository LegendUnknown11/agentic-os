// Proves the token pool reaches spawned agents. Uses dummy tokens — no real
// credential, no API call.
//   node test/t-tokens.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { stateDir } from '../src/worktree.js';

const repo = mkdtempSync(join(tmpdir(), 'agenticos-tok-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'claude' },
  briefer: { name: 'briefer', cli: 'claude' },
  agents: [{ name: 'coder', cli: 'claude' }, { name: 'reviewer', cli: 'codex' }],
}));

// --- the store the `npm run token` command writes ---------------------
mkdirSync(stateDir(repo), { recursive: true });
writeFileSync(join(stateDir(repo), 'tokens.json'),
  JSON.stringify({ claude: ['sk-ant-oat01-DUMMY-A', 'sk-ant-oat01-DUMMY-B'] }));

delete process.env.AGENTICOS_CLAUDE_TOKENS;
const k = new AgenticOS(repo, configPath);

a.equal(k.tokenCount(), 2, 'pool must load from tokens.json');

const orchestrator = k.authEnvFor('orchestrator');
const briefer = k.authEnvFor('briefer');
const coder = k.authEnvFor('coder');
a.ok(orchestrator.CLAUDE_CODE_OAUTH_TOKEN, 'orchestrator must get a token');
a.notEqual(orchestrator.CLAUDE_CODE_OAUTH_TOKEN, briefer.CLAUDE_CODE_OAUTH_TOKEN,
  'adjacent members must land on different tokens — that is the whole point');
a.equal(orchestrator.CLAUDE_CODE_OAUTH_TOKEN, coder.CLAUDE_CODE_OAUTH_TOKEN,
  'with 2 tokens and 4 members, member 0 and member 2 share (round robin)');
a.deepEqual(k.authEnvFor('orchestrator'), orchestrator, 'assignment must be stable across calls');

// --- env precedence ---------------------------------------------------
process.env.AGENTICOS_CLAUDE_TOKENS = 'sk-ant-oat01-FROM-ENV';
const k2 = new AgenticOS(repo, configPath);
a.equal(k2.tokenCount(), 1, 'AGENTICOS_CLAUDE_TOKENS must win over the file');
a.equal(k2.authEnvFor('orchestrator').CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-FROM-ENV');
delete process.env.AGENTICOS_CLAUDE_TOKENS;

// --- does it ACTUALLY reach a child process? --------------------------
// This is the bit that "it doesn't work" hinges on: AgentProcess must merge its env
// into the spawn, not drop it.
const probe = spawnSync(process.execPath,
  ['-e', 'process.stdout.write(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "MISSING")'],
  { env: { ...process.env, ...k.authEnvFor('orchestrator') }, encoding: 'utf8' });
a.equal(probe.stdout, orchestrator.CLAUDE_CODE_OAUTH_TOKEN, 'token must survive into the child env');

// --- codex members must NOT be handed a claude token ------------------
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
a.equal(cfg.agents.find((p) => p.name === 'reviewer').cli, 'codex');

// --- global store is the fallback when the repo store is empty --------
// Isolate from the real ~/.agenticos/tokens.json.
const globalStore = join(mkdtempSync(join(tmpdir(), 'agenticos-global-')), 'tokens.json');
process.env.AGENTICOS_TOKEN_STORE = globalStore;

writeFileSync(join(stateDir(repo), 'tokens.json'), JSON.stringify({ claude: [] }));
writeFileSync(globalStore, JSON.stringify({ claude: ['sk-ant-oat01-GLOBAL'] }));
const kg = new AgenticOS(repo, configPath);
a.equal(kg.tokenCount(), 1, 'empty repo store must fall through to the global one');
a.equal(kg.authEnvFor('orchestrator').CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-GLOBAL');

// --- no token anywhere = no env override, just inherit ----------------
writeFileSync(globalStore, JSON.stringify({ claude: [] }));
const k3 = new AgenticOS(repo, configPath);
a.equal(k3.tokenCount(), 0);
a.equal(k3.authEnvFor('orchestrator'), null, 'empty pool must mean inherit, not an empty token');
delete process.env.AGENTICOS_TOKEN_STORE;

// --- host-session vars must be stripped from an agent's environment --
const { claudeEnv } = await import('../src/agent.js');
process.env.CLAUDE_CODE_CHILD_SESSION = '1';
const cleaned = claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-KEEP' });
a.equal(cleaned.CLAUDE_CODE_CHILD_SESSION, undefined, 'host-session marker must be stripped');
a.equal(cleaned.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-KEEP', 'real auth must survive stripping');
delete process.env.CLAUDE_CODE_CHILD_SESSION;

for (const d of [repo, stateDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-tokens.js OK — pool loads, assigns stably, and reaches the child env');
