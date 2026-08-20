// What the COURT can reach, as opposed to what the sovereign can.
//
// Two separate reports drove this file:
//
//   1. "I attached the repo and it couldn't recognize" — the sovereign attached
//      a repository from inside the app, the config recorded it, and the
//      orchestrator went on answering that it was in the repo-less workspace
//      home and that this was not a git repository. A running process cannot
//      change directory, and agent.js hands a RESUMED session its original cwd
//      back, so neither attaching nor resuming moves a member that is already
//      awake. It has to be restarted.
//
//   2. "It doesn't have access to switch modes" — and it did not have access to
//      wake, dismiss or re-model anybody either. Every one of those is a method
//      daemon.js already calls for the sovereign. mcp.js runs in its own
//      process and reaches the court only through the bus, so they travel as
//      `control` rows that kingdom.js sweeps.
//
//   node test/t-control.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir, dbPath } from '../src/worktree.js';
import { listSkills } from '../src/skills.js';

process.env.KINGDOM_CODEX_BIN = process.execPath;   // a spawn that costs nothing
process.env.KINGDOM_SETTLE_MS = '120';

// Sandbox homedir(): kingdomDir(null) is a REAL path under it, and this test
// writes a database and restarts members there. os.homedir() reads these at
// call time, so setting them before anything is constructed is enough.
const fakeHome = mkdtempSync(join(tmpdir(), 'kingdom-ctl-home-'));
const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const dir = mkdtempSync(join(tmpdir(), 'kingdom-ctl-'));
const repo = join(dir, 'repo');
const vault = join(dir, 'vault');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: repo });
writeFileSync(join(repo, 'README.md'), '# control\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

const workspace = kingdomDir(null);
mkdirSync(workspace, { recursive: true });
const configPath = join(workspace, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex', description: 'writes code' }],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  summarizer: { enabled: false },
  vault,
  vaultWriteDir: 'Kingdom',
  mode: 'chat',
}));

const until = async (pred, ms = 8_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

/** Drive the real MCP server the way a CLI does, over stdin. */
function mcp(calls, { role = 'orchestrator', db }) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-control', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...calls.map((c, i) => ({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: c })),
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc,
    encoding: 'utf8',
    env: { ...process.env, KINGDOM_AGENT: role, KINGDOM_ROLE: role, KINGDOM_DB: db, KINGDOM_VAULT: vault },
  });
  a.equal(r.status, 0, `mcp exited ${r.status}. stderr: ${r.stderr.slice(0, 500)}`);
  const msgs = r.stdout.split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return {
    tools: (msgs.find((m) => m.id === 2)?.result?.tools ?? []).map((t) => t.name),
    said: calls.map((_, i) => msgs.find((m) => m.id === 10 + i)?.result?.content?.[0]?.text ?? ''),
  };
}

let k;
try {
  k = new Kingdom(null, configPath);
  k.on('error', () => {});
  const delivered = [];
  k.on('delivered', (d) => delivered.push(d));
  await k.start();

  /* ---- 1. a live member follows the repo, or the attach did nothing ------ */
  const who = k.config.orchestrator.name;
  a.ok(k.agents.has(who), 'the orchestrator must be awake for this to mean anything');
  a.equal(k.agents.get(who).cwd, workspace,
    'with no repo it is spawned in the workspace home — this is the state the bug starts from');

  const bornAs = k.agents.get(who);
  await k.attachRepo(repo);

  a.equal(k.repo, repo, 'attachRepo must record the repo');
  a.notEqual(k.agents.get(who), bornAs,
    'the member stranded in the repo-less home must be RESTARTED: a live process cannot '
    + 'change directory, and a resumed session is handed its original cwd back');
  a.equal(k.agents.get(who).cwd, repo,
    'and the replacement must be standing in the repository the sovereign just attached');
  a.equal(k.bus.get(`session:${who}`), '',
    'its session must be dropped too, or the CLI resumes the old thread in the old cwd');

  // Re-attaching the same repo must not cost the court another respawn.
  const settled = k.agents.get(who);
  await k.attachRepo(repo);
  a.equal(k.agents.get(who), settled,
    'a member already standing in the repo must be left alone on a re-attach');

  /* ---- 2. the court can change the court's shape ------------------------- */
  const db = dbPath(null);
  a.equal(k.mode(), 'chat');

  const list = mcp([], { db }).tools;
  a.ok(list.includes('set_mode'), 'the orchestrator must be able to switch modes');
  a.ok(list.includes('set_model'), 'and to re-model a member in any mode');
  a.ok(!list.includes('wake_member'),
    'but not to wake anybody in Chat, which has no crew — a tool that can only fail '
    + 'still costs every member the context to carry it');
  a.ok(!list.includes('dismiss_member'), 'same for dismissing');

  const { said } = mcp([
    { name: 'set_mode', arguments: { mode: 'reserch', why: 'a typo' } },
    { name: 'set_mode', arguments: { mode: 'research', why: 'this is a research job' } },
  ], { db });

  a.match(said[0], /No such mode/,
    'an unknown mode must be refused BY NAME: modeName() falls back to DEFAULT_MODE, '
    + 'so a typo that reached it would quietly put the whole court into Code');
  a.equal(k.mode(), 'chat', 'and nothing may have moved yet');

  a.ok(await until(() => k.mode() === 'research'),
    `the court must actually switch, still in ${k.mode()}`);

  // The other half of the gate: hidden where they cannot work is only correct
  // if they are THERE where they can. Research has a bench.
  const inResearch = mcp([], { db }).tools;
  a.ok(inResearch.includes('wake_member') && inResearch.includes('dismiss_member'),
    'and both must appear once the court has a crew to act on');

  a.equal(delivered.filter((d) => d.msg?.kind === 'control').length, 0,
    'a control request must never be DELIVERED to a member: it is posted with a null '
    + 'recipient so the sweep can find it, and a null recipient matches every summoned '
    + 'member in bus.pending() — each delivery is a full context replay');

  /* ---- 3. a refused lever comes back as an answer, not as silence -------- */
  // Code needs a repo; detach the court from one to prove the refusal path.
  k.repo = null;
  k.bus.post('coder', null, JSON.stringify({ op: 'mode', mode: 'code' }), 'control');
  a.ok(await until(() => k.bus.history({ limit: 400 })
    .some((m) => m.recipient === 'coder' && /needs a repository/i.test(m.body))),
  'a refused switch must reach whoever asked — a member told nothing cannot tell '
    + '"refused" from "lost"');
  k.repo = repo;

  k.bus.post('coder', null, JSON.stringify({ op: 'levitate' }), 'control');
  a.ok(await until(() => k.bus.history({ limit: 400 })
    .some((m) => m.recipient === 'coder' && /No such control/.test(m.body))),
  'and so must a lever that does not exist');

  /* ---- 3b. a member that uses its CLI's own court must be reported ------- */
  // codex 0.145.0 ships spawn_agent/wait/todo_list and no feature flag removes
  // them, so the prompt is the only guard — and a prompt can be talked past.
  // When one was, an entire four-module build ran through codex's own
  // sub-agents while this kingdom recorded one member and one turn. Nothing
  // said a word. Asserted on the event, not on a real process: the gate is one
  // handler, and a test that has to run codex to see it is a test nobody runs.
  {
    const heard = [];
    k.on('failure', (f) => heard.push(f));
    k.agents.get(who).emit('tool', { name: 'collab_tool_call', input: { tool: 'spawn_agent' } });

    a.equal(heard.length, 1, 'a member reaching for its CLI\'s own agents must be reported once');
    a.match(heard[0].message, /spawn_agent/, 'and the report must name the tool it actually called');
    a.equal(heard[0].name, who);
    a.ok(k.bus.history({ limit: 400 }).some((m) =>
      m.recipient === k.config.orchestrator.name && /AWARENESS ONLY/.test(m.body)
      && /spawn_agent/.test(m.body)),
    'and must reach the orchestrator, which is the one that can stop doing it');

    // An ordinary tool call must stay silent, or the notice is noise.
    k.agents.get(who).emit('tool', { name: 'command_execution', input: { command: 'ls' } });
    a.equal(heard.length, 1, 'a normal tool call must not be reported');
    k.removeAllListeners('failure');
    console.log('  a member using its CLI\'s own court is reported, not swallowed');
  }

  /* ---- 4. the court can write a skill, which it structurally could not --- */
  // vault_write puts a note in the folder the MODE picks and strips '/' out of
  // the title, so no member could ever land a file in Kingdom/Skills/ — the one
  // place skills.js reads them from. Build mode advertises "skills, notes,
  // instructions" and could deliver two of the three.
  const before = listSkills(vault).map((s) => s.name);
  a.ok(!before.includes('ship-migration'), 'not there to begin with');

  const saved = mcp([{ name: 'skill_save', arguments: {
    name: 'Ship Migration',
    description: 'moving a schema forward without a window of downtime',
    body: '1. add the new column\n2. backfill\n3. flip the read\n4. drop the old one',
  } }], { db }).said[0];

  a.match(saved, /Kingdom\/Skills\/ship-migration\.md/,
    'a skill must land where skills.js reads them from, not where the mode would put a note');
  a.ok(existsSync(join(vault, 'Kingdom', 'Skills', 'ship-migration.md')));
  const after = listSkills(vault).find((s) => s.name === 'ship-migration');
  a.ok(after, 'and the court must be able to find it immediately');
  a.equal(after.description, 'moving a schema forward without a window of downtime',
    'with its trigger line intact — that line is the only part every member carries');
  a.equal(after.source, 'vault');

  console.log('t-control.js OK — a live court follows the repo, and the court can steer itself');
} finally {
  await k?.stop?.();   // closes the bus with it
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}
