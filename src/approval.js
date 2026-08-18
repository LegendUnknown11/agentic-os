// One reader for approval payloads, because there were three and they
// disagreed.
//
// An approval is a bus message whose body is JSON. Three places read them:
// kingdom's #reloadApprovals (at start), kingdom's #surfaceApprovals (live),
// and the daemon's /api/approvals (for the UI). #surfaceApprovals guarded its
// parse; #reloadApprovals did not, so one unparseable row threw inside
// start() and THE DAEMON DID NOT COME UP — no court, no panel, no way back
// except editing SQLite by hand. That is the exact shape of drift AGENTS.md
// rule 4 exists to stop, so the rule lives here now instead of in three
// copies.
//
// What "usable" means is set by the renderer, not by taste. ui/app.js does:
//   TITLES[a.kind] ?? a.kind.toUpperCase()      -> a missing kind throws
//   summon -> a.names.join(', ')                -> missing names throws
//   role   -> a.name,  merge -> a.peasant       -> missing is only ugly
// so kind is required always, and `names` is required for a summon. A row
// that fails this is dropped with a line on stderr: a bad record must cost
// itself and nothing else, and never the queue it is sitting in.

const NEEDS = { summon: 'names', role: 'name', merge: 'peasant' };

/**
 * Parse an approval message body, or return null if nothing renderable is in
 * it. Never throws.
 */
export function readApproval(body) {
  let p;
  try { p = JSON.parse(body); } catch { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (typeof p.kind !== 'string' || !p.kind) return null;
  const need = NEEDS[p.kind];
  // An unknown kind is allowed through: the UI falls back to
  // kind.toUpperCase() and empty detail, which is legible. A KNOWN kind
  // missing its own field is not — that is the one that throws.
  if (need && p[need] === undefined) return null;
  if (p.kind === 'summon' && !Array.isArray(p.names)) return null;
  return p;
}

/** The CLIs a role may name. An unknown one silently ran codex. */
export const ROLE_CLIS = ['claude', 'codex', 'agy', 'opencode'];

// A role name is not a label. It becomes a directory under wt/ and a git
// branch, and it reaches renameSync, `git add -A` and `worktree remove
// --force` — so `../..` in it escapes the worktree root. Git's own refname
// rules stop the branch half; nothing stopped the filesystem half.
const NAME_OK = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Why this proposed role cannot be created, or null if it can.
 *
 * Used by propose_role (so the orchestrator is told immediately, and can fix it) AND by
 * approve (because the sovereign is ruling on whether the court needs the role,
 * having read a description an LLM wrote — that is a judgement, not validation,
 * and it is the approve path that writes to disk).
 */
export function badRole(p, { taken = [] } = {}) {
  if (typeof p?.name !== 'string' || !NAME_OK.test(p.name)) {
    return `"${p?.name}" is not a usable name — lowercase letters, digits, - and _ only, `
      + 'starting with a letter, at most 32 characters.';
  }
  if (taken.includes(p.name)) return `"${p.name}" is already a member of the court.`;
  if (p.cli !== undefined && !ROLE_CLIS.includes(p.cli)) {
    return `"${p.cli}" is not a CLI this kingdom runs (${ROLE_CLIS.join(', ')}).`;
  }
  return null;
}

if (process.argv[1]?.endsWith('approval.js')) {
  const { strict: a } = await import('node:assert');

  a.equal(readApproval('this is not json at all'), null, 'unparseable is null, not a throw');
  a.equal(readApproval('null'), null);
  a.equal(readApproval('"a string"'), null);
  a.equal(readApproval('[1,2]'), null, 'an array is not an approval');
  a.equal(readApproval('{"reason":"no kind here"}'), null, 'kind is what the UI renders on');
  a.equal(readApproval('{"kind":""}'), null, 'an empty kind is no kind');
  a.equal(readApproval('{"kind":"summon"}'), null, 'a summon with no names throws in the UI');
  a.equal(readApproval('{"kind":"summon","names":"coder"}'), null, 'names must be an array to join');
  a.equal(readApproval('{"kind":"merge","verdict":"fine"}'), null, 'a merge names a peasant');
  a.equal(readApproval('{"kind":"role","reason":"why"}'), null, 'a role has a name');

  a.deepEqual(readApproval('{"kind":"summon","names":["coder"],"reason":"work"}'),
    { kind: 'summon', names: ['coder'], reason: 'work' });
  a.deepEqual(readApproval('{"kind":"summon","names":[]}'), { kind: 'summon', names: [] },
    'an empty crew is a real, renderable proposal — the UI joins it to ""');
  a.deepEqual(readApproval('{"kind":"merge","peasant":"coder","verdict":"ok"}'),
    { kind: 'merge', peasant: 'coder', verdict: 'ok' });
  a.equal(readApproval('{"kind":"something-new","note":"hi"}').kind, 'something-new',
    'an unknown kind still renders: TITLES falls back to kind.toUpperCase()');

  // A role name reaches the filesystem, so it is checked like one.
  a.equal(badRole({ name: 'archivist', cli: 'claude' }), null, 'an ordinary role is fine');
  a.equal(badRole({ name: 'a' }), null, 'one letter is a name');
  a.match(badRole({ name: '../../etc/passwd' }), /not a usable name/,
    'a traversal must never reach worktreePath');
  a.match(badRole({ name: '..' }), /not a usable name/);
  a.match(badRole({ name: 'has space' }), /not a usable name/);
  a.match(badRole({ name: 'Caps' }), /not a usable name/, 'wt/ is case-insensitive on Windows');
  a.match(badRole({ name: '9lives' }), /not a usable name/, 'must start with a letter');
  a.match(badRole({ name: '' }), /not a usable name/);
  a.match(badRole({ name: 'x'.repeat(33) }), /not a usable name/);
  a.match(badRole({ name: null }), /not a usable name/);
  a.match(badRole({ name: 'coder' }, { taken: ['coder'] }), /already a member/,
    'a duplicate name shadows the member it collides with in specOf');
  a.match(badRole({ name: 'ok', cli: 'gemini' }), /not a CLI this kingdom runs/,
    'an unknown cli fell through to codex and ran the wrong model in silence');
  a.equal(badRole({ name: 'ok' }), null, 'cli is optional — peasantDefaults supplies it');

  console.log('approval.js self-check OK — unreadable rows are null, bad roles never reach disk');
}
