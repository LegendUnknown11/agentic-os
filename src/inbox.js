// Everything inside the app that is waiting on the sovereign, in one ranked
// list: the Inbox view reads it, and the morning-brief automation turns it
// into text. Pure — every input is an argument — so the ranking is pinned by
// test/t-inbox.js rather than by eye.
//
// Ranked by what stalls the most work if left: a blocked run stops the whole
// run; a pending decision stops whoever asked; an overdue task of your own is
// late already; a run ready for review is done and only waits on you; a task
// due today is coming; a message is information.

const DAY = 86_400_000;

const KIND_TITLES = {
  summon: 'Team request', role: 'Role request', merge: 'Merge request', push: 'Push request', question: 'Question',
};

function approvalTitle(a) {
  if (a.kind === 'question') return a.questions?.[0]?.question ?? 'A question for you';
  if (a.kind === 'summon') return `Summon ${(a.names ?? []).join(', ')}`;
  if (a.kind === 'merge') return `Merge ${a.peasant ?? 'a member'}'s work`;
  if (a.kind === 'role') return `Role for ${a.name ?? 'a member'}`;
  return KIND_TITLES[a.kind] ?? String(a.kind ?? 'Request');
}

const oneLine = (text, max = 160) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * @param approvals  rows as /api/approvals returns them (kind, from, ts, resolved, ...)
 * @param run        the current run, or null
 * @param myTasks    bus.myTasks()
 * @param messages   bus messages addressed to the sovereign
 * @returns ranked [{id, rank, kind, tone, title, detail, href, ts}]
 */
export function inboxItems({ approvals = [], run = null, myTasks = [], messages = [], now = Date.now() } = {}) {
  const items = [];
  if (run?.state === 'blocked') {
    items.push({
      id: `run:${run.id}`, rank: 0, kind: 'run', tone: 'attention', href: '#home', ts: run.blocker?.at ?? run.updatedTs ?? now,
      title: `Run blocked: ${run.objective || run.id}`,
      detail: [run.blocker?.operation, run.blocker?.next && `Next: ${run.blocker.next}`].filter(Boolean).join('. ') || 'The run needs you.',
    });
  }
  for (const a of approvals) {
    if (a.resolved) continue;
    items.push({
      id: `approval:${a.id}`, rank: 1, kind: a.kind === 'question' ? 'question' : 'approval', tone: 'attention',
      href: '#approvals', ts: a.ts ?? now, title: approvalTitle(a),
      detail: `${KIND_TITLES[a.kind] ?? 'Request'} from ${a.from ?? 'the team'}${a.reason ? `: ${oneLine(a.reason)}` : ''}`,
    });
  }
  for (const t of myTasks) {
    if (t.doneTs || t.dueTs == null || t.snoozedUntil > now) continue;
    if (t.dueTs <= now) {
      items.push({ id: `mine:${t.id}`, rank: 2, kind: 'task', tone: 'attention', href: '#tasks', ts: t.dueTs, title: t.title, detail: oneLine(t.notes) || 'Overdue' });
    } else if (t.dueTs - now < DAY) {
      items.push({ id: `mine:${t.id}`, rank: 4, kind: 'task', tone: 'live', href: '#tasks', ts: t.dueTs, title: t.title, detail: oneLine(t.notes) || 'Due today' });
    }
  }
  if (run?.state === 'ready_for_review') {
    items.push({
      id: `run:${run.id}`, rank: 3, kind: 'run', tone: 'live', href: '#changes', ts: run.updatedTs ?? now,
      title: `Ready for your review: ${run.objective || run.id}`,
      detail: run.finalApproval ? 'Approved; apply it when ready.' : 'Verification passed. It waits for your final approval.',
    });
  }
  for (const m of messages) {
    if (now - (m.ts ?? 0) > DAY) continue;
    items.push({ id: `message:${m.id}`, rank: 5, kind: 'message', tone: 'idle', href: '#messages', ts: m.ts, title: `From ${m.sender}`, detail: oneLine(m.body) });
  }
  // Within a rank, the oldest waiting first; messages are the exception,
  // where the newest is the one worth reading.
  return items.sort((x, y) => x.rank - y.rank || (x.rank === 5 ? y.ts - x.ts : x.ts - y.ts));
}

/** A plain-text brief of the same list, for a notification or a message. */
export function inboxBrief(items, { now = Date.now(), max = 8 } = {}) {
  if (!items.length) return 'Nothing is waiting on you.';
  const waiting = items.filter((i) => i.rank <= 3).length;
  const head = waiting ? `${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} you` : 'Nothing is blocked on you';
  const lines = items.slice(0, max).map((i) => `- ${i.title}${i.detail ? ` — ${i.detail}` : ''}`);
  const more = items.length > max ? [`…and ${items.length - max} more in the Inbox.`] : [];
  return [`${head} (${new Date(now).toISOString().slice(0, 10)}).`, ...lines, ...more].join('\n');
}
