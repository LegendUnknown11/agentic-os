// The advisor runs BEFORE the court sees anything the sovereign typed, so its
// failure modes are the dangerous kind: a bad rewrite silently changes the
// order, and a creative model pick silently spends money on a tier the
// sovereign excluded. Both must be impossible, not merely unlikely.
//
//   node test/t-advisor.js
import { strict as a } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-advisor-'));

/* ---------- 1. pulling JSON out of whatever the model felt like saying ---- */
{
  const { parseJson } = await import('../src/advisor.js');
  a.deepEqual(parseJson('{"a":1}'), { a: 1 }, 'bare JSON');
  a.deepEqual(parseJson('Sure!\n```json\n{"a":1}\n```\nHope that helps'), { a: 1 }, 'fenced with prose');
  a.deepEqual(parseJson('here you go: {"a":{"b":2}} — let me know'), { a: { b: 2 } },
    'nested, with trailing commentary');
  a.deepEqual(parseJson('{"s":"a } b"}'), { s: 'a } b' }, 'a brace inside a string is not the end');
  a.equal(parseJson('no json here'), null);
  a.equal(parseJson(''), null);
  a.equal(parseJson('{"broken":'), null, 'a truncated answer must not throw');
  console.log('  parseJson survives fences, prose, nesting and truncation');
}

/* ---------- 2. the allowlist is enforced on the way OUT ------------------- */
// The prompt asks the model to stay inside the list. That is a request, not a
// guarantee — the check that matters is this one.
// ONE stub path, rewritten in place. resolveCli memoises per process, and
// agent.js is imported once no matter how many times advisor.js is re-imported
// under a fresh query string — so a NEW stub file would never be reached: the
// first path resolveCli ever saw wins for the rest of the run. (This test
// initially pointed at a new file each time and quietly kept replaying the
// first stub's answer.)
const STUB = join(dir, 'stub.js');
process.env.KINGDOM_CODEX_BIN = STUB;
const stub = (body) => { writeFileSync(STUB, body); return STUB; };
const says = (reply) => stub(`
process.stdout.write(JSON.stringify({ type: 'item.completed',
  item: { type: 'agent_message', text: ${JSON.stringify(reply)} } }) + '\\n');
`);

const efforts = {
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};
const members = [{ name: 'coder', description: 'writes code' }, { name: 'scribe', description: 'docs' }];

async function pick(reply, allowed) {
  says(reply);
  const { pickModels } = await import(`../src/advisor.js?p=${Math.random()}`);
  return pickModels({ cli: 'codex' }, { goal: 'g', members, allowed, efforts }, { cwd: dir });
}

{
  const ok = await pick(JSON.stringify({
    coder: { model: 'codex/gpt-5.6-terra', effort: 'high' },
    scribe: { model: 'codex/gpt-5.6-luna', effort: 'low' },
  }), ['codex/gpt-5.6-luna', 'codex/gpt-5.6-terra']);
  a.deepEqual(ok, {
    coder: { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
    scribe: { cli: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
  });
  console.log('  allowed picks come through intact');
}

{
  // The sovereign excluded terra. The model reaches for it anyway.
  const out = await pick(JSON.stringify({
    coder: { model: 'codex/gpt-5.6-terra', effort: 'ultra' },
    scribe: { model: 'codex/gpt-5.6-luna', effort: 'low' },
  }), ['codex/gpt-5.6-luna']);
  a.deepEqual(out, { scribe: { cli: 'codex', model: 'gpt-5.6-luna', effort: 'low' } },
    'a model outside the allowlist must be dropped, not applied');
  console.log('  excluded model refused even though the advisor chose it');
}

{
  // 'ultra' is real, but not on luna — codex would reject it per-model.
  const out = await pick(JSON.stringify({ coder: { model: 'codex/gpt-5.6-luna', effort: 'ultra' } }),
    ['codex/gpt-5.6-luna']);
  a.deepEqual(out, {}, 'an effort the chosen model does not publish must be dropped');
  console.log('  per-model effort ladder enforced (luna has no "ultra")');
}

{
  const out = await pick(JSON.stringify({ ghost: { model: 'codex/gpt-5.6-luna', effort: 'low' } }),
    ['codex/gpt-5.6-luna']);
  a.deepEqual(out, {}, 'a member that does not exist must be ignored');
  const junk = await pick('I would suggest thinking about this more.', ['codex/gpt-5.6-luna']);
  a.deepEqual(junk, {}, 'prose with no JSON must change nothing');
  console.log('  unknown members and non-answers change nothing');
}

/* ---------- 3. output/effort evidence is observed, never guessed -------- */
{
  const { outputEvidence, pickModels } = await import(`../src/advisor.js?output=${Math.random()}`);
  const evidence = outputEvidence([
    { agent: 'coder', payload: {
      cli: 'codex', model: 'gpt-5.6-luna', effort: 'max',
      usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
    } },
    { agent: 'coder', payload: {
      cli: 'codex', model: 'gpt-5.6-luna', effort: 'max',
      // Codex usage is cumulative, so this contributes 40, not 50, output tokens.
      usage: { input_tokens: 250, cached_input_tokens: 200, output_tokens: 50 },
    } },
    // Courts created before this feature have no configuration snapshot. They
    // remain an honest absence of evidence, rather than being guessed from a
    // member's current settings.
    { agent: 'scribe', payload: { usage: { input_tokens: 999, output_tokens: 999 } } },
  ]);
  a.match(evidence, /coder .*gpt-5\.6-luna.*max.*2 turns.*50 output tokens/i,
    'the advisor sees the measured cumulative delta, grouped by the actual effort used');
  a.match(evidence, /\$0\.000060/, 'output cost uses the rate card, not an invented ratio');
  a.equal(outputEvidence([]), 'No measured output history is available for this court yet.');

  const capture = join(dir, 'model-prompt.txt');
  stub(`
require('node:fs').writeFileSync(${JSON.stringify(capture)}, process.argv.at(-1));
process.stdout.write(JSON.stringify({ type: 'item.completed',
  item: { type: 'agent_message', text: ${JSON.stringify(JSON.stringify({
    coder: { model: 'codex/gpt-5.6-luna', effort: 'max' },
  }))} } }) + '\\n');
`);
  const picked = await pickModels({ cli: 'codex' }, {
    goal: 'ship a small regression fix', members, allowed: ['codex/gpt-5.6-luna'], efforts,
    measurements: evidence,
  }, { cwd: dir });
  a.ok(picked.coder, 'adding evidence must not change the allowlist gate');
  const prompt = readFileSync(capture, 'utf8');
  a.match(prompt, /MEASURED OUTPUT HISTORY/, 'the selected advisor receives the court measurement');
  a.match(prompt, /do not treat token count as a quality score/i,
    'the prompt must not turn output volume into an invented quality proxy');
  console.log('  measured output history informs effort selection without claiming quality');
}

/* ---------- 4. the rewrite must never replace the order with an answer ---- */
{
  says(JSON.stringify({ mode: 'code', brief: 'Fix the login redirect on /auth/callback.' }));
  const { engineerPrompt } = await import(`../src/advisor.js?e=${Math.random()}`);
  const short = await engineerPrompt({ cli: 'codex' }, 'login redirect broken', { cwd: dir });
  a.deepEqual(short, { text: 'Fix the login redirect on /auth/callback.', mode: 'code' });

  // A model that answers instead of rewriting produces something far longer
  // than what it was given. Feeding that to the orchestrator as if the sovereign said
  // it would put an invented plan in their mouth.
  says('x'.repeat(4000));
  const { engineerPrompt: e2 } = await import(`../src/advisor.js?e2=${Math.random()}`);
  a.equal(await e2({ cli: 'codex' }, 'login redirect broken', { cwd: dir }), null,
    'a runaway rewrite must fall back to the original');

  // The schema is a request, not a guarantee. A model that answers in plain
  // prose must still get its rewrite used — losing the classification costs a
  // manual switch, losing the rewrite would put the wrong words in the court.
  says('Fix the login redirect on /auth/callback.');
  const { engineerPrompt: e3 } = await import(`../src/advisor.js?e3=${Math.random()}`);
  a.deepEqual(await e3({ cli: 'codex' }, 'login redirect broken', { cwd: dir }),
    { text: 'Fix the login redirect on /auth/callback.', mode: null },
    'plain prose still rewrites; only the mode is lost');

  // A mode nobody has heard of must not reach setMode.
  says(JSON.stringify({ mode: 'yolo', brief: 'Fix it.' }));
  const { engineerPrompt: e4 } = await import(`../src/advisor.js?e4=${Math.random()}`);
  a.equal((await e4({ cli: 'codex' }, 'fix it', { cwd: dir })).mode, null,
    'an invented mode is dropped, not passed on');

  console.log('  rewrite accepted when brief, refused when it runs away; mode classified');
}

/* ---------- 5. a dead advisor must not stop the sovereign ---------------- */
{
  stub('process.exit(9);');
  const { ask, engineerPrompt } = await import(`../src/advisor.js?d=${Math.random()}`);
  a.equal(await ask({ cli: 'codex' }, 'hi', { cwd: dir }), null, 'a crash returns null, not a throw');
  a.equal(await engineerPrompt({ cli: 'codex' }, 'hi', { cwd: dir }), null);

  stub('setTimeout(() => {}, 60000);');
  const { ask: a2 } = await import(`../src/advisor.js?h=${Math.random()}`);
  const t = Date.now();
  a.equal(await a2({ cli: 'codex' }, 'hi', { cwd: dir, timeoutMs: 700 }), null);
  a.ok(Date.now() - t < 5000, 'a hung advisor must be killed, not waited on forever');
  console.log('  crash and hang both degrade to "no advice" quickly');
}

/* ---------- 6. the money path: what actually reaches the orchestrator ------------ */
// Everything above tests the advisor in isolation. This tests the only thing
// that matters — that command() puts the RIGHT text on the bus.
{
  const { execFileSync } = await import('node:child_process');
  const { Kingdom } = await import('../src/kingdom.js');

  const repo = mkdtempSync(join(tmpdir(), 'kingdom-adv-repo-'));
  const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'k@kingdom');
  git('config', 'user.name', 'kingdom');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const cfg = join(repo, 'kingdom.config.json');
  const write = (advisor, auto = false) => writeFileSync(cfg, JSON.stringify({
    models: { codex: ['gpt-5.6-luna'] },
    efforts: { codex: ['low', 'medium'], byModel: { 'gpt-5.6-luna': ['low', 'medium'] } },
    orchestrator: { name: 'orchestrator', cli: 'codex' },
    briefer: { name: 'briefer', cli: 'codex' },
    peasants: [{ name: 'coder', cli: 'codex', model: 'gpt-5.6-luna', effort: 'medium',
      description: 'writes code', ...(auto && { auto: true }) }],
    rolesSeeded: true,
    advisor,
  }));

  const sovereignSaid = (k) =>
    k.bus.history({ limit: 50 }).filter((m) => m.sender === 'sovereign').pop();

  // (a) rewrite ON — the orchestrator reads the brief, but the original survives.
  says('Fix the double-charge race in the payment webhook handler.');
  write({ cli: 'codex', model: 'gpt-5.6-luna', promptEngineer: true, autoModel: false, allow: [] });
  let k = new Kingdom(repo, cfg);
  k.on('error', () => {});   // #warn routes here; nothing to assert on
  await k.start();
  await k.command('the payment thing charges twice sometimes');
  let posted = sovereignSaid(k);
  a.match(posted.body, /double-charge race/, 'the orchestrator must receive the engineered brief');
  a.match(posted.body, /charges twice sometimes/,
    "the sovereign's own wording must still be on the bus for a successor to find");
  await k.stop();

  // (b) rewrite OFF — byte-for-byte what was typed, nothing appended.
  write({ promptEngineer: false, autoModel: false });
  k = new Kingdom(repo, cfg);
  k.on('error', () => {});
  await k.start();
  await k.command('exactly this');
  a.equal(sovereignSaid(k).body, 'exactly this', 'with the advisor off nothing may be added');
  await k.stop();

  // (c) A completed turn persists the configuration that actually produced it,
  // and that measurement reaches the next Auto selection. A live member can
  // be reconfigured later; reading its current dropdown would relabel history.
  const captured = join(repo, 'measured-model-prompt.txt');
  stub(`
require('node:fs').writeFileSync(${JSON.stringify(captured)}, process.argv.at(-1));
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message',
  text: ${JSON.stringify(JSON.stringify({ coder: { model: 'codex/gpt-5.6-luna', effort: 'medium' } }))} } }) + '\\n');
`);
  write({ cli: 'codex', model: 'gpt-5.6-luna', promptEngineer: false, autoModel: true, allow: [] }, true);
  k = new Kingdom(repo, cfg);
  await k.start();
  await k.wake('coder');
  const liveCoder = k.agents.get('coder');
  liveCoder.emit('turn_end', { usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 12 }, ctx: 12 });
  const recorded = k.bus.events({ agent: 'coder', type: 'turn_end' }).at(-1).payload;
  a.deepEqual(
    { cli: recorded.cli, model: recorded.model, effort: recorded.effort },
    { cli: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    'turn history must retain the launched model and effort, not infer either later');
  await k.command('use the measured effort history');
  await k.autoModelPending;
  a.match(readFileSync(captured, 'utf8'), /12 output tokens/,
    'the next Auto selection receives this court\'s measured output history');
  await k.stop();

  // (d) nobody is on Auto — the model selector must not be called AT ALL.
  // A member pinned to a model chose it deliberately; there is nothing to pick,
  // and spending an advisor call to throw the answer away is pure cost.
  stub('process.exit(1);');
  write({ cli: 'codex', model: 'gpt-5.6-luna', promptEngineer: false, autoModel: true, allow: [] });
  k = new Kingdom(repo, cfg);
  const quiet = [];
  k.on('error', (e) => quiet.push(e.message));
  await k.start();
  await k.command('no auto members here');
  await k.autoModelPending;
  a.equal(sovereignSaid(k).body, 'no auto members here', 'the order still goes through');
  a.equal(quiet.length, 0, 'with nobody on Auto the selector must never run');
  await k.stop();

  // (e) advisor dead, with a member on Auto — the order still gets through.
  write({ cli: 'codex', model: 'gpt-5.6-luna', promptEngineer: true, autoModel: true, allow: [] }, true);
  k = new Kingdom(repo, cfg);
  const warned = [];
  k.on('error', (e) => warned.push(e.message));
  await k.start();
  await k.command('ship it');
  a.equal(sovereignSaid(k).body, 'ship it', 'a broken advisor must not eat the order');

  // Model selection no longer blocks the order — it only ever changes sleeping
  // members, and awaiting it put the advisor's 90s timeout between the
  // sovereign pressing enter and the orchestrator hearing anything. So its complaint
  // lands after command() has already returned. Wait for it rather than racing.
  await k.autoModelPending;   // deterministic: no polling, no race
  a.equal(warned.length, 2, 'each failing advisor job must complain exactly once');
  for (const w of warned) a.match(w, /gave no advice/);

  // ...and then stop. A failing advisor must not turn into a warning storm.
  await new Promise((r) => setTimeout(r, 300));
  a.equal(warned.length, 2, 'and must not keep repeating itself');
  await k.stop();

  console.log('  command(): brief delivered, original preserved, failure harmless');
  try { rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
}

// Best effort: the killed hang-stub can still hold the directory open on
// Windows for a moment, and a temp dir we could not delete is not a failure.
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-advisor.js OK — advice is optional, the allowlist is not');
