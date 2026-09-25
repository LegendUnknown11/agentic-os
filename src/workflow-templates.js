// Built-in automations the sovereign can switch on from the Automations view.
// Each is an ordinary workflow: installing one saves a copy under a fresh id,
// which the sovereign then edits (time, weekdays, recipient, prompt) like any
// other. Nothing here runs until it is installed.
//
// Two kinds, and the difference matters:
// - `digest` and `task` templates run entirely on this app's own state, cost
//   no model tokens, and are covered by the suite end to end.
// - `connector` templates ask the orchestrator to use a connector or CLI it
//   may not have (a calendar, gh). They are only as good as that member's
//   setup on this machine, which no test here can see, so each prompt tells
//   the orchestrator to say so plainly rather than guess.

const orchestratorPrompt = (lines) => lines.join(' ');

export const WORKFLOW_TEMPLATES = [
  {
    id: 'morning-brief',
    name: 'Morning inbox brief',
    description: 'Every weekday at 08:00: what is waiting on you in the app, posted to you and shown on your desktop.',
    needs: null,
    workflow: {
      name: 'Morning inbox brief',
      trigger: { type: 'daily', at: '08:00', days: [1, 2, 3, 4, 5] },
      nodes: [{ id: 'brief', type: 'digest', config: { of: 'inbox', title: 'Your morning brief' } }],
    },
  },
  {
    id: 'team-digest',
    name: 'Daily team digest',
    description: 'Every day at 17:30: what the team finished, the queue, the run, run spend, and what waits on you.',
    needs: null,
    workflow: {
      name: 'Daily team digest',
      trigger: { type: 'daily', at: '17:30' },
      nodes: [{ id: 'digest', type: 'digest', config: { of: 'team', title: 'Team digest' } }],
    },
  },
  {
    id: 'weekly-dependencies',
    name: 'Weekly dependency check',
    description: "Every Monday at 09:00: puts a dependency-update task on the team's queue. Edit the title, owner and day to schedule any recurring work.",
    needs: null,
    workflow: {
      name: 'Weekly dependency check',
      trigger: { type: 'daily', at: '09:00', days: [1] },
      nodes: [{
        id: 'task', type: 'task',
        config: {
          title: 'Check dependencies for updates',
          detail: 'List outdated dependencies, update the safe ones with tests passing, and report anything that needs a decision.',
          owner: '', priority: 0,
        },
      }],
    },
  },
  {
    id: 'calendar-brief',
    name: 'Calendar brief',
    description: "Every weekday at 07:45: asks the orchestrator to brief you on today's meetings using its calendar connector.",
    needs: 'The orchestrator\'s CLI must have a calendar connector configured on this machine. Without one it will say so.',
    workflow: {
      name: 'Calendar brief',
      trigger: { type: 'daily', at: '07:45', days: [1, 2, 3, 4, 5] },
      nodes: [{
        id: 'ask', type: 'bus',
        config: {
          to: 'orchestrator',
          body: orchestratorPrompt([
            "Brief the sovereign on today's calendar: each meeting's time, who, and one line of prep.",
            'Use your calendar connector. If you have no calendar connector, reply only that the calendar',
            'brief needs one configured for your CLI, and stop. Never guess or invent meetings.',
          ]),
        },
      }],
    },
  },
  {
    id: 'github-triage',
    name: 'GitHub triage',
    description: 'Every weekday at 09:15: asks the orchestrator for open pull requests and issues that need you, using gh.',
    needs: 'The orchestrator needs gh (or a GitHub connector) signed in on this machine. Without it, it will say so.',
    workflow: {
      name: 'GitHub triage',
      trigger: { type: 'daily', at: '09:15', days: [1, 2, 3, 4, 5] },
      nodes: [{
        id: 'ask', type: 'bus',
        config: {
          to: 'orchestrator',
          body: orchestratorPrompt([
            "Triage this repository's GitHub for the sovereign: open pull requests awaiting their review or",
            'with failing checks, and issues assigned to them or opened since yesterday. One line each, most',
            'urgent first. Use gh (or a GitHub connector). If neither is available and signed in, reply only',
            'that GitHub triage needs gh signed in, and stop. Never guess.',
          ]),
        },
      }],
    },
  },
];

/** A fresh, installable copy of a template: new id, enabled, marked with its source. */
export function instantiateTemplate(templateId, { now = Date.now() } = {}) {
  const template = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
  if (!template) return null;
  return {
    ...structuredClone(template.workflow),
    id: `${template.id}-${now.toString(36)}`,
    enabled: true,
    template: template.id,
  };
}
