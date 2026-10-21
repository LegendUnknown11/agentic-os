// What shape the court is in.
//
// The court had exactly one shape: decompose, summon a crew, put every
// specialist in an isolated git worktree, test what comes back, merge it. That
// is right for writing code and wrong for the other three things this
// application is actually used for. Asking a question spent an advisor call, an
// orchestrator turn, a summon approval, a `git worktree add` and a peasant
// carrying four thousand tokens of test doctrine — to produce a paragraph.
//
// A mode answers five questions, and they are the questions that differ:
//
//   crew        who may be summoned at all
//   worktrees   does a member get an isolated checkout
//   merge       can work ever reach the base branch
//   tasks       is there a shared task list
//   vaultDir    where the durable output of this mode belongs
//
// WHY RESEARCH STILL GETS A WORKTREE. "Read-only against the repo" needs an
// enforcement mechanism, and a per-CLI sandbox flag is not one: codex has
// `sandbox_mode` (the advisor uses it), the other three CLIs do not, and a rule
// that holds for one member in four is not a rule. Isolation is the mechanism
// this system already has and it holds for all four — a member in a worktree
// cannot touch the real repo, and with `merge:false` nothing it writes can
// escape. Read-only by construction rather than by a flag two CLIs ignore.
//
// Pure on purpose, and self-checking: nothing here reads a file, spawns a
// process or touches the bus, so the whole table is testable in milliseconds.

/**
 * `crew: 'all'` is the whole configured bench; an array is a shortlist; an
 * empty array means this mode summons nobody at all.
 */
const LEGACY_MODES = {
  code: {
    label: 'Code',
    blurb: 'Write and change code. A crew in isolated worktrees, tests, review, merge.',
    crew: 'all',
    worktrees: true,
    merge: true,
    tasks: true,
    vaultDir: null,
  },
  research: {
    label: 'Research',
    blurb: 'Find things out. Findings are written up as a note; nothing is merged.',
    crew: ['researcher', 'writer', 'strategist', 'auditor', 'fact-checker', 'defendant', 'critic'],
    worktrees: true,
    merge: false,
    tasks: true,
    vaultDir: 'Research',
    pipeline:
      `Before you write the note, run contestable claims — numbers, named ` +
      `standards, citations, specific facts — past the fact-checker rather than ` +
      `trusting how confident they sound. If a finding is worth recording but ` +
      `genuinely contestable, summon a defendant and a critic to argue it out ` +
      `before you commit to it.`,
  },
  chat: {
    label: 'Chat',
    blurb: 'Talk to the orchestrator. No crew, no task list, no worktree, nothing to approve.',
    crew: [],
    worktrees: false,
    merge: false,
    tasks: false,
    vaultDir: null,
  },
  build: {
    label: 'Build',
    blurb: 'Extend the court itself — skills, notes, instructions. Vault writes land; code stays on the branch.',
    crew: ['writer', 'architect', 'strategist'],
    worktrees: true,
    merge: false,
    tasks: true,
    vaultDir: null,
  },
  automate: {
    label: 'Automate',
    blurb: 'Describe an automation in plain language — the orchestrator builds, wires up a trigger, and runs it.',
    crew: [],
    worktrees: false,
    merge: false,
    tasks: false,
    vaultDir: null,
    workflows: true,
    pipeline:
      `You build and edit automations by calling workflow_save — translate what the ` +
      `sovereign describes into a small JSON node graph plus a trigger, and save it ` +
      `yourself; do not make them write the JSON. Node types: http (call a URL), ` +
      `delay (wait ms), log (record a line), set (write literal values into the ` +
      `run's context), condition (branch next to "then" or "else" on a value), bus ` +
      `(post a message onto the court's own bus), transform (filter+pick over an ` +
      `array), foreach (repeat a small sub-chain over an array). Each node has an ` +
      `id, a type, a config, and next (another node's id, or {then,else} after a ` +
      `condition). Use "{{path.into.ctx}}" inside any config string to read a value ` +
      `written earlier in the run. Triggers, pick whichever the request implies: ` +
      `manual (fires only from workflow_run), interval (config: everyMs), daily ` +
      `(config: at, "HH:MM" local time, fires once per day), webhook ` +
      `(fires on POST /api/workflows/hook?id=<id>; the request body becomes ` +
      `ctx.input), bus (fires when a bus message's body contains trigger.pattern; ` +
      `that message becomes ctx.input). After saving, call workflow_run to prove it ` +
      `actually works and report the real outcome, not just that you saved it.`,
  },
};

export const MODES = {
  chat: LEGACY_MODES.chat,
  cowork: {
    ...LEGACY_MODES.build,
    label: 'Cowork',
    blurb: 'Delegate research, writing, tasks, and automations. Code changes stay isolated until Code mode.',
    crew: ['researcher', 'writer', 'strategist', 'auditor', 'fact-checker', 'defendant', 'critic', 'architect'],
    workflows: true,
    pipeline: `${LEGACY_MODES.research.pipeline}\n${LEGACY_MODES.automate.pipeline}`,
  },
  code: LEGACY_MODES.code,
};

export const MODE_NAMES = Object.keys(MODES);
export const DEFAULT_MODE = 'code';
// Existing courts may still have one of these persisted. They continue as
// Cowork, then Kingdom#start rewrites the config to the canonical key.
export const MODE_ALIASES = Object.freeze({ research: 'cowork', build: 'cowork', automate: 'cowork' });

/**
 * Never undefined.
 *
 * This is read on every spawn, every tool call and every delivery. A typo in a
 * config file, a mode from a newer build, or a bus row written before modes
 * existed must all land somewhere sensible — and the sensible place is the
 * behaviour the court had before this file existed.
 */
export function modeOf(name) {
  return MODES[MODE_ALIASES[name] ?? name] ?? MODES[DEFAULT_MODE];
}

/** Normalise anything to a real mode key. */
export const modeName = (name) => {
  const canonical = MODE_ALIASES[name] ?? name;
  return MODES[canonical] ? canonical : DEFAULT_MODE;
};

/**
 * Can this member be summoned in this mode?
 *
 * The orchestrator and the briefer are exempt: they are the court's officers, they are
 * started with it, and a mode that could not talk to its own orchestrator would
 * be a mode with nothing to say. Only the bench is filtered.
 */
export function canSummon(mode, name, role = 'peasant') {
  if (role !== 'peasant') return true;
  const crew = modeOf(mode).crew;
  return crew === 'all' ? true : crew.includes(name);
}

/** The bench this mode offers, given the full configured roster of names. */
export function crewFor(mode, allNames = []) {
  const crew = modeOf(mode).crew;
  return crew === 'all' ? [...allNames] : allNames.filter((n) => crew.includes(n));
}

/**
 * Tools this mode withholds, by the capability they belong to rather than by
 * name — a tool added later that merges is a tool that must be gated, and
 * listing names here would silently exempt it.
 *
 * `declare_done` is deliberately NOT gated by `merge`: it is how a member
 * reports that it has finished, which every mode needs. What Research and Build
 * withhold is the step AFTER the report — the merge itself.
 */
const GATED = {
  crew:  ['summon', 'assign', 'propose_role', 'wake_member', 'dismiss_member'],
  tasks: ['add_task', 'tasks', 'claim_task', 'finish_task', 'submit_plan', 'rule_on_plan'],
  merge: ['request_merge', 'send_back'],
  workflows: ['workflow_list', 'workflow_get', 'workflow_save', 'workflow_delete', 'workflow_run'],
};

export function toolAllowed(mode, tool) {
  const m = modeOf(mode);
  if (GATED.crew.includes(tool) && !(m.crew === 'all' || m.crew.length)) return false;
  if (GATED.tasks.includes(tool) && !m.tasks) return false;
  if (GATED.merge.includes(tool) && !m.merge) return false;
  if (GATED.workflows.includes(tool) && !m.workflows) return false;
  return true;
}

/**
 * The block appended to a member's system prompt.
 *
 * Baked in at spawn and cached with the rest of the prompt, which is correct
 * here: each mode has its own bench, so a member spawned under one mode is not
 * reused under another. A LIVE mode change is carried by a bus notice instead —
 * see agenticos.js, and the measurement beside it about what rewriting a cached
 * prompt costs.
 */
export function modeBlock(mode) {
  const m = modeOf(mode);
  const lines = [`\n\n--- THIS COURT IS IN ${m.label.toUpperCase()} MODE ---`, m.blurb];
  if (!m.merge) {
    lines.push(
      `NOTHING MERGES IN THIS MODE. Your worktree is yours and it stays on its ` +
      `own branch — do not ask for a merge, and do not describe work as landed. ` +
      `Say what you changed and where it is.`);
  }
  if (!m.tasks) lines.push(`There is no shared task list in this mode.`);
  if (m.crew !== 'all' && !m.crew.length) {
    lines.push(
      `There is no crew. Answer the sovereign yourself rather than proposing ` +
      `anyone to do it for you — there is nobody to propose.`);
  }
  if (m.vaultDir) {
    lines.push(
      `THE DELIVERABLE IS A NOTE. Call vault_write with your findings — it lands ` +
      `under "${m.vaultDir}/" automatically in this mode, you do not need to put ` +
      `that in the title. Then say where you put it. A finding that lives only ` +
      `in this transcript is one the court pays to discover again next month.`);
  }
  if (m.pipeline) lines.push(m.pipeline);
  return lines.join('\n') + '\n';
}

// Self-check. `typeof process` rather than a bare `process.argv`: this module is
// imported by the UI's mode switcher too, and a bare reference throws
// ReferenceError in a browser and takes the whole module graph down with it.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('modes.js')) {
  const assert = await import('node:assert/strict');
  const a = assert.default ?? assert;

  // --- the table itself ---
  a.deepEqual(MODE_NAMES, ['chat', 'cowork', 'code']);
  for (const n of MODE_NAMES) {
    const m = MODES[n];
    a.ok(m.label && m.blurb, `${n} needs a label and a blurb — both reach the UI`);
    a.ok(m.crew === 'all' || Array.isArray(m.crew), `${n}.crew must be 'all' or a list`);
  }
  // The two the sovereign chose deliberately, asserted rather than assumed.
  a.equal(MODES.code.merge, true);
  a.equal(MODES.cowork.merge, false, 'cowork never merges');
  a.equal(MODES.cowork.worktrees, true, 'isolation still protects delegated work');
  a.deepEqual(MODES.chat.crew, [], 'chat is the orchestrator alone');
  a.equal(MODES.chat.worktrees, false, 'nobody to give a worktree to');
  a.equal(MODES.cowork.workflows, true);
  a.equal(MODES.code.workflows, undefined, 'workflow tools are Cowork-only');

  // --- modeOf never returns undefined ---
  a.equal(modeOf('code'), MODES.code);
  a.equal(modeOf('nonsense'), MODES.code, 'an unknown mode falls back to Code, not undefined');
  a.equal(modeOf(undefined), MODES.code);
  a.equal(modeOf(null), MODES.code);
  a.equal(modeName('chat'), 'chat');
  a.equal(modeName('research'), 'cowork', 'legacy modes migrate to Cowork');
  a.equal(modeName('nonsense'), 'code');

  // --- who may be summoned ---
  a.equal(canSummon('code', 'tester'), true, 'code offers the whole bench');
  a.equal(canSummon('cowork', 'researcher'), true);
  a.equal(canSummon('cowork', 'tester'), false, 'not on the Cowork bench');
  a.equal(canSummon('chat', 'researcher'), false, 'chat summons nobody');
  // The officers are never filtered: a mode that could not reach its own
  // orchestrator would have nothing to say.
  a.equal(canSummon('chat', 'orchestrator', 'orchestrator'), true);
  a.equal(canSummon('chat', 'briefer', 'briefer'), true);

  const bench = ['researcher', 'coder', 'writer', 'tester'];
  a.deepEqual(crewFor('code', bench), bench);
  a.deepEqual(crewFor('cowork', bench), ['researcher', 'writer']);
  a.deepEqual(crewFor('chat', bench), []);

  // --- the tool gate agrees with the table ---
  a.equal(toolAllowed('code', 'request_merge'), true);
  a.equal(toolAllowed('cowork', 'request_merge'), false);
  a.equal(toolAllowed('chat', 'summon'), false, 'nobody to summon');
  a.equal(toolAllowed('chat', 'add_task'), false, 'no task list in chat');
  a.equal(toolAllowed('cowork', 'add_task'), true);
  a.equal(toolAllowed('cowork', 'workflow_save'), true);
  a.equal(toolAllowed('code', 'workflow_save'), false, 'workflow tools are Cowork-only');
  a.equal(toolAllowed('cowork', 'summon'), true, 'Cowork has a crew');
  // The report survives everywhere; only the merge after it is withheld.
  for (const n of MODE_NAMES) {
    a.equal(toolAllowed(n, 'declare_done'), true, `${n} must still be able to report work`);
    a.equal(toolAllowed(n, 'send_message'), true, `${n} must still be able to talk`);
    a.equal(toolAllowed(n, 'vault_write'), true, `${n} must still be able to write a note`);
  }

  // --- the prompt block says the load-bearing thing in each mode ---
  a.match(modeBlock('cowork'), /NOTHING MERGES/);
  a.match(modeBlock('cowork'), /fact-checker/i, 'Cowork must nudge toward verifying contestable claims');
  a.match(modeBlock('cowork'), /workflow_save/, 'Cowork must explain automation work');
  a.doesNotMatch(modeBlock('code'), /fact-checker/i, 'the pipeline nudge is Cowork-only');
  a.doesNotMatch(modeBlock('code'), /NOTHING MERGES/);
  a.match(modeBlock('chat'), /no crew|nobody to propose/i);
  a.match(modeBlock('nonsense'), /CODE MODE/, 'an unknown mode still produces a usable block');

  console.log('modes ok — Chat, Cowork, Code; only Code merges');
}
