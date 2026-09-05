// control tools. See src/mcp.js for how these reach a member.
import { modeName, modeOf, MODE_NAMES } from '../modes.js';
import { join } from 'node:path';
import {
  ME, bus, str, rosterNow, goalNow, modeNow,
} from './ctx.js';

export const control = {
  goal: {
    roles: ['orchestrator', 'briefer', 'peasant'],
    description:
      'The court\'s standing goal and its milestones. Read it when you are '
      + 'unsure whether a piece of work is worth doing.',
    schema: { type: 'object', properties: {} },
    run: () => {
      const { goal: g, unreadable } = goalNow();
      if (unreadable) return 'The standing goal is unreadable. Ask the sovereign to set it again.';
      if (!g) return 'No standing goal. The court works on whatever the sovereign last asked.';
      return `GOAL: ${g.text}\n`
        + (g.milestones ?? []).map((m, i) => `  ${i}. [${m.done ? 'x' : ' '}] ${m.text}`).join('\n');
    },
  },

  milestone_done: {
    // The orchestrator judges completion — it is the one that reviews the work. A
    // peasant marking its own milestone done is the same failure as a peasant
    // declaring its own tests passed.
    roles: ['orchestrator'],
    description:
      'Mark one of the standing goal\'s milestones finished, by its index from '
      + 'the goal tool. Only do this once you have SEEN the evidence.',
    schema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Milestone index, as shown by the goal tool' },
        evidence: str('What convinced you it is done — a diff, a test result, a merge'),
      },
      required: ['index', 'evidence'],
    },
    run: ({ index, evidence }) => {
      const { goal: g, unreadable } = goalNow();
      if (unreadable) return 'Cannot record a milestone: the standing goal is unreadable.';
      if (!g) return 'There is no standing goal.';
      if (!g.milestones?.[index]) return `No milestone at index ${index}.`;
      // Written to the bus, not to the config: the orchestrator owns the config
      // and watches this key, so there is one writer and no lost update.
      bus.post(ME, 'orchestrator', JSON.stringify({ index, evidence }), 'milestone');
      return `Recorded milestone ${index} ("${g.milestones[index].text}") as done.`;
    },
  },

  argue: {
    // The orchestrator only. This is three to five one-shot model calls across two
    // vendors, and it is the orchestrator that owns contested decisions — the same
    // reason summon and propose_role are its alone. A peasant that wants a
    // question settled asks the orchestrator for one.
    roles: ['orchestrator'],
    description:
      'Put a genuinely contested question to the argument court: two different '
      + 'models argue it and a third judges. Returns immediately — the verdict '
      + 'arrives later as a message. Use it where asking two members would just '
      + 'produce one opinion twice; not for anything you can settle yourself.',
    schema: {
      type: 'object',
      properties: {
        question: str('The question, stated so it could honestly be answered either way'),
      },
      required: ['question'],
    },
    run: ({ question }) => {
      const q = String(question ?? '').trim();
      if (!q) return 'Nothing was argued: the question is empty.';
      // The same 4,000-char ceiling the bus puts on a message. A debate is not
      // a document, and argue.js trims each side to 6,000 anyway.
      if (q.length > 4000) {
        return `Nothing was argued: the question is ${q.length} chars, and the limit is 4000. State it shorter.`;
      }
      bus.post(ME, null, JSON.stringify({ question: q }), 'argue');
      return 'Sent to the argument court. The verdict arrives later as a message — '
        + 'do not wait on it, carry on with something else.';
    },
  },

  set_mode: {
    // The orchestrator only. A mode decides who may be summoned, what tools exist and
    // where notes land — it is the shape of the whole court, not one member.
    roles: ['orchestrator'],
    description:
      'Change what shape the court is in. Do this when the work in front of you '
      + 'is plainly a different KIND of work than the mode allows — a coding job '
      + 'asked for in Chat, a question that wants a research note. Says so to '
      + 'everyone. Code needs a repository attached and comes back refused if '
      + 'there is none, so do not promise the sovereign a switch you have not made yet.',
    schema: {
      type: 'object',
      properties: {
        mode: str(`One of: ${MODE_NAMES.join(', ')}`),
        why: str('One line the rest of the court will read. Optional.'),
      },
      required: ['mode'],
    },
    run: ({ mode, why }) => {
      // Checked against the real list, NOT through modeName(): that falls back
      // to DEFAULT_MODE for anything it does not recognise, so a typo would
      // quietly put the whole court into Code mode.
      if (!MODE_NAMES.includes(mode)) {
        return `No such mode: "${mode}". The court has: ${MODE_NAMES.join(', ')}. Nothing changed.`;
      }
      if (mode === modeNow()) return `The court is already in ${modeOf(mode).label} mode.`;
      bus.post(ME, null, JSON.stringify({ op: 'mode', mode, why: why ?? '' }), 'control');
      return 'Asked for the switch. It lands within a second and everyone is told; '
        + 'if it is refused you get a message saying why, so carry on rather than waiting on it.';
    },
  },

  wake_member: {
    roles: ['orchestrator'],
    description:
      'Wake a member that is on the roster but asleep, so it can pick work up '
      + 'again. This is not summoning: it adds nobody, it only restarts someone '
      + 'the sovereign already approved.',
    schema: {
      type: 'object',
      properties: { name: str('A name already on the roster') },
      required: ['name'],
    },
    run: ({ name }) => {
      const known = rosterNow().map((x) => x.name);
      if (!known.includes(name)) {
        return `Nobody on the roster is called "${name}". The court has: ${known.join(', ')}.`;
      }
      bus.post(ME, null, JSON.stringify({ op: 'wake', name }), 'control');
      return `Waking ${name}. You get a message when it is up.`;
    },
  },

  dismiss_member: {
    roles: ['orchestrator'],
    description:
      'Stand a member down when its work is genuinely finished. This is the '
      + 'one cost lever you hold: an idle member still costs a full context '
      + 'replay every time it wakes. It leaves the roster and must be summoned '
      + 'again — with the sovereign approving — to come back, so do not use it '
      + 'to park somebody for a minute.',
    schema: {
      type: 'object',
      properties: {
        name: str('A member currently on the roster'),
        why: str('One line for the record. Optional.'),
      },
      required: ['name'],
    },
    run: ({ name }) => {
      if (name === ME) return 'You cannot stand yourself down. Ask the sovereign.';
      const known = rosterNow().map((x) => x.name);
      if (!known.includes(name)) {
        return `Nobody on the roster is called "${name}". The court has: ${known.join(', ')}.`;
      }
      bus.post(ME, null, JSON.stringify({ op: 'sleep', name }), 'control');
      return `Standing ${name} down.`;
    },
  },

  set_model: {
    roles: ['orchestrator'],
    description:
      'Move a member onto a different model or effort level. Use it when the '
      + 'work and the model are plainly mismatched in either direction — a '
      + 'reasoning model grinding through a rename, or a small one out of its '
      + 'depth. Changing the CLI throws that member session away, so say why in '
      + 'the same breath.',
    schema: {
      type: 'object',
      properties: {
        name: str('A member on the roster'),
        cli: str('claude, codex, agy or opencode. Optional — leave it out to keep the current one.'),
        model: str('Model name. Optional — leave it out for that CLI default.'),
        effort: str('Reasoning effort, where the model has one. Optional.'),
      },
      required: ['name'],
    },
    run: ({ name, cli, model, effort }) => {
      const known = rosterNow().map((x) => x.name);
      if (!known.includes(name)) {
        return `Nobody on the roster is called "${name}". The court has: ${known.join(', ')}.`;
      }
      if (!cli && !model && !effort) return 'Nothing to change: name a cli, a model or an effort.';
      bus.post(ME, null, JSON.stringify({ op: 'model', name, cli, model, effort }), 'control');
      return `Asked to move ${name}. You get a message with what it ended up on.`;
    },
  },

  pause_court: {
    roles: ['orchestrator'],
    description:
      'Stop handing out new turns to anyone, without dismissing the crew. Nobody mid-turn is interrupted; '
      + 'this only stops the next one. Cheaper than dismissing everyone when work needs to stop for a beat '
      + '— a review, a suspected loop, a change the sovereign wants to make first.',
    schema: { type: 'object', properties: { why: str('One line for the record. Optional.') }, required: [] },
    run: ({ why }) => {
      bus.post(ME, null, JSON.stringify({ op: 'pause', why: why ?? '' }), 'control');
      return 'Pausing the court.';
    },
  },

  resume_court: {
    roles: ['orchestrator'],
    description: 'Lift a pause. Everyone resumes exactly where their queued work left off.',
    schema: { type: 'object', properties: {}, required: [] },
    run: () => {
      bus.post(ME, null, JSON.stringify({ op: 'resume' }), 'control');
      return 'Resuming the court.';
    },
  },

  set_budget: {
    roles: ['orchestrator'],
    description:
      'Raise or lower the court-wide spend ceiling live, without a restart. 0 means no ceiling. This does '
      + 'not touch any one member\'s own per-member cap.',
    schema: {
      type: 'object',
      properties: { cap_usd: { type: 'number', description: 'New ceiling in USD, 0 for none' } },
      required: ['cap_usd'],
    },
    run: ({ cap_usd }) => {
      if (typeof cap_usd !== 'number' || !Number.isFinite(cap_usd) || cap_usd < 0) {
        return 'cap_usd must be a number, 0 or more.';
      }
      bus.post(ME, null, JSON.stringify({ op: 'budget', capUsd: cap_usd }), 'control');
      return `Asked to set the kingdom spend ceiling to ${cap_usd ? '$' + cap_usd : 'unlimited'}.`;
    },
  },
};
