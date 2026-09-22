// Focused contract checks for the functionality pass: accounting, free paths,
// prompt/tool budgets, roster discovery and observation masking.
//
//   node test/t-efficiency.js
import { strict as a } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { Kingdom } from '../src/kingdom.js';
import { buildPrompt } from '../src/prompt.js';
import { cachedTokens, deltaOf, hasUsage, totalsOf } from '../src/usage.js';
import { costClassOf } from '../src/price.js';
import { forecast as forecastOf, turnsPerClosedCampaign } from '../src/forecast.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = join(import.meta.dirname, '..');
const MCP = join(ROOT, 'src', 'mcp.js');
const dir = mkdtempSync(join(tmpdir(), 'kingdom-efficiency-'));

const rpc = (db, env, request) => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-efficiency', version: '1' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, ...request },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [MCP], {
    input, encoding: 'utf8', env: { ...process.env, KINGDOM_DB: db, ...env },
  });
  a.equal(result.status, 0, `MCP failed: ${result.stderr}`);
  const message = result.stdout.split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((line) => line?.id === 2);
  a.ok(message, `MCP returned no response: ${result.stderr}`);
  return message;
};

/* ---------- provider arithmetic and honest cost states ------------------- */
{
  a.deepEqual(totalsOf({ input_tokens: 100, cached_input_tokens: 70, output_tokens: 5 }),
    { in: 100, cached: 70, written: 0, fresh: 30, out: 5 });
  a.deepEqual(totalsOf({ usageMetadata: {
    promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 6,
  } }), { in: 100, cached: 40, written: 0, fresh: 60, out: 6 });
  a.deepEqual(totalsOf({ input_tokens: 20, cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5, output_tokens: 2 }),
  { in: 35, cached: 10, written: 5, fresh: 20, out: 2 });
  a.equal(cachedTokens({ prompt_tokens_details: { cached_tokens: 9 } }), 9);
  a.equal(deltaOf({ in: 100, cached: 80, written: 0, out: 4 },
    { input_tokens: 130, cached_input_tokens: 100, output_tokens: 7 }).fresh, 10);
  a.equal(costClassOf({ usage: { in: 1 }, cli: 'codex', model: 'not-priced' }), 'unpriced');
  a.equal(costClassOf({ usage: null, cli: 'codex', model: 'gpt-5.6-luna' }), 'unavailable');
  a.equal(hasUsage({ total_tokens: 100 }), false, 'an unsupported total-only shape stays unavailable');
  console.log('  provider variants normalize fresh/cache-write/cache-read/output without double counting');
}

/* ---------- advisor telemetry is bounded and does not leak prompts -------- */
{
  const stub = join(dir, 'advisor.js');
  const marker = join(dir, 'called');
  process.env.KINGDOM_CODEX_BIN = stub;
  writeFileSync(stub, `
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {
  input_tokens: 120, cached_input_tokens: 100, output_tokens: 8
}}) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'ok'
}}) + '\\n');
`);
  const { ask, pickModels } = await import(`../src/advisor.js?eff=${Math.random()}`);
  const telemetry = [];
  a.equal(await ask({ cli: 'codex', model: 'gpt-5.6-luna', effort: 'low' }, 'private prompt', {
    cwd: dir, purpose: 'efficiency-test', onTelemetry: (x) => telemetry.push(x),
  }), 'ok');
  a.equal(telemetry.length, 1);
  a.deepEqual(telemetry[0].usage, { in: 120, cached: 100, written: 0, fresh: 20, out: 8 });
  a.equal(telemetry[0].costClassification, 'estimated');
  a.equal(Object.prototype.hasOwnProperty.call(telemetry[0], 'prompt'), false);
  a.equal(Object.prototype.hasOwnProperty.call(telemetry[0], 'response'), false);

  writeFileSync(stub, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
  const picked = await pickModels({ cli: 'codex' }, {
    goal: 'one fixed model', members: [{ name: 'coder' }],
    allowed: ['codex/gpt-5.6-luna'], efforts: { 'gpt-5.6-luna': ['low', 'max'] },
  }, { cwd: dir });
  a.deepEqual(picked, { coder: { cli: 'codex', model: 'gpt-5.6-luna', effort: 'max' } });
  a.equal(existsSync(marker), false, 'a one-item allowlist must not spend a model-selection call');
  console.log('  advisor records bounded telemetry and routes one-choice selections without a model call');
}

/* ---------- the full bench remains discoverable under the prompt budget --- */
{
  const config = JSON.parse(readFileSync(join(ROOT, 'kingdom.config.json'), 'utf8'));
  const limits = { orchestrator: 11_000, briefer: 4_000, peasant: 8_500 };
  for (const [role, spec] of [['orchestrator', config.orchestrator], ['briefer', config.briefer], ['peasant', config.peasants[0]]]) {
    const prompt = buildPrompt({ name: spec.name, role, spec, config, mode: 'code', goal: null, repo: ROOT });
    a.ok(prompt.length <= limits[role], `code/${role} prompt is ${prompt.length} bytes`);
    if (role === 'orchestrator') {
      for (const member of config.peasants) a.ok(prompt.includes(member.name), `${member.name} fell out of the bench`);
    } else {
      a.ok(!prompt.includes(config.peasants.at(-1).name), `${role} still embeds the full bench`);
    }
  }
  console.log(`  code prompts fit ${limits.orchestrator}/${limits.briefer}/${limits.peasant}-byte role ceilings; all ${config.peasants.length} specialists remain visible to the orchestrator`);
}

/* ---------- MCP payload budgets and roster filtering --------------------- */
const BASE = {
  'code/orchestrator': [36, 17_924], 'code/briefer': [19, 9_160], 'code/peasant': [19, 8_817],
  'cowork/orchestrator': [39, 18_774], 'cowork/briefer': [19, 9_160], 'cowork/peasant': [19, 8_817],
};
const db = join(dir, 'mcp.sqlite');
const state = new Bus(db);
state.set('roster', JSON.stringify([
  { name: 'coder', role: 'peasant', title: 'Code specialist', description: 'writes code', awake: true, summoned: true, cli: 'codex', model: 'gpt-5.6-luna', effort: 'high', auto: false },
  { name: 'scribe', role: 'peasant', title: 'Documentation specialist', description: 'writes docs', awake: false, summoned: false, cli: 'codex', model: 'gpt-5.6-luna', effort: 'low', auto: true },
  { name: 'orchestrator', role: 'orchestrator', title: 'Court lead', description: 'assigns work', awake: false, summoned: false },
]));
state.set('mode', 'code');
state.close();

for (const [key, [count, baseline]] of Object.entries(BASE)) {
  const [mode, role] = key.split('/');
  const modeBus = new Bus(db);
  modeBus.set('mode', mode);
  modeBus.close();
  const listed = rpc(db, { KINGDOM_MODE: mode, KINGDOM_AGENT: role, KINGDOM_ROLE: role }, { method: 'tools/list' });
  const tools = listed.result.tools;
  a.equal(tools.length, count, `${key} tool count changed`);
  const payloadSize = JSON.stringify(tools).length;
  a.ok(payloadSize <= baseline, `${key} MCP payload grew: ${payloadSize} vs ${baseline}`);
}

const codeMode = new Bus(db);
codeMode.set('mode', 'code');
codeMode.close();
const roster = (args) => {
  const out = rpc(db, { KINGDOM_MODE: 'code', KINGDOM_AGENT: 'coder', KINGDOM_ROLE: 'peasant' }, {
    method: 'tools/call', params: { name: 'roster', arguments: args },
  });
  return JSON.parse(out.result.content[0].text);
};
a.deepEqual(roster({ query: 'documentation', detail: true }).map((m) => m.name), ['scribe']);
a.deepEqual(roster({ activeOnly: true }).map((m) => m.name), ['coder']);
a.equal(roster({ query: 'specialist', limit: 1 }).length, 1);
console.log('  MCP surfaces are under budget and roster supports query, activeOnly, detail and limit');

/* ---------- high-volume MCP reads stop at their context budgets ---------- */
{
  const seeded = new Bus(db);
  for (let i = 0; i < 550; i++) seeded.logEvent('coder', 'text', { text: `limitneedle event ${i}` });
  for (let i = 0; i < 250; i++) seeded.post('coder', 'briefer', `limitneedle message ${i}`);
  seeded.close();
  const call = (role, name, args) => rpc(db, {
    KINGDOM_MODE: 'code', KINGDOM_AGENT: role, KINGDOM_ROLE: role,
  }, { method: 'tools/call', params: { name, arguments: args } }).result.content[0].text.split('\n');
  a.equal(call('briefer', 'read_bus', { since: 0, limit: 200 }).length, 200);
  a.equal(call('briefer', 'read_events', { since: 0, limit: 500 }).length, 500);
  a.equal(call('peasant', 'recall', { query: 'limitneedle', limit: 50 }).length, 50);

  const assets = join(dir, 'assets');
  mkdirSync(assets);
  for (let i = 0; i < 105; i++) writeFileSync(join(assets, `upload-${String(i).padStart(3, '0')}.md`), 'x');
  const uploads = call('peasant', 'list_uploads', { query: 'upload-', limit: 100 });
  a.equal(uploads.length, 101, '100 uploads plus one truthful truncation line');
  a.match(uploads.at(-1), /5 more uploads withheld/);
  console.log('  bus, event, recall and upload reads stop at 200/500/50/100 rows');
}

/* ---------- duplicate observations are measured, not just masked --------- */
{
  const maskDir = mkdtempSync(join(tmpdir(), 'kingdom-mask-'));
  const maskDb = join(maskDir, 'mask.sqlite');
  const vault = join(maskDir, 'vault');
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  writeFileSync(join(vault, 'Notes', 'Big.md'), 'A durable observation. '.repeat(40));
  const seed = new Bus(maskDb);
  seed.set('mode', 'code');
  seed.close();
  const env = { KINGDOM_MODE: 'code', KINGDOM_AGENT: 'coder', KINGDOM_ROLE: 'peasant', KINGDOM_VAULT: vault };
  const call = () => rpc(maskDb, env, { method: 'tools/call', params: {
    name: 'vault_read', arguments: { path: 'Notes/Big.md' },
  } }).result.content[0].text;
  const first = call();
  const second = call();
  a.ok(first.length > 400 && first.includes('durable observation'));
  a.match(second, /\[unchanged/);
  const seen = new Bus(maskDb);
  a.equal(Number(seen.get('mask:calls')), 1);
  a.equal(Number(seen.get('mask:chars')), first.length);
  seen.close();
  rmSync(maskDir, { recursive: true, force: true });
  console.log('  observation masking increments durable call and character counters');
}

/* ---------- a projected total is measured from REAL campaign/event ids --- */
{
  const campDb = join(dir, 'campaigns.sqlite');
  const cb = new Bus(campDb);
  const specOf = () => ({ cli: 'codex', model: 'gpt-5.6-luna' });

  // Campaign 1: two real turns, closed by the sovereign's next order.
  cb.beginCampaign('order one');
  cb.logEvent('coder', 'turn_end', { usage: { input_tokens: 1000, output_tokens: 100 } });
  cb.logEvent('coder', 'turn_end', { usage: { input_tokens: 1000, output_tokens: 100 } });
  // Campaign 2: one real turn, also closed.
  cb.beginCampaign('order two');
  cb.logEvent('coder', 'turn_end', { usage: { input_tokens: 1000, output_tokens: 100 } });
  // Campaign 3: still open when read below — must not count toward the mean.
  cb.beginCampaign('order three');
  cb.logEvent('coder', 'turn_end', { usage: { input_tokens: 1000, output_tokens: 100 } });
  cb.logEvent('coder', 'turn_end', { usage: { input_tokens: 1000, output_tokens: 100 } });
  cb.logEvent('coder', 'turn_end', { usage: { input_tokens: 1000, output_tokens: 100 } });

  const rows = cb.events({ type: 'turn_end' });
  const campaigns = cb.campaigns();
  a.equal(campaigns.length, 3);
  a.equal(campaigns.filter((c) => !c.current).length, 2, 'the still-open campaign must not read as closed');

  // The real event ids the bus assigns are the whole point of this check —
  // forecast.js's own self-check only ever proves the arithmetic against
  // hand-picked ids, never against what SQLite autoincrement actually hands
  // back campaign to campaign.
  a.deepEqual(turnsPerClosedCampaign(campaigns, rows), [2, 1],
    'turn counts bracketed by real bus event ids, not array position');

  const f = forecastOf(rows, ['coder'], { specOf, campaigns });
  a.equal(f.crew.campaignsSampled, 2);
  a.equal(f.crew.turnsPerCampaign, 1.5, 'mean of 2 and 1 real closed-campaign turn counts');
  a.ok(f.crew.projectedTotalUsd > 0);
  const near = Math.abs(f.crew.projectedTotalUsd - f.crew.perTurnUsd * 1.5) < 1e-9;
  a.ok(near, 'projected total must be the measured rate times the measured mean, end to end against a real bus');
  cb.close();
  console.log('  the summon card projected total is measured from a real bus\'s campaign/event-id brackets');
}

/* ---------- a per-run ceiling actually stops the run, restart-safe ------- */
{
  const runRepo = mkdtempSync(join(tmpdir(), 'kingdom-runcap-'));
  const git = (...x) => execFileSync('git', x, { cwd: runRepo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(runRepo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const runConfigPath = join(runRepo, 'kingdom.config.json');
  writeFileSync(runConfigPath, JSON.stringify({
    maxRunUsd: 1,
    orchestrator: { name: 'orchestrator', cli: 'codex' },
    briefer: { name: 'briefer', cli: 'codex' },
    peasants: [{ name: 'coder', cli: 'codex' }],
  }));

  const rk = new Kingdom(runRepo, runConfigPath);
  rk.on('error', () => {});
  await rk.start();
  // Same technique as t-budget.js: a REAL agent so the turn_end wiring under
  // test is genuine, with send/stop patched so nothing actually spawns.
  await rk.wake('coder');
  const coder = rk.agents.get('coder');
  coder.send = () => {};
  coder.stop = function () { this.stopped = true; };

  const run = await rk.createRun({ objective: 'prove a per-run ceiling actually stops the run' });
  a.equal(run.state, 'planning', 'sanity: a fresh run has not been approved yet');

  const runEvents = [];
  rk.on('run', (r) => runEvents.push(r));

  // Three turns of $0.40 = $1.20, over the $1 run cap.
  for (let i = 0; i < 3; i++) coder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0.4 });
  await wait(200);

  const blocked = runEvents.find((r) => r.id === run.id && r.state === 'blocked');
  a.ok(blocked, 'crossing maxRunUsd must block the run, not just log it');
  a.match(blocked.blocker?.operation ?? '', /run spend ceiling/,
    'the blocker must name what actually happened, not a generic message');
  a.equal(rk.bus.run(run.id).state, 'blocked', 'and the state must persist in the bus');
  a.equal(coder.stopped, undefined, 'a run ceiling stops the RUN, not unrelated work on the same member');

  await rk.stop();
  rmSync(runRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('  maxRunUsd stops a run that crosses it, the same restart-safe way maxBudgetUsd/maxKingdomUsd already do');
}

rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log('t-efficiency.js OK — accounting, telemetry, routing, budgets, roster and masking contracts hold');
