// rename-keep (pure core of the codemod; scripts/rename/rename.mjs drives it)
//
// transformLine(file, line, opts) applies scripts/rename/map.mjs to one line
// of one repo-relative file. Pure: no filesystem, no git, so a test can hold
// shipped data to "the old text, renamed" (test/t-roster-migrate.js does).
import * as M from './map.mjs';

const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Expand WORDS into [regex, replacement, opts] triples. */
function wordRules() {
  const out = [];
  for (const [old, neu, opts = {}] of M.WORDS) {
    out.push([new RegExp(`(?<![A-Za-z])${old}(?![a-z])`, 'g'), neu, opts]);
    out.push([new RegExp(`(?<![A-Z])${cap(old)}(?![a-z])`, 'g'), opts.Cap ?? cap(neu), opts]);
    out.push([new RegExp(`(?<![A-Z])${old.toUpperCase()}(?![A-Z])`, 'g'), opts.UPPER ?? neu.toUpperCase(), opts]);
  }
  return out;
}
const WORD_RULES = wordRules();

export const excluded = (f) => M.EXCLUDE.some((re) => re.test(f));
const keepLine = (f, line) => line.includes('rename-keep')
  || M.KEEP_LINES.some(([fre, lre]) => fre.test(f) && lre.test(line));

/** Code part of a JS line: everything before a `//` comment, or nothing on a JSDoc/comment line. */
function splitCode(line) {
  if (/^\s*(\*|\/\*|\/\/)/.test(line)) return ['', line];
  const i = line.indexOf('//');
  return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i)];
}

/**
 * @param f      repo-relative path, which selects file-scoped rules
 * @param opts   { phase0: run PHASE0 too, pathsOnly: PATH_RULES only }
 */
export function transformLine(f, line, { phase0 = false, pathsOnly = false } = {}) {
  if (keepLine(f, line)) return line;
  let s = line;
  for (const [re, to] of M.PATH_RULES) s = s.replace(re, to);
  if (pathsOnly) return s;
  if (phase0) {
    for (const block of M.PHASE0) {
      if (!block.files.test(f)) continue;
      for (const [re, to] of block.rules) {
        if (block.code) {
          const [code, rest] = splitCode(s);
          s = code.replace(re, to) + rest;
        } else s = s.replace(re, to);
      }
    }
  }
  for (const [re, to, fre] of M.SCOPED) if (fre.test(f)) s = s.replace(re, to);
  for (const [re, to] of M.PHRASES) s = s.replace(re, to);
  if (/\.md$/.test(f)) for (const [re, to] of M.PROSE) s = s.replace(re, to);
  else if (/\.(m|c)?js$/.test(f)) {
    const [code, rest] = splitCode(s);
    let prose = rest;
    for (const [re, to] of M.PROSE) prose = prose.replace(re, to);
    s = code + prose;
  }
  const ordinaryDismiss = M.DISMISS_IS_ORDINARY.test(f);
  for (const [re, to, o] of WORD_RULES) {
    if (o.dismiss && ordinaryDismiss) continue;
    s = s.replace(re, to);
  }
  if (s !== line) for (const [re, to] of M.ARTICLES) s = s.replace(re, to);
  return s;
}

/** A whole text, line by line, as `file` would be rewritten. */
export const transformText = (f, text, opts) => text.split('\n').map((l) => transformLine(f, l, opts)).join('\n');
