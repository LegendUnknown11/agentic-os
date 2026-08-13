// Proves the token pool reaches spawned agents. Uses dummy tokens — no real
// credential, no API call.
//   node test/t-tokens.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir } from '../src/worktree.js';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-tok-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  king: { name: 'king', cli: 'claude' },
  jester: { name: 'jester', cli: 'claude' },
  peasants: [{ name: 'coder', cli: 'claude' }, { name: 'reviewer', cli: 'codex' }],
}));

// --- the store the `npm run token` command writes ---------------------
mkdirSync(kingdomDir(repo), { recursive: true });
writeFileSync(join(kingdomDir(repo), 'tokens.json'),
  JSON.stringify({ claude: ['sk-ant-oat01-DUMMY-A', 'sk-ant-oat01-DUMMY-B'] }));

delete process.env.KINGDOM_CLAUDE_TOKENS;
const k = new Kingdom(repo, configPath);

a.equal(k.tokenCount(), 2, 'pool must load from tokens.json');

const king = k.authEnvFor('king');
const jester = k.authEnvFor('jester');
const coder = k.authEnvFor('coder');
a.ok(king.CLAUDE_CODE_OAUTH_TOKEN, 'king must get a token');
a.notEqual(king.CLAUDE_CODE_OAUTH_TOKEN, jester.CLAUDE_CODE_OAUTH_TOKEN,
  'adjacent members must land on different tokens — that is the whole point');
a.equal(king.CLAUDE_CODE_OAUTH_TOKEN, coder.CLAUDE_CODE_OAUTH_TOKEN,
  'with 2 tokens and 4 members, member 0 and member 2 share (round robin)');
a.deepEqual(k.authEnvFor('king'), king, 'assignment must be stable across calls');

// --- env precedence ---------------------------------------------------
process.env.KINGDOM_CLAUDE_TOKENS = 'sk-ant-oat01-FROM-ENV';
const k2 = new Kingdom(repo, configPath);
a.equal(k2.tokenCount(), 1, 'KINGDOM_CLAUDE_TOKENS must win over the file');
a.equal(k2.authEnvFor('king').CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-FROM-ENV');
delete process.env.KINGDOM_CLAUDE_TOKENS;

// --- does it ACTUALLY reach a child process? --------------------------
// This is the bit that "it doesn't work" hinges on: Agent must merge its env
// into the spawn, not drop it.
const probe = spawnSync(process.execPath,
  ['-e', 'process.stdout.write(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "MISSING")'],
  { env: { ...process.env, ...k.authEnvFor('king') }, encoding: 'utf8' });
a.equal(probe.stdout, king.CLAUDE_CODE_OAUTH_TOKEN, 'token must survive into the child env');

// --- codex members must NOT be handed a claude token ------------------
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
a.equal(cfg.peasants.find((p) => p.name === 'reviewer').cli, 'codex');

// --- global store is the fallback when the repo store is empty --------
// Isolate from the real ~/.kingdom/tokens.json.
const globalStore = join(mkdtempSync(join(tmpdir(), 'kingdom-global-')), 'tokens.json');
process.env.KINGDOM_TOKEN_STORE = globalStore;

writeFileSync(join(kingdomDir(repo), 'tokens.json'), JSON.stringify({ claude: [] }));
writeFileSync(globalStore, JSON.stringify({ claude: ['sk-ant-oat01-GLOBAL'] }));
const kg = new Kingdom(repo, configPath);
a.equal(kg.tokenCount(), 1, 'empty repo store must fall through to the global one');
a.equal(kg.authEnvFor('king').CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-GLOBAL');

// --- no token anywhere = no env override, just inherit ----------------
writeFileSync(globalStore, JSON.stringify({ claude: [] }));
const k3 = new Kingdom(repo, configPath);
a.equal(k3.tokenCount(), 0);
a.equal(k3.authEnvFor('king'), null, 'empty pool must mean inherit, not an empty token');
delete process.env.KINGDOM_TOKEN_STORE;

// --- host-session vars must be stripped from a peasant's environment --
const { claudeEnv } = await import('../src/agent.js');
process.env.CLAUDE_CODE_CHILD_SESSION = '1';
const cleaned = claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-KEEP' });
a.equal(cleaned.CLAUDE_CODE_CHILD_SESSION, undefined, 'host-session marker must be stripped');
a.equal(cleaned.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-KEEP', 'real auth must survive stripping');
delete process.env.CLAUDE_CODE_CHILD_SESSION;

for (const d of [repo, kingdomDir(repo)]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('t-tokens.js OK — pool loads, assigns stably, and reaches the child env');
