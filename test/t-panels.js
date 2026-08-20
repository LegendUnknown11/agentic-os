// The three panels that report on the court: metrics, diff/merge, vault.
//
// The one with teeth is metrics. Codex reports `usage` CUMULATIVELY PER THREAD
// in turn.completed, so a naive sum counts every earlier turn again — on a real
// run that turned 65M input tokens into an apparent 420M, and every cost
// decision made from that number was wrong. This pins the delta arithmetic,
// including the session restart that makes the counter drop.
//
//   node test/t-panels.js
import { strict as a } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from '../src/bus.js';
import { dbPath, kingdomDir, createWorktree, worktreePath } from '../src/worktree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const repo = mkdtempSync(join(tmpdir(), 'kingdom-panels-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
writeFileSync(join(repo, 'app.js'), 'const a = 1;\nconst b = 2;\n');
git('add', '-A');
git('commit', '-qm', 'init');
// git init's default branch is master here and main elsewhere; ask, do not assume.
const BASE = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

// A vault to browse, with a note that only matches by filename.
const vault = mkdtempSync(join(tmpdir(), 'kingdom-panelvault-'));
mkdirSync(join(vault, 'References'), { recursive: true });
mkdirSync(join(vault, '.obsidian'), { recursive: true });
writeFileSync(join(vault, 'References', 'Effort Levels.md'), '# Effort\nluna goes to max\n');
writeFileSync(join(vault, 'Roster.md'), '# Roster\nthe coder runs on luna\n');
writeFileSync(join(vault, '.obsidian', 'workspace.md'), 'luna luna luna\n');

const cfg = join(repo, 'kingdom.config.json');
writeFileSync(cfg, JSON.stringify({
  vault,
  maxKingdomUsd: 75,
  maxBudgetUsd: 5,
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  // codex here has no $/token — it runs against a subscription plan's own
  // token allowance, not a metered key. See t-panels.js section 1.
  quotas: { codex: { label: 'Test Plan', limitTokens: 200_000 } },
}));

/* ---------- seed turn_end events BEFORE the daemon opens the bus ---------- */
// Two threads' worth for the orchestrator: the counter climbs, then DROPS when the
// session restarts. A sum would report 30+60+90+25+50 = 255k. The truth is
// 90k from the first thread plus 50k from the second = 140k.
{
  const bus = new Bus(dbPath(repo));
  const turn = (agent, input, ctx) => bus.logEvent(agent, 'turn_end',
    { usage: { input_tokens: input, output_tokens: Math.round(input / 100), cached_input_tokens: 0 }, ctx });
  turn('orchestrator', 30_000, 10_000);
  turn('orchestrator', 60_000, 20_000);
  turn('orchestrator', 90_000, 30_000);
  turn('orchestrator', 25_000, 8_000);     // <- recycled: a fresh thread, counter resets
  turn('orchestrator', 50_000, 14_000);
  turn('coder', 40_000, 12_000);
  bus.set('spentUsd', '3.50');
  bus.set('spent:orchestrator', '2.00');
  // One good approval and two the throne room cannot render. The UI does
  // `TITLES[a.kind] ?? a.kind.toUpperCase()`, so an entry with no `kind` threw
  // and took the whole approvals pass down with it — including the pending one
  // the sovereign was waiting on. A bad row must cost only itself.
  bus.post('orchestrator', null, JSON.stringify({ kind: 'summon', names: ['coder'], reason: 'work' }), 'approval');
  bus.post('orchestrator', null, 'this is not json at all', 'approval');
  bus.post('orchestrator', null, JSON.stringify({ reason: 'parses, but has no kind' }), 'approval');
  // A task list the sovereign can see. #2 waits on #1, so the panel must be
  // able to distinguish "nobody has taken this" from "nobody CAN take it yet".
  const t1 = bus.addTask({ title: 'write the parser', by: 'orchestrator' });
  bus.addTask({ title: 'test the parser', needs: [t1], by: 'orchestrator' });
  bus.claimTask('coder', t1);
  // In service, because only a summoned member can reach claim_task at all —
  // the MCP server that carries it runs per spawned agent. Without this the
  // fixture describes a task held by somebody the court does not have, which
  // start() now releases on sight (a dismissed or config-dropped member used
  // to strand its claims forever). That is a different scenario than the one
  // this fixture is for.
  bus.set('summoned', JSON.stringify(['coder']));
  bus.close();
}

const PORT = 7960 + (process.pid % 30);
const base = `http://127.0.0.1:${PORT}`;
process.env.KINGDOM_CODEX_BIN = process.execPath;

const daemon = spawn(process.execPath,
  [join(HERE, '..', 'src', 'daemon.js'), repo, '--port', String(PORT), '--config', cfg],
  { stdio: 'ignore', env: process.env });

const up = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) return true; } catch {}
    await wait(250);
  }
  return false;
};
a.ok(await up(), 'the daemon must come up');
const get = (p) => fetch(base + p).then((r) => r.json());
const post = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

try {
  /* ---------- 1. metrics: deltas, not sums ---------- */
  {
    const m = await get('/api/metrics');
    a.ok(m.ok);
    const orchestrator = m.members.find((x) => x.name === 'orchestrator');

    a.equal(orchestrator.turns, 5, 'every turn is counted');
    a.equal(orchestrator.in, 140_000,
      'input must be the sum of DELTAS (90k first thread + 50k after the restart), not 255k');
    a.notEqual(orchestrator.in, 255_000, 'the naive sum is the bug this test exists for');
    a.equal(orchestrator.ctx, 14_000, 'context is the LATEST reading, never a total');
    a.equal(orchestrator.perTurn, 28_000, '140k over 5 turns');
    a.equal(orchestrator.role, 'orchestrator');
    a.equal(orchestrator.spent, 2);

    a.equal(m.total.turns, 6, 'orchestrator 5 + coder 1');
    a.equal(m.total.in, 180_000, '140k + 40k');
    a.equal(m.spent, 3.5);
    a.equal(m.cap, 75);
    a.equal(m.perMemberCap, 5);

    // codex has no $/token in this config — quota tracks its real ceiling
    // (the plan's token allowance) instead of inventing a dollar figure.
    // Both orchestrator and coder run on codex, so their deltaed in+out (the
    // same numbers already proven above, not resummed some other way) land
    // in one bucket: (140,000 + 1,400) + (40,000 + 400) = 181,800.
    const q = m.quotas.find((x) => x.cli === 'codex');
    a.ok(q, 'a cli named in config.quotas appears in the metrics response');
    a.equal(q.label, 'Test Plan');
    a.equal(q.used, 181_800, 'every codex member\'s deltaed tokens, summed across the whole cli');
    a.equal(q.limit, 200_000);
    a.equal(q.pct, 91);
    console.log(`  metrics: orchestrator 5 turns -> ${orchestrator.in} in (a sum would have said 255000)`);
    console.log(`  quota: codex at ${q.pct}% of its plan, no dollar price required`);
  }

  /* ---------- 2. diff of real work ---------- */
  {
    // A peasant with no worktree is a normal state, not an error.
    let d = await get('/api/diff?peasant=coder');
    a.equal(d.ok, true);
    a.equal(d.none, true, 'no worktree yet is reported, not thrown');

    await createWorktree(repo, 'coder', BASE);
    const wt = worktreePath(repo, 'coder');
    writeFileSync(join(wt, 'app.js'), 'const a = 1;\nconst b = 22;\nconst c = 3;\n');
    writeFileSync(join(wt, 'new.js'), 'export const hi = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: wt, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'work'], { cwd: wt, stdio: 'pipe' });

    d = await get('/api/diff?peasant=coder');
    a.equal(d.ok, true);
    a.equal(d.base, BASE);
    a.match(d.stat, /app\.js/, 'the stat must name the changed file');
    a.match(d.stat, /new\.js/, 'and the added one');
    a.match(d.diff, /^\+const c = 3;$/m, 'the diff must carry the added line');
    a.match(d.diff, /^-const b = 2;$/m, 'and the removed one');
    a.equal(d.truncated, false);

    // One file at a time, for when the whole diff is too big to read.
    const one = await get('/api/diff?peasant=coder&file=new.js');
    a.match(one.diff, /new\.js/);
    a.ok(!one.diff.includes('const c = 3'), 'a single-file diff must not carry other files');

    // Only peasants have worktrees; the orchestrator must not be diffable.
    const k = await get('/api/diff?peasant=orchestrator');
    a.equal(k.ok, false);
    const ghost = await get('/api/diff?peasant=nobody');
    a.equal(ghost.ok, false);
    console.log('  diff: stat + patch, per-file view, orchestrator and unknowns refused');
  }

  /* ---------- 2b. the chronicle ---------- */
  {
    // Seed a mixed history: summaries and errors are EVENTS, messages are
    // messages, and the chronicle has to merge two tables into one timeline.
    const { Bus: B } = await import('../src/bus.js');
    const bus = new B(dbPath(repo));
    bus.logEvent('coder', 'summary', { text: 'Fixed the webhook idempotency key.' });
    bus.logEvent('tester', 'summary', { text: 'Ran the suite; two gates still red.' });
    bus.logEvent('coder', 'error', { message: 'ENOENT reading fixtures.json' });
    bus.post('coder', 'tester', 'Try the suite again now.');
    bus.post('coder', 'orchestrator', 'Webhook work is finished.', 'done');
    bus.post('orchestrator', null, 'ignore me', 'notice');        // machinery, not narrative
    bus.post('orchestrator', null, '{"kind":"summon"}', 'approval');
    bus.close();

    const all = await get('/api/chronicle');
    a.ok(all.ok);
    const kinds = new Set(all.rows.map((r) => r.kind));
    a.ok(!kinds.has('notice') && !kinds.has('approval'),
      'notices and approvals are machinery and must not pollute the narrative');
    a.ok(kinds.has('summary') && kinds.has('message') && kinds.has('done') && kinds.has('error'),
      'events and messages must be merged into one timeline');

    // Newest first, always — a chronicle that reads oldest-first is a log file.
    for (let i = 1; i < all.rows.length; i++) {
      a.ok(all.rows[i - 1].ts >= all.rows[i].ts, 'rows must be newest first');
    }

    const hit = await get('/api/chronicle?q=webhook');
    a.equal(hit.total, 2, 'search spans both tables: one summary and one done');
    a.ok(hit.rows.every((r) => /webhook/i.test(r.text)));

    // A term nobody said must return NOTHING. The UI bug this pairs with was a
    // stale response repainting 78 rows over an empty result.
    const none = await get('/api/chronicle?q=zzzznope');
    a.equal(none.total, 0);
    a.deepEqual(none.rows, []);

    const byWho = await get('/api/chronicle?q=tester');
    a.ok(byWho.total >= 2, 'searching a member name finds what they said and what was said to them');

    const only = await get('/api/chronicle?kinds=summary');
    a.ok(only.rows.every((r) => r.kind === 'summary'), 'the kind filter is honoured');
    a.equal(only.total, 2);
    console.log('  chronicle: two tables merged, newest first, filtered and searchable');
  }

  /* ---------- 2c. campaigns: one sovereign order, one bounded interval ---- */
  {
    const { Bus: B } = await import('../src/bus.js');
    const bus = new B(dbPath(repo));
    bus.set('spentUsd', '4');
    bus.set('tokens', '100');
    const first = bus.beginCampaign('ship the parser');
    bus.post('sovereign', 'orchestrator', 'ship the parser', 'assignment');
    bus.logEvent('coder', 'summary', { text: 'Parser campaign finished.' });
    bus.set('spentUsd', '4.5');
    bus.set('tokens', '150');
    bus.close();

    a.ok((await post('/api/command', { text: 'ship the formatter' })).ok,
      'a real sovereign command must start the next campaign');
    await wait(20);

    const fresh = new B(dbPath(repo));
    fresh.logEvent('coder', 'summary', { text: 'Formatter campaign finished.' });
    fresh.set('spentUsd', '5');
    fresh.set('tokens', '190');
    fresh.close();

    const campaigns = await get('/api/campaigns');
    a.equal(campaigns.ok, true);
    a.equal(campaigns.campaigns.length, 2, 'two sovereign orders make two durable intervals');
    const second = campaigns.campaigns.find((c) => c.title === 'ship the formatter');
    a.ok(second, 'the real command names the current campaign');
    a.equal(second.spentUsd, 0.5, 'current spend is the measured state delta, not a forecast');
    a.equal(second.tokens, 40, 'current tokens are the measured state delta, not a cumulative total');
    const old = campaigns.campaigns.find((c) => c.id === first.id);
    a.equal(old.spentUsd, 0.5, 'the next campaign snapshot closes the earlier interval');

    const scoped = await get(`/api/chronicle?campaign=${second.id}`);
    a.ok(scoped.rows.some((r) => /ship the formatter/.test(r.text)));
    a.ok(scoped.rows.some((r) => /Formatter campaign finished/.test(r.text)));
    a.ok(!scoped.rows.some((r) => /parser|Parser campaign/i.test(r.text)),
      'a campaign view must not leak an earlier order\'s narrative');
    console.log('  campaigns: durable order intervals scope activity and measured deltas');
  }

  /* ---------- 3. vault ---------- */
  {
    const recent = await get('/api/vault');
    a.equal(recent.configured, true);
    a.equal(recent.notes.length, 2, 'two notes — .obsidian must not be walked');
    a.ok(!recent.notes.some((n) => n.path.includes('.obsidian')));

    const hits = await get('/api/vault?q=luna');
    a.equal(hits.notes.length, 2);
    a.ok(hits.notes.every((n) => !n.path.startsWith('.')), 'dot-directories stay excluded from search');

    // A filename match counts even when the body never says the word.
    const byName = await get('/api/vault?q=Effort');
    a.equal(byName.notes[0].path, 'References/Effort Levels.md');
    a.equal(byName.notes[0].inName, true);

    const note = await get('/api/vault?path=References/Effort Levels.md');
    a.match(note.body, /luna goes to max/);

    // The containment rule is the same one the agents get, from vault.js.
    for (const bad of ['../../../etc/passwd', '..\\..\\secret.md', '/etc/hosts', '../kingdom.config.json']) {
      const r = await get(`/api/vault?path=${encodeURIComponent(bad)}`);
      a.equal(r.ok, false, `${bad} must not be readable`);
    }
    console.log('  vault: recent, search, filename matches, traversal refused');
  }

  /* ---------- 4. approvals: one unreadable row costs only itself ---------- */
  {
    const r = await get('/api/approvals');
    a.ok(r.ok);
    a.equal(r.approvals.length, 1,
      'the two unrenderable approvals must be dropped, not passed through as {}');
    a.equal(r.approvals[0].kind, 'summon',
      'and the readable one must still arrive — a bad row must not hide a good one');
    a.deepEqual(r.approvals[0].names, ['coder']);
    a.ok(r.approvals.every((x) => typeof x.kind === 'string'),
      'every row handed to the UI must carry the field the UI renders on');
    console.log('  approvals: unreadable rows dropped, the readable one survives');

    // The summon card carries what the crew costs per turn. Hand-derived
    // from the seeded events above: coder took ONE turn of 40,000 input and
    // 400 output. codex is named in config.quotas here, so it is billed
    // against a plan and not a metered key — the card must therefore report
    // tokens and refuse to report dollars, even though the rate card does
    // have a row for it. Inventing a price for a subscription is the exact
    // failure the quota feature exists to prevent.
    const f = r.approvals[0].forecast;
    a.ok(f, 'a pending summon must carry the cost of the crew it proposes');
    a.equal(f.members.length, 1, 'one proposed name, one line on the card');
    a.equal(f.members[0].name, 'coder');
    a.equal(f.members[0].turns, 1, 'one seeded turn_end for coder');
    a.equal(f.members[0].perTurnUsd, null,
      'a quota-billed cli must never be priced from the metered rate card');
    a.equal(f.members[0].perTurnTokens, 40_400,
      'so it reports the tokens it actually burned: 40,000 in + 400 out');
    a.deepEqual(f.crew.unpriced, ['coder'],
      'and the card names WHICH member has no dollar figure, not just how many');
    a.equal(f.crew.perTurnUsd, null,
      'a wholly unpriced crew has no rate — never $0.00, which would read as free');
    console.log('  approvals: the summon card carries a measured burn rate for the crew');
  }

  /* ---------- 5. the task list is visible to the sovereign ---------- */
  {
    const r = await get('/api/tasks');
    a.ok(r.ok);
    a.equal(r.open, 2, 'both tasks are outstanding — a claimed task is not a finished one');
    a.equal(r.available, 0,
      'and neither is claimable: one is held, the other is blocked. "open" and "available" are different questions');
    a.equal(r.tasks[0].owner, 'coder');
    a.deepEqual(r.tasks[1].blockedBy, [r.tasks[0].id],
      'the panel must be told WHAT a task is waiting for, not merely that it waits');
    console.log('  tasks: outstanding, held, and blocked are three distinguishable states');
  }

  console.log('t-panels.js OK — metrics take deltas, diffs are real, bad approvals cost one row, the task list is visible');
} finally {
  daemon.kill();
  await wait(300);
  for (const d of [repo, vault, kingdomDir(repo)]) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
}
