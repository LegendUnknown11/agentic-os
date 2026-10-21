// What the sovereign's court is called on screen.
//
// The orchestrator's model is a kingdom and the code says so everywhere: roles
// are `orchestrator`/`briefer`/`peasant`, the config keys are those words, and so are
// the CSS classes, the localStorage keys and the /api paths. None of that
// changes here. This module is the DISPLAY layer only, for the same reason
// app.js:887 keeps `board`/`flow` as internal names: renaming a label is not
// renaming a state, and renaming state logs every sovereign out of their
// layout to change a word they never see.
//
// So: `role-orchestrator` stays in the CSS, `config.orchestrator.name` stays in the config,
// and the screen says Orchestrator.

/** The role, as one word, for a member card or a fact list. */
const ROLE_WORD = {
  orchestrator: 'Orchestrator',
  briefer: 'Monitor',
  peasant: 'Agent',
};

/** The role, as a group heading over a list of them. */
const ROLE_GROUP = {
  orchestrator: 'Orchestrator',
  briefer: 'Monitor',
  peasant: 'Agents',
};

export const roleWord = (role) => ROLE_WORD[role] ?? 'Agent';
export const roleGroup = (role) => ROLE_GROUP[role] ?? 'Agents';

/**
 * What to print where a member's name goes.
 *
 * The orchestrator and the briefer are singletons whose configured NAME is the generic
 * role word — `config.orchestrator.name` is literally "orchestrator". Printing that beside a
 * group heading reading "Orchestrator" undercuts the whole rename, so the two
 * generic names are substituted.
 *
 * Only the generic ones. A sovereign who names their orchestrator "Rex" gets Rex: that
 * is a choice they made and this has no business overriding it.
 *
 * `role` is optional because two callers genuinely do not have it: the Activity
 * panel renders `bus.events`, which carry an agent name and no role, and so
 * does the message feed. With a role, it is trusted — an agent that happens to
 * be called "orchestrator" is not the throne. Without one, the generic name is taken at
 * face value, which is right in every real config and wrong only for a roster
 * that named an agent after the role it is not.
 */
export function displayName(name, role) {
  if (name === 'orchestrator' && (role === 'orchestrator' || role === undefined)) return ROLE_WORD.orchestrator;
  if (name === 'briefer' && (role === 'briefer' || role === undefined)) return ROLE_WORD.briefer;
  return name;
}

/** "3 agents" / "1 agent" — the count line under a roster. */
export const agentCount = (n) => `${n} agent${n === 1 ? '' : 's'}`;

// Self-check. Guarded with `typeof process` rather than a bare `process.argv`:
// a bare reference throws ReferenceError in the browser, and because app.js
// imports this module the whole graph dies and the room boots to an empty
// shell. Nothing in the test suite catches that — only loading the page does.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('names.js')) {
  const assert = await import('node:assert/strict');
  const a = assert.default ?? assert;

  // Every role the orchestrator can hand the UI resolves to a word. `roleOf`
  // in src/agenticos.js returns exactly these three, and upsertNode defaults an
  // unknown one to 'peasant'.
  for (const role of ['orchestrator', 'briefer', 'peasant']) {
    a.ok(ROLE_WORD[role], `${role} has a word`);
    a.ok(ROLE_GROUP[role], `${role} has a group heading`);
  }
  // An unknown role degrades rather than printing "undefined" into the rail.
  a.equal(roleWord('release-manager'), 'Agent');
  a.equal(roleGroup(undefined), 'Agents');

  // The substitution is for the generic names only.
  a.equal(displayName('orchestrator', 'orchestrator'), 'Orchestrator');
  a.equal(displayName('briefer', 'briefer'), 'Monitor');
  a.equal(displayName('Rex', 'orchestrator'), 'Rex', 'a named orchestrator keeps its name');
  a.equal(displayName('coder', 'peasant'), 'coder', 'agents are never renamed');
  // A peasant that happens to be called "orchestrator" is not the throne — a KNOWN
  // role always wins over the name.
  a.equal(displayName('orchestrator', 'peasant'), 'orchestrator');
  // No role: the Activity panel and the message feed both render bus rows,
  // which carry a name and nothing else.
  a.equal(displayName('orchestrator'), 'Orchestrator');
  a.equal(displayName('briefer'), 'Monitor');
  a.equal(displayName('coder'), 'coder');

  a.equal(agentCount(1), '1 agent');
  a.equal(agentCount(0), '0 agents');

  console.log('names ok');
}
