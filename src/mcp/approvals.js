// approvals tools. See src/mcp.js for how these reach a member.
import { badRole, badSummon } from '../approval.js';
import {
  ME, bus, str, stateArray, rosterNow, officer,
} from './ctx.js';

export const approvals = {
  submit_plan: {
    roles: ['peasant'],
    description:
      'Send the orchestrator your approach for a task that requires approval. You stay read-only until it is approved.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Which task' }, plan: str('What you intend to do, and why') },
      required: ['id', 'plan'],
    },
    run: ({ id, plan }) => {
      const t = bus.tasks().find((x) => x.id === Number(id));
      if (!t) return `No task #${id}.`;
      if (t.owner !== ME) return `Task #${id} is not yours.`;
      if (t.state !== 'planning') return `Task #${id} is ${t.state} — it does not need a plan.`;
      bus.updateTask(id, { plan });
      bus.post(ME, officer('orchestrator', 'orchestrator'), `Plan for task #${id} (${t.title}):\n\n${plan}`, 'plan');
      return `Plan sent for #${id}. Do not edit anything until the orchestrator approves it.`;
    },
  },

  rule_on_plan: {
    roles: ['orchestrator'],
    description:
      'Approve or reject a peasant\'s plan. Rejecting keeps them read-only and hands back your notes, so say '
      + 'what would make it acceptable rather than only what is wrong.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Which task' },
        approve: { type: 'boolean', description: 'true to let the work begin' },
        notes: str('Your reasoning, or what must change'),
      },
      required: ['id', 'approve', 'notes'],
    },
    run: ({ id, approve, notes }) => {
      const t = bus.tasks().find((x) => x.id === Number(id));
      if (!t) return `No task #${id}.`;
      if (t.state !== 'planning') return `Task #${id} is ${t.state} — there is no plan pending on it.`;
      if (!t.plan) return `Task #${id} has not submitted a plan yet.`;
      if (approve) bus.updateTask(id, { state: 'active' });
      bus.post(ME, t.owner,
        approve ? `Plan approved for #${id}. Begin. ${notes}`
          : `Plan rejected for #${id}. Revise and submit again — you remain read-only. ${notes}`,
        'assignment');
      return approve ? `#${id} approved; ${t.owner} may begin.` : `#${id} sent back to ${t.owner}.`;
    },
  },

  summon: {
    roles: ['orchestrator'],
    description:
      'Propose the crew to wake. The sovereign approves it and reads your reasoning. Wake the fewest that can do the job.',
    schema: {
      type: 'object',
      properties: {
        names: {
          type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 32,
          uniqueItems: true, description: 'Roster names to wake (up to 32 unique names)',
        },
        reason: str('Why these ones'),
      },
      required: ['names', 'reason'],
    },
    run: ({ names, reason }) => {
      const roster = stateArray('roster');
      if (!roster) return 'Cannot propose a summon: roster is unavailable.';
      const error = badSummon({ names, reason }, { roster });
      if (error) return error;
      bus.post(ME, null, JSON.stringify({ kind: 'summon', names, reason }), 'approval');
      return 'Proposal sent to the sovereign. Wait for approval before assigning work.';
    },
  },

  propose_role: {
    roles: ['orchestrator'],
    description:
      'Propose a brand-new kind of peasant to add to the roster permanently. ' +
      'Requires the sovereign\'s approval.',
    schema: {
      type: 'object',
      properties: {
        name: str('Short lowercase name, e.g. "security-auditor"'),
        prompt: str('The system prompt defining this role'),
        cli: str('"claude" or "codex"'),
        model: str('Model name (optional)'),
        reason: str('Why the kingdom needs it'),
      },
      required: ['name', 'prompt', 'cli', 'reason'],
    },
    run: (spec) => {
      // Refused HERE as well as at approve(), because the orchestrator can act on this
      // answer — a rejection at the approval boundary is a card the sovereign
      // has to read and dismiss, hours later, with no way to tell the orchestrator why.
      const err = badRole(spec, { taken: rosterNow().map((m) => m.name) });
      if (err) return `${err} Nothing was proposed.`;
      bus.post(ME, null, JSON.stringify({ kind: 'role', ...spec }), 'approval');
      return 'Role proposed. Await the sovereign\'s decision.';
    },
  },

  request_merge: {
    roles: ['orchestrator'],
    description:
      'You have reviewed a peasant\'s work and judge it fit. This surfaces a ' +
      'Merge button to the sovereign, who has the final word.',
    schema: {
      type: 'object',
      properties: { peasant: str('Whose worktree'), verdict: str('Your review, for the sovereign') },
      required: ['peasant', 'verdict'],
    },
    run: ({ peasant, verdict }) => {
      bus.post(ME, null, JSON.stringify({ kind: 'merge', peasant, verdict }), 'approval');
      return 'Merge proposed to the sovereign.';
    },
  },

  request_push: {
    roles: ['orchestrator'],
    description:
      'Ask the sovereign for one explicit push of the local base branch to its configured upstream. This never '
      + 'pushes now, never force-pushes, and every later push needs a new approval.',
    schema: {
      type: 'object',
      properties: { reason: str('Why this reviewed local state should leave the machine') },
      required: ['reason'],
    },
    run: ({ reason }) => {
      bus.post(ME, null, JSON.stringify({ op: 'push', reason }), 'control');
      return 'Push proposed to the sovereign. No remote was contacted.';
    },
  },
};
