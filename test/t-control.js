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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir, dbPath, createWorktree, removeWorktree } from '../src/worktree.js';
import { listSkills } from '../src/skills.js';

process.env.KINGDOM_CODEX_BIN = process.execPath;   // a spawn that costs nothing
process.env.KINGDOM_SETTLE_MS = '120';

// Sandbox homedir(): kingdomDir(null) is a REAL path under it, and this test
// writes a database and restarts members there. os.homedir() reads these at
// call time, so setting them before anything is constructed is enough.
const fakeHome = mkdtempSync(join(tmpdir(), 'kingdom-ctl-home-'));
const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const savedPushTimeout = process.env.KINGDOM_PUSH_TIMEOUT_MS;
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const dir = mkdtempSync(join(tmpdir(), 'kingdom-ctl-'));
const repo = join(dir, 'repo');
const otherRepo = join(dir, 'other-repo');
const vault = join(dir, 'vault');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: repo });
writeFileSync(join(repo, 'README.md'), '# control\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
execFileSync('git', ['init', '-q', otherRepo]);
execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: otherRepo });
execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: otherRepo });
writeFileSync(join(otherRepo, 'README.md'), '# other control\n');
execFileSync('git', ['add', '-A'], { cwd: otherRepo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: otherRepo });

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  a.throws(() => k.reject('missing'), /No pending approval missing/,
    'a stale rejection must fail instead of looking like it resolved an approval');

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
  a.equal(k.bus.get(`session:${who}:default`), '',
    'its session must be dropped too, or the CLI resumes the old thread in the old cwd');

  // Re-attaching the same repo must not cost the court another respawn.
  const settled = k.agents.get(who);
  await k.attachRepo(repo);
  a.equal(k.agents.get(who), settled,
    'a member already standing in the repo must be left alone on a re-attach');
  await a.rejects(k.attachRepo(otherRepo), /requires a fresh court/,
    'changing repositories mid-court must be refused before old worktrees can survive');
  a.equal(k.repo, repo, 'a refused repository switch must leave the attached repository unchanged');
  a.equal(k.agents.get(who), settled, 'a refused repository switch must not restart the settled court');

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
    { name: 'set_mode', arguments: { mode: 'cowork', why: 'this needs delegated workspace work' } },
  ], { db });

  a.match(said[0], /No such mode/,
    'an unknown mode must be refused BY NAME: modeName() falls back to DEFAULT_MODE, '
    + 'so a typo that reached it would quietly put the whole court into Code');
  a.equal(k.mode(), 'chat', 'and nothing may have moved yet');

  a.ok(await until(() => k.mode() === 'cowork'),
    `the court must actually switch, still in ${k.mode()}`);

  // The other half of the gate: hidden where they cannot work is only correct
  // if they are THERE where they can. Cowork has a bench.
  const inCowork = mcp([], { db }).tools;
  a.ok(inCowork.includes('wake_member') && inCowork.includes('dismiss_member'),
    'and both must appear once the court has a crew to act on');

  // A member process reads this independently of the court. A torn roster
  // record must reject an assignment, never crash the tool or claim it sent.
  const savedRoster = k.bus.get('roster');
  k.bus.set('roster', '{broken');
  const corruptRoster = mcp([{ name: 'assign', arguments: { to: 'coder', task: 'must not be sent' } }], { db });
  a.match(corruptRoster.said[0], /roster is unavailable/,
    'a corrupt roster must turn assignment into an explicit refusal');
  k.bus.set('roster', savedRoster);

  k.setGoal({ text: 'keep the MCP state readable' });
  const savedGoal = k.bus.get('goal');
  k.bus.set('goal', '{broken');
  const corruptGoal = mcp([{ name: 'goal', arguments: {} }], { db });
  a.match(corruptGoal.said[0], /standing goal is unreadable/,
    'a corrupt goal must be explained instead of failing the member tool');
  k.bus.set('goal', savedGoal);

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

  /* ---- 3c. dismissing a member must not orphan the work it claimed ------- */
  // Watched live: "backend" finished #3 and claimed #5 while #3 was in review.
  // #3 merged, mergeWork() slept it to drop the worktree, and #5 stayed active
  // under an owner the court no longer had. claim_task refuses an owned task,
  // so nobody could take it; the orchestrator read "active" as work in hand.
  // The build stopped and the board said it was running.
  {
    const held = k.bus.addTask({ title: 'Integrate the CLI', by: 'orchestrator' });
    const other = k.bus.addTask({ title: 'Untouched by anyone', by: 'orchestrator' });
    a.equal(k.bus.claimTask('coder', held).ok, true, 'sanity: the claim must land');

    k.sleep('coder');

    const after = k.bus.task(held);
    a.equal(after.owner, null, 'a dismissed member must not keep holding a task nobody can take');
    a.equal(after.state, 'pending', 'and it must be claimable again, not stuck in active');
    a.ok(k.bus.availableTasks().some((x) => x.id === held),
      'availableTasks is what claim_task offers — the released task must appear there');

    a.equal(k.bus.task(other).owner, null, 'sanity: an unclaimed task is untouched');

    a.ok(k.bus.history({ limit: 400 }).some((m) =>
      m.recipient === k.config.orchestrator.name && /still holding/.test(m.body)
      && new RegExp(`#${held}`).test(m.body)),
    'and the orchestrator must be told, or it goes on reporting the task as in progress');

    console.log('  a dismissed member releases its claims, and the king hears about it');
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

  /* ---- 5. pausing freezes new turns without dismissing anyone ------------ */
  // The king could previously only stop a member by dismissing it — which
  // costs a full re-summon and re-brief to undo. This is the cheap version:
  // freeze delivery, leave the roster and every session exactly as it was.
  {
    await k.wake('coder');
    a.equal(k.paused, false, 'sanity: the court is not paused to start');

    const pausedEvents = [];
    k.on('paused', (e) => pausedEvents.push(e));

    const r1 = k.pause('checking something');
    a.equal(r1.changed, true);
    a.equal(k.paused, true);
    a.equal(k.bus.get('paused'), '1', 'must persist — a crash or redeploy must not silently lift it');
    a.deepEqual(pausedEvents[0], { paused: true, why: 'checking something' });

    const r2 = k.pause('again');
    a.equal(r2.changed, false, 'pausing an already-paused court is a no-op, not a second event');
    a.equal(pausedEvents.length, 1);

    const beforeLen = delivered.length;
    k.bus.post('sovereign', 'coder', 'do something', 'assignment');
    await wait(400);
    a.equal(delivered.slice(beforeLen).some((d) => d.to === 'coder'), false,
      'a message queued while paused must not be handed out — that is the entire feature');

    // Lifted the same way every other court-issued lever travels: a `control`
    // row the orchestrator's own MCP tool posts, swept on the next tick.
    k.bus.post('coder', null, JSON.stringify({ op: 'resume' }), 'control');
    a.ok(await until(() => k.paused === false), 'resume must actually take effect');
    a.equal(k.bus.get('paused'), '0');
    a.equal(pausedEvents[pausedEvents.length - 1].paused, false);

    a.ok(await until(() => delivered.slice(beforeLen).some((d) => d.to === 'coder')),
      'and the queued message must now go out — nothing paused twice is lost, only delayed');

    // Persistence: a pause set before a restart must still hold after one.
    k.pause('about to restart');
    await k.stop();
    k = new Kingdom(null, configPath);
    k.on('error', () => {});
    k.on('delivered', (d) => delivered.push(d));
    await k.start();
    a.equal(k.paused, true, 'a paused court must come back paused, the same way `summoned` comes back restored');
    k.resume();   // leave a clean state for what follows

    console.log('  a pause freezes delivery without touching the roster, and survives a restart');
  }

  /* ---- 6. the orchestrator can move a stuck task without a dismissal ----- */
  // Previously the only way to move a claimed task off a member was
  // dismiss_member — which also drops its worktree and its session. A task
  // stuck with a member that will not finish it needed all of that just to
  // free up nine words of ownership.
  {
    const t = k.bus.addTask({ title: 'Reassign me', by: 'orchestrator' });
    a.equal(k.bus.claimTask('coder', t).ok, true, 'sanity: coder holds it to start');

    const { said } = mcp([
      { name: 'reassign_task', arguments: { id: t, to: 'nobody-home' } },
      { name: 'reassign_task', arguments: { id: t, to: 'briefer' } },
    ], { db });

    a.match(said[0], /not summoned/, 'cannot reassign to somebody not in service');
    a.match(said[1], /Reassigned/);

    const after = k.bus.task(t);
    a.equal(after.owner, 'briefer', 'ownership must actually move');
    a.equal(after.state, 'active', 'and stay workable, not reset to pending');

    a.ok(k.bus.history({ limit: 400 }).some((m) =>
      m.recipient === 'briefer' && /reassigned to you/.test(m.body) && new RegExp(`#${t}`).test(m.body)),
    'the new owner must be told, with the task content, not left to discover it via tasks()');
    a.ok(k.bus.history({ limit: 400 }).some((m) =>
      m.recipient === 'coder' && /reassigned to briefer/.test(m.body)),
    'and the old owner must be told to stop, or it keeps working a task it no longer owns');

    // #53: a task awaiting controller verification must not be reset to active
    const v = k.bus.addTask({ title: 'Verify me', by: 'orchestrator' });
    a.equal(k.bus.claimTask('coder', v).ok, true);
    k.bus.updateTask(v, { state: 'verifying' });
    const { said: vs } = mcp([{ name: 'reassign_task', arguments: { id: v, to: 'briefer' } }], { db });
    a.match(vs[0], /being verified/, 'reassigning mid-verification must be refused');
    a.equal(k.bus.task(v).state, 'verifying', 'and the task must keep its verifying state');
    a.equal(k.bus.task(v).owner, 'coder');

    console.log('  the orchestrator can move a stuck task without a dismissal round-trip');
  }

  /* ---- 7. an outward push needs its own, one-time sovereign approval ----- */
  {
    // §5 deliberately restarted the workspace court without a command-line
    // repo. Real push is Code-only, so attach the fixture base again here.
    if (!k.repo) await k.attachRepo(repo);
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
    const remote = join(dir, 'push-remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: remote });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
    execFileSync('git', ['config', `branch.${branch}.remote`, 'origin'], { cwd: repo });
    execFileSync('git', ['config', `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd: repo });

    const pushed = [];
    const blocked = [];
    k.on('pushed', (e) => pushed.push(e));
    k.on('pushBlocked', (e) => blocked.push(e));

    const asked = mcp([{ name: 'request_push', arguments: {
      reason: 'publish the reviewed local base', force: true,
    } }], { db }).said[0];
    a.match(asked, /Push proposed/, 'the tool must return after posting an approval, not push in the caller turn');
    a.ok(await until(() => [...k.approvals.values()].some((p) => p.kind === 'push')),
      'a push must be a distinct approval kind, not a summon or merge');
    a.equal(execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: remote, encoding: 'utf8' }).trim(), '',
      'requesting a push must not touch its remote before the sovereign approves');
    const first = [...k.approvals].find(([, p]) => p.kind === 'push')[0];
    const proposal = JSON.parse(k.bus.history({ limit: 50 }).find((m) => m.id === first).body);
    a.equal(proposal.force, undefined, 'there is no force-push request path to approve');

    await k.approve(first);
    a.equal(pushed.length, 1, 'one approval must cause exactly one push attempt');
    a.equal(k.bus.get(`resolved:${first}`), 'approved');
    a.equal(execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf8' }).trim(),
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    'the approved plain push must update the configured upstream branch');

    // Make the two sides diverge. A force push would replace this remote head;
    // the only safe result is a blocked card and the remote left as it was.
    writeFileSync(join(repo, 'local-after-push.txt'), 'local\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'local after push'], { cwd: repo });
    const other = join(dir, 'push-other');
    execFileSync('git', ['clone', '-q', remote, other]);
    execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: other });
    writeFileSync(join(other, 'remote-after-push.txt'), 'remote\n');
    execFileSync('git', ['add', '-A'], { cwd: other });
    execFileSync('git', ['commit', '-qm', 'remote after push'], { cwd: other });
    execFileSync('git', ['push'], { cwd: other });
    const remoteHead = execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf8' }).trim();

    const secondAsked = mcp([{ name: 'request_push', arguments: { reason: 'try a diverged upstream' } }], { db }).said[0];
    a.match(secondAsked, /Push proposed/);
    a.ok(await until(() => [...k.approvals.values()].filter((p) => p.kind === 'push').length === 1));
    const second = [...k.approvals].find(([, p]) => p.kind === 'push')[0];
    await k.approve(second);
    a.equal(blocked.length, 1, 'a rejected non-fast-forward push must report a blocked result');
    a.equal(k.bus.get(`resolved:${second}`), 'blocked', 'remote divergence must stay visible on the approval card');
    a.equal(execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf8' }).trim(), remoteHead,
      'the divergence proves force-push is unreachable: the remote head remains untouched');

    const hungRemote = join(dir, 'push-hung.git');
    execFileSync('git', ['init', '--bare', '-q', hungRemote]);
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: hungRemote });
    writeFileSync(join(hungRemote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 2\n');
    chmodSync(join(hungRemote, 'hooks', 'pre-receive'), 0o755); // git skips a non-executable hook silently
    execFileSync('git', ['remote', 'set-url', 'origin', hungRemote], { cwd: repo });
    process.env.KINGDOM_PUSH_TIMEOUT_MS = '150';

    const thirdAsked = mcp([{ name: 'request_push', arguments: { reason: 'prove a hanging remote is bounded' } }], { db }).said[0];
    a.match(thirdAsked, /Push proposed/);
    a.ok(await until(() => [...k.approvals.values()].filter((p) => p.kind === 'push').length === 1));
    const third = [...k.approvals].find(([, p]) => p.kind === 'push')[0];
    const started = Date.now();
    await k.approve(third);
    a.ok(Date.now() - started < 1_500, 'a timed-out push must return control instead of wedging the court');
    a.equal(k.bus.get(`resolved:${third}`), 'blocked');
    a.match(JSON.parse(k.bus.get(`push:${third}`)).message, /timed out/i,
      'the timeout must become a human-readable blocked result, not a silent failure');
    process.env.KINGDOM_PUSH_TIMEOUT_MS = savedPushTimeout;
    // The killed client has already returned; this only lets the local bare
    // repository's deliberate two-second hook exit before fixture cleanup.
    await wait(2_100);

    console.log('  push waits for one approval, never forces divergence, and turns timeout into a blocked card');
  }

  /* ---- 8. a restart must not inherit a task nobody in the court can work -- */
  // sleep() releases what a dismissed member held, but a member can also leave
  // without ever being dismissed: drop it from kingdom.config.json and the
  // restore loop in start() silently skips it, because specOf() no longer
  // answers for the name. Its claims survive with an owner the court does not
  // have — claimTask refuses an owned task, so nobody may take it, and the
  // orchestrator goes on reporting it as active. Same deadlock as a dismissal,
  // reached without one. This is the boot-time half of the same invariant.
  {
    await k.wake('coder');   // it has to actually be in service before it can leave it
    const stranded = k.bus.addTask({ title: 'Work held by a departed hand', by: 'orchestrator' });
    const mine = k.bus.addTask({ title: 'Held by somebody still here', by: 'orchestrator' });
    a.equal(k.bus.claimTask('coder', stranded).ok, true, 'sanity: the claim must land');
    a.equal(k.bus.claimTask('briefer', mine).ok, true, 'sanity: the second claim must land');
    a.ok(JSON.parse(k.bus.get('summoned') ?? '[]').includes('coder'),
      'sanity: the departing member must be in the persisted roster to begin with');

    // The sovereign edits the roster between runs. Nothing dismisses anybody.
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.peasants = cfg.peasants.filter((p) => p.name !== 'coder');
    writeFileSync(configPath, JSON.stringify(cfg));

    await k.stop();
    k = new Kingdom(null, configPath);
    k.on('error', () => {});
    await k.start();

    a.equal(k.summoned.has('coder'), false,
      'sanity: a name the config no longer carries must not be restored — that is the setup');
    const after = k.bus.task(stranded);
    a.equal(after.owner, null,
      'a restart must not inherit a task owned by somebody no longer in the court: nobody can claim it');
    a.equal(after.state, 'pending', 'and it must be claimable again, not stuck in active');
    a.ok(k.bus.availableTasks().some((x) => x.id === stranded),
      'availableTasks is what claim_task offers — the released task must appear there');

    a.equal(k.bus.task(mine).owner, 'briefer',
      'and a task held by somebody still in service must be left exactly alone');

    a.ok(k.bus.history({ limit: 400 }).some((m) =>
      m.recipient === k.config.orchestrator.name && /no longer in this court/.test(m.body)
      && new RegExp(`#${stranded}`).test(m.body)),
    'the orchestrator must be told, or it goes on reporting the task as in progress');

    console.log('  a restart releases work held by members the config no longer carries');
  }

  /* ---- 9. a paused run's failed reconciliation must not vanish silently -- */
  // #reconcileRun already retries a paused run at restart (its own allow-list
  // already includes 'paused'), but #runBlock — the only place that turns a
  // reconciliation failure into a recorded blocker, a notice, and a 'run'
  // event — did not, so the failure disappeared with no state change and no
  // concrete next action, contradicting HANDOFF.md's "Degrade visibly".
  {
    await k.stop();
    // Repo known at construction, the way a real daemon boots for a court
    // already attached to a project — this is the only path that reaches
    // #reconcileRun() while a run is still 'paused' (see start(), which calls
    // it before this.paused is restored).
    k = new Kingdom(repo, configPath);
    k.on('error', () => {});
    await k.start();

    const run = await k.createRun({ objective: 'prove a paused run surfaces a broken worktree' });
    k.pauseRun(run.id);
    a.equal(k.bus.run(run.id).state, 'paused', 'sanity: the run is paused before the restart');

    // Make the next reconciliation attempt fail for real: a plain file now
    // occupies the run worktree's parent directory, so createRunWorktree's
    // own mkdirSync cannot recover by recreating it — the same class of
    // corruption the issue names ("the repo directory moved, or the worktree
    // metadata got corrupted").
    const runsDir = join(kingdomDir(repo), 'runs');
    rmSync(runsDir, { recursive: true, force: true });
    writeFileSync(runsDir, 'not a directory');

    await k.stop();
    k = new Kingdom(repo, configPath);
    k.on('error', () => {});
    const runEvents = [];
    k.on('run', (r) => runEvents.push(r));
    await k.start();

    a.equal(k.bus.run(run.id).state, 'blocked',
      'a paused run whose worktree cannot be reconciled at restart must become visibly blocked, not stay silently paused');
    a.ok(runEvents.some((r) => r.id === run.id && r.state === 'blocked'),
      'the blocked transition must actually be emitted, not just written');
    a.ok(k.bus.history({ limit: 400 }).some((m) =>
      m.recipient === k.config.orchestrator.name && /RUN BLOCKED: startup reconciliation/.test(m.body)),
    'the orchestrator must be told, or the failure has no visible next action');

    rmSync(runsDir, { force: true });
    // This section deliberately paused the court to reach #reconcileRun()
    // while a run was still 'paused' (see the comment above) — resume it, or
    // every section after this one silently inherits a paused, un-delivering
    // court, the same way a leftover 'blocked' run would.
    k.resume();
    console.log("  a paused run's failed reconciliation at restart becomes a visible blocker, not silence");
  }

  /* ---- 10. a merge approval must not race a concurrent reject ----------- */
  // approve()'s 'merge' branch used to await the merge before deleting the
  // approval, unlike every other branch (including 'push', right below it in
  // source, which is careful to delete first) — leaving a window where
  // reject(id) could still find and "reject" an approval whose merge was
  // already in flight or had already landed.
  {
    if (!k.repo) await k.attachRepo(repo);
    // Earlier sections dropped 'coder' from the roster, or replaced `k`
    // entirely via a restart; restore it here rather than reuse a name the
    // court no longer recognises.
    if (!k.specOf('coder')) k.config.peasants.push({ name: 'coder', cli: 'codex', description: 'writes code' });
    k.setMode('code', { why: 'prove the merge approval race is closed' });
    await k.wake('coder');
    const wt = k.agents.get('coder').cwd;
    writeFileSync(join(wt, 'race.txt'), 'merge race fixture\n');
    execFileSync('git', ['add', '-A'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'prove the merge race is closed'], { cwd: wt });

    k.bus.post('orchestrator', null, JSON.stringify({ kind: 'merge', peasant: 'coder' }), 'approval');
    await until(() => [...k.approvals.values()].some((p) => p.kind === 'merge' && p.peasant === 'coder'));
    const approvalId = [...k.approvals].find(([, p]) => p.kind === 'merge')[0];

    const approving = k.approve(approvalId);
    // approve()'s merge branch runs synchronously up to its first await, so a
    // correct implementation has already consumed the approval by the time
    // this next line runs — a concurrent reject must find nothing left.
    a.throws(() => k.reject(approvalId), /No pending approval/,
      'a merge approval must be consumed before the merge is awaited, or a concurrent reject can still catch it mid-flight');
    await approving;
    a.equal(k.bus.get(`resolved:${approvalId}`), 'approved');
    a.equal(k.approvals.has(approvalId), false);

    console.log('  a merge approval is consumed before the merge is awaited, closing the reject race');
  }

  /* ---- 11. stopping a run must clean up like any other departure -------- */
  // stopRun killed each run-owned worker's process directly instead of
  // routing through sleep() — skipping exactly the reconciliation sleep()
  // exists to perform: dropping the name from `summoned` and releasing its
  // still-open tasks. A stopped run's worker used to silently respawn on the
  // next message reaching its inbox, and its tasks stayed falsely "owned".
  {
    if (!k.repo) await k.attachRepo(repo);
    // Earlier sections dropped 'coder' from the roster, or slept it as part
    // of a completed merge; restore it here rather than reuse a name the
    // court no longer recognises.
    if (!k.specOf('coder')) k.config.peasants.push({ name: 'coder', cli: 'codex', description: 'writes code' });
    await k.wake('coder');

    // §9 above deliberately leaves its run 'blocked' to prove the state
    // sticks — createRun refuses a second run while one is still active, so
    // that leftover has to be cleared before this section can start its own.
    if (k.bus.currentRun()) await k.stopRun(undefined, 'test cleanup: clear the previous section\'s run');
    const run = await k.createRun({ objective: 'prove stopRun cleans up like any other departure' });
    const task = k.bus.addTask({ title: 'stop-run cleanup fixture', by: 'orchestrator', runId: run.id });
    k.bus.updateRun(run.id, { taskIds: [task] });
    a.equal(k.bus.claimTask('coder', task).ok, true, 'sanity: coder holds the run-owned task');
    a.ok(k.summoned.has('coder'), 'sanity: coder is in service before the run is stopped');

    const stopped = k.stopRun(run.id, 'prove cleanup');
    a.equal(stopped.state, 'cancelled');
    a.equal(k.agents.has('coder'), false, 'the stopped worker\'s process must be gone');
    a.equal(k.summoned.has('coder'), false,
      'a stopped run must not leave its worker in `summoned` — the delivery loop respawns anyone still there');
    const after = k.bus.task(task);
    a.equal(after.owner, null,
      'a stopped run must release what its worker still held — nobody may otherwise claim it again');
    a.equal(after.state, 'pending', 'and it must be claimable again, not stuck in active');
    a.ok(k.bus.history({ limit: 400 }).some((m) =>
      m.recipient === k.config.orchestrator.name && /left service still holding/.test(m.body)
      && new RegExp(`#${task}`).test(m.body)),
    'the orchestrator must be told, or it goes on reporting the task as in progress');

    console.log('  stopping a run releases its worker\'s claims exactly like any other departure');
  }

  /* ---- 12. #onDone must not silently clear a run blocked by someone else - */
  // #onDone set the run to 'verifying' or 'blocked' from whichever
  // submission happened to arrive last, with no check of the run's existing
  // state, bypassing transitionRun's allowed-transition map entirely by
  // writing state directly. A later, unrelated peasant's PASSING submission
  // could silently clear a run already blocked on a DIFFERENT peasant's
  // still-unresolved failure.
  {
    if (!k.repo) await k.attachRepo(repo);
    // §11 above stops its own run when it finishes, but clear defensively in
    // case a future section is inserted between these two.
    if (k.bus.currentRun()) await k.stopRun(undefined, 'test cleanup: clear the previous section\'s run');
    const run = await k.createRun({ objective: 'prove onDone cannot clear a blocker it did not cause' });

    const aliceWt = await createWorktree(repo, 'alice', k.base);
    writeFileSync(join(aliceWt, 'package.json'), JSON.stringify({
      name: 'alice-fixture', type: 'module', scripts: { test: 'node -e "process.exit(1)"' },
    }));
    execFileSync('git', ['add', '-A'], { cwd: aliceWt });
    execFileSync('git', ['commit', '-qm', 'alice: a failing test'], { cwd: aliceWt });

    const bobWt = await createWorktree(repo, 'bob', k.base);
    writeFileSync(join(bobWt, 'package.json'), JSON.stringify({
      name: 'bob-fixture', type: 'module', scripts: { test: 'node -e "process.exit(0)"' },
    }));
    execFileSync('git', ['add', '-A'], { cwd: bobWt });
    execFileSync('git', ['commit', '-qm', 'bob: a passing test'], { cwd: bobWt });

    const aliceId = k.bus.post('alice', k.config.orchestrator.name, 'alice: broken work', 'done');
    await until(() => Boolean(k.bus.get(`done:${aliceId}`)));
    await until(() => k.bus.run(run.id)?.state === 'blocked');
    a.equal(k.bus.run(run.id).state, 'blocked', "sanity: alice's failing submission must block the run");

    const bobId = k.bus.post('bob', k.config.orchestrator.name, 'bob: unrelated finished work', 'done');
    await until(() => Boolean(k.bus.get(`done:${bobId}`)));
    // `done:${bobId}` is set BEFORE #onDone runs (kingdom.js's dedup guard), so it
    // fires the instant the tick claims the message, not once #onDone is done with
    // bob's worktree. Bob's submission is valid, so #onDone never calls #runBlock —
    // there is no run-state transition to wait on the way alice's failure gives us
    // above — so the only real completion signal is `tests:${peasant}`, which
    // #onDone sets last, right after its own diffOf/statOf finish touching the
    // worktree. A fixed sleep here raced removeWorktree(repo, 'bob') below against
    // those still-running git calls on Windows CI (commitAll + revisionOf x2 +
    // runTests + diffOf + statOf is ~7 subprocesses at ~100ms each), producing a
    // "not a working tree" fatal when the removal outran them.
    await until(() => Boolean(k.bus.get('tests:bob')));
    a.equal(k.bus.run(run.id).state, 'blocked',
      "a run blocked on one peasant's failure must not be silently cleared back to verifying by a "
      + "different, unrelated peasant's success");

    // A raw rmSync of the still-live git worktrees below (in the outer
    // finally block) can EPERM on Windows over a lingering git file handle;
    // removing them properly first releases that the way git itself does.
    await removeWorktree(repo, 'alice');
    await removeWorktree(repo, 'bob');

    console.log("  onDone cannot silently clear a run's blocker with an unrelated peasant's success");
  }

  /* ---- 13. recovery-attempt counting must be per (name, operation) ------- */
  // #recordRecovery's returned `attempts` used to be the WHOLE run's
  // recoveryHistory.length — any entry, for any worker, of any kind.
  // #escalateFailure blocks the entire run once that count reaches 2, so a
  // benign, already-handled transport-retry on one worker plus one real
  // failure on an unrelated worker could block everyone, even though
  // neither worker had actually failed twice.
  {
    if (!k.repo) await k.attachRepo(repo);
    // §12 above stops its own run when it finishes, but clear defensively in
    // case a future section is inserted between these two.
    if (k.bus.currentRun()) await k.stopRun(undefined, 'test cleanup: clear the previous section\'s run');
    // Earlier sections dropped 'coder' from the roster, or replaced `k`
    // entirely via a restart; restore it here rather than reuse a name the
    // court no longer recognises.
    if (!k.specOf('coder')) k.config.peasants.push({ name: 'coder', cli: 'codex', description: 'writes code' });
    await k.wake('coder');
    await k.wake('briefer');

    const run = await k.createRun({ objective: 'prove recovery counting is per worker, per kind' });

    // coder hits a session-limit blip: rewindForRetry records a
    // transport-retry entry, and the session-limit branch always returns
    // before reaching escalateFailure — coder is never itself escalated.
    k.lastBatch.set('coder', { from: 1, to: 2 });
    k.agents.get('coder').emit('error', 'session limit reached, resets tomorrow');
    await until(() => (k.bus.run(run.id)?.recoveryHistory ?? []).length >= 1);
    a.equal(k.bus.run(run.id).recoveryHistory.length, 1, "sanity: coder's blip is recorded");

    // briefer then fails once, for real, on something unrelated to coder.
    k.agents.get('briefer').emit('error', 'the process crashed unexpectedly');
    await until(() => Boolean(k.bus.get('failnotify:briefer')));
    await wait(200);   // let the async error handler's recordRecovery land

    a.notEqual(k.bus.run(run.id).state, 'blocked',
      "one worker's already-resolved retry plus a different worker's single real failure must not "
      + 'block the whole run — neither worker actually failed twice');

    console.log('  a benign retry on one worker cannot combine with an unrelated single failure to block the run');
  }

  console.log('t-control.js OK — a live court follows the repo, and the court can steer itself');
} finally {
  await k?.stop?.();   // closes the bus with it
  Object.assign(process.env, savedEnv);
  if (savedPushTimeout == null) delete process.env.KINGDOM_PUSH_TIMEOUT_MS;
  else process.env.KINGDOM_PUSH_TIMEOUT_MS = savedPushTimeout;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
