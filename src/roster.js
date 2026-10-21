// The shape of the standing court, as data the code and the tests can check.
//
// docs/PLAN-court.md replaced a 107-role directory of professions with a small
// court organised on the stage of work. Measured on 2026-10-21 against the
// template this replaced: 107 peasants, every one codex / gpt-5.6-luna /
// effort max, 97,548 characters of prompts that mostly restated their own
// descriptions, and an orchestrator code-mode prompt of 10,920 bytes against
// an 11,000-byte ceiling (test/t-efficiency.js).
//
// roles.json and kingdom.config.json's `peasants` carry the roles themselves;
// this file only names which of them are standing, which tier each belongs to,
// and why the extra three exist. test/t-roles.js holds both files to it.

/** Bumped when the shipped roster changes shape. A court's config records the version it is on. */
export const ROSTER_VERSION = 2;

/**
 * The five lifecycle tiers, in the order work moves through them. Every
 * standing role names one in its `tier` field.
 */
export const TIERS = ['discovery', 'construction', 'verification', 'protection', 'memory'];

/**
 * The fifteen standing roles of docs/PLAN-court.md section 2, Q1.
 *
 * Two names differ from that plan, deliberately: it was written before the
 * repository renamed scout -> researcher and scribe -> writer, and src/modes.js
 * crews Cowork from the new names. Keeping the names the code already uses was
 * the conservative choice; plans/functionality/f2-design.md records it.
 */
export const STANDING = [
  'researcher', 'strategist', 'architect',
  'coder', 'refactoring-engineer', 'frontend', 'designer', 'backend', 'dba',
  'tester', 'reviewer', 'debugger',
  'auditor', 'devops-engineer',
  'writer',
];

/**
 * Roles kept beyond the fifteen because a mode names them. src/modes.js crews
 * Cowork with these three and its pipeline text tells the orchestrator to
 * summon them ("run contestable claims past the fact-checker", "summon a
 * defendant and a critic"). The plan predates that pipeline; dropping them
 * would leave Cowork's own instructions pointing at nobody.
 */
export const MODE_BOUND = ['fact-checker', 'defendant', 'critic'];

/** Every name roles.json ships (its own order is the bench order, grouped by tier). */
export const SHIPPED = [...STANDING, ...MODE_BOUND];
