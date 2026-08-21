// The three panels that show the court's own state: what it cost, what it
// changed, and what it knows. Each is a plain builder — win.js owns the frame,
// the canvas owns where it sits.
import * as W from './win.js';
import { setIcon, icon } from './icons.js';
import { matchesQuery } from './court.js';
import { cue } from './feel.js';
import { displayName } from './names.js';

const get = (u) => fetch(u).then((r) => r.json()).catch(() => ({ ok: false }));

/**
 * Guard against a stale response painting over a newer one.
 *
 * Every search panel here has the same shape: type, fetch, clear, append. When
 * a slow request resolves AFTER a faster later one, it clears the newer result
 * and repaints its own — searching for nonsense showed 78 rows belonging to the
 * previous query. Each panel takes its own sequencer and drops anything that is
 * no longer the latest.
 */
function sequencer() {
  let seq = 0;
  return {
    next: () => ++seq,
    current: (n) => n === seq,
  };
}
const el = (tag, cls, text) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
const money = (n) => `$${(n ?? 0).toFixed(2)}`;

// A per-turn rate is routinely under a cent, where money()'s two decimals
// read as $0.00 — the one thing a cost must never look like. Three decimals
// normally, four below a cent.
const rate = (n) => `$${n.toFixed(n < 0.01 ? 4 : 3)}/turn`;

/**
 * What a proposed crew has cost per turn, drawn as the Usage panel's grid.
 *
 * Three states, and the difference between them is the whole point:
 *   no history   never run here — no number, because there is nothing to
 *                average and a borrowed one would be fiction
 *   no rate      subscription-billed or unpriced — tokens, never dollars
 *   otherwise    dollars, and the sample size they rest on
 *
 * Same rule price.js keeps by returning null rather than 0. The sample size
 * sits beside every figure on purpose: a rate off two turns and a rate off
 * two hundred are not the same claim, and the sovereign is the one deciding
 * how much weight to put on it.
 */
function forecastTable(f) {
  const wrap = el('div', 'forecast');
  const t = el('table', 'grid');
  const hr = el('tr');
  ['member', 'per turn', 'observed'].forEach((c, i) => hr.append(el('th', i ? 'r' : null, c)));
  const thead = el('thead');
  thead.append(hr);
  t.append(thead);

  const tb = el('tbody');
  for (const m of f.members) {
    const tr = el('tr');
    const cost = m.perTurnUsd !== null ? rate(m.perTurnUsd)
      : m.turns ? `${kb(m.perTurnTokens)} tok/turn`
      : 'no history';
    tr.append(
      el('td', null, displayName(m.name, 'peasant')),
      el('td', 'r num', cost),
      el('td', 'r num', m.turns ? `${m.turns} turn${m.turns === 1 ? '' : 's'}` : '—'),
    );
    tb.append(tr);
  }

  const c = f.crew ?? {};
  const sum = el('tr', 'sum');
  sum.append(
    el('td', null, 'crew'),
    el('td', 'r num', c.perTurnUsd != null ? rate(c.perTurnUsd) : `${kb(c.perTurnTokens ?? 0)} tok/turn`),
    el('td', 'r num', ''),
  );
  tb.append(sum);
  t.append(tb);
  wrap.append(t);

  // Say what the number is NOT. A rate is not a bill, and a member that has
  // never run has no rate at all — leaving either unsaid invites the card to
  // be read as a quote.
  const caveats = [];
  if (c.unknown?.length) caveats.push(`no history yet for ${c.unknown.join(', ')}`);
  if (c.unpriced?.length) caveats.push(`no published rate for ${c.unpriced.join(', ')}`);
  caveats.push('a rate per turn, not a total for the job');
  wrap.append(el('div', 'note', caveats.join(' · ')));
  return wrap;
}

/* ================= cost and run metrics ================= */
export function openMetrics() {
  // The poller is stopped by onClose, not by a custom event: a closed window is
  // removed from the DOM, so an event listener on it would never fire again and
  // the interval would keep hitting the daemon forever.
  let timer = null;
  W.toggle('metrics', {
    title: 'Usage',
    onClose: () => clearInterval(timer),
    build(box) {
      const body = el('div', 'log settings');
      box.append(body);

      const draw = async () => {
        const m = await get('/api/metrics');
        body.textContent = '';
        if (!m.ok) { body.append(el('div', 'empty', 'The team is not answering.')); return; }

        // The headline is turns per task, because that is the sovereign's own
        // North Star metric — not tokens, which nobody can feel.
        const head = el('div', 'stats');
        const stat = (label, value, sub) => {
          const d = el('div', 'stat-cell');
          d.append(el('div', 'v num', value), el('div', 'k', label));
          if (sub) d.append(el('div', 'sub', sub));
          return d;
        };
        head.append(
          stat('turns', String(m.total.turns)),
          stat('input', kb(m.total.in), m.total.in ? `${Math.round((m.total.cached / m.total.in) * 100)}% cached` : ''),
          stat('output', kb(m.total.out)),
          stat('spent', money(m.spent), m.cap ? `of ${money(m.cap)}` : 'no ceiling'),
        );
        body.append(head);

        if (m.cap) {
          const pct = Math.min(100, (m.spent / m.cap) * 100);
          const bar = el('div', 'meter');
          const fill = el('i');
          fill.style.width = `${pct}%`;
          if (pct > 80) fill.classList.add('hot');
          bar.append(fill);
          body.append(bar);
        }

        // A subscription CLI has no $/token, so its "spent" figure above is at
        // best a guess — the real ceiling is the plan's own token allowance.
        for (const q of m.quotas ?? []) {
          body.append(el('div', 'note',
            `${q.label} — ${kb(q.used)}${q.limit ? ` / ${kb(q.limit)} tokens (no dollar price; this is a plan allowance)` : ' tokens burned (no plan size set)'}`));
          if (q.pct !== null) {
            const bar = el('div', 'meter');
            const fill = el('i');
            fill.style.width = `${q.pct}%`;
            if (q.pct > 80) fill.classList.add('hot');
            bar.append(fill);
            body.append(bar);
          }
        }

        const h = el('div', 'shead');
        h.innerHTML = 'Per member<em>Input is the real figure: codex reports usage cumulatively '
          + 'per thread, so these are deltas, not the sum it hands out.</em>';
        body.append(h);

        if (!m.members.length) {
          body.append(el('div', 'empty', 'No turns recorded yet.'));
        } else {
          const t = el('table', 'grid');
          const hr = el('tr');
          // Every column but the first is a number and reads right-aligned.
          // Keyed on position, not on the heading's text: when that heading was
          // renamed the string comparison stopped matching and silently
          // right-aligned the name column too.
          ['agent', 'turns', 'in', 'per turn', 'ctx', 'spent'].forEach((c, i) => {
            const th = el('th', i ? 'r' : null, c);
            hr.append(th);
          });
          const thead = el('thead');
          thead.append(hr);
          t.append(thead);
          const tb = el('tbody');
          for (const r of m.members) {
            const tr = el('tr', r.role === 'orchestrator' ? 'orchestrator' : '');
            const nm = el('td');
            nm.append(el('span', `dot ${r.awake ? 'awake' : ''}`),
              document.createTextNode(displayName(r.name, r.role)));
            tr.append(nm,
              el('td', 'r num', String(r.turns)),
              el('td', 'r num', kb(r.in)),
              el('td', 'r num', kb(r.perTurn)),
              el('td', 'r num', r.ctx ? kb(r.ctx) : '—'),
              el('td', 'r num', r.spent ? money(r.spent) : '—'));
            tb.append(tr);
          }
          t.append(tb);
          body.append(t);
        }

        const foot = el('div', 'note');
        foot.textContent = `${m.messages} messages on the bus`
          + (m.perMemberCap ? ` · ${money(m.perMemberCap)} ceiling per member` : '');
        body.append(foot);
      };

      draw();
      // Cheap enough to poll, and the numbers only change on a turn boundary.
      clearInterval(timer);
      timer = setInterval(draw, 5000);
    },
  });
}

/* ================= diff and merge ================= */
export function openDiff(peasant, { post, toast }) {
  W.toggle(`diff:${peasant}`, {
    title: `${peasant} · changes`,
    build(box) {
      const body = el('div', 'log settings');
      box.append(body);

      const draw = async (file = null) => {
        body.textContent = '';
        body.append(el('div', 'empty', 'Reading the worktree…'));
        const d = await get(`/api/diff?peasant=${encodeURIComponent(peasant)}`
          + (file ? `&file=${encodeURIComponent(file)}` : ''));
        body.textContent = '';

        if (!d.ok) { body.append(el('div', 'empty', d.error ?? 'Could not read the diff.')); return; }
        if (d.none) { body.append(el('div', 'empty', d.reason)); return; }
        if (!d.stat?.trim() && !d.diff?.trim()) {
          body.append(el('div', 'empty', `${peasant} has not changed anything against ${d.base}.`));
          return;
        }

        if (file) {
          const back = el('button', 'link', '‹ all files');
          back.onclick = () => draw(null);
          body.append(back);
        }

        // Files first: the diff is what you read second, once you know what
        // you are reading.
        const files = parseStat(d.stat);
        if (files.length && !file) {
          const list = el('div', 'files');
          for (const f of files) {
            const row = el('button', 'file');
            row.append(el('span', 'p', f.path));
            const ch = el('span', 'ch');
            if (f.plus) ch.append(el('i', 'add', `+${f.plus}`));
            if (f.minus) ch.append(el('i', 'del', `−${f.minus}`));
            row.append(ch);
            row.onclick = () => draw(f.path);
            list.append(row);
          }
          body.append(list);
        }

        const pre = el('pre', 'diff');
        for (const line of (d.diff ?? '').split('\n')) {
          const cls = line.startsWith('+++') || line.startsWith('---') ? 'meta'
            : line.startsWith('@@') ? 'hunk'
            : line.startsWith('diff ') || line.startsWith('index ') ? 'meta'
            : line.startsWith('+') ? 'add'
            : line.startsWith('-') ? 'del' : '';
          pre.append(el('span', cls, line + '\n'));
        }
        body.append(pre);

        if (d.truncated) body.append(el('div', 'note', 'Diff truncated — open a single file for the rest.'));

        const act = el('div', 'act sticky');
        const merge = el('button', 'primary');
        merge.append(icon('send'), document.createTextNode(`Merge into ${d.base}`));
        merge.onclick = async () => {
          merge.disabled = true;
          // The orchestrator dry-runs the merge and refuses on conflict, so
          // this cannot half-merge the base branch — but it IS the sovereign's
          // decision, so confirm it rather than firing on one click.
          if (merge.dataset.armed !== '1') {
            merge.dataset.armed = '1';
            merge.lastChild.textContent = `Confirm — merge ${peasant} into ${d.base}`;
            merge.disabled = false;
            return;
          }
          await post('merge', { peasant });
          toast(`Merging ${peasant}…`);
        };
        const refresh = el('button', null, 'Refresh');
        refresh.onclick = () => draw(file);
        act.append(merge, refresh);
        body.append(act);
      };

      draw();
    },
  });
}

/** " lib/a.dart | 12 +++---" -> {path, plus, minus} */
function parseStat(stat) {
  const out = [];
  for (const line of (stat ?? '').split('\n')) {
    const m = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)/);
    if (!m) continue;
    out.push({
      path: m[1],
      plus: (m[3].match(/\+/g) ?? []).length,
      minus: (m[3].match(/-/g) ?? []).length,
    });
  }
  return out;
}

/* ================= the chronicle ================= */
/**
 * Everything the court did, newest first, searchable.
 *
 * The bus panel shows messages and a member's panel shows one transcript —
 * neither answers "what has been happening" or "which of the sixteen mentioned
 * the webhook". Summaries make this readable: one line per turn instead of the
 * wall of tool calls underneath it.
 */
export function openChronicle({ onOpenMember }) {
  W.toggle('chronicle', {
    title: 'Activity',
    build(box) {
      const search = el('div', 'searchbar');
      const input = el('input');
      input.placeholder = 'Search everything the team said…';
      input.autocomplete = 'off';
      const filters = el('div', 'filters');
      const campaign = el('select', 'filt');
      campaign.append(el('option', '', 'all orders'));
      filters.append(campaign);
      search.append(input, filters);

      const body = el('div', 'log settings');
      box.append(search, body);

      // Which layers to show. Summaries alone is the useful default: it is the
      // court's narrative without the machinery.
      const kinds = new Set(['summary', 'message', 'done', 'error']);
      for (const [k, label] of [['summary', 'summaries'], ['message', 'messages'],
        ['done', 'done'], ['error', 'errors']]) {
        const b = el('button', 'filt on', label);
        b.onclick = () => {
          kinds.has(k) ? kinds.delete(k) : kinds.add(k);
          b.classList.toggle('on', kinds.has(k));
          draw();
        };
        filters.append(b);
      }

      const TONE = { summary: 'sum', message: 'msg', done: 'done', error: 'err' };

      const seq = sequencer();
      const draw = async () => {
        const mine = seq.next();
        const r = await get(`/api/chronicle?kinds=${[...kinds].join(',')}`
          + `&q=${encodeURIComponent(input.value.trim())}&campaign=${campaign.value}`);
        if (!seq.current(mine)) return;   // a newer search already painted
        body.textContent = '';
        if (!r.ok) { body.append(el('div', 'empty', 'The team is not answering.')); return; }
        if (!r.rows.length) {
          body.append(el('div', 'empty', r.query
            ? `Nothing matches “${r.query}”.` : 'Nothing has happened yet.'));
          return;
        }
        if (r.total > r.rows.length) {
          body.append(el('div', 'note', `${r.rows.length} of ${r.total} — narrow the search to see older.`));
        }

        let lastDay = '';
        for (const row of r.rows) {
          const d = new Date(row.ts);
          const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          if (day !== lastDay) { lastDay = day; body.append(el('div', 'chron-day', day)); }

          const item = el('div', `chron ${TONE[row.kind] ?? ''}`);
          const head = el('div', 'ch');
          const who = el('button', 'cwho', displayName(row.who));
          who.onclick = () => onOpenMember?.(row.who);   // the real name opens it
          head.append(who);
          if (row.to) head.append(el('span', 'cto', `→ ${displayName(row.to)}`));
          head.append(el('span', 'ctime num',
            d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
          item.append(head, el('div', 'ctext', row.text));
          body.append(item);
        }
      };

      // Debounced: every keystroke would re-scan the whole bus.
      let t;
      input.oninput = () => { clearTimeout(t); t = setTimeout(draw, 220); };
      input.onkeydown = (e) => { if (e.key === 'Escape') { input.value = ''; draw(); } };
      campaign.onchange = draw;
      get('/api/campaigns').then((r) => {
        for (const c of r.campaigns ?? []) {
          const option = el('option', '', `${c.current ? 'current — ' : ''}${c.title.slice(0, 80)}`);
          option.value = c.id;
          campaign.append(option);
        }
      }).catch(() => {});
      draw();
      setTimeout(() => input.focus(), 30);
    },
  });
}

/* ================= the standing goal ================= */
/**
 * What the court is for, and how far along it is.
 *
 * Everything else the court knows is a single message or a transcript that
 * gets recycled away. This is the only thing that survives both — it is put
 * into every member's prompt on every spawn, so a restarted court still knows
 * what it was working towards.
 */
export function openGoal({ post, toast, goal }) {
  W.toggle('goal', {
    title: 'Objective',
    build(box) {
      const body = el('div', 'log settings');
      box.append(body);

      const draw = (g) => {
        body.textContent = '';

        const ta = el('textarea', 'style');
        ta.rows = 3;
        ta.spellcheck = false;
        ta.placeholder = 'What is the team working towards? One or two sentences.';
        ta.value = g?.text ?? '';
        body.append(el('div', 'note', g
          ? `Set ${new Date(g.setAt).toLocaleDateString()} · every member is told this on every spawn`
          : 'Nothing set. The team works on whatever you last asked and forgets it on restart.'));
        body.append(ta);

        const act = el('div', 'act');
        const save = el('button', 'primary', g ? 'Update the objective' : 'Set the objective');
        save.onclick = async () => {
          const text = ta.value.trim();
          if (!text) return toast('Write the objective first.', true);
          await post('goal', { text });
          toast('Objective set — the team has been told.');
        };
        act.append(save);
        if (g) {
          const clear = el('button', null, 'Clear');
          clear.onclick = async () => {
            if (clear.dataset.armed !== '1') {
              clear.dataset.armed = '1';
              clear.textContent = 'Confirm — clear the objective';
              return;
            }
            await post('goal', { text: null });
            toast('Objective cleared.');
          };
          act.append(clear);
        }
        body.append(act);

        if (!g) return;

        const total = (g.milestones ?? []).length;
        const done = (g.milestones ?? []).filter((m) => m.done).length;
        if (total > 0) {
          const pct = Math.round((done / total) * 100);
          const prog = el('div', 'goal-progress');
          const bar = el('div', 'gp-bar');
          const fill = el('i');
          fill.style.width = `${pct}%`;
          bar.append(fill);
          const label = el('span', 'gp-label num', `${done}/${total} (${pct}%)`);
          prog.append(bar, label);
          body.append(prog);
        }

        const h = el('div', 'shead');
        h.innerHTML = 'Milestones<em>The orchestrator ticks these off when it has seen the evidence. '
          + 'You can override either way.</em>';
        body.append(h);

        (g.milestones ?? []).forEach((m, i) => {
          const row = el('label', `srow ms ${m.done ? 'done' : ''}`);
          const t = el('span');
          t.append(el('span', 'mtext', m.text));
          const c = document.createElement('input');
          c.type = 'checkbox';
          c.checked = m.done;
          c.onchange = () => post('milestone', { index: i, done: c.checked });
          row.append(t, c);
          body.append(row);
        });

        const add = el('div', 'act');
        const input = document.createElement('input');
        input.className = 'msnew';
        input.placeholder = 'Add a milestone…';
        const push = async () => {
          const text = input.value.trim();
          if (!text) return;
          input.value = '';
          await post('goal', { milestones: [...(g.milestones ?? []), { text, done: false }] });
        };
        input.onkeydown = (e) => { if (e.key === 'Enter') push(); };
        const btn = el('button', null, 'Add');
        btn.onclick = push;
        add.append(input, btn);
        body.append(add);
      };

      draw(goal());
      box.addEventListener('kd:goal', (e) => draw(e.detail));
    },
  });
}

/* ================= approvals ================= */
/**
 * Everything the court has asked permission for — waiting and already decided.
 *
 * The cards that pop up in the corner are for answering NOW. This is the other
 * half: with an empty queue those cards never appear, so there was no sign the
 * approval mechanism existed, and no way to see what had already been agreed.
 */
export function openApprovals({ post, toast }) {
  let timer = null;
  W.toggle('approvals', {
    title: 'Approvals',
    onClose: () => clearInterval(timer),
    build(box) {
      const body = el('div', 'log settings');
      box.append(body);

      const draw = async () => {
        const r = await get('/api/approvals');
        body.textContent = '';
        if (!r.ok) { body.append(el('div', 'empty', 'The team is not answering.')); return; }

        const pending = r.approvals.filter((a) => !a.resolved);
        const done = r.approvals.filter((a) => a.resolved);

        if (!pending.length) {
          body.append(el('div', 'empty', 'Nothing is waiting on you.'));
        } else {
          const head = el('div', 'note', `${pending.length} waiting`);
          body.append(head);
          const bulk = pending.length > 1 ? bulkRow(pending) : null;
          if (bulk) body.append(bulk);
          for (const a of pending) body.append(card(a, true));
        }

        if (done.length) {
          const h = el('div', 'shead');
          h.innerHTML = 'Already decided<em>What the team asked, and what you said.</em>';
          body.append(h);
          for (const a of done.slice(0, 40)) body.append(card(a, false));
        }
      };

      // Several requests queue up whenever a wave of peasants finish at once —
      // deciding them one dialog at a time is the busywork, not the decision.
      // A question is excluded: approve()/reject() have no idea what "approved"
      // means for one (see the card() comment below), so bulk-approving a mixed
      // batch would silently eat any question in it.
      const bulkRow = (pending) => {
        // A push approval is deliberately never part of a bulk gesture: it is
        // a one-time outward action and needs the sovereign's focused click.
        const actionable = pending.filter((a) => a.kind !== 'question' && a.kind !== 'push');
        if (actionable.length < 2) return null;
        const row = el('div', 'btns');
        const act = (verb, cls, label) => {
          const b = el('button', cls, label);
          b.onclick = async () => {
            cue(verb);
            row.querySelectorAll('button').forEach((x) => (x.disabled = true));
            for (const a of actionable) await post(verb, { id: a.id });
            toast(`${verb === 'approve' ? 'Approved' : 'Rejected'} ${actionable.length}.`);
            draw();
          };
          return b;
        };
        row.append(act('approve', 'go', `Approve all ${actionable.length}`), act('reject', 'no', 'Reject all'));
        return row;
      };

      const card = (a, live) => {
        const d = el('div', `appr ${a.resolved ?? 'open'}`);
        const head = el('div', 'hd');
        head.append(
          el('span', 'kind', (a.kind ?? 'request').toUpperCase()),
          el('span', 'who', a.from ?? 'orchestrator'),
          el('span', 'when', new Date(a.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
        );
        d.append(head);

        // What is actually being asked: names for a summon, a peasant for a merge.
        const what = a.kind === 'push' ? 'Configured upstream (one plain push)' :
          (a.names?.length ? a.names.join(', ') : (a.peasant ?? a.name ?? ''));
        if (what) d.append(el('div', 'what', what));
        if (a.reason) d.append(el('div', 'why', a.reason));
        if (a.kind === 'push') d.append(el('div', 'note', 'No force push. Approval permits this one attempt only.'));
        if (a.push?.message) d.append(el('div', `verdict ${a.push.status}`, a.push.message));

        // The cost of the crew, at the moment the crew is decided. README.md
        // calls the roster the biggest lever there is and says to trim it
        // here — and this card carried names and a paragraph of prose and no
        // number at all. Guarded on the field rather than the kind: the
        // daemon attaches it only to a summon still awaiting a decision, so
        // an absent forecast is the ordinary case, not a failure.
        if (a.forecast?.members?.length) d.append(forecastTable(a.forecast));

        // approve()/reject() only know summon/role/merge — a question answers
        // with CHOSEN OPTIONS, not a yes/no, and its reply must go back to
        // whoever asked (kingdom.js#answerQuestion), not the orchestrator.
        // Approve/Reject here would either silently drop the reply or send it
        // to the wrong agent. Point at the real interview card instead of
        // reimplementing it a second time in this panel.
        if (a.kind === 'question') {
          for (const q of a.questions ?? []) d.append(el('div', 'what', q.question));
          if (live) d.append(el('div', 'note', 'Answer this from its card in the conversation — it needs your actual choices, not an approve/reject.'));
          return d;
        }

        if (live) {
          const btns = el('div', 'btns');
          const go = el('button', 'go', 'Approve');
          go.onclick = async () => { cue('approve'); await post('approve', { id: a.id }); toast('Approved'); draw(); };
          const no = el('button', 'no', 'Reject');
          no.onclick = async () => { cue('reject'); await post('reject', { id: a.id }); toast('Rejected'); draw(); };
          btns.append(go, no);
          d.append(btns);
        } else {
          d.append(el('div', `verdict ${a.resolved}`, a.resolved === 'approved' ? 'Approved' :
            (a.resolved === 'blocked' ? 'Blocked' : 'Rejected')));
        }
        return d;
      };

      draw();
      clearInterval(timer);
      timer = setInterval(draw, 6000);
    },
  });
}

/* ================= the summoning ================= */

export const ROLE_CATEGORIES = {
  architect: 'Discovery',
  strategist: 'Discovery',
  researcher: 'Discovery',
  coder: 'Craft',
  frontend: 'Craft',
  designer: 'Craft',
  backend: 'Craft',
  dba: 'Craft',
  'refactoring-engineer': 'Craft',
  tester: 'Verification',
  reviewer: 'Verification',
  'fact-checker': 'Verification',
  defendant: 'Verification',
  critic: 'Verification',
  auditor: 'Security & Ops',
  'devops-engineer': 'Security & Ops',
  writer: 'Knowledge',
};

/**
 * Who is in the court, and who could be.
 *
 * This screen categorizes the roster by lifecycle domain, with instant
 * category filters and fast recruitment. Only a fraction of the roster has a
 * named category (ROLE_CATEGORIES) — anything else falls into 'Other' rather
 * than disappearing when a filter tab is active.
 *
 * @param roster () => Map<name, {role, title, description, cli, model, summoned}>
 */
export function openSummon({ post, toast, roster }) {
  W.toggle('summon', {
    title: 'Add agents',
    cls: 'summon',
    build(box) {
      const search = el('div', 'searchbar');
      const input = el('input');
      input.placeholder = 'Search by name, title or skill…';
      input.autocomplete = 'off';
      search.append(input);

      const catTabs = el('div', 'sum-cat-tabs');
      // ROLE_CATEGORIES only names the 17 roles the last redesign proposed keeping
      // (docs/PLAN-court.md) — the roster itself still has 107. Every unmapped name
      // fell through to `undefined`, which matched no category tab, so ~90 agents
      // were unreachable except through "All" or search. 'Other' is the fallback
      // that keeps every category tab a true partition of the full roster.
      const categories = ['All', 'Discovery', 'Craft', 'Verification', 'Security & Ops', 'Knowledge', 'Other'];
      const categoryOf = (name) => ROLE_CATEGORIES[name] ?? 'Other';
      let activeCat = 'All';

      for (const cat of categories) {
        const btn = el('button', `sum-cat-tab${cat === activeCat ? ' on' : ''}`, cat);
        btn.onclick = () => {
          activeCat = cat;
          catTabs.querySelectorAll('.sum-cat-tab').forEach((b) => b.classList.toggle('on', b.textContent === cat));
          paint(input.value.trim().toLowerCase());
        };
        catTabs.append(btn);
      }

      const body = el('div', 'log settings');
      box.append(search, catTabs, body);

      const card = (m) => {
        const row = el('button', `sum-row${m.summoned ? ' in' : ''}`);

        // No state light on this screen. Every other place the dot appears is
        // a member of the team, where awake/resting/busy is the question; these
        // are roles you could ADD, and "asleep" beside 105 of them would be the
        // "not summoned" wallpaper the rail already had to delete. Whether a
        // role is on the team is carried by `.in` and by the Add/Remove verb.
        const content = el('div', 'sum-content');
        const main = el('div', 'sum-main');
        main.append(el('span', 'sum-name', m.name));
        if (m.title && m.title !== m.name) main.append(el('span', 'sum-title', m.title));

        main.append(el('span', 'sum-cat', categoryOf(m.name)));
        content.append(main);

        if (m.description) {
          content.append(el('p', 'sum-desc', m.description));
        }
        row.append(content);

        const meta = el('div', 'sum-meta');
        if (m.model) {
          meta.append(el('span', 'sum-model', `${m.model}${m.effort ? ' · ' + m.effort : ''}`));
        }
        const act = el('span', `sum-act ${m.summoned ? 'dismiss' : 'summon'}`, m.summoned ? 'Remove' : 'Add');
        meta.append(act);
        row.append(meta);

        row.title = m.summoned
          ? `${m.name} is on the team — remove to stop it and free its worktree`
          : `Add ${m.name} to the team`;
        row.onclick = () => {
          const going = m.summoned;
          cue(going ? 'dismiss' : 'summon');
          post(going ? 'sleep' : 'wake', { name: m.name });
          toast(going ? `${m.name} left the team.` : `${m.name} joined the team.`);
          row.disabled = true;
          row.classList.add('pending');
          act.textContent = going ? 'Removing…' : 'Adding…';
        };
        return row;
      };

      function paint(q) {
        const all = [...roster().entries()]
          .map(([name, m]) => ({ ...m, name }))
          .filter((m) => m.role === 'peasant')
          .sort((a, b) => a.name.localeCompare(b.name));

        body.textContent = '';
        const matchCat = (m) => activeCat === 'All' || categoryOf(m.name) === activeCat;
        const here = all.filter((m) => m.summoned && matchesQuery(m, q) && matchCat(m));
        const rest = all.filter((m) => !m.summoned && matchesQuery(m, q) && matchCat(m));

        if (here.length) {
          body.append(el('div', 'note engraved', `On your team · ${here.length}`));
          for (const m of here) body.append(card(m));
        }
        if (rest.length) {
          body.append(el('div', 'note engraved',
            q || activeCat !== 'All' ? `Matching · ${rest.length}` : `Available · ${rest.length}`));
          for (const m of rest) body.append(card(m));
        }
        if (!here.length && !rest.length) {
          body.append(el('div', 'empty', q || activeCat !== 'All'
            ? `Nobody matches that filter.`
            : 'No agents are configured. Add them to kingdom.config.json.'));
        }
      }

      const onRoster = () => {
        if (!box.isConnected) return document.removeEventListener('kd:roster', onRoster);
        paint(input.value.trim().toLowerCase());
      };
      document.addEventListener('kd:roster', onRoster);

      input.oninput = () => paint(input.value.trim().toLowerCase());
      input.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        body.querySelector('.sum-row:not(.in)')?.click();
        input.select();
      };
      paint('');
      setTimeout(() => input.focus(), 0);
    },
  });
}

/* ================= recall: everything the court remembers ================= */
/**
 * One search box over both memories: the bus's own history (what was said or
 * done — recall) and the sovereign's curated notes (vault_search). They stay
 * two sections rather than one merged list because they answer different
 * questions — "what happened" vs. "what did I write down" — but one query
 * against both is the actual "remembers everything" the search is for.
 */
export function openRecall() {
  W.toggle('recall', {
    title: 'Memory',
    build(box) {
      const search = el('div', 'searchbar');
      const input = el('input');
      input.placeholder = 'Search everything the court remembers…';
      input.autocomplete = 'off';
      search.append(input);
      const body = el('div', 'log settings');
      box.append(search, body);

      const showNote = async (path) => {
        const r = await get(`/api/vault?path=${encodeURIComponent(path)}`);
        body.textContent = '';
        const back = el('button', 'link', '‹ back');
        back.onclick = () => run(input.value.trim());
        body.append(back, el('div', 'note-title', path));
        body.append(el('pre', 'note-body', r.ok ? r.body : (r.error ?? 'Could not read it.')));
      };

      const seq = sequencer();
      const run = async (q) => {
        const mine = seq.next();
        body.textContent = '';
        if (!q) { body.append(el('div', 'empty', 'Type to search history, tool calls and notes together.')); return; }
        const [recall, vault] = await Promise.all([get(`/api/recall?q=${encodeURIComponent(q)}`), get(`/api/vault?q=${encodeURIComponent(q)}`)]);
        if (!seq.current(mine)) return;   // a newer search already painted
        body.textContent = '';

        body.append(el('div', 'shead', 'History'));
        if (!recall.ok || !recall.hits.length) {
          body.append(el('div', 'empty', 'Nothing matches in what the court has said or done.'));
        } else {
          for (const h of recall.hits) {
            const item = el('div', 'chron');
            const head = el('div', 'ch');
            head.append(el('span', 'cwho', displayName(h.who)),
              el('span', 'ctime num', new Date(h.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
            item.append(head, el('div', 'ctext', h.text));
            body.append(item);
          }
        }

        if (vault.configured) {
          body.append(el('div', 'shead', 'Notes'));
          if (!vault.notes.length) {
            body.append(el('div', 'empty', 'Nothing matches in your notes.'));
          } else {
            for (const n of vault.notes) {
              const row = el('button', 'note-row');
              row.append(el('span', 'p', n.path));
              if (n.lines?.length) {
                const ctx = el('span', 'ctx');
                for (const l of n.lines) ctx.append(el('i', null, l.text));
                row.append(ctx);
              }
              row.onclick = () => showNote(n.path);
              body.append(row);
            }
          }
        }
      };

      let t;
      input.oninput = () => { clearTimeout(t); t = setTimeout(() => run(input.value.trim()), 220); };
      input.onkeydown = (e) => { if (e.key === 'Escape') { input.value = ''; run(''); } };
      run('');
      setTimeout(() => input.focus(), 30);
    },
  });
}

/* ================= automation workflows, n8n-style ================= */
/**
 * List, run, and edit the court's own automations.
 *
 * The node graph itself is edited as JSON in a textarea rather than a visual
 * builder — a drag-and-drop graph editor is a project of its own, and the
 * engine's node types (http/delay/log/set/condition/bus/transform/foreach)
 * are already a small, readable JSON shape. Add a visual editor later if
 * hand-writing the graph turns out to be the actual friction.
 */
export function openWorkflows({ post, toast }) {
  W.toggle('workflows', {
    title: 'Automations',
    build(box) {
      const body = el('div', 'log settings');
      box.append(body);

      const TRIGGERS = ['manual', 'interval', 'daily', 'webhook', 'bus'];

      const summarize = (t) => {
        if (t?.type === 'interval') return `every ${Math.round((t.everyMs ?? 0) / 1000)}s`;
        if (t?.type === 'daily') return `daily at ${t.at ?? '?'}`;
        if (t?.type === 'bus') return `on message containing “${t.pattern ?? ''}”`;
        if (t?.type === 'webhook') return 'webhook';
        return 'manual';
      };

      const list = async () => {
        body.textContent = '';
        const add = el('button', 'primary', '+ New automation');
        add.onclick = () => editor(null);
        body.append(add);

        const r = await get('/api/workflows');
        if (!r.ok || !r.workflows.length) {
          body.append(el('div', 'empty', 'No automations yet.'));
          return;
        }
        for (const wf of r.workflows) {
          const runs = await get(`/api/workflows/runs?id=${encodeURIComponent(wf.id)}`);
          const last = runs.ok ? runs.runs.at(-1) : null;

          const row = el('div', 'note-row');
          const main = el('button', 'link');
          main.append(el('span', 'p', wf.name), el('span', 'ctx', summarize(wf.trigger)));
          main.onclick = () => editor(wf);
          row.append(main);

          if (last) {
            const when = new Date(last.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            row.append(el('div', 'note', `Last run ${when} — ${last.payload.ok ? 'ok' : `failed: ${last.payload.error}`}`));
          }
          if (wf.enabled === false) row.append(el('div', 'note', 'disabled'));

          const act = el('div', 'btns');
          const run = el('button', null, 'Run now');
          run.onclick = async () => {
            run.disabled = true;
            const r2 = await post('workflows/run', { id: wf.id });
            toast(r2.ok ? (r2.result.ok ? 'Ran successfully.' : `Ran with an error: ${r2.result.steps.find((s) => !s.ok)?.error}`) : (r2.error ?? 'Could not run it.'), !r2.ok || !r2.result?.ok);
            list();
          };
          const del = el('button', null, 'Delete');
          del.onclick = async () => {
            if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Confirm delete'; return; }
            await post('workflows/delete', { id: wf.id });
            toast(`Deleted ${wf.name}.`);
            list();
          };
          act.append(run, del);
          row.append(act);
          body.append(row);
        }
      };

      const editor = (wf) => {
        body.textContent = '';
        const back = el('button', 'link', '‹ back');
        back.onclick = list;
        body.append(back);

        const name = document.createElement('input');
        name.className = 'msnew';
        name.placeholder = 'Automation name';
        name.value = wf?.name ?? '';
        body.append(el('div', 'note', 'Name'), name);

        const triggerType = document.createElement('select');
        for (const t of TRIGGERS) {
          const o = document.createElement('option');
          o.value = t; o.textContent = t;
          if (wf?.trigger?.type === t) o.selected = true;
          triggerType.append(o);
        }
        const triggerDetail = document.createElement('input');
        triggerDetail.className = 'msnew';
        const paintDetail = () => {
          if (triggerType.value === 'interval') { triggerDetail.hidden = false; triggerDetail.placeholder = 'Every N seconds'; triggerDetail.value = wf?.trigger?.everyMs ? String(wf.trigger.everyMs / 1000) : ''; }
          else if (triggerType.value === 'daily') { triggerDetail.hidden = false; triggerDetail.placeholder = 'Time of day, e.g. 09:00'; triggerDetail.value = wf?.trigger?.at ?? ''; }
          else if (triggerType.value === 'bus') { triggerDetail.hidden = false; triggerDetail.placeholder = 'Fire when a message contains…'; triggerDetail.value = wf?.trigger?.pattern ?? ''; }
          else triggerDetail.hidden = true;
        };
        triggerType.onchange = paintDetail;
        paintDetail();
        body.append(el('div', 'note', 'Trigger'), triggerType, triggerDetail);
        if (wf?.id && wf.trigger?.type === 'webhook') {
          body.append(el('div', 'note', `POST ${location.origin}/api/workflows/hook?id=${encodeURIComponent(wf.id)}`));
        }

        const nodes = document.createElement('textarea');
        nodes.className = 'style';
        nodes.rows = 14;
        nodes.spellcheck = false;
        nodes.value = JSON.stringify(wf?.nodes ?? [
          { id: 'a', type: 'log', config: { message: 'hello from a new automation' } },
        ], null, 2);
        body.append(el('div', 'note', 'Nodes — a small JSON graph: http, delay, log, set, '
          + 'condition, bus, transform, foreach. Each has an id, a type, config, and next.'), nodes);

        const act = el('div', 'act');
        const save = el('button', 'primary', wf ? 'Save' : 'Create');
        save.onclick = async () => {
          let parsed;
          try { parsed = JSON.parse(nodes.value); } catch { return toast('Nodes must be valid JSON.', true); }
          if (!name.value.trim()) return toast('Give it a name.', true);
          if (triggerType.value === 'daily' && !/^\d{1,2}:\d{2}$/.test(triggerDetail.value.trim())) {
            return toast('Time of day must look like "09:00".', true);
          }
          const trigger = triggerType.value === 'interval' ? { type: 'interval', everyMs: Math.max(1, Number(triggerDetail.value) || 60) * 1000 }
            : triggerType.value === 'daily' ? { type: 'daily', at: triggerDetail.value.trim() }
            : triggerType.value === 'bus' ? { type: 'bus', pattern: triggerDetail.value.trim() }
            : { type: triggerType.value };
          const r = await post('workflows', { id: wf?.id, name: name.value.trim(), trigger, nodes: parsed, enabled: wf?.enabled !== false });
          if (!r.ok) return toast(r.error ?? 'Could not save it.', true);
          toast(wf ? 'Saved.' : 'Created.');
          list();
        };
        act.append(save);
        body.append(act);
      };

      list();
    },
  });
}

export function openVault(openPath) {
  // A citation click (openPath set) must always land on that note, even if
  // the panel is already open — toggle() would close it instead, and open()
  // alone would leave an already-open panel sitting wherever it was. Both
  // the toolbar button (no path) and a citation click go through the same
  // build() below; only which one they call differs.
  if (openPath) {
    const existing = W.getWindow('vault');
    if (existing) { existing._showVaultPath?.(openPath); W.open('vault', {}); return; }
  }
  const opener = openPath ? W.open : W.toggle;
  opener('vault', {
    title: 'Notes',
    build(box) {
      const search = el('div', 'searchbar');
      const input = el('input');
      input.placeholder = 'Search your notes…';
      input.autocomplete = 'off';
      search.append(input);
      const body = el('div', 'log settings');
      box.append(search, body);

      const show = async (path) => {
        const r = await get(`/api/vault?path=${encodeURIComponent(path)}`);
        body.textContent = '';
        const back = el('button', 'link', '‹ back');
        back.onclick = () => list(input.value);
        body.append(back, el('div', 'note-title', path));
        body.append(el('pre', 'note-body', r.ok ? r.body : (r.error ?? 'Could not read it.')));
      };
      box._showVaultPath = show;

      const seq = sequencer();
      const list = async (q) => {
        const mine = seq.next();
        const r = await get(`/api/vault${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        if (!seq.current(mine)) return;   // a newer search already painted
        body.textContent = '';
        if (!r.configured) {
          body.append(el('div', 'empty', 'No notes folder configured. Set "vault" in kingdom.config.json.'));
          return;
        }
        if (!r.notes.length) {
          body.append(el('div', 'empty', q ? `Nothing matches “${q}”.` : 'No notes found.'));
          return;
        }
        if (!q) body.append(el('div', 'note', 'Recently edited'));
        for (const n of r.notes) {
          const row = el('button', 'note-row');
          row.append(el('span', 'p', n.path));
          if (n.lines?.length) {
            const ctx = el('span', 'ctx');
            for (const l of n.lines) ctx.append(el('i', null, l.text));
            row.append(ctx);
          }
          row.onclick = () => show(n.path);
          body.append(row);
        }
      };

      // Debounced: the vault walk reads every note, so a keystroke-per-search
      // would re-read the whole thing sixteen times a word.
      let t;
      input.oninput = () => { clearTimeout(t); t = setTimeout(() => list(input.value.trim()), 220); };
      input.onkeydown = (e) => { if (e.key === 'Escape') { input.value = ''; list(''); } };
      if (openPath) show(openPath); else list('');
      setTimeout(() => input.focus(), 30);
    },
  });
}
