import { createHash } from 'node:crypto';

// The shape of the standing team, as data the code and the tests can check.
//
// docs/PLAN-team.md replaced a 107-role directory of professions with a small
// team organised on the stage of work. Measured on 2026-10-21 against the
// template this replaced: 107 agents, every one codex / gpt-5.6-luna /
// effort max, 97,548 characters of prompts that mostly restated their own
// descriptions, and an orchestrator code-mode prompt of 10,920 bytes against
// an 11,000-byte ceiling (test/t-efficiency.js).
//
// roles.json and agenticos.config.json's `agents` carry the roles themselves;
// this file only names which of them are standing, which tier each belongs to,
// and why the extra three exist. test/t-roles.js holds both files to it.
//
// It also owns the one-time upgrade of a team seeded with the old roster:
// planRosterMigration below, pure, proven by test/t-roster-migrate.js.

/** Bumped when the shipped roster changes shape. A team's config records the version it is on. */
export const ROSTER_VERSION = 2;

/**
 * The five lifecycle tiers, in the order work moves through them. Every
 * standing role names one in its `tier` field.
 */
export const TIERS = ['discovery', 'construction', 'verification', 'protection', 'memory'];

/**
 * The fifteen standing roles of docs/PLAN-team.md section 2, Q1.
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
 * add them ("run contestable claims past the fact-checker", "add a
 * defendant and a critic"). The plan predates that pipeline; dropping them
 * would leave Cowork's own instructions pointing at nobody.
 */
export const MODE_BOUND = ['fact-checker', 'defendant', 'critic'];

/** Every name roles.json ships (its own order is the bench order, grouped by tier). */
export const SHIPPED = [...STANDING, ...MODE_BOUND];

/**
 * Which standing role now takes the work of each retired one. The migration
 * records it on the archived entry, and roles-library.json carries the same
 * mapping. Every name the v1 template shipped is either on the v2 bench or
 * here; test/t-roster-migrate.js enforces that.
 */
export const COVERED_BY = {
  'accessibility-engineer': 'frontend',
  'aerospace-engineer': 'coder',
  'ai-safety-officer': 'auditor',
  'analyst': 'researcher',
  'audio-dsp-engineer': 'coder',
  'av-engineer': 'coder',
  'bioinformatics-specialist': 'coder',
  'blockchain-engineer': 'backend',
  'brand-designer': 'designer',
  'build-engineer': 'devops-engineer',
  'cad-specialist': 'coder',
  'chaos-engineer': 'devops-engineer',
  'climate-modeler': 'coder',
  'clinical-health-specialist': 'researcher',
  'cloud-architect': 'devops-engineer',
  'community-manager': 'writer',
  'compiler-engineer': 'coder',
  'copywriter': 'writer',
  'cryptographer': 'auditor',
  'customer-experience': 'designer',
  'data-engineer': 'backend',
  'data-steward': 'dba',
  'desktop-engineer': 'frontend',
  'developer-advocate': 'writer',
  'embedded': 'coder',
  'evaluator': 'tester',
  'event-coordinator': 'strategist',
  'exploit-developer': 'auditor',
  'finops-analyst': 'devops-engineer',
  'fintech-protocol-engineer': 'backend',
  'forensics-specialist': 'debugger',
  'game-engineer': 'coder',
  'gis-engineer': 'coder',
  'grant-specialist': 'writer',
  'growth-specialist': 'strategist',
  'hardware-engineer': 'coder',
  'hardware-security-analyst': 'auditor',
  'iam-specialist': 'auditor',
  'incident-commander': 'debugger',
  'industrial-automation': 'coder',
  'instructional-designer': 'writer',
  'integration-specialist': 'backend',
  'internal-auditor': 'auditor',
  'knowledge-graph-engineer': 'dba',
  'legal-counsel': 'researcher',
  'localization': 'frontend',
  'maa-strategist': 'strategist',
  'materials-scientist': 'researcher',
  'migration-engineer': 'dba',
  'mlops': 'devops-engineer',
  'mobile': 'frontend',
  'motion-designer': 'designer',
  'multi-modal': 'coder',
  'network-engineer': 'devops-engineer',
  'neurotechnology-engineer': 'coder',
  'operator': 'devops-engineer',
  'penetration-tester': 'auditor',
  'people-operations': 'strategist',
  'performance': 'debugger',
  'photonics-engineer': 'coder',
  'physical-security': 'auditor',
  'privacy-officer': 'auditor',
  'procurement-specialist': 'researcher',
  'prompt-engineer': 'writer',
  'public-relations': 'writer',
  'quantitative-modeler': 'coder',
  'quantum-engineer': 'coder',
  'release-manager': 'devops-engineer',
  'reverse-engineer': 'debugger',
  'risk-officer': 'strategist',
  'robotics-engineer': 'coder',
  'scientific-computing-engineer': 'coder',
  'search-engineer': 'backend',
  'security-reviewer': 'auditor',
  'seo-specialist': 'writer',
  'soc-analyst': 'auditor',
  'solutions-engineer': 'architect',
  'sound-designer': 'designer',
  'supply-chain-security': 'auditor',
  'supply-chain-specialist': 'researcher',
  'synthetic-data-specialist': 'tester',
  'systems': 'backend',
  'tax-specialist': 'researcher',
  'technical-artist': 'designer',
  'technical-writer': 'writer',
  'threat-intelligence-specialist': 'auditor',
  'video-streaming-engineer': 'backend',
  'virtualization-engineer': 'devops-engineer',
  'wasm-engineer': 'coder',
  'xr-spatial-engineer': 'frontend',
};

/**
 * On the v2 bench but absent from the v1 template, so a v1 team never had the
 * chance to delete it: the migration adds these to a team that held one of the
 * roles they replace. Any other bench role a team lacks was deleted by its
 * user and stays deleted, the same promise #seedRoles makes.
 */
export const NEW_IN_V2 = ['devops-engineer'];

/**
 * sha256-16 of `title\ndescription\nprompt` for every role as SHIPPED before
 * v2: the 107-role template and the 17-role roles.json, both as of
 * origin/functionality e730bb6. A team entry whose text still matches was
 * never edited, so replacing or retiring it loses nothing the user wrote.
 * An entry that does not match is the user's, and its text is left alone.
 */
const LEGACY_FINGERPRINTS = {
  'accessibility-engineer': ['db3ffab7a101527a'],
  'aerospace-engineer': ['1fcf2d16b89b354d'],
  'ai-safety-officer': ['30ed862c06b890ad'],
  'analyst': ['4017a6a97b6d4e53'],
  'architect': ['a27d6a248097e604', '39754f999e78c26a'],
  'audio-dsp-engineer': ['6b800515abba1915'],
  'auditor': ['cd3c2f3cc36839a3', '372342ccfd7c44c6'],
  'av-engineer': ['963614c8122c323d'],
  'backend': ['62c5e7f28b97d564', 'aecddf28b93dc9f0'],
  'bioinformatics-specialist': ['e14a3a67fbca1286'],
  'blockchain-engineer': ['0513305c9e9b74ee'],
  'brand-designer': ['28fb3c4e007f8af7'],
  'build-engineer': ['30a30bfc5b61e305'],
  'cad-specialist': ['196581ed52422aea'],
  'chaos-engineer': ['20b5a4faa47de8ab'],
  'climate-modeler': ['71288f5dc89669a1'],
  'clinical-health-specialist': ['c02c8f3e5a8de86f'],
  'cloud-architect': ['4079c3ad0d569cec'],
  'coder': ['de7c6a16a6d05e89', 'fd05c1477740082f'],
  'community-manager': ['55876630bc618224'],
  'compiler-engineer': ['430635ec510695af'],
  'copywriter': ['c3324507ef74e16d'],
  'critic': ['bf7f4d8555edd4b7', 'b929a342fd0a63fa'],
  'cryptographer': ['3fca74be94516ae3'],
  'customer-experience': ['6818cd189d8c9a3b'],
  'data-engineer': ['3bbedb4585a50f87'],
  'data-steward': ['2e90045ce8c1a5b0'],
  'dba': ['19924aec4ae819da', '5993fff3198aea1c'],
  'debugger': ['31b624e9bf45963d'],
  'defendant': ['231b5c5e1f054fdc', '322a856f16eeff84'],
  'designer': ['13ed60379bbb6e95', 'b4353097cc94ede0'],
  'desktop-engineer': ['4ff684ba68000e8a'],
  'developer-advocate': ['9f85a4a8ed02b3d8'],
  'devops-engineer': ['7a380eb7dcc4c1d7'],
  'embedded': ['e72e5d92fd8ba00a'],
  'evaluator': ['efe51bee4c59ae97'],
  'event-coordinator': ['eb018c8e70df1672'],
  'exploit-developer': ['251136b86dd2b141'],
  'fact-checker': ['4a4afb591507a3c5', '3584cfdf105ff3e0'],
  'finops-analyst': ['cc28b6df11f6a180'],
  'fintech-protocol-engineer': ['cd6eb4234bdbbd0c'],
  'forensics-specialist': ['f7019848c147abf9'],
  'frontend': ['a9b2fe0a90ffbb96', 'ee828e3dd7306377'],
  'game-engineer': ['fcc866272f49fb05'],
  'gis-engineer': ['20ef5f4bf67611fa'],
  'grant-specialist': ['1b60d2bf15aeac75'],
  'growth-specialist': ['5cd4cb8a70c11abd'],
  'hardware-engineer': ['77c8a801a773e0d0'],
  'hardware-security-analyst': ['bf097dfaf9c73535'],
  'iam-specialist': ['231b948505b64bf1'],
  'incident-commander': ['c20a5988bdd9271a'],
  'industrial-automation': ['ce4af24f8d9534f6'],
  'instructional-designer': ['011c3ca6e1f70d91'],
  'integration-specialist': ['57381b0cca70d694'],
  'internal-auditor': ['c241f4e1dfd90d5a'],
  'knowledge-graph-engineer': ['337af20163e8f760'],
  'legal-counsel': ['e9a6c8ac372e4dbc'],
  'localization': ['4c59b3942d3a8446'],
  'maa-strategist': ['326315b8975c064d'],
  'materials-scientist': ['627efab18a8958c5'],
  'migration-engineer': ['9e91321fd975988d'],
  'mlops': ['932e697f32a62a5a'],
  'mobile': ['ce508db53d49e1ea'],
  'motion-designer': ['2eb80a9769154b94'],
  'multi-modal': ['fe513dab3f9fd7e0'],
  'network-engineer': ['35c02bea3c78b163'],
  'neurotechnology-engineer': ['ca459da0af37a608'],
  'operator': ['aa5f210f0941ff8a'],
  'penetration-tester': ['38567271e98f8c89'],
  'people-operations': ['0441b036cb4b31d3'],
  'performance': ['7da5f5fb5eb3f0b9'],
  'photonics-engineer': ['af39b39d01e242f3'],
  'physical-security': ['75d6869f4432b24b'],
  'privacy-officer': ['894e9f11ec7976fe'],
  'procurement-specialist': ['10d347fafcd2a2d2'],
  'prompt-engineer': ['0aa799f2a7f231b2'],
  'public-relations': ['a30d62d9ff6a7e47'],
  'quantitative-modeler': ['07a4dca07e1d5665'],
  'quantum-engineer': ['8f7d631898e38c48'],
  'refactoring-engineer': ['a0427b080d570076', '7088364b4a1de7e8'],
  'release-manager': ['4dcf649cde68880e'],
  'researcher': ['81b7d292a32beaa8', 'f4f0037f8c5f4faa'],
  'reverse-engineer': ['162f224a1f8bc56a'],
  'reviewer': ['cc663d906baf7744', '1c924125c7847657'],
  'risk-officer': ['629824c9a7a515f4'],
  'robotics-engineer': ['24e15b644f961157'],
  'scientific-computing-engineer': ['e0ac2f8589984897'],
  'search-engineer': ['396845a7ae9d5a95'],
  'security-reviewer': ['e8e5d967b5ff89e3'],
  'seo-specialist': ['643c578bc5b1549a'],
  'soc-analyst': ['9476185141c1c447'],
  'solutions-engineer': ['81b58af7f91ca972'],
  'sound-designer': ['6ca5fe9f1d2e1bd2'],
  'strategist': ['6f36f6f586d508e1', 'c998307b1e803ba3'],
  'supply-chain-security': ['3c0efe3a2adfe78c'],
  'supply-chain-specialist': ['fb8d38801c44c2bf'],
  'synthetic-data-specialist': ['d8c56f8a9c402fc4'],
  'systems': ['a66e6cd43ba43048'],
  'tax-specialist': ['53edb706781190f1'],
  'technical-artist': ['9c8627d1a1071a22'],
  'technical-writer': ['d5fcdb577d3a0f9c'],
  'tester': ['c370c19e3de6f7b1', 'f2309d4e056c1fce'],
  'threat-intelligence-specialist': ['0cb595aa91425d59'],
  'video-streaming-engineer': ['ed78b02e0f340294'],
  'virtualization-engineer': ['9242e09f94f1cea6'],
  'wasm-engineer': ['da223fa7058d9def'],
  'writer': ['031bcf5a83c589ab', '72171746e0611180'],
  'xr-spatial-engineer': ['b7799197a4a9ea91'],
};

/** The model every v1 template role shipped on (measured: 107 of 107). */
const LEGACY_MODEL = 'codex/gpt-5.6-luna/max';

export const fingerprint = (r) => createHash('sha256')
  .update(`${r.title ?? ''}\n${r.description ?? ''}\n${r.prompt ?? ''}`, 'utf8')
  .digest('hex').slice(0, 16);

const triple = (r) => `${r.cli ?? ''}/${r.model ?? ''}/${r.effort ?? ''}`;

/** Text exactly as some version shipped it. */
const textUntouched = (p) => (LEGACY_FINGERPRINTS[p.name] ?? []).includes(fingerprint(p));

/** Model as shipped, or as agentDefaults stamped it at seed time, and not handed to Auto. */
const modelUntouched = (p, defaults) => p.auto !== true
  && (triple(p) === LEGACY_MODEL || triple(p) === triple(defaults));

/**
 * Upgrade a team's roster from v1 to v2 without losing anything.
 *
 * Pure: the caller supplies `busy(name)`, true while a member has work in
 * flight. Returns null when there is nothing to do, otherwise the new
 * `{ agents, retiredAgents, rosterRetiring, rosterVersion, report }`.
 *
 * The rules, each the conservative reading of "upgrade safely":
 *  - a v2 role the team has: its text and its model are replaced only where
 *    they are still exactly as shipped. An edited prompt or a chosen model stays.
 *  - a retired v1 role, untouched: archived into `retiredAgents` with the
 *    role that now covers it, not deleted. If it is busy it stays on the roster
 *    and is listed in `rosterRetiring`, and a later launch retires it once idle.
 *  - a retired v1 role the user edited, and any role the team invented:
 *    kept as is. Only the user deletes those.
 *  - a NEW_IN_V2 role the team lacks: added, if the team held a v1 role it replaces.
 * Messages, tasks, events and memory live on the bus and in the vault. This
 * rewrites config only, so it cannot lose any of them.
 */
export function planRosterMigration(config, { library, busy = () => false }) {
  const version = Number(config.rosterVersion ?? 1);
  const pending = Array.isArray(config.rosterRetiring) ? config.rosterRetiring : [];
  if (version >= ROSTER_VERSION && !pending.length) return null;
  const firstPass = version < ROSTER_VERSION;
  const defaults = config.agentDefaults ?? {};
  const shipped = new Map(library.map((r) => [r.name, r]));
  const retiring = new Set(firstPass ? [] : pending);
  const report = { upgraded: [], retired: [], keptBusy: [], keptEdited: [], added: [] };
  const agents = [];
  const archive = [];

  for (const p of config.agents ?? []) {
    const lib = shipped.get(p.name);
    if (firstPass && lib) {
      const next = { ...p, tier: lib.tier };
      if (textUntouched(p)) Object.assign(next, { title: lib.title, description: lib.description, prompt: lib.prompt });
      if (modelUntouched(p, defaults)) Object.assign(next, { cli: lib.cli, model: lib.model, effort: lib.effort });
      if (JSON.stringify(next) !== JSON.stringify(p)) report.upgraded.push(p.name);
      agents.push(next);
      continue;
    }
    const legacy = Object.hasOwn(COVERED_BY, p.name);
    const candidate = firstPass
      ? legacy && textUntouched(p) && modelUntouched(p, defaults)
      : retiring.has(p.name);
    if (!candidate) {
      if (firstPass && legacy) report.keptEdited.push(p.name);
      agents.push(p);
      continue;
    }
    if (busy(p.name)) {
      retiring.add(p.name);
      report.keptBusy.push(p.name);
      agents.push(p);
      continue;
    }
    retiring.delete(p.name);
    archive.push({ ...p, retiredFor: COVERED_BY[p.name] ?? null });
    report.retired.push(p.name);
  }
  // A pending name the user has since removed by hand is no longer pending.
  for (const n of [...retiring]) if (!agents.some((p) => p.name === n)) retiring.delete(n);
  if (firstPass) {
    // Only where a role it replaces was on the team (operator, build-engineer
    // and the rest that COVERED_BY sends to it): that is a team seeded from the
    // v1 template. A hand-built team without them chose its own bench.
    const had = new Set((config.agents ?? []).map((p) => COVERED_BY[p.name]));
    for (const n of NEW_IN_V2) {
      if (shipped.has(n) && had.has(n) && !agents.some((p) => p.name === n)) {
        agents.push({ ...defaults, ...shipped.get(n) });
        report.added.push(n);
      }
    }
  }
  return {
    agents,
    retiredAgents: [...(Array.isArray(config.retiredAgents) ? config.retiredAgents : []), ...archive],
    rosterRetiring: [...retiring],
    rosterVersion: ROSTER_VERSION,
    report,
  };
}
