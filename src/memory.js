// The team's brain: the user's Obsidian vault, read at spawn.
//
// Three things live here, and they are deliberately different in kind:
//
//   INSTRUCTIONS  AgenticOS/Team Instructions.md — standing rules the user
//                 edits in Obsidian. Every member is given them verbatim on
//                 every spawn. This is the one file to change to change how
//                 the whole team behaves.
//
//   MEMORY        AgenticOS/Memories/*.md — one durable fact per note, written by
//                 the team through the `remember` tool. Members are given the
//                 INDEX (title + hook) at spawn, never the bodies: an index of
//                 forty memories costs a few hundred tokens, the bodies would
//                 cost tens of thousands and be replayed on every turn.
//                 A member that wants one reads it with vault_read.
//
//   The rest of the vault stays searchable through vault_search, unchanged.
//
// Everything here degrades to null/empty rather than throwing. A member that
// cannot read the brain must still be able to work.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { insideVault } from './vault.js';

// 'Memories', not 'Memory': that is the folder the vault actually has, and
// the mismatch meant the memory half of every system prompt was silently
// empty while `remember` filed notes into a sibling folder nothing ever read.
// Nothing errored — an absent directory reads as "no memories yet", which is
// indistinguishable from a team that has simply not learned anything.
export const MEMORY_DIR = 'Memories';
export const INSTRUCTIONS_NOTE = 'Team Instructions.md';

/** Filenames are titles; keep them safe on Windows and readable in Obsidian. */
export const slugTitle = (s) =>
  String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);

const root = (vault, dir) => join(vault, dir);

/**
 * The user's standing instructions to the whole team, or null.
 *
 * Capped: this goes into EVERY member's prompt on EVERY spawn, so an essay
 * here is paid for over and over. The cap is generous enough for real rules
 * and small enough that it cannot quietly become the biggest thing a member
 * carries.
 */
export function teamInstructions(vault, dir = 'AgenticOS', max = 6000) {
  if (!vault) return null;
  try {
    const text = readFileSync(join(root(vault, dir), INSTRUCTIONS_NOTE), 'utf8').trim();
    if (!text) return null;
    return text.length > max
      ? `${text.slice(0, max)}\n\n[truncated at ${max} chars — keep Team Instructions shorter]`
      : text;
  } catch {
    return null;   // no instructions note is a normal, silent state
  }
}

/**
 * Every memory title, newest first.
 *
 * TITLES ONLY, deliberately. The `remember` tool requires the title to be the
 * fact itself ("flutter test, not dart test, for a Flutter repo"), so a hook
 * from the body mostly restates it — measured on the real vault, hooks were
 * 2,173 chars against 704 for titles alone, and that difference is paid on
 * every turn of every member for the life of the session. It also puts honest
 * pressure on titles: a memory titled "testing notes" is now visibly useless.
 *
 * Newest first because a team that has learned something recently is usually
 * still working on it, and because a hard cap has to drop something: dropping
 * the oldest is the only ordering that degrades sensibly.
 */
export function memoryIndex(vault, dir = 'AgenticOS', { limit = 40, maxChars = 3000 } = {}) {
  if (!vault) return [];
  const d = root(vault, join(dir, MEMORY_DIR));
  let files;
  try {
    files = readdirSync(d).filter((f) => f.endsWith('.md'));
  } catch {
    return [];   // no memories yet
  }

  const rows = [];
  for (const f of files) {
    try {
      const full = join(d, f);
      // A note without `type: memory` in its frontmatter was not written by
      // `remember()` — a hand-authored index, a table of contents, someone's
      // scratch note dropped in this folder — and its filename is not a fact,
      // so it does not belong in what every member is told "the team
      // already knows". A real AgenticOS/Memories/Index.md landed in this exact
      // index as "- Index" until this check existed.
      // Only the leading frontmatter is read (400 chars, `type:` is always
      // one of its first lines) — no need to find the closing `---`, which
      // could sit past the slice on a note with a long tag list.
      const head = readFileSync(full, 'utf8').slice(0, 400);
      if (!/^---[\s\S]*?\n\s*type:\s*memory\s*(\r?\n|$)/.test(head)) continue;
      // stat only past the frontmatter peek — the rest of the body is never
      // shown here, so reading it would be work thrown away on every spawn.
      rows.push({ name: f.replace(/\.md$/, ''), at: statSync(full).mtimeMs });
    } catch { /* a note that vanished mid-read is not worth failing over */ }
  }
  rows.sort((a, b) => b.at - a.at);

  const out = [];
  let used = 0;
  for (const r of rows.slice(0, limit)) {
    const line = `- ${r.name}`;
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    out.push(line);
  }
  return out;
}

/** Write one durable fact. Returns the vault-relative path. */
export function remember(vault, { title, body: text, tags = [], by = 'team', dir = 'AgenticOS' }) {
  if (!vault) throw new Error('No vault is configured for this workspace.');
  const d = root(vault, join(dir, MEMORY_DIR));
  mkdirSync(d, { recursive: true });
  const name = slugTitle(title);
  // The title comes from a language model, so it is untrusted input at a
  // filesystem boundary. slugTitle already strips separators, which makes
  // traversal impossible — but the check is on the RESOLVED path anyway,
  // because "already impossible" is exactly the assumption that stops being
  // true when someone loosens the slug later.
  const file = insideVault(d, `${name}.md`);
  if (!file) throw new Error(`Refusing to write a memory outside ${MEMORY_DIR}/: "${title}"`);
  const stamp = new Date().toISOString().slice(0, 10);
  // Frontmatter matches the vault's own taxonomy so these notes are findable
  // by the same queries as everything else the user writes.
  const front = [
    '---',
    'type: memory',
    'status: active',
    `updated: ${stamp}`,
    `recorded_by: ${by}`,
    ...(tags.length ? ['tags:', ...tags.map((t) => `  - ${String(t).replace(/\s+/g, '-')}`)] : []),
    '---',
    '',
  ].join('\n');
  writeFileSync(file, `${front}${String(text).trim()}\n`);
  return `${dir}/${MEMORY_DIR}/${name}.md`;
}

/**
 * A cheap identity for the current brain: instructions plus memory titles.
 *
 * The system prompt is only sent when a session is CREATED. A resumed member —
 * which is most of them, most of the time — keeps whatever prompt it was born
 * with, so editing Team Instructions or recording a memory would reach nobody
 * until they happened to recycle. Comparing this against what a member was last
 * told is how the orchestrator knows to hand them the difference.
 *
 * Titles, not bodies: a memory whose body is edited is the same memory, and
 * re-briefing the whole team over a typo is not worth a context replay each.
 */
export function brainFingerprint(vault, dir = 'AgenticOS') {
  if (!vault) return '';
  const rules = teamInstructions(vault, dir) ?? '';
  const titles = memoryIndex(vault, dir, { limit: 200, maxChars: 50_000 })
    .map((l) => l.split(' — ')[0]).join('|');
  // Not cryptographic — this only has to change when the content does.
  let h = 0;
  const s = `${rules.length}:${rules.slice(0, 400)}:${titles}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

/**
 * The block handed to a member at spawn: who to obey, and what is already known.
 *
 * Returns '' when there is no vault, so a team without one is unaffected.
 */
export function brainBlock(vault, dir = 'AgenticOS') {
  if (!vault || !existsSync(vault)) return '';
  const parts = [];

  const rules = teamInstructions(vault, dir);
  if (rules) {
    parts.push(
      `--- STANDING INSTRUCTIONS FROM THE USER ---\n` +
      `These are the user's own words, from ${dir}/${INSTRUCTIONS_NOTE} in their vault. ` +
      `They outrank your role's habits. If an order conflicts with them, say so rather ` +
      `than quietly doing both.\n\n${rules}`);
  }

  const mem = memoryIndex(vault, dir);
  if (mem.length) {
    parts.push(
      `--- WHAT THE TEAM ALREADY KNOWS (${mem.length} memories) ---\n` +
      `Titles only. Read one in full with vault_read("${dir}/${MEMORY_DIR}/<title>.md") when it ` +
      `bears on your task — do NOT re-derive something the team has already learned, and do ` +
      `NOT ask the user to re-explain it. When you learn something durable yourself, ` +
      `record it with the remember tool.\n\n${mem.join('\n')}`);
  }

  return parts.length ? `\n\n${parts.join('\n\n')}\n` : '';
}

if (process.argv[1]?.endsWith('memory.js')) {
  const { strict: a } = await import('node:assert');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const v = mkdtempSync(join(tmpdir(), 'agenticos-mem-'));
  a.equal(teamInstructions(v), null, 'no instructions note is a silent, normal state');
  a.deepEqual(memoryIndex(v), [], 'no memories yet is not an error');
  a.equal(brainBlock(v), '', 'and produces nothing to carry');

  mkdirSync(join(v, 'AgenticOS'), { recursive: true });
  writeFileSync(join(v, 'AgenticOS', INSTRUCTIONS_NOTE), 'Always run the tests.\n');
  a.match(teamInstructions(v), /Always run the tests/);

  const p = remember(v, { title: 'Flutter tests need flutter test', body: '`dart test` cannot load the bindings.', tags: ['flutter'], by: 'tester' });
  a.equal(p, 'AgenticOS/Memories/Flutter tests need flutter test.md');
  const idx = memoryIndex(v);
  a.equal(idx.length, 1);
  a.equal(idx[0], '- Flutter tests need flutter test',
    'the index is TITLES ONLY — the body is paid for on every turn and the title is the fact');
  a.ok(!idx.join('\n').includes('cannot load the bindings'),
    'no part of a memory body may ride along in the index');

  const saved = readFileSync(join(v, p), 'utf8');
  a.match(saved, /type: memory/, 'memories must carry the vault taxonomy');
  a.match(saved, /recorded_by: tester/);

  // A title that would escape the folder must not.
  // A traversing title is flattened to an ordinary filename and stays put.
  // The flattened name legitimately BEGINS with "..", which is exactly the
  // case a naive startsWith('..') containment check gets wrong — it did.
  const evil = remember(v, { title: '../../etc/passwd', body: 'no' });
  const abs = resolve(v, evil);
  a.ok(insideVault(resolve(v, 'AgenticOS', MEMORY_DIR), abs),
    `a traversing title must stay inside Memory/, got ${evil}`);
  a.ok(existsSync(abs), 'and must still have been written, not silently dropped');
  a.ok(!existsSync(resolve(v, '..', 'etc')), 'and nothing may appear outside the vault');

  // A hand-authored note in the same folder — an index, a README — is not a
  // `remember()`-authored fact and must not show up as if it were one.
  const before = memoryIndex(v).length;
  writeFileSync(join(v, 'AgenticOS', MEMORY_DIR, 'Index.md'),
    '---\ntype: index\nstatus: active\n---\n\n# Table of contents\n');
  const withStray = memoryIndex(v);
  a.equal(withStray.length, before, 'the stray index note must not join the memory index');
  a.ok(!withStray.some((l) => l.includes('Index')), 'and must not appear under any title');

  // The index is capped, and drops the OLDEST rather than truncating a line.
  for (let i = 0; i < 60; i++) remember(v, { title: `mem ${i}`, body: 'x'.repeat(400) });
  const big = memoryIndex(v);
  a.ok(big.length <= 40, `index must cap the count, got ${big.length}`);
  a.ok(big.join('\n').length <= 3000, 'and cap the characters');

  const block = brainBlock(v);
  a.match(block, /STANDING INSTRUCTIONS/);
  a.match(block, /WHAT THE TEAM ALREADY KNOWS/);
  a.ok(block.length < 12_000, 'the brain block must stay affordable on every spawn');

  rmSync(v, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('memory.js self-check OK — instructions, memory index, bounded brain block');
}
