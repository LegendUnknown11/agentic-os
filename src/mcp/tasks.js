// tasks tools. See src/mcp.js for how these reach a member.
import {
  ME, bus, str, stateArray, officer,
} from './ctx.js';

const runFor = (requested) => {
  const id = requested ?? bus.currentRun()?.id ?? null;
  if (id != null && !bus.run(id)) return { error: `No run ${id}.` };
  return { id };
};

// The sovereign's own to-do list (bus my_tasks), not the team queue. The
// orchestrator reads it to answer "what's on my plate" and adds to it only
// when the sovereign asks; nothing here assigns work to a member.
const when = (ts) => (ts == null ? 'no due date' : new Date(ts).toISOString().replace(':00.000Z', 'Z'));

export const tasks = {
  my_tasks: {
    roles: ['orchestrator'],
    description: "Read the sovereign's own to-do list (not the team queue): open items, due soonest first, "
      + 'with overdue ones marked. Use it when the sovereign asks what is on their plate.',
    schema: { type: 'object', properties: {} },
    run: () => {
      const open = bus.myTasks({ includeDone: false });
      if (!open.length) return "The sovereign's list is empty.";
      const now = Date.now();
      return open.map((t) => `#${t.id} ${t.title} — ${when(t.dueTs)}${t.dueTs != null && t.dueTs <= now ? ' (OVERDUE)' : ''}`
        + `${t.notes ? `\n    ${t.notes}` : ''}`).join('\n');
    },
  },

  add_my_task: {
    roles: ['orchestrator'],
    description: "Add an item to the sovereign's own to-do list. ONLY when the sovereign asked you to note "
      + 'or remind them of something; never to hand them work you could do. due is ISO 8601, optional.',
    schema: {
      type: 'object',
      properties: { title: str('What to remember'), notes: str('Optional detail'), due: str('Optional ISO 8601 due time') },
      required: ['title'],
    },
    run: ({ title, notes = '', due }) => {
      const dueTs = due ? Date.parse(due) : null;
      if (due && !Number.isFinite(dueTs)) return `Not added: "${due}" is not a date. Use ISO 8601, e.g. 2026-10-01T09:00:00Z.`;
      try {
        const t = bus.addMyTask({ title, notes, dueTs, by: ME });
        return `Added #${t.id} to the sovereign's list (${when(t.dueTs)}).`;
      } catch (e) { return `Not added: ${e.message}`; }
    },
  },

  assign: {
    roles: ['orchestrator'],
    description: 'Assign a task. Be specific about scope and done-criteria.',
    schema: {
      type: 'object',
      properties: { to: str('Peasant name'), task: str('The assignment') },
      required: ['to', 'task'],
    },
    run: ({ to, task }) => {
      const roster = stateArray('roster');
      if (!roster) return `Cannot assign to ${to}: roster is unavailable; nothing was sent.`;
      const target = roster.find((member) => member.name === to);
      const summoned = stateArray('summoned');
      if (!summoned) return `Cannot assign to ${to}: summoned crew is unavailable; nothing was sent.`;
      if (target?.role === 'peasant' && !summoned.includes(to)) {
        return `Cannot assign to ${to}: peasant is not summoned.`;
      }
      bus.post(ME, to, task, 'assignment');
      return `Assigned to ${to}.`;
    },
  },

  add_task: {
    roles: ['orchestrator'],
    description:
      'Put a unit of work on the shared list. Size it so it has ONE clear deliverable — a function, '
      + 'a test file, a review. Too small and the coordination costs more than the work; too large and '
      + 'nobody checks in until it has gone wrong. Use needs for real ordering only: a task waits until '
      + 'everything it needs is done, so a false dependency idles a peasant for nothing.',
    schema: {
      type: 'object',
      properties: {
        title: str('The deliverable, in one line'),
        detail: str('Scope, constraints, and how you will know it is done'),
        needs: {
          type: 'array', items: { type: 'integer' }, maxItems: 20,
          description: 'Task ids that must finish first (optional)',
        },
        require_plan: {
          type: 'boolean',
          description: 'For risky work: the peasant must submit a plan and have it approved before it may finish',
        },
        run_id: str('Optional improvement run id; defaults to the current run'),
      },
      required: ['title', 'detail'],
    },
    run: ({ title, detail, needs = [], require_plan = false, run_id = null }) => {
      const known = new Set(bus.tasks().map((t) => t.id));
      const missing = needs.filter((n) => !known.has(Number(n)));
      if (missing.length) return `No such task: ${missing.map((n) => `#${n}`).join(', ')}. Nothing was added.`;
      // Capped, because the `tasks` tool's output goes in front of the WHOLE
      // court, on every listing, for as long as the task is open. One verbose
      // orchestrator turn would otherwise put an unbounded string in everyone's
      // context — the same thing memory.js:74 and skills.js:175 cap.
      title = String(title).slice(0, 200);
      detail = String(detail).slice(0, 2000);
      const run = runFor(run_id);
      if (run.error) return run.error;
      const id = bus.addTask({ title, detail, needs, needsPlan: require_plan, by: ME, runId: run.id });
      return `Task #${id} added${run.id ? ` to run ${run.id}` : ''}${needs.length ? `, waiting on ${needs.map((n) => `#${n}`).join(', ')}` : ''}.`;
    },
  },

  tasks: {
    roles: ['orchestrator', 'briefer', 'peasant'],
    description: 'The shared task list: what is outstanding, who holds it, and what is blocked.',
    schema: { type: 'object', properties: {}, required: [] },
    run: () => {
      const all = bus.tasks();
      if (!all.length) return 'The task list is empty.';
      const line = (t) => {
        const who = t.owner ? ` [${t.owner}]` : '';
        const wait = t.blockedBy.length ? ` (waits on ${t.blockedBy.map((n) => `#${n}`).join(', ')})` : '';
        return `#${t.id} ${t.state}${who} ${t.title}${wait}`;
      };
      const open = all.filter((t) => t.state !== 'done');
      const done = all.filter((t) => t.state === 'done');
      return [
        ...(open.length ? ['OPEN', ...open.map(line)] : ['Nothing is outstanding.']),
        ...(done.length ? ['', `DONE (${done.length})`, ...done.map(line)] : []),
      ].join('\n');
    },
  },

  claim_task: {
    roles: ['peasant'],
    description:
      'Take a task off the list. Omit id to take the next available one. Claiming is atomic — if two of '
      + 'you ask at once exactly one gets it, and the other is told who holds it.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Which task (optional)' } },
      required: [],
    },
    run: ({ id = null }) => {
      const r = bus.claimTask(ME, id);
      if (!r.ok) return r.why;
      const t = r.task;
      return t.state === 'planning'
        ? `Claimed #${t.id}: ${t.title}\n\n${t.detail}\n\nThis task requires an approved plan. `
          + `Investigate, then call submit_plan — do NOT change any file until the orchestrator approves it.`
        : `Claimed #${t.id}: ${t.title}\n\n${t.detail}`;
    },
  },

  finish_task: {
    roles: ['peasant'],
    description: 'Mark your task done. Only its owner may, and only once its plan is approved.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Which task' }, summary: str('What you delivered') },
      required: ['id', 'summary'],
    },
    run: ({ id, summary }) => {
      const t = bus.tasks().find((x) => x.id === Number(id));
      if (!t) return `No task #${id}.`;
      if (t.owner !== ME) return `Task #${id} is ${t.owner ?? 'unclaimed'}, not yours.`;
      if (t.state === 'done') return `Task #${id} is already done.`;
      if (t.state === 'verifying') return `Task #${id} is already submitted for verification.`;
      // The plan gate is enforced HERE rather than by asking nicely in the
      // prompt: a member cannot close a risky task by deciding its plan was
      // fine. This is the one boundary the orchestrator actually controls.
      if (t.state === 'planning') {
        return `Task #${id} still needs an approved plan. Call submit_plan and wait for the orchestrator.`;
      }
      if (t.runId) {
        bus.updateTask(id, { state: 'verifying' });
        const orchestrator = officer('orchestrator', 'orchestrator');
        const submission = bus.post(ME, orchestrator, `Task #${id} (${t.title}) submitted for verification. ${summary}`, 'done');
        // reassign_task reads this to tell an in-flight verification from a resolved one.
        bus.set(`submission:task:${id}`, String(submission));
        return `Task #${id} submitted for verification. The controller must pass tests and independent review before it is closed.`;
      }
      bus.updateTask(id, { state: 'done', doneTs: Date.now() });
      const orchestrator = officer('orchestrator', 'orchestrator');
      bus.post(ME, orchestrator, `Task #${id} (${t.title}) done. ${summary}`, 'done');
      const left = bus.tasks().filter((x) => x.state !== 'done').length;
      return `Task #${id} closed. ${left ? `${left} still open — claim_task for the next.` : 'The list is clear.'}`;
    },
  },

  close_task: {
    roles: ['orchestrator'],
    description:
      'Close an UNOWNED stale task after its work was superseded or otherwise completed. ' +
      'Never use this to take a task away from a member who still owns it.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The unowned stale task to reconcile' },
        summary: str('Why this task is complete without an owner'),
      },
      required: ['id', 'summary'],
    },
    run: ({ id, summary }) => {
      const t = bus.task(id);
      if (!t) return `No task #${id}.`;
      if (t.owner) return `Task #${id} is still owned by ${t.owner}; do not close someone else's work.`;
      if (t.state === 'done') return `Task #${id} is already closed.`;
      if (typeof summary !== 'string' || !summary.trim()) return 'Say why the unowned task is complete.';
      bus.updateTask(id, { state: 'done', doneTs: Date.now() });
      return `Task #${id} closed. ${summary.trim()}`;
    },
  },

  reassign_task: {
    roles: ['orchestrator'],
    description:
      'Move a task to a different peasant — one stuck with an owner who will not finish it, or one still '
      + 'unclaimed that needs to be placed rather than waited on. Unlike claim_task, which only the '
      + 'claiming peasant may call, this is an administrative override and works on someone else\'s task.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Which task' }, to: str('The new owner') },
      required: ['id', 'to'],
    },
    run: ({ id, to }) => {
      const t = bus.tasks().find((x) => x.id === Number(id));
      if (!t) return `No task #${id}.`;
      if (t.state === 'done') return `Task #${id} is already done — nothing to reassign.`;
      // Verification runs against the submitter's worktree; moving the task
      // while that check is in flight would show it as fresh work (#53). Once
      // the controller has recorded its evidence the task is still 'verifying'
      // (nothing moves it on), so reassigning is then the recovery path.
      if (t.state === 'verifying' && t.owner) {
        const submission = bus.get(`submission:task:${id}`);
        if (submission && !bus.get(`verification:${t.owner}:${submission}`)) {
          return `Task #${id} is being verified — wait for the controller's result before reassigning it.`;
        }
      }
      if (t.owner === to) return `Task #${id} is already ${to}'s.`;
      const summoned = stateArray('summoned');
      if (!summoned) return `Cannot reassign to ${to}: summoned crew is unavailable.`;
      if (!summoned.includes(to)) return `Cannot reassign to ${to}: not summoned.`;
      const from = t.owner;
      bus.updateTask(id, { owner: to, state: t.state === 'planning' ? 'planning' : 'active' });
      bus.post(ME, to,
        `Task #${id} (${t.title}) was reassigned to you${from ? ` from ${from}` : ''}.\n\n${t.detail}`,
        'assignment');
      if (from) bus.post(ME, from, `Task #${id} (${t.title}) was reassigned to ${to}. Stop work on it.`, 'notice');
      return `Reassigned #${id} to ${to}${from ? ` (was ${from}'s)` : ''}.`;
    },
  },
};
