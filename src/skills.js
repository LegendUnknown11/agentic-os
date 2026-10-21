// The team's skill set.
//
// A skill is a procedure the team should follow the same way every time —
// "how we ship a migration", "how we review a PR". It is NOT knowledge (that
// is Memory) and NOT a standing rule (that is Team Instructions): it is a
// method, invoked on purpose, for a task that is happening now.
//
// PROGRESSIVE DISCLOSURE, exactly as memoryIndex does it. Every member carries
// the INDEX — one line per skill, name and trigger — on every turn for the
// life of the session. The bodies are fetched with the `skill` tool only when
// one actually applies. Measured on the shipped set: the index is ~330 chars
// where the bodies are ~14,000, and that difference is paid on every turn of
// every member. A skill set that loaded itself would be the single most
// expensive thing the team carries.
//
// Skills come from two places, and both are optional:
//   skills/*.md next to this source   — what the OS ships with
//   <vault>/AgenticOS/Skills/*.md       — what the user writes in Obsidian
// The vault wins on a name collision, so a user can override a shipped
// skill without editing the repo.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_DIR = 'Skills';
const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/**
 * Names are typed by a human into a `/` menu, so they stay lowercase-kebab.
 * One colon is allowed and meaningful: `design:design-critique` is the
 * `design-critique` skill from the `design` pack, which is just a
 * subdirectory. Packs exist so a set can grow past the point where a flat
 * menu is readable, and so the user can drop a whole family in at once.
 */
export const slugSkill = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9:]+/g, '-')
    .replace(/:+/g, ':').replace(/^[-:]+|[-:]+$/g, '').slice(0, 60);

/**
 * `name:` and `description:` out of the frontmatter, and the body without it.
 *
 * Hand-rolled rather than a YAML dependency: this reads two scalar strings out
 * of a block the team itself writes. A parser for the other 95% of YAML would
 * be five dependencies to support syntax nobody here emits.
 */
function parse(text, fallbackName) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const front = m?.[1] ?? '';
  const field = (k) => {
    const f = new RegExp(`^${k}:\\s*(.+)$`, 'im').exec(front);
    return f ? f[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  // `combo: a, b` and a YAML `combo:\n  - a\n  - b` both mean the same thing,
  // and the team writes both. Accepting either is cheaper than teaching it.
  const comboLine = /^combo:\s*(.*)$/im.exec(front);
  let combo = [];
  if (comboLine) {
    combo = comboLine[1].trim()
      ? comboLine[1].replace(/^\[|\]$/g, '').split(',')
      : (/^combo:\s*\n((?:\s*-\s*.+\n?)+)/im.exec(front)?.[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
    combo = combo.map(slugSkill).filter(Boolean);
  }
  return {
    name: slugSkill(field('name') || fallbackName),
    description: field('description') || field('when') || '',
    combo,
    body: (m ? text.slice(m[0].length) : text).trim(),
  };
}

/**
 * One directory of skills, plus one level of pack subdirectories.
 *
 * One level, not a recursive walk: `design:responsive` is a name a person can
 * type, `design:web:layout:responsive` is not. The depth limit is the menu's
 * limit, so it belongs here rather than in a comment on the menu.
 */
function readDir(dir, pack = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;   // an absent skills directory is a normal, silent state
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!pack) out.push(...readDir(join(dir, e.name), slugSkill(e.name)));
      continue;
    }
    if (!e.name.endsWith('.md')) continue;
    try {
      const s = parse(readFileSync(join(dir, e.name), 'utf8'), e.name.replace(/\.md$/, ''));
      // A skill in a pack directory is named for its pack whether or not its
      // frontmatter remembered to say so.
      if (pack && !s.name.includes(':')) s.name = `${pack}:${s.name}`;
      out.push({ ...s, file: join(dir, e.name) });
    } catch { /* a skill that will not read is one the team does without */ }
  }
  return out;
}

/**
 * Every skill, name-sorted, with the vault's copy shadowing a shipped one.
 *
 * Bodies come along because the only callers are a one-shot tool call and the
 * daemon's menu; a skill set is a dozen small files, not a vault.
 */
export function listSkills(vault, dir = 'AgenticOS') {
  const byName = new Map();
  for (const s of readDir(BUILTIN)) if (s.name) byName.set(s.name, { ...s, source: 'builtin' });
  if (vault) {
    for (const s of readDir(join(vault, dir, SKILLS_DIR))) {
      if (s.name) byName.set(s.name, { ...s, source: 'vault' });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One skill in full, or null.
 *
 * A bare name matches a packed skill when it is unambiguous, so `/responsive`
 * finds `design:responsive`. Typing the pack is for disambiguating, not a tax
 * on the common case.
 */
export function readSkill(vault, name, dir = 'AgenticOS') {
  const want = slugSkill(name);
  const all = listSkills(vault, dir);
  const exact = all.find((s) => s.name === want);
  if (exact) return exact;
  const tail = all.filter((s) => s.name.split(':').pop() === want);
  return tail.length === 1 ? tail[0] : null;   // ambiguous means say so, not guess
}

/**
 * A skill resolved for handing to a member — a combo brings its parts with it.
 *
 * This is the ONE place the team deliberately spends context up front. A
 * combo exists because those procedures are always run together, so making the
 * member discover and fetch each part would buy four tool calls (and four
 * context replays) to save nothing. Every other path stays index-first.
 *
 * Cycles are cut by `seen` rather than by forbidding a combo of combos: two
 * combos that share a part is the normal case and must keep working.
 */
export function composeSkill(vault, name, dir = 'AgenticOS', seen = new Set()) {
  const s = readSkill(vault, name, dir);
  if (!s || seen.has(s.name)) return null;
  seen.add(s.name);
  if (!s.combo.length) return { ...s, text: s.body, parts: [] };

  const parts = [];
  const chunks = [s.body];
  for (const step of s.combo) {
    const sub = composeSkill(vault, step, dir, seen);
    if (!sub) continue;                          // a missing part is a gap, not a failure
    parts.push(sub.name);
    chunks.push(`\n\n--- ${sub.name} ---\n\n${sub.text}`);
    parts.push(...sub.parts);
  }
  const missing = s.combo.filter((c) => !parts.includes(c) && !seen.has(c));
  if (missing.length) chunks.push(`\n\n[combo step not installed: ${missing.join(', ')}]`);
  return { ...s, parts, text: chunks.join('') };
}

/**
 * The line every member carries: names and triggers, never bodies.
 *
 * Capped for the same reason the memory index is — this is replayed on every
 * turn, so an unbounded list would quietly become the biggest thing a member
 * holds. Descriptions are clipped rather than dropped: a skill nobody can tell
 * when to use is worse than one with a shortened hint.
 */
export function skillsBlock(vault, dir = 'AgenticOS', { maxChars = 2600 } = {}) {
  const skills = listSkills(vault, dir);
  if (!skills.length) return '';
  // Combos first, then bare skills: a combo answers a whole task and a member
  // scanning this should meet those before the parts they are assembled from.
  //
  // Packed skills get their pack line and nothing else. Describing all 27 cost
  // 2,870 chars replayed on every turn of every member; naming the packs and
  // describing only what is reachable on its own costs 2,053 for the same
  // reachability, because `design:a11y` already says what it is and the combos
  // above it say when the pack applies.
  const rank = (s) => (s.combo.length ? 0 : 1);
  const loose = skills.filter((s) => !s.name.includes(':'))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const packs = new Map();
  for (const s of skills) {
    if (!s.name.includes(':')) continue;
    const [p, n] = s.name.split(':');
    packs.set(p, [...(packs.get(p) ?? []), n]);
  }

  const lines = [];
  let used = 0;
  const add = (line) => {
    if (used + line.length > maxChars) return false;
    used += line.length + 1;
    lines.push(line);
    return true;
  };
  for (const s of loose) {
    if (!add(`- /${s.name}${s.combo.length ? ` (runs: ${s.combo.join(' + ')})` : ''}` +
      `${s.description ? ` — ${s.description.slice(0, 110)}` : ''}`)) break;
  }
  for (const [p, names] of [...packs].sort()) {
    add(`- /${p}:… — ${names.sort().join(', ')}`);
  }
  return `\n\n--- SKILLS AVAILABLE TO YOU (${skills.length}) ---\n` +
    `Named procedures the team follows. Names and triggers only — call ` +
    `skill("<name>") to get the steps, and only when one applies to the task in ` +
    `front of you. Loading a skill you do not need costs the same as one you do. ` +
    `If the user's message begins with /<name>, that skill is not a ` +
    `suggestion: load it first and follow it.\n\n${lines.join('\n')}\n`;
}

/**
 * A `/name rest…` command from the user, resolved.
 *
 * Returns the rewritten prompt, which NAMES the skill rather than pasting it.
 * Inlining the body here would put it in the member's context permanently even
 * on the turns it no longer matters; making the member fetch it costs one tool
 * call and keeps the whole set on the same progressive-disclosure footing.
 *
 * An unknown /word is left completely alone — the user may simply be
 * writing a path, a flag, or a date.
 */
export function expandSkillCommand(vault, text, dir = 'AgenticOS') {
  const m = /^\/([a-zA-Z0-9-]+)\s*([\s\S]*)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const skill = readSkill(vault, m[1], dir);
  if (!skill) return null;
  const rest = m[2].trim();
  return {
    name: skill.name,
    text: `Follow the "${skill.name}" skill for this. Load it now with ` +
      `skill("${skill.name}") and do exactly what it says.` +
      (rest ? `\n\n${rest}` : ''),
  };
}

// basename, not endsWith: `test/t-skills.js` also ends with "skills.js" and
// was silently running this whole self-check as a side effect of importing.
if (process.argv[1] && /(^|[\\/])skills\.js$/.test(process.argv[1])) {
  const { strict: a } = await import('node:assert');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const shipped = listSkills(null);
  a.ok(shipped.length >= 20, `the OS must ship a real skill set, got ${shipped.length}`);
  a.ok(shipped.every((s) => s.name && s.description),
    'every shipped skill needs a name and a description — the description IS the menu');
  a.ok(shipped.every((s) => s.body.length > 100), 'a skill with no steps is not a skill');
  a.ok(shipped.some((s) => s.name.includes(':')), 'packs must survive the round trip to disk');
  a.ok(shipped.some((s) => s.combo.length), 'combos must survive the round trip to disk');

  // Every combo step must resolve. A combo naming a skill nobody shipped is
  // the one failure a member cannot work around, and it is invisible until
  // someone runs it.
  for (const c of shipped.filter((s) => s.combo.length)) {
    for (const step of c.combo) {
      a.ok(readSkill(null, step), `/${c.name} names a step that does not exist: ${step}`);
    }
  }

  // The index must stay tiny next to the bodies, because it is the thing that
  // is replayed on every turn of every member.
  const block = skillsBlock(null);
  const bodies = shipped.reduce((n, s) => n + s.body.length, 0);
  // A budget, not a formality: this rides in every prompt of every member on
  // every turn. If a new skill breaks this, the fix is to put it in a PACK
  // (packs cost one shared line) — top level is for procedures that answer a
  // whole task and that the team must know exist without being told.
  a.ok(block.length < 2200, `the skills block must stay affordable, got ${block.length}`);
  a.ok(block.length * 8 < bodies,   // 10.1× as shipped
    `progressive disclosure must actually save: block ${block.length} vs bodies ${bodies}`);
  a.ok(!shipped.some((s) => block.includes(s.body.slice(0, 80))),
    'no skill body may ride along in the index');
  // Every skill has to be reachable from the block, or it may as well not ship.
  for (const s of shipped) {
    a.ok(block.includes(s.name) || block.includes(`/${s.name.split(':')[0]}:…`),
      `/${s.name} is not reachable from the index`);
  }

  const combo = composeSkill(null, 'design-site');
  a.ok(combo.parts.length >= 3, 'a combo must bring its parts');
  a.ok(combo.text.length > combo.body.length * 3, 'and their bodies, not just their names');
  a.ok(combo.text.includes('Squint at it'), 'the parts must be the real bodies');
  a.equal(composeSkill(null, 'review').parts.length, 0, 'a plain skill brings only itself');
  a.equal(composeSkill(null, 'design-critique').name, 'design:design-critique',
    'a bare name must find an unambiguous packed skill — typing the pack is for disambiguating');

  const v = mkdtempSync(join(tmpdir(), 'agenticos-skill-'));
  a.equal(readSkill(v, 'nope'), null, 'an unknown skill is null, not a throw');
  a.equal(expandSkillCommand(v, '/nope do a thing'), null,
    'an unknown /word must be left alone — it is probably a path or a flag');
  a.equal(expandSkillCommand(v, 'no slash here'), null);

  mkdirSync(join(v, 'AgenticOS', SKILLS_DIR), { recursive: true });
  writeFileSync(join(v, 'AgenticOS', SKILLS_DIR, 'Ship It.md'),
    '---\nname: ship-it\ndescription: how we cut a release\n---\n1. run the tests\n2. tag it\n');
  const mine = readSkill(v, 'ship-it');
  a.equal(mine.source, 'vault');
  a.match(mine.body, /tag it/);
  a.equal(readSkill(v, 'SHIP-IT').name, 'ship-it', 'the menu is typed by hand — match loosely');

  const cmd = expandSkillCommand(v, '/ship-it the auth branch');
  a.equal(cmd.name, 'ship-it');
  a.match(cmd.text, /the auth branch/, 'the rest of the user\'s message must survive');
  a.ok(!cmd.text.includes('tag it'),
    'the body must NOT be inlined — it would sit in context forever; the member fetches it');

  // A vault skill shadows a shipped one of the same name.
  const first = shipped[0].name;
  writeFileSync(join(v, 'AgenticOS', SKILLS_DIR, 'override.md'),
    `---\nname: ${first}\ndescription: mine\n---\nthe user's own version of this procedure\n`);
  const merged = listSkills(v);
  a.equal(merged.filter((s) => s.name === first).length, 1, 'an override must replace, not duplicate');
  a.equal(merged.find((s) => s.name === first).source, 'vault', 'and the vault must win');

  rmSync(v, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`skills.js self-check OK — ${shipped.length} shipped, index ${block.length} chars vs ${bodies} of bodies`);
}
