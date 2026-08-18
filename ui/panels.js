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
          + `&q=${encodeURIComponent(input.value.trim())}`);
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
          body.append(el('div', 'note', `${pending.length} waiting`));
          for (const a of pending) body.append(card(a, true));
        }

        if (done.length) {
          const h = el('div', 'shead');
          h.innerHTML = 'Already decided<em>What the team asked, and what you said.</em>';
          body.append(h);
          for (const a of done.slice(0, 40)) body.append(card(a, false));
        }
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
        const what = a.names?.length ? a.names.join(', ') : (a.peasant ?? a.name ?? '');
        if (what) d.append(el('div', 'what', what));
        if (a.reason) d.append(el('div', 'why', a.reason));

        if (live) {
          const btns = el('div', 'btns');
          const go = el('button', 'go', 'Approve');
          go.onclick = async () => { cue('approve'); await post('approve', { id: a.id }); toast('Approved'); draw(); };
          const no = el('button', 'no', 'Reject');
          no.onclick = async () => { cue('reject'); await post('reject', { id: a.id }); toast('Rejected'); draw(); };
          btns.append(go, no);
          d.append(btns);
        } else {
          d.append(el('div', `verdict ${a.resolved}`, a.resolved === 'approved' ? 'Approved' : 'Rejected'));
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
 * This screen categorizes the 14-specialist standing court by lifecycle domain
 * with rich visual cues, instant category filters, and fast recruitment.
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
      const categories = ['All', 'Discovery', 'Craft', 'Verification', 'Security & Ops', 'Knowledge'];
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

        const cat = ROLE_CATEGORIES[m.name];
        if (cat) {
          main.append(el('span', 'sum-cat', cat));
        }
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
        const matchCat = (m) => activeCat === 'All' || ROLE_CATEGORIES[m.name] === activeCat;
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

export function openVault() {
  W.toggle('vault', {
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
      list('');
      setTimeout(() => input.focus(), 30);
    },
  });
}
