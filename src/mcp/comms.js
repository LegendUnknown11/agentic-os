// comms tools. See src/mcp.js for how these reach a member.
import { badQuestions } from '../approval.js';
import { join } from 'node:path';
import {
  ME, bus, tooBig, str, rosterNow, officer, badRecipient, cursorFor, advance, nothingNew,
} from './ctx.js';

export const comms = {
  send_message: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Message another member directly by name. Prefer this over waiting on the orchestrator.',
    schema: {
      type: 'object',
      properties: { to: str('Recipient name, e.g. "coder"'), body: str('What to say') },
      required: ['to', 'body'],
    },
    run: ({ to, body }) => {
      const err = tooBig(body) ?? badRecipient(to);
      if (err) return err;
      bus.post(ME, to, body);
      return `Sent to ${to}.`;
    },
  },

  broadcast: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description:
      'Say something to every member of the court at once. EXPENSIVE — it ' +
      'costs every recipient a turn, so prefer send_message to the one or two ' +
      'members who actually need to know.',
    schema: { type: 'object', properties: { body: str('What to say') }, required: ['body'] },
    run: ({ body }) => {
      const err = tooBig(body);
      if (err) return err;
      bus.post(ME, null, body);
      return 'Broadcast sent to everyone.';
    },
  },

  roster: {
    roles: ['peasant', 'briefer', 'orchestrator'],
    description: 'Who is in the court, their role, and whether they are awake.',
    schema: { type: 'object', properties: {} },
    run: () => rosterNow(),
  },

  declare_done: {
    roles: ['peasant'],
    description:
      'Declare your task complete. Tests run automatically and the orchestrator reviews your diff.',
    schema: {
      type: 'object',
      properties: { summary: str('What you changed and why') },
      required: ['summary'],
    },
    run: ({ summary }) => {
      const held = bus.tasks().filter((t) => t.owner === ME && t.state !== 'done');
      if (held.length > 1) {
        return `You still hold ${held.map((t) => `#${t.id}`).join(' and ')}. Call finish_task for the completed one before declaring done.`;
      }
      if (held[0]?.state === 'planning') {
        return `Task #${held[0].id} still needs an approved plan. Call submit_plan and wait for the orchestrator.`;
      }
      if (held[0]) bus.updateTask(held[0].id, { state: 'done', doneTs: Date.now() });
      const orchestrator = officer('orchestrator', 'orchestrator');
      bus.post(ME, orchestrator, summary, 'done');
      return `Declared done${held[0] ? `; task #${held[0].id} closed` : ''}. ${orchestrator} has been notified; await review.`;
    },
  },

  read_bus: {
    roles: ['briefer', 'orchestrator'],
    description:
      'New messages since you last looked. Orchestrator: prefer the briefer briefings.',
    schema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Look back from this id instead of where you left off' },
        limit: { type: 'number', description: 'Max rows (default 60)' },
      },
    },
    run: ({ since, limit = 60 }) => {
      const { from, track } = cursorFor('bus', since);
      const rows = bus.history({ since: from, limit });
      advance('bus', track, rows);
      if (!rows.length) return nothingNew(from);
      return rows.map((m) =>
        `#${m.id} ${m.sender}->${m.recipient ?? '*'} [${m.kind}] ` +
        m.body.replace(/\s+/g, ' ').slice(0, 300)).join('\n');
    },
  },

  brief_orchestrator: {
    roles: ['briefer'],
    description:
      'Brief the orchestrator in plain language. Flag anything blocked, looping or contradictory.',
    schema: { type: 'object', properties: { summary: str('The briefing') }, required: ['summary'] },
    run: ({ summary }) => {
      bus.post(ME, officer('orchestrator', 'orchestrator'), summary, 'brief');
      return 'Briefing delivered.';
    },
  },

  ask_question: {
    roles: ['orchestrator', 'briefer', 'peasant'],
    description:
      'Ask the sovereign one or more structured, multiple-choice questions when you are blocked ' +
      'on a decision only they can make. Returns immediately — the answer arrives later as a bus ' +
      'message. Do not use for anything you can reasonably decide yourself.',
    schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: str('The full question'),
              header: str('Very short label, under 12 chars, e.g. "Auth method"'),
              multiSelect: { type: 'boolean', description: 'Allow picking more than one option' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: str('Short choice text'),
                    description: str('What this choice means'),
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'header', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    run: ({ questions }) => {
      const err = badQuestions({ questions });
      if (err) return `${err} Nothing was asked.`;
      bus.post(ME, null, JSON.stringify({ kind: 'question', questions }), 'approval');
      return 'Question(s) posted to the sovereign. Their answer will arrive as a bus message — '
        + 'continue other work or end your turn.';
    },
  },

  send_back: {
    roles: ['orchestrator'],
    description: 'Reject a peasant\'s work and send it back with notes on what to fix.',
    schema: {
      type: 'object',
      properties: { peasant: str('Whose work'), notes: str('What must change') },
      required: ['peasant', 'notes'],
    },
    run: ({ peasant, notes }) => {
      const err = badRecipient(peasant);
      if (err) return err;
      bus.post(ME, peasant, `Your work was sent back. ${notes}`, 'assignment');
      return `Sent back to ${peasant}.`;
    },
  },
};
