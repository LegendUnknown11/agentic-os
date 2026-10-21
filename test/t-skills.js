// The team's skill set, and observation masking on tool results.
//
// Both exist for the same reason and are tested together: 93% of this team's
// input tokens are replayed context, so the only things that matter are what
// enters a member's context and how many times.
//
//   node test/t-skills.js
import { strict as a } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from '../src/bus.js';
import {
  listSkills, readSkill, composeSkill, skillsBlock, expandSkillCommand, slugSkill,
} from '../src/skills.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = join(HERE, '..', 'src', 'mcp.js');
const dir = mkdtempSync(join(tmpdir(), 'agenticos-skills-'));
const vault = join(dir, 'vault');
mkdirSync(join(vault, 'AgenticOS', 'Skills'), { recursive: true });

// ---- names ----------------------------------------------------------
// The name is typed by a human into a `/` menu, so it has to survive being
// typed the wrong way.
a.equal(slugSkill('Design Critique'), 'design-critique');
a.equal(slugSkill('DESIGN:A11Y'), 'design:a11y');
a.equal(slugSkill('  --weird-- '), 'weird');
a.equal(slugSkill('a::b'), 'a:b', 'one colon separates a pack; more is a typo');

// ---- the shipped set ------------------------------------------------
const shipped = listSkills(null);
a.ok(shipped.length >= 20, `the OS must ship a real skill set, got ${shipped.length}`);
a.ok(shipped.some((s) => s.name === 'design:a11y'), 'a subdirectory must become a pack');
a.ok(shipped.some((s) => s.name === 'design-site' && s.combo.length >= 3), 'combos must ship');

// Every combo step has to resolve. A combo naming a skill nobody shipped fails
// only when a member runs it, which is the worst possible moment to find out.
for (const c of shipped.filter((s) => s.combo.length)) {
  for (const step of c.combo) {
    a.ok(readSkill(null, step), `/${c.name} names a missing step: ${step}`);
  }
}

// ---- a skill that names a team member must name one that exists ----
// A skill that assigns work by name — "send this to the devops-engineer" — fails at the
// worst possible moment if that role was renamed or removed: mid-task, after
// the user has already approved a crew. Check every skill, not one.
{
  const roles = JSON.parse(readFileSync(join(HERE, '..', 'roles.json'), 'utf8'));
  const known = new Set((roles.agents ?? roles).map((p) => p.name));
  for (const s of shipped) {
    // Table rows shaped `| scout | what it takes |`, minus a `| member |` header.
    const named = [...s.body.matchAll(/^\|\s*([a-z]+)\s*\|/gm)]
      .map((m) => m[1]).filter((n) => n !== 'member' && n !== 'level');
    for (const n of named) {
      a.ok(known.has(n), `/${s.name} assigns work to "${n}", which is not a team role`);
    }
  }
}

// ---- progressive disclosure -----------------------------------------
// This is the whole point: the index rides in every prompt of every member for
// the life of the session, the bodies do not.
const block = skillsBlock(null);
const bodies = shipped.reduce((n, s) => n + s.body.length, 0);
a.ok(block.length < 2200, `the block must stay affordable, got ${block.length}`);
a.ok(bodies / block.length > 8, `disclosure must save: ${bodies} of bodies vs ${block.length}`);
for (const s of shipped) {
  a.ok(block.includes(s.name) || block.includes(`/${s.name.split(':')[0]}:…`),
    `/${s.name} is unreachable from the index — it may as well not ship`);
}
for (const s of shipped) {
  a.ok(!block.includes(s.body.slice(0, 60)), `a body leaked into the index: /${s.name}`);
}

// ---- combos ---------------------------------------------------------
const site = composeSkill(null, 'design-site');
a.ok(site.parts.includes('design:a11y'));
a.ok(site.text.length > bodies / shipped.length, 'a combo must be bigger than one skill');
a.ok(site.text.includes('4.5:1'), 'and must contain the real part bodies, not their names');
a.equal(composeSkill(null, 'review').parts.length, 0, 'a plain skill brings only itself');

// A combo that names itself must terminate rather than recurse forever.
writeFileSync(join(vault, 'AgenticOS', 'Skills', 'loop.md'),
  '---\nname: loop\ndescription: a cycle\ncombo: loop, review\n---\nround and round\n');
const loop = composeSkill(vault, 'loop');
a.ok(loop, 'a self-referential combo must resolve, not hang');
a.ok(loop.parts.includes('review'), 'and must still pick up its other parts');

// ---- the user overrides ----------------------------------------
writeFileSync(join(vault, 'AgenticOS', 'Skills', 'review.md'),
  '---\nname: review\ndescription: my own review\n---\nlook at it and see how you feel\n');
const mine = readSkill(vault, 'review');
a.equal(mine.source, 'vault', 'the vault must win over a shipped skill of the same name');
a.equal(listSkills(vault).filter((s) => s.name === 'review').length, 1, 'and replace, not duplicate');

// ---- /command expansion ---------------------------------------------
a.equal(expandSkillCommand(vault, 'no slash'), null);
a.equal(expandSkillCommand(vault, '/src/mcp.js is broken'), null,
  'an unknown /word is a path or a flag far more often than a skill — leave it alone');
const cmd = expandSkillCommand(vault, '/design-site the settings page, mobile first');
a.equal(cmd.name, 'design-site');
a.match(cmd.text, /mobile first/, "the rest of the user's message must survive");
a.ok(!cmd.text.includes('Squint at it'),
  'the body must NOT be inlined — an order is replayed forever, a tool result is fetched once');

// ---- observation masking, through the real MCP server ----------------
// The mask has to work ACROSS PROCESSES: codex runs one process per turn, so a
// ledger held in memory would forget between the two turns that matter. Each
// call below is a separate spawn, which is exactly the real shape.
const db = join(dir, 'bus.db');
const bus = new Bus(db);
mkdirSync(join(vault, 'Notes'), { recursive: true });
const NOTE = 'Notes/Big.md';
writeFileSync(join(vault, NOTE), `# Big\n\n${'a fact worth reading. '.repeat(60)}\n`);

function callTool(name, args) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-skills', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [MCP], {
    input: rpc, encoding: 'utf8',
    env: { ...process.env, AGENTICOS_AGENT: 'coder', AGENTICOS_ROLE: 'agent',
      AGENTICOS_DB: db, AGENTICOS_VAULT: vault, AGENTICOS_VAULT_WATCH: '0' },
  });
  a.equal(r.status, 0, `mcp exited ${r.status}: ${r.stderr.slice(0, 500)}`);
  const msg = r.stdout.split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m?.id === 2);
  a.ok(msg, `no reply to ${name}`);
  return msg.result.content[0].text;
}

// The skill tool serves the real body, and a combo brings its parts.
const viaTool = callTool('skill', { name: 'root-cause' });
a.match(viaTool, /Reproduce it first/);
a.match(callTool('skill', { name: 'design-site' }), /combo — includes/);
a.match(callTool('skill', { name: 'nonsense' }), /No skill named/);

const first = callTool('vault_read', { path: NOTE });
a.ok(first.length > 400, `the fixture must be worth masking, got ${first.length}`);
a.match(first, /a fact worth reading/);

const second = callTool('vault_read', { path: NOTE });
a.match(second, /\[unchanged/, 'an identical payload must not be sent into context twice');
a.ok(!second.includes('a fact worth reading'), 'and must not smuggle the body into the placeholder');
a.ok(second.length < first.length / 2, 'the placeholder must actually be cheaper');

// MASK ONCE, THEN RELENT. A member that lost the text — compaction, a bad
// summary — has to be able to get it back without knowing masking exists.
const third = callTool('vault_read', { path: NOTE });
a.match(third, /a fact worth reading/,
  'asking again after a mask must return the real thing — a member that cannot see what it needs is the worse failure');

// A CHANGED note must never be masked. This is the property that makes the
// whole mechanism safe, so break it deliberately: same path, new bytes.
writeFileSync(join(vault, NOTE), `# Big\n\n${'a fact worth reading. '.repeat(60)}\nAnd one more line.\n`);
const changed = callTool('vault_read', { path: NOTE });
a.match(changed, /And one more line/, 'an edited note must always come through in full');

// Short payloads are left alone: a placeholder costs about what they do.
const miss = callTool('vault_read', { path: 'Notes/Nope.md' });
a.equal(callTool('vault_read', { path: 'Notes/Nope.md' }), miss,
  'a short result must not be masked — the placeholder is not cheaper than the answer');

// Recycling clears the ledger: the successor has a fresh context and has
// genuinely never seen any of this.
callTool('vault_read', { path: NOTE });                 // re-arm the hash
bus.set('served:coder', '');                            // what recycleAgent does
a.match(callTool('vault_read', { path: NOTE }), /And one more line/,
  'a recycled member must be told everything again — it is a new context');

bus.close();
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(`t-skills OK — ${shipped.length} skills, index ${block.length} vs ${bodies} chars of bodies, masking verified across processes`);
