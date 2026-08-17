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

  console.log('approval.js self-check OK — unreadable rows are null, never an exception');
}
