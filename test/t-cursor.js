// The Cursor headless agent (`cursor-agent` / `agent`) as a court backend.
// Fakes only: a node stub speaks the stream-json protocol the
// cli-integrations branch recorded. No real Cursor binary, no model call.
//
//   node test/t-cursor.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-cursor-'));
const record = join(dir, 'argv.json');
const stub = join(dir, 'cursor-stub.js');
writeFileSync(stub, `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'cursor-session' });
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } });
// No final newline: the framing layer must flush on process close.
process.stdout.write(JSON.stringify({ type: 'result', usage: { inputTokens: 4, outputTokens: 2 } }));
`);
process.env.KINGDOM_CURSOR_BIN = stub;
const { Agent } = await import('../src/agent.js');

/* ---------- 1. turns: cwd, flags, resume, staged brief, usage ---------- */
{
  const agent = new Agent({ name: 'coder', cli: 'cursor', model: 'fixture', mode: 'plan', sandbox: 'enabled', skipPermissions: false },
    { cwd: dir, addDirs: [join(dir, 'wt')] });
  agent.start();
  const texts = [], ends = [], errors = [];
  agent.on('text', (t) => texts.push(t));
  agent.on('turn_end', (e) => ends.push(e));
  agent.on('error', (e) => errors.push(e));
  const turn = (prompt) => {
    const done = new Promise((resolve) => agent.once('turn_end', resolve));
    agent.send(prompt);
    return done;
  };
  try {
    await turn('inspect');
    a.deepEqual(texts, ['answer']);
    a.equal(agent.sessionId, 'cursor-session');
    a.deepEqual(ends[0].usage, { input_tokens: 4, output_tokens: 2 },
      'camelCase usage is normalised, and only reported fields are carried');
    let recorded = JSON.parse(readFileSync(record, 'utf8'));
    a.equal(recorded.cwd, dir);
    a.deepEqual(recorded.args.slice(recorded.args.indexOf('--workspace'), recorded.args.indexOf('--workspace') + 2), ['--workspace', dir]);
    a.ok(recorded.args.includes('enabled'));
    a.ok(!recorded.args.includes('--force'), 'skipPermissions:false drops --force');
    a.ok(!recorded.args.includes('--add-dir'), 'unverified --add-dir must not be passed to every peasant');

    // A resumed turn that starts with '-' must not be parsed as a flag.
    await turn('--- follow up');
    recorded = JSON.parse(readFileSync(record, 'utf8'));
    a.deepEqual(recorded.args.slice(recorded.args.indexOf('--resume'), recorded.args.indexOf('--resume') + 2), ['--resume', 'cursor-session']);
    a.equal(recorded.args.at(-1), '\n--- follow up');

    await turn('x'.repeat(100000));
    recorded = JSON.parse(readFileSync(record, 'utf8'));
    a.ok(recorded.args.join(' ').length < 2000, 'a long brief goes to a file, not argv');
    a.match(recorded.args.at(-1), /full instructions are in a file/);
    a.equal(agent.briefFile, null, 'the staged brief is removed when the turn closes');
    a.equal(ends.length, 3);
    a.deepEqual(errors, []);
  } finally {
    agent.stop();
  }
  console.log('  turns: workspace cwd, permission flags, resume, dash-safe prompt, staged brief, usage');
}

/* ---------- 2. an unknown CLI fails its turn visibly, never throws ---------- */
{
  const member = new Agent({ name: 'unsupported', cli: 'freebuff' }, { cwd: dir });
  const failures = [];
  member.on('error', (e) => failures.push(e));
  member.start();
  const done = new Promise((resolve) => member.once('turn_end', resolve));
  member.send('hello');
  await done;
  a.equal(member.busy, false);
  a.equal(member.proc, null);
  a.match(failures[0], /Unsupported agent CLI: freebuff/);
  console.log('  an unsupported CLI ends its turn with a visible error');
}

/* ---------- 3. officers: own .cursor/mcp.json; a repo-owned one is never touched */
{
  const repo = mkdtempSync(join(tmpdir(), 'kingdom-cursor-officers-'));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  // A sovereign-edited exclude with CRLF endings and `.agents` sans slash.
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '# mine\r\n.agents\r\n');

  const cfg = join(repo, 'kingdom.config.json');
  writeFileSync(cfg, JSON.stringify({
    orchestrator: { name: 'orchestrator', cli: 'cursor' },
    briefer: { name: 'briefer', cli: 'cursor-agent' },
    peasants: [],
    rolesSeeded: true,
    advisor: { promptEngineer: false, autoModel: false },
    summarizer: { enabled: false },
  }));
  const { kingdomDir } = await import('../src/worktree.js?cursor-officers');
  // The briefer's workspace already holds a config that is not the court's.
  const foreign = join(kingdomDir(repo), 'officers', 'briefer', '.cursor', 'mcp.json');
  mkdirSync(join(foreign, '..'), { recursive: true });
  const foreignText = JSON.stringify({ mcpServers: { theirs: { command: 'x' } } });
  writeFileSync(foreign, foreignText);

  const { Kingdom } = await import('../src/kingdom.js?cursor-officers');
  const warnings = [];
  const k = new Kingdom(repo, cfg);
  k.on('error', (e) => warnings.push(String(e?.message ?? e)));
  await k.start();
  await new Promise((r) => setTimeout(r, 400));
  try {
    const orchFile = join(kingdomDir(repo), 'officers', 'orchestrator', '.cursor', 'mcp.json');
    a.ok(existsSync(orchFile), 'the orchestrator gets its own .cursor/mcp.json');
    a.equal(JSON.parse(readFileSync(orchFile, 'utf8')).mcpServers.kingdom.env.KINGDOM_AGENT, 'orchestrator');
    a.equal(readFileSync(foreign, 'utf8'), foreignText, 'a config the court did not write is left byte-for-byte');
    a.ok(warnings.some((w) => /briefer.*own \.cursor\/mcp\.json/.test(w)), 'and the lost kingdom tools are said out loud');
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    a.equal(exclude.split(/\r?\n/).filter((l) => l.trim() === '.cursor/mcp.json').length, 1);
    a.ok(!/^\.agents\/$/m.test(exclude), '`.agents` without a slash already covers it; no duplicate');
  } finally {
    await k.stop();
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 8 }); } catch {}
    try { rmSync(kingdomDir(repo), { recursive: true, force: true, maxRetries: 8 }); } catch {}
  }
  console.log('  officers: isolated identities; a foreign .cursor/mcp.json untouched; exclude not duplicated');
}

rmSync(dir, { recursive: true, force: true });
console.log('t-cursor.js OK — headless turns, flags, resume, staged brief, unsupported CLI, and MCP isolation');
