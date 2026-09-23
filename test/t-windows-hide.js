// Issue #44: "A bunch of terminals pop up after agentic-os has started"
// (Windows). Every child process this repository spawns must pass
// `windowsHide: true`, or a console window flashes/stays open per spawn —
// invisible on Linux CI, which is exactly why this has to be a static guard
// rather than a runtime one: nothing here can observe a Windows console.
//
// This parses (not greps) every `src/*.js` and `electron/*.js` file for calls
// to node:child_process's spawn/exec/execFile/spawnSync/execSync/execFileSync
// — including through a local `promisify(execFile)`-style alias, or a small
// wrapper like agent.js's spawnGuarded() that only forwards an `opts` object
// its own callers are checked for instead — and fails on any call whose
// argument list neither contains `windowsHide` nor is a verified pass-through.
//
//   node test/t-windows-hide.js
import { strict as a } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');

const jsFilesIn = (dir) => readdirSync(join(ROOT, dir))
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(dir, f));

const files = [...jsFilesIn('src'), ...jsFilesIn('electron')];

/**
 * Blank out comments and string/template contents (keeping their length and
 * every newline) so a call regex cannot match inside a comment ("spawn() that
 * cannot wedge a member.") or a string, while every real character still
 * lands at its original line and column.
 */
function stripNonCode(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '\'' || c === '"') {
      // A single/double-quoted STRING cannot legitimately span a newline, so
      // a bare quote with no close before end-of-line is not a string at all
      // — it is a regex character class like ['"]? (assertRepo's error
      // matcher). Leave it as ordinary code rather than eating the rest of
      // the file looking for a quote that was never meant to close one.
      let j = i + 1;
      let closes = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) { closes = true; break; }
        j++;
      }
      if (!closes) { out += c; i++; continue; }
      out += ' '; i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') { out += '  '; i += 2; continue; }
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' '; i++;
    } else if (c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') { out += '  '; i += 2; continue; }
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' '; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/** The text of the balanced (...) starting at `open` (which must be '('). */
function matchParens(text, open) {
  a.equal(text[open], '(', 'matchParens must be called at an opening paren');
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced parens');
}

/** The text of the balanced {...} starting at `open` (which must be '{'). */
function matchBraces(text, open) {
  a.equal(text[open], '{', 'matchBraces must be called at an opening brace');
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  throw new Error('unbalanced braces');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function violationsIn(relPath) {
  const raw = readFileSync(join(ROOT, relPath), 'utf8');
  const text = stripNonCode(raw);
  const violations = [];

  // ---- names that resolve to a real node:child_process function -----------
  const spawnLike = new Set();
  const importMatch = raw.match(/import\s*\{([^}]+)\}\s*from\s*['"]node:child_process['"]/);
  if (importMatch) {
    for (const part of importMatch[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) spawnLike.add(name);
    }
  }
  if (!spawnLike.size) return violations; // this file never touches child_process

  // `const exec = promisify(execFile)` (worktree.js, evidence.js, snapshot.js,
  // doctor.js) makes `exec` spawn-like too; a chain resolves in a few passes.
  for (let pass = 0; pass < 4; pass++) {
    for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*promisify\((\w+)\)/g)) {
      if (spawnLike.has(m[2])) spawnLike.add(m[1]);
    }
  }

  // ---- function declarations, so a forwarding wrapper (spawnGuarded) can be
  // recognised: it calls a spawn-like name with its OWN parameter passed
  // through as the options argument, and its own callers carry the real
  // windowsHide literal instead. ---------------------------------------------
  const fns = [];
  for (const m of text.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{/g)) {
    const braceOpen = m.index + m[0].length - 1;
    const [start, end] = matchBraces(text, braceOpen);
    fns.push({
      name: m[1],
      params: m[2].split(',').map((p) => p.trim().split(/[=\s]/)[0]).filter(Boolean),
      start, end,
    });
  }

  // Fixed point: a function that only forwards its options parameter to an
  // already-spawn-like name is itself spawn-like, and this can chain.
  const exempt = new Set(); // `${index}` of a call whose windowsHide check is skipped
  for (let pass = 0; pass < 4; pass++) {
    for (const fn of fns) {
      if (spawnLike.has(fn.name)) continue;
      for (const name of spawnLike) {
        const callRe = new RegExp(`\\b${name}\\(`, 'g');
        for (const cm of text.matchAll(callRe)) {
          if (cm.index < fn.start || cm.index > fn.end) continue;
          const openParen = cm.index + name.length;
          const args = matchParens(text, openParen);
          const last = args.slice(1, -1).split(',').pop().trim();
          if (fn.params.includes(last)) {
            spawnLike.add(fn.name);
            exempt.add(`${name}@${cm.index}`);
          }
        }
      }
    }
  }

  // ---- every call to one of those names -------------------------------
  for (const name of spawnLike) {
    const callRe = new RegExp(`\\b${name}\\(`, 'g');
    for (const m of text.matchAll(callRe)) {
      if (exempt.has(`${name}@${m.index}`)) continue;
      // The declaration `function spawnGuarded(...)` itself is not a call —
      // only its own callers' opts literals are checked.
      const before = text.slice(0, m.index).match(/(\w+)\s*$/)?.[1];
      if (before === 'function') continue;
      const openParen = m.index + name.length;
      const args = matchParens(text, openParen);
      if (!/windowsHide/.test(args)) {
        violations.push(`${relPath}:${lineOf(raw, m.index)} — ${name}(...) has no windowsHide`);
      }
    }
  }
  return violations;
}

const all = files.flatMap(violationsIn);
a.deepEqual(all, [],
  `every child_process call must pass windowsHide: true (Windows terminal-flash guard, #44):\n${all.join('\n')}`);

console.log(`t-windows-hide.js OK — ${files.length} files scanned, every child_process call passes windowsHide`);
