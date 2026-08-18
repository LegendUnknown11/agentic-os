// Who is in the court, and who matches a search for one.
//
// These two predicates decide what the front door shows, so they live apart
// from the DOM that renders them and are checked by `npm test` — the rest of
// ui/ cannot be, because there is no browser in the test run.
//
// The rule they encode: the RAIL is the court, the SUMMONING screen is the
// roster. Conflating them is what made the app unusable to open. Every role in
// kingdom.config.json got a permanent rail row, so the live config put 107 rows
// and 4,179px of scroll behind a 580px viewport, and 105 of them read "not
// summoned" — a member list that is 98% absence is a wall, not a list.

/**
 * Is this member part of the working court, and therefore in the rail?
 *
 * The throne and the watch are structural: a kingdom always has an orchestrator and a
 * briefer, they are never summoned or dismissed, and hiding them because they
 * happen to be idle would leave a court of nobody. Peasants come and go.
 */
export const inCourt = (m) =>
  m.role === 'orchestrator' || m.role === 'briefer' || Boolean(m.summoned);

/**
 * Does this member answer a search on the summoning screen?
 *
 * Searches the description, not just the name. You know you want someone who
 * does Kubernetes long before you know they are filed under "cloud-architect",
 * and a recruit screen that only matches slugs is one you have to already know
 * the answer to use. Empty query matches everyone.
 */
export function matchesQuery(m, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [m.name, m.title, m.description]
    .some((s) => typeof s === 'string' && s.toLowerCase().includes(needle));
}

/* ---------------- self-check ----------------
 * `typeof process` guarded, unlike the self-checks in src/. Those files only
 * ever run in Node; this one is imported by the browser too, and a bare
 * `process.argv` there is a ReferenceError that kills the whole module graph —
 * app.js imports this first, so the throne room booted to an empty shell.
 */
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('court.js')) {
  const { strict: a } = await import('node:assert');

  // --- the rail is the court, not the roster ---
  a.equal(inCourt({ role: 'orchestrator' }), true, 'the orchestrator is always in the rail');
  a.equal(inCourt({ role: 'briefer' }), true, 'so is the briefer');
  a.equal(inCourt({ role: 'peasant', summoned: true }), true, 'a summoned peasant is in the court');
  a.equal(inCourt({ role: 'peasant', summoned: false }), false,
    'an unsummoned peasant must NOT hold a rail row — this is the whole fix');
  a.equal(inCourt({ role: 'peasant' }), false, 'and `summoned` absent means absent');

  // The regression this exists to prevent, at the scale it actually happened.
  const roster = [
    { name: 'orchestrator', role: 'orchestrator' },
    { name: 'briefer', role: 'briefer' },
    ...Array.from({ length: 105 }, (_, i) => ({ name: `role-${i}`, role: 'peasant' })),
  ];
  a.equal(roster.filter(inCourt).length, 2,
    '105 configured-but-unsummoned roles must contribute nothing to the rail');
  roster[7].summoned = true;
  a.equal(roster.filter(inCourt).length, 3, 'summoning one adds exactly one row');

  // --- search reaches the description ---
  const cloud = {
    name: 'cloud-architect',
    title: 'Cloud Architect',
    description: 'Cloud infrastructure, Kubernetes, Terraform, multi-region failover',
  };
  a.equal(matchesQuery(cloud, ''), true, 'an empty query matches everyone');
  a.equal(matchesQuery(cloud, 'cloud'), true, 'by name');
  a.equal(matchesQuery(cloud, 'Cloud Architect'), true, 'by title');
  a.equal(matchesQuery(cloud, 'kubernetes'), true,
    'and by description — you know the skill before you know the slug');
  a.equal(matchesQuery(cloud, 'KUBERNETES'), true, 'case-insensitively');
  a.equal(matchesQuery(cloud, 'woodwind'), false, 'and misses when it should');
  // A member with no title or description must not throw the search.
  a.equal(matchesQuery({ name: 'coder' }, 'coder'), true, 'a bare member still matches by name');
  a.equal(matchesQuery({ name: 'coder' }, 'kubernetes'), false, 'and does not match by nothing');

  console.log('court.js OK — the rail holds the court, the summoning holds the roster');
}
