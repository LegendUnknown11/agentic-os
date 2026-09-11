// The whole tool surface, pinned — every name, every role gate, every schema.
//
// This is a CHARACTERIZATION test, written to make a refactor of src/mcp.js
// safe rather than to prove any one tool correct. It exists because of a gap
// found by counting: of the 47 tools, ELEVEN are named in no test at all —
// broadcast, read_diff, milestone_done, pause_court, resume_court, set_budget,
// request_merge, workflow_list, workflow_get, workflow_delete, workflow_run.
// Nothing stopped one of them being dropped, renamed, or handed to the wrong
// role. Now something does.
//
// What this DOES cover: that each role is offered exactly the tools it should
// be, under the right mode, with the right required arguments. That is the
// registration surface, and it is what a file split can break.
//
// What this does NOT cover: what a tool's `run` actually does. For the eleven
// above, that remains untested — before this file and after it. Do not read a
// green run here as "the workflow tools work".
//
//   node test/t-tool-surface.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { dbPath } from '../src/worktree.js';

const MCP = join(import.meta.dirname, '..', 'src', 'mcp.js');
const PRINT = process.argv.includes('--print');

/** Ask a real mcp.js process, over real JSON-RPC, what tools it offers. */
function toolsFor(db, env) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-tool-surface', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const r = spawnSync(process.execPath, [MCP], {
    input: rpc,
    encoding: 'utf8',
    env: { ...process.env, KINGDOM_DB: db, ...env },
  });
  const line = r.stdout.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m?.id === 2);
  a.ok(line, `tools/list returned nothing for ${env.KINGDOM_ROLE}\n${r.stderr}`);
  return line.result.tools;
}

/**
 * One tool reduced to what a split can break: its name, its description, and
 * the shape of its arguments. Not the full schema — descriptions inside
 * properties are prose that gets reworded, and pinning those would turn this
 * into a test that fails on every copy edit and gets ignored.
 */
const shapeOf = (t) => [
  t.name,
  Object.keys(t.inputSchema?.properties ?? {}).sort().join(','),
  (t.inputSchema?.required ?? []).slice().sort().join(','),
].join('|');

const digest = (tools) => createHash('sha256')
  .update(tools.map(shapeOf).sort().join('\n'), 'utf8').digest('hex').slice(0, 16);

// `mode/role` -> [tool count, sha256-16 of the sorted shapes].
// Regenerate with --print.
const EXPECT = {
  'code/orchestrator': [36, '47e11285b3d4ad2c'],
  'code/briefer': [19, '8bc1ad2c6c66e5da'],
  'code/peasant': [19, '39a2a13baab6ff1e'],
  'cowork/orchestrator': [39, '6427b3ec06ee4311'],
  'cowork/briefer': [19, '8bc1ad2c6c66e5da'],
  'cowork/peasant': [19, '39a2a13baab6ff1e'],
};

const dir = mkdtempSync(join(tmpdir(), 'kingdom-surface-'));
const repo = join(dir, 'repo');

try {
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const cfg = join(repo, 'kingdom.config.json');
  writeFileSync(cfg, JSON.stringify({
    orchestrator: { name: 'orchestrator', cli: 'codex' },
    briefer: { name: 'briefer', cli: 'codex' },
    peasants: [{ name: 'coder', cli: 'codex', description: 'writes code' }],
    rolesSeeded: true,
    advisor: { promptEngineer: false, autoModel: false },
    summarizer: { enabled: false },
  }));

  const k = new Kingdom(repo, cfg);
  k.on('error', () => {});
  await k.start();
  const db = dbPath(repo);

  // Both modes, because the mode gate hides tools from EVERY role: measured,
  // cowork sees 45 of the 47 (request_merge and send_back are Code-only) while
  // code hides the five workflow tools. Pinning one mode would have left two
  // tools uncovered by the very test written to cover them.
  const seen = {};
  const union = new Set();
  for (const mode of ['code', 'cowork']) {
    k.setMode(mode);
    for (const role of ['orchestrator', 'briefer', 'peasant']) {
      const tools = toolsFor(db, { KINGDOM_AGENT: role, KINGDOM_ROLE: role, KINGDOM_REPO: repo });
      for (const t of tools) union.add(t.name);
      seen[`${mode}/${role}`] = [tools.length, digest(tools)];

      // Every tool must carry a description a model can act on. A split that
      // drops one leaves a nameless tool the member will never call correctly.
      for (const t of tools) {
        a.ok(t.description && t.description.length > 20,
          `${mode}/${role}: ${t.name} has no usable description`);
      }
    }
  }
  await k.stop();

  if (PRINT) {
    console.log('const EXPECT = {');
    for (const [r, [n, h]] of Object.entries(seen)) console.log(`  ${r}: [${n}, '${h}'],`);
    console.log('};');
    console.log(`// union across roles: ${union.size}`);
  } else {
    for (const key of Object.keys(EXPECT)) {
      const [wantN, wantH] = EXPECT[key];
      const got = seen[key];
      a.ok(got, `no surface captured for ${key}`);
      a.equal(got[0], wantN, `${key} was offered ${got[0]} tools, expected ${wantN}`);
      a.equal(got[1], wantH,
        `${key}'s tool surface changed (names, arguments or required fields). `
        + 'If that was deliberate, rerun with --print.');
    }
    // The roles between them must still see all 47. A tool present in the file
    // but gated to no role is invisible, and that is the failure mode a split
    // produces most easily.
    a.equal(union.size, 47, `expected 47 distinct tools across all roles, saw ${union.size}`);
    console.log(`  47 tools, 6 mode/role surfaces byte-stable (${Object.values(seen).map(([n]) => n).join('/')})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
