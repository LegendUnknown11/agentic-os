// `/argue` in the throne room.
//
// The argument mechanics — cross-vendor panel, judge that never argued,
// compulsory dissent — are pinned by src/argue.js's own self-check. What this
// covers is the WIRING, which is where a settings-shaped command goes wrong:
// it must answer the sovereign directly, never post itself to the court as
// work, and refuse cleanly when the kingdom cannot staff a panel.
//
// Deliberately never reaches a real model: every path here is one the court
// takes BEFORE spawning anything.
//
//   node test/t-argue.js
import { strict as a } from 'node:assert';

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kingdom } from '../src/kingdom.js';
import { removeRepo } from './cleanup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const repo = mkdtempSync(join(tmpdir(), 'kingdom-argue-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

/** A real MCP peer, so court-only tools cannot be accidentally tested in-process. */
function member(name, role, db) {
  const child = spawn(process.execPath, [join(HERE, '..', 'src', 'mcp.js')], {
    cwd: join(HERE, '..'),
    env: { ...process.env, KINGDOM_AGENT: name, KINGDOM_ROLE: role, KINGDOM_DB: db },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  const waiting = [];
  const fail = (e) => { while (waiting.length) waiting.shift().reject(e); };
  child.on('error', fail);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { waiting.shift()?.resolve(JSON.parse(line)); } catch (e) { fail(e); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  });
  return {
    async start() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      return this;
    },
    async call(tool, args = {}) {
      const r = await rpc('tools/call', { name: tool, arguments: args });
      return r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
    },
    stop() { child.kill(); },
  };
}

const configPath = join(repo, 'kingdom.config.json');
const write = (models) => writeFileSync(configPath, JSON.stringify({
  models,
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

/* ---------- one model cannot argue with itself -------------------------- */
write({ codex: ['gpt-5.6-luna'] });
const solo = new Kingdom(repo, configPath);
solo.config.advisor = { autoModel: false, promptEngineer: false };
const said = [];
solo.on('compact', (d) => said.push(d.message));
const posted = () => solo.bus.history({ limit: 1000 }).length;

const before = posted();
const r1 = await solo.command('/argue should the settle window be longer?');
a.ok(r1.local, 'a refusal must answer the sovereign, not be posted to the court');
a.match(said.at(-1), /two different models/,
  'a single model arguing with itself is corroboration theatre — it must be refused, not faked');
a.equal(posted(), before, 'and nothing may reach the bus');

/* ---------- a question is required -------------------------------------- */
write({ claude: ['opus'], codex: ['gpt-5.6-luna'], agy: ['gemini-3.6-flash-high'] });
const k = new Kingdom(repo, configPath);
k.config.advisor = { autoModel: false, promptEngineer: false };
const heard = [];
k.on('compact', (d) => heard.push(d.message));
const argued = [];
k.on('argued', (d) => argued.push(d));

await k.command('/argue');
a.match(heard.at(-1), /Nothing to argue/);
a.equal(argued.length, 0, 'an empty question must not start a panel');

/* ---------- a real question names its panel before spending anything ---- */
// Stand in for the three model calls. Everything AFTER the argument — the vault
// note, the orchestrator's notice, the completion event — is what this exercises, and
// spawning three real CLIs to reach it would make the suite cost money.
const vault = mkdtempSync(join(tmpdir(), 'kingdom-vault-'));
k.config.vault = vault;
k.config.vaultWriteDir = 'Kingdom';
let sawCwd = null;
k.argueImpl = async (question, opts) => {
  sawCwd = opts.cwd;
  opts.onProgress?.({ stage: 'opening' });
  return {
    question,
    transcript: '### FOR\nthe window absorbs bursts\n\n### AGAINST\nit delays the human',
    verdict: 'VERDICT: keep it.\nBECAUSE: bursts dominate.\nDISSENT: the human waits.\nCONFIDENCE: medium',
    panel: opts.panel,
  };
};

const n = k.bus.history({ limit: 1000 }).length;
const r2 = await k.command('/argue is the 90s settle window too long?');
a.ok(r2.local, 'the command answers immediately — an argument is 3+ model calls, never awaited');
a.match(heard.at(-1), /judged by/, 'the sovereign must see who is arguing and who judges');
a.match(heard.at(-1), /three vendors/, 'and how strong that panel is');
// Nothing an argument produces may be WORK. The verdict notice below is
// allowed — it rides along with real traffic — but an assignment would buy the
// orchestrator a full context replay for a question it never asked.
a.equal(k.bus.history({ since: n, limit: 1000 }).filter((x) => x.kind !== 'notice').length, 0,
  'an argument must never post work to the court — only a notice that rides along');

// The panel it announced must be the cross-vendor one, or the whole point is
// lost: two samples of one model agree for reasons unrelated to the question.
const start = argued.find((d) => d.stage === 'start');
a.ok(start, 'the run must announce itself for the UI');
a.equal(new Set([...start.panel.arguers.map((s) => s.cli), start.panel.judge.cli]).size, 3);

// ...and then the verdict has to actually land somewhere.
// Poll rather than await an event: the argument is fired, not awaited, so with
// a fast implementation it has already finished by the time we could listen —
// and a listener attached too late waits for ever.
const waitFor = async (pred, ms = 5_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    const hit = argued.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { error: 'the argument never finished' };
};
const done = await waitFor((d) => d.stage === 'done' || d.error);
a.ok(!done.error, `the argument must complete: ${done.error ?? ''}`);
a.equal(sawCwd, repo, 'arguers must run in the repo so they can read the code in dispute');
a.ok(done.path && existsSync(done.path), 'the verdict must be written to the vault, not just emitted');
const note = readFileSync(done.path, 'utf8');
a.match(note, /VERDICT: keep it/);
a.match(note, /DISSENT/, 'the dissent must survive into the record, not be edited out');
a.match(note, /<details>/, 'the full argument is kept but folded — the verdict is what gets read');

const last = k.bus.history({ limit: 1000 }).at(-1);
a.equal(last.kind, 'notice',
  'the orchestrator did not ask for this: it must ride along with real traffic, not buy a replay');
a.match(last.body, /VERDICT: keep it/);
a.match(last.body, /AWARENESS ONLY/);

/* ---------- an ordinary order is untouched ------------------------------ */
const m = k.bus.history({ limit: 1000 }).length;
await k.command('/argue-with-me is not a command');
const after = k.bus.history({ since: m, limit: 1000 });
// Assert the MESSAGE ITSELF arrived, not merely that the count moved. Counting
// passed even with the bug present, because the spurious argument it started
// posted its own verdict notice and made up the difference.
a.equal(after.length, 1);
a.equal(after[0].kind, 'assignment',
  'a word that merely STARTS with /argue is an ordinary order to the orchestrator — a word '
  + 'boundary sits before the hyphen, so \\b matched it and swallowed the message');
a.match(after[0].body, /is not a command/, 'and the whole message must survive intact');

rmSync(vault, { recursive: true, force: true });

/* ---------- the COURT can convene one, not just the sovereign ---------- */
// argue.js was built, tested, and reachable only by the sovereign typing
// /argue. The orchestrator that actually hits a contested decision could not call
// for one. Three things have to hold once it can:
//
//   1. the verdict goes back to WHOEVER ASKED. Hardcoding the orchestrator is the
//      bug t-questions.js pins for ask_question; this has the same shape.
//   2. ONE argument at a time. Each is 3-5 calls across two vendors, and a
//      sweep reads up to 50 rows — firing them together multiplies the bill
//      by whatever happened to land in the same window.
//   3. the request must never be DELIVERED. It is posted with a null
//      recipient so the sweep can find it, and a null recipient matches every
//      summoned member in bus.pending() — the trap a milestone notice already
//      fell into, where one FYI bought the whole court a context replay.
process.env.KINGDOM_CODEX_BIN = process.execPath;
const vault2 = mkdtempSync(join(tmpdir(), 'kingdom-vault2-'));
const t = new Kingdom(repo, configPath);
t.config.advisor = { autoModel: false, promptEngineer: false };
t.config.vault = vault2;
t.config.vaultWriteDir = 'Kingdom';
// A non-default name catches a verdict accidentally hardcoded to `orchestrator`.
t.config.orchestrator.name = 'sovereign-regent';

let inFlight = 0;
let maxInFlight = 0;
const ran = [];
t.argueImpl = async (question, opts) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 40));   // long enough to overlap if it could
  ran.push(question);
  inFlight--;
  return {
    question,
    transcript: '### FOR\nyes\n\n### AGAINST\nno',
    verdict: `VERDICT: settled ${question}`,
    panel: opts.panel,
  };
};

const delivered = [];
t.on('delivered', (d) => delivered.push(d));
await t.start();
t.summoned.add('coder');   // so a null-recipient message HAS somewhere wrong to go
const regent = await member('sovereign-regent', 'orchestrator', t.dbPath).start();

const mcpReply = await regent.call('argue', { question: 'from the real MCP server?' });
a.match(mcpReply, /Sent to the argument court/,
  'the MCP tool must fire and return, rather than waiting for a three-model verdict');
a.ok(t.bus.history({ limit: 1000 }).some((x) => x.sender === 'sovereign-regent'
  && x.recipient === null && x.kind === 'argue' && /real MCP server/.test(x.body)),
  'the real MCP server must queue the question for the Kingdom sweep');
a.equal(ran.length, 0, 'the MCP response returns before the argument runner starts');

// Both posted before a single sweep can run, so they land in one window.
t.bus.post('coder', null, JSON.stringify({ question: 'first?' }), 'argue');
t.bus.post('coder', null, JSON.stringify({ question: 'second?' }), 'argue');

const until = async (pred, ms = 8_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
a.ok(await until(() => ran.length === 3),
  `all questions must be argued, got ${ran.length}: ${ran.join(', ')}`);

a.deepEqual(ran, ['from the real MCP server?', 'first?', 'second?'],
  'a queue, in the order asked — not a set, and not whichever finished first');
a.equal(maxInFlight, 1,
  'one argument at a time: two in the same sweep must not both be convened');

// The verdicts must come back to coder, who asked — not to the orchestrator.
a.ok(await until(() => t.bus.history({ limit: 1000 }).filter((x) => x.recipient === 'coder' && x.kind === 'notice').length === 2));
const back = t.bus.history({ limit: 1000 }).filter((x) => x.recipient === 'coder' && x.kind === 'notice');
a.match(back[0].body, /VERDICT: settled first\?/,
  'the verdict must reach the member that asked for it');
a.ok(back.every((x) => x.kind === 'notice'),
  'and as a notice — the asker did not buy a turn to be told, it rides along');

const regentVerdict = () => t.bus.history({ limit: 1000 }).find((x) => x.recipient === 'sovereign-regent'
  && x.kind === 'notice' && /VERDICT: settled from the real MCP server\?/.test(x.body));
a.ok(await until(regentVerdict),
  'the MCP caller must receive its verdict under its configured name, not a hardcoded recipient');

a.equal(t.bus.history({ limit: 1000 }).filter((x) => x.recipient === t.config.orchestrator.name
  && /VERDICT: settled (first|second)\?/.test(x.body)).length, 0,
  'the orchestrator must NOT be told about an argument it did not ask for');

a.equal(delivered.filter((d) => d.msg?.kind === 'argue').length, 0,
  'an argue request must never be delivered to a member: a null recipient reaches '
  + 'every summoned member, and each delivery is a full context replay');

regent.stop();
await t.stop();
rmSync(vault2, { recursive: true, force: true });

for (const x of [solo, k]) x.bus.close?.();
removeRepo(repo);
console.log('t-argue.js OK — panel staffed across vendors, convened by the court, one at a time, answered to the asker');
