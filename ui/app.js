// Throne room. A glass workspace: an unbounded canvas of panels over a
// backdrop, reached from the court rail on the left.
import * as G from './rail.js';
import * as C from './canvas.js';
import * as W from './win.js';
import { attachMic, onNotice } from './voice.js';
import { icon, setIcon } from './icons.js';
import { verbFor, toneOf, STICKY } from './status.js';
import * as A from './assets.js';
import * as P from './panels.js';
import * as N from './notify.js';
import * as I from './identity.js';
import { avatar } from './avatar.js';
import * as PET from './pet.js';
// The rail-vs-roster rule, apart from the DOM so `npm test` can check it.
import { inCourt } from './court.js';

const $ = (s) => document.querySelector(s);

/**
 * One money format for the whole UI. Two call sites used to write the same
 * .stat slot at different precisions — a member read '$1.319' after a turn and
 * '$1.32' after a spend event. Sub-cent amounts keep a third digit, because
 * rounding a real cost to '$0.00' reads as free.
 */
const money = (n) => `$${Math.abs(n) >= 0.01 ? n.toFixed(2) : n.toFixed(3)}`;
/** Turn counts run to tens of millions; raw digits are unreadable at a glance. */
const tokens = (n = 0) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : n >= 1e3 ? `${Math.round(n / 1e3)}k tok` : `${n} tok`;
const LOG_CAP = 400;

const log = new Map();      // name -> [{cls, text}]  kept whether or not a window is open
const members = new Map();  // name -> {role, cli, model, awake}
let MODELS = { claude: ['opus', 'sonnet', 'haiku', 'fable'], codex: [], agy: [] };
let EFFORTS = { claude: ['low', 'medium', 'high'], codex: ['low', 'medium', 'high', 'xhigh', 'max'], agy: ['low', 'medium', 'high'] };
let ADVISOR = { cli: 'codex', model: 'gpt-5.6-luna', effort: 'max', promptEngineer: true, autoModel: true, allow: [] };
// Which members a domain preset moves. Comes from the daemon snapshot.
let DOMAINS = { frontend: [], backend: [] };
// The `/` menu. Names and triggers only — the bodies never come near the UI.
let SKILLS = [];
// Handled by the kingdom itself and never posted to the court. Kept here rather
// than fetched: it is one entry, and the menu must paint before the first poll.
const LOCAL_COMMANDS = [{
  name: 'autocompact',
  description: 'set the compaction window — auto, 80k, 300000, or 300',
}, {
  name: 'argue',
  description: 'two models argue a question, a third judges — verdict to the vault',
}];
let GOAL = null;
let SUMMARIZER = { enabled: true, cli: 'codex', model: 'gpt-5.4-mini', effort: 'none', maxWords: 16, style: '' };

const post = (action, body = {}) =>
  fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));

function toast(text, bad = false) {
  const d = document.createElement('div');
  if (bad) d.className = 'bad';
  d.textContent = text;
  $('#toast').append(d);
  setTimeout(() => d.remove(), 6000);
}
onNotice(toast);

/* ---------- transcripts ---------- */
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

function render(el, entry) {
  const d = document.createElement('div');
  d.className = entry.cls;
  if (entry.text.length > 700) {
    d.textContent = entry.text.slice(0, 700);
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = ` …+${entry.text.length - 700}`;
    more.onclick = () => { d.textContent = entry.text; };
    d.append(more);
  } else d.textContent = entry.text;
  el.append(d);
  return d;
}

function append(name, cls, text) {
  G.upsertNode(name, members.get(name)?.role);
  const buf = log.get(name) ?? (log.set(name, []), log.get(name));
  const prev = buf[buf.length - 1];

  // Tool calls are the bulk of the noise. Collapse a run into one counted line.
  if (cls === 't-tool' && prev?.cls === 't-tool') {
    prev.n = (prev.n ?? 1) + 1;
    prev.text = `→ ${prev.first} +${prev.n - 1} more`;
    const el = body(name);
    if (el) el.lastElementChild.textContent = prev.text;
    return;
  }

  const entry = { cls, text, first: text.replace(/^→ /, '') };
  buf.push(entry);
  if (buf.length > LOG_CAP) buf.shift();

  const el = body(name);
  if (el) {
    const stick = atBottom(el);
    render(el, entry);
    while (el.children.length > LOG_CAP) el.firstChild.remove();
    if (stick) el.scrollTop = el.scrollHeight;
  }
}

const body = (name) => W.getWindow(`m:${name}`)?.querySelector('.log');

/* ---------- member windows ---------- */
function openMember(name) {
  I.select(name);
  const m = members.get(name) ?? {};
  W.toggle(`m:${name}`, {
    title: name,
    cls: `member role-${m.role ?? 'peasant'} ${m.awake ? '' : 'asleep'}`,
    build(el) {
      const bar = el.querySelector('.slot');
      // The member's own face, so a board of six cards is scannable without
      // reading six titles.
      el.querySelector('.bar').prepend(avatar(name, m.role, 20));

      // Was a bare ⏻, which said nothing about which way it would go.
      const power = document.createElement('button');
      power.className = 'power';
      power.onclick = () => {
        const action = members.get(name)?.awake ? 'sleep' : 'wake';
        append(name, 't-sys', `— ${action === 'sleep' ? 'sending ' + name + ' to sleep' : 'waking ' + name} —`);
        post(action, { name });
      };

      const sel = document.createElement('select');
      sel.className = 'model';
      sel.title = 'CLI and model for this member';
      fillModels(sel, m.cli ?? 'claude', m.model, m.auto);
      sel.onchange = () => {
        if (sel.value === '__custom__') return askCustomModel(el, sel, name);
        if (sel.value === AUTO) return applyAuto(name);
        const [cli, ...rest] = sel.value.split(':');
        applyModel(name, cli, rest.join(':'));
      };

      const eff = document.createElement('select');
      eff.className = 'model effort';
      eff.onchange = () => {
        if (eff.value === AUTO) return applyAuto(name);
        const cur = members.get(name) ?? {};
        applyModel(name, cur.cli ?? 'claude', cur.model ?? '', eff.value);
      };
      // The model and effort pickers do NOT go in the title bar. In the
      // reference they sit as small chips under the prompt, which is where
      // they belong: they are properties of the next message, not of the
      // window. The title bar keeps only actions.
      bar.append(power);
      el.querySelector('.stat').textContent = stats.get(name) ?? '';

      // Summaries by default, raw underneath. This is the whole point of the
      // summariser: the transcript is a wall of text and almost none of it is
      // what you came to read. Toggling is per panel, not global — you usually
      // want detail on exactly one member.
      const quiet = document.createElement('button');
      quiet.className = 'quiet';
      const applyQuiet = () => {
        const on = localStorage.getItem(`kd.raw.${name}`) !== '1';
        el.classList.toggle('summary-only', on);
        quiet.classList.toggle('on', on);
        quiet.title = on ? 'Showing summaries. Click for the full transcript.'
                         : 'Showing everything. Click for summaries only.';
      };
      setIcon(quiet, 'summary', 'Summaries only');
      quiet.onclick = () => {
        const on = localStorage.getItem(`kd.raw.${name}`) !== '1';
        localStorage.setItem(`kd.raw.${name}`, on ? '1' : '0');
        applyQuiet();
      };

      const logEl = document.createElement('div');
      logEl.className = 'log';
      // An empty transcript is a huge blank rectangle. CSS :empty fills it and
      // gets out of the way the moment the first line lands — no lifecycle.
      logEl.dataset.who = name;
      const form = document.createElement('form');
      form.innerHTML = `<div class="row1">
          <input placeholder="Prompt ${name}…" autocomplete="off">
          <button type="button" class="mic"></button>
          <button type="submit" class="send"></button>
        </div>
        <div class="chips"></div>`;
      el.append(logEl, form);

      // Chips: model, effort, and the summaries toggle — everything that
      // shapes the next turn, in one row you can read without opening a menu.
      const chips = form.querySelector('.chips');
      const sep = () => { const s = document.createElement('span'); s.className = 'sep'; return s; };
      chips.append(sel, sep(), eff, sep(), quiet);

      const input = form.querySelector('input');
      setIcon(form.querySelector('.mic'), 'mic', 'Dictate');
      setIcon(form.querySelector('.send'), 'send', 'Send');
      syncControls(name);
      attachMic(form.querySelector('.mic'), input);
      attachSkills(input);
      form.onsubmit = (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // No optimistic echo: the bus round-trips this back as a `delivered`
        // message from the sovereign a moment later, and echoing here showed
        // every message twice — once instantly, once delayed.
        post('speak', { name, text });
      };

      for (const entry of log.get(name) ?? []) render(logEl, entry);
      logEl.scrollTop = logEl.scrollHeight;
      applyQuiet();
    },
  });
}

/* ---------- model picker ---------- */
const DEFAULT_LABEL = '(default)';
const AUTO = '__auto__';

/** value format: "<cli>:<model>", empty model = that CLI's own default. */
function fillModels(sel, cli, model, auto) {
  sel.innerHTML = '';
  // Auto first: the advisor picks model AND effort per task from the vault's
  // Model Guidance. Both are chosen together because that guidance couples
  // them, so selecting Auto in either dropdown sets both.
  const a = document.createElement('option');
  a.value = AUTO;
  a.textContent = 'auto · advisor picks';
  sel.append(a);
  for (const [c, list] of Object.entries(MODELS)) {
    const og = document.createElement('optgroup');
    og.label = c;
    for (const m of [DEFAULT_LABEL, ...list]) {
      const o = document.createElement('option');
      o.value = `${c}:${m === DEFAULT_LABEL ? '' : m}`;
      o.textContent = `${c} · ${m}`;
      og.append(o);
    }
    sel.append(og);
  }
  // A model the config names but MODELS does not list must still be selectable.
  const want = `${cli}:${model ?? ''}`;
  if (![...sel.options].some((o) => o.value === want)) {
    const o = document.createElement('option');
    o.value = want;
    o.textContent = `${cli} · ${model}`;
    sel.insertBefore(o, sel.firstChild);
  }
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'custom…';
  sel.append(custom);
  sel.value = auto ? AUTO : want;
  sel.dataset.current = sel.value;
}

/** Electron has no window.prompt, so "custom…" swaps in a text box. */
function askCustomModel(win, sel, name) {
  const input = document.createElement('input');
  input.className = 'model custom';
  input.placeholder = 'cli:model';
  // The sentinels are not editable text. Prefilling the box with "__auto__"
  // and asking the sovereign to correct it is worse than an empty box.
  const cur = sel.dataset.current ?? '';
  input.value = cur.includes(':') ? cur : '';
  sel.replaceWith(input);
  input.focus();
  input.select();

  const finish = (commit) => {
    const raw = input.value.trim();
    input.replaceWith(sel);
    if (!commit || !raw) { sel.value = sel.dataset.current; return; }
    const [cli, ...rest] = raw.split(':');
    if (MODELS[cli.trim()]) applyModel(name, cli.trim(), rest.join(':').trim());
    else toast(`Unknown CLI "${cli.trim()}". Use claude:, codex: or agy:<model>.`, true);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(false);
}

/**
 * Hand this member's model AND effort to the advisor, chosen per task.
 *
 * Both together, from either dropdown: the vault's Model Guidance couples them
 * (Luna wants max, Terra wants high), so picking the model by hand and the
 * effort automatically would be choosing along the wrong axis.
 */
async function applyAuto(name) {
  append(name, 't-sys', '— model and effort handed to the advisor —');
  const r = await post('model', { name, auto: true });
  if (!r.ok) return append(name, 't-error', `could not set auto: ${r.error ?? 'unknown'}`);
  // Auto on a member does nothing while the selector itself is off, and a
  // dropdown that silently does nothing is worse than no dropdown.
  if (!ADVISOR.autoModel) {
    toast('Auto is set, but the advisor’s model selector is off — turn it on in Advisor.', true);
  }
}

/** `effort` undefined leaves the current one alone; '' resets to the CLI default. */
async function applyModel(name, cli, model, effort) {
  append(name, 't-sys', `— switching to ${cli}${model ? ' / ' + model : ' (default)'}`
    + `${effort ? ' at ' + effort + ' effort' : effort === '' ? ' at default effort' : ''} —`);
  const r = await post('model', { name, cli, model, effort });
  if (!r.ok) append(name, 't-error', `model change failed: ${r.error ?? 'unknown'}`);
}

/**
 * Effort options depend on the CLI, and some models take none at all — showing
 * a live-looking dropdown that the CLI ignores is how settings end up silently
 * doing nothing.
 */
function fillEfforts(sel, cli, effort, takesEffort, model, auto) {
  sel.innerHTML = '';
  const a = document.createElement('option');
  a.value = AUTO;
  a.textContent = 'effort · auto';
  sel.append(a);
  const opts = ['(default)', ...(EFFORTS.byModel?.[model] ?? EFFORTS[cli] ?? [])];
  if (effort && !opts.includes(effort)) opts.push(effort);   // keep a config-set value visible
  for (const e of opts) {
    const o = document.createElement('option');
    o.value = e === '(default)' ? '' : e;
    o.textContent = `effort · ${e}`;
    sel.append(o);
  }
  sel.value = auto ? AUTO : (effort ?? '');
  // Auto still applies to a model with no effort ladder — the advisor may move
  // it onto one that has. Only a PINNED model with no levels disables this.
  sel.disabled = takesEffort === false && !auto;
  sel.title = sel.disabled
    ? 'This model has no effort levels — the flag would be ignored.'
    : `Reasoning effort (${cli === 'codex' ? 'model_reasoning_effort' : '--effort'})`;
}

/** Push roster state into an open window's controls. */
function syncControls(name) {
  const win = W.getWindow(`m:${name}`);
  const m = members.get(name);
  if (!win || !m) return;
  win.classList.toggle('asleep', !m.awake);
  const power = win.querySelector('.power');
  if (power) {
    power.textContent = m.awake ? 'sleep' : 'wake';
    power.title = m.awake
      ? `Stop ${name}. It leaves service and stops costing anything; its session is kept.`
      : `Start ${name} and hand it any mail waiting for it.`;
  }
  const sel = win.querySelector('select.model:not(.effort)');   // not while mid-edit in "custom…"
  if (sel) fillModels(sel, m.cli ?? 'claude', m.model, m.auto);
  const eff = win.querySelector('select.effort');
  if (eff) fillEfforts(eff, m.cli ?? 'claude', m.effort, m.takesEffort, m.model, m.auto);
}

/* ---------- roster ---------- */
function applyRoster(roster) {
  for (const r of roster) {
    members.set(r.name, {
      role: r.role, cli: r.cli, model: r.model, title: r.title, description: r.description,
      effort: r.effort, takesEffort: r.takesEffort, awake: r.awake, summoned: r.summoned,
      auto: r.auto,
    });
    if (!inCourt(r)) {
      // Dismissed, or never summoned. Its panel and its transcript survive —
      // only the rail row goes, so re-summoning restores it where it was.
      G.remove(r.name);
      I.refresh(r.name);
      continue;
    }
    G.upsertNode(r.name, r.role);
    G.setState(r.name, r.awake ? 'awake' : 'asleep');
    G.setServing(r.name, r.summoned);
    // Sleeping clears a stuck "limited"/"failed" — that state died with the process.
    // "resting" rather than "asleep" for a summoned member: it is in the crew
    // and wakes on its next message, which is a different thing entirely.
    if (!r.awake) {
      clearSticky(r.name);
      setStatus(r.name, r.summoned ? 'resting' : 'not summoned');
    }
    else if (!statusOf.has(r.name)) setStatus(r.name, 'idle');
    tip(r.name);
    syncControls(r.name);
    I.refresh(r.name);
  }
  paintCourtCount();
  paintFirstRun();
  syncPet();
  // Anything painting from the roster repaints here — the summoning screen is
  // the first, and it must not disagree with the rail about who is in the court.
  document.dispatchEvent(new CustomEvent('kd:roster'));
}

/**
 * How many are in the court, on the rail's own header.
 *
 * The rail no longer shows the roster, so the size of the roster has to be
 * visible somewhere or summoning looks like it does nothing. This is also the
 * only always-on answer to "how big is my court", which used to require
 * counting rows.
 */
function paintCourtCount() {
  const n = $('#court-count');
  if (!n) return;
  const total = [...members.values()].filter((m) => m.role === 'peasant').length;
  const here = [...members.values()].filter((m) => m.role === 'peasant' && m.summoned).length;
  n.textContent = `${here}/${total}`;
  n.title = `${here} peasant${here === 1 ? '' : 's'} in the court, `
    + `${total - here} more available to summon`;
}

const openSummon = () => P.openSummon({ post, toast, roster: () => members });
$('#summon-btn').onclick = openSummon;

/**
 * What to do when there is nothing to look at.
 *
 * State-driven, not a one-shot tour: it appears whenever the court has no
 * peasants and no goal, which is true on a first run and true again the day you
 * dismiss everyone. A tutorial you can only ever see once is no help to someone
 * who comes back in a month, and this costs nothing to keep correct.
 *
 * The king and the jester are always present, so they are not the test — an
 * empty court means nobody has been summoned to do the work.
 */
function paintFirstRun() {
  const box = $('#firstrun');
  if (!box) return;
  const staffed = [...members.values()].some((m) => m.role === 'peasant' && m.summoned);
  if (staffed || GOAL) { box.hidden = true; return; }

  if (box.dataset.built) { box.hidden = false; return; }
  box.dataset.built = '1';
  box.hidden = false;

  const step = (n, label, hint, run) => {
    const b = document.createElement('button');
    b.className = 'fr-step';
    b.append(
      Object.assign(document.createElement('span'), { className: 'fr-n num', textContent: n }),
      Object.assign(document.createElement('span'), { className: 'fr-label', textContent: label }),
      Object.assign(document.createElement('span'), { className: 'fr-hint', textContent: hint }),
    );
    b.onclick = run;
    return b;
  };

  box.append(
    Object.assign(document.createElement('h1'), { textContent: 'Your court is empty' }),
    Object.assign(document.createElement('p'), {
      textContent: 'The king and the jester are here. Nobody is doing any work yet.',
    }),
    step('1', 'Summon someone', 'Pick who joins the court', openSummon),
    step('2', 'Set a standing goal', 'What everyone is working towards',
      () => P.openGoal({ post, toast, goal: () => GOAL })),
    step('3', 'Give the king an order', 'Type it at the bottom', () => $('#cmd').focus()),
  );
}

/* ---------- bus ---------- */
const busRows = [];

function busRow(m) {
  const d = document.createElement('div');
  d.className = `m kind-${m.kind}`;
  d.innerHTML = `<span class="who"></span><span class="arrow"> → </span><span class="who to"></span>
    <div class="body"></div>`;
  d.querySelector('.who').textContent = m.sender;
  d.querySelector('.to').textContent = m.recipient ?? 'all';
  const b = d.querySelector('.body');
  if (m.body.length > 160) {
    b.textContent = m.body.slice(0, 160) + '…';
    b.style.cursor = 'pointer';
    b.onclick = () => { b.textContent = m.body; b.onclick = null; };
  } else b.textContent = m.body;
  return d;
}

function renderMessage(m) {
  busRows.push(m);
  if (busRows.length > 300) busRows.shift();

  const feed = W.getWindow('bus')?.querySelector('.log');
  if (feed) {
    const stick = atBottom(feed);
    feed.append(busRow(m));
    while (feed.children.length > 300) feed.firstChild.remove();
    if (stick) feed.scrollTop = feed.scrollHeight;
  }

  if (m.sender !== 'orchestrator') G.flash(m.sender, m.recipient);
  // Surface mail inside the recipient's own transcript so it reads in order.
  if (m.recipient && m.sender !== 'orchestrator') {
    append(m.recipient, 't-msg', `✉ ${m.sender}: ${m.body.slice(0, 200)}`);
  }
}

function openBus() {
  const on = W.toggle('bus', {
    title: 'Court bus',
    build(el) {
      const feed = document.createElement('div');
      feed.className = 'log';
      el.append(feed);
      for (const m of busRows) feed.append(busRow(m));
      feed.scrollTop = feed.scrollHeight;
    },
    onClose: () => $('.tool[data-tool="bus"]')?.classList.remove('on'),
  });
  $('.tool[data-tool="bus"]')?.classList.toggle('on', on);
}

/* ---------- approvals ---------- */
const TITLES = { summon: 'SUMMON', role: 'NEW ROLE', merge: 'MERGE' };

function renderApproval(a) {
  if (document.getElementById(`ap-${a.id}`)) return;
  const el = document.createElement('details');
  el.className = 'approval';
  el.id = `ap-${a.id}`;
  el.open = true;
  const who = a.kind === 'summon' ? a.names.join(', ') : a.kind === 'role' ? a.name : a.peasant;
  const detail = a.kind === 'summon' ? a.reason
    : a.kind === 'role' ? `${a.cli}${a.model ? ' · ' + a.model : ''}\n\n${a.reason}\n\n${a.prompt}`
    : a.verdict;
  el.dataset.id = String(a.id);
  el.innerHTML = `<summary><span></span><span class="who"></span></summary>
    <pre></pre><div class="btns"><button class="go">Approve</button><button class="no">Reject</button></div>`;
  el.querySelector('summary span').textContent = `${TITLES[a.kind] ?? a.kind.toUpperCase()} #${a.id}`;
  el.querySelector('summary .who').textContent = who;
  el.querySelector('pre').textContent = detail;
  const decide = async (action) => {
    const buttons = el.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    const r = await post(action, { id: a.id });
    if (!r.ok) {
      buttons.forEach((b) => { b.disabled = false; });
      toast(r.error ?? 'The court could not record that decision.', true);
      return;
    }
    el.remove();
    badge();
    syncApprovals();
  };
  el.querySelector('.go').onclick = () => decide('approve');
  el.querySelector('.no').onclick = () => decide('reject');
  $('#approvals').append(el);
  badge();
}

/** Recover pending cards if an SSE approval event was missed. */
async function syncApprovals() {
  try {
    const r = await fetch('/api/approvals').then((res) => res.json());
    if (!r.ok || !Array.isArray(r.approvals)) return;
    const pending = r.approvals.filter((a) => !a.resolved);
    const ids = new Set(pending.map((a) => String(a.id)));
    for (const a of pending) renderApproval(a);
    for (const card of [...$('#approvals').children]) {
      if (!ids.has(card.dataset.id)) card.remove();
    }
    badge();
  } catch { /* the stream/next poll will retry */ }
}

/**
 * Put the number of waiting approvals on the toolbar.
 *
 * Counted from the cards actually on screen, not from a tally we increment:
 * a counter and a DOM can disagree, and the one the sovereign believes is the
 * one they can see. With nothing pending the icon still sits there, which is
 * the point — the approval mechanism used to be invisible until it fired.
 */
function badge() {
  const n = $('#approvals').childElementCount;
  const btn = $('.tool[data-tool="approve"]');
  if (!btn) return;
  btn.dataset.count = n > 0 ? String(n) : '';
  btn.classList.toggle('waiting', n > 0);
  btn.title = n > 0
    ? `Approvals — ${n} waiting on you`
    : 'Approvals — what the court is asking permission for';
}

/* ---------- stream ---------- */
const statusOf = new Map();

/** One word under the node. A blocked member is not relabelled by a stray tool. */
function setStatus(name, word) {
  if (STICKY.has(statusOf.get(name)) && !STICKY.has(word)) return;
  statusOf.set(name, word);
  G.setStatus(name, word, toneOf(word));
  I.refresh(name);
  syncPet();
}
const clearSticky = (name) => statusOf.delete(name);

/**
 * The dog reports the court.
 *
 * Derived from the roster and the live statuses rather than counted by hand:
 * an incremented tally and a DOM can disagree, and the one you can see is the
 * one you believe. Same reasoning as the approvals badge.
 */
const syncPet = () => PET.setMood(PET.moodOf(
  [...members].map(([name, m]) => ({ awake: m.awake, busy: isBusy(statusOf.get(name)) }))));
const isBusy = (word) => Boolean(word) && word !== 'idle';

function renderEvent({ name, kind, payload }, live = true) {
  if (kind === 'text') {
    const t = payload.text.trim();
    append(name, 't-text', t);
    if (live) setStatus(name, 'speaking');
  } else if (kind === 'tool') {
    append(name, 't-tool', `→ ${payload.name}`);
    if (live) setStatus(name, verbFor(payload));
  } else if (kind === 'summary') {
    append(name, 't-sum', payload.text);
    G.setSummary(name, payload.text);
    summaries.set(name, payload.text);
    I.refresh(name);
  } else if (kind === 'error') {
    append(name, 't-error', `!! ${payload.message}`);
  } else if (kind === 'turn_end') {
    append(name, 't-end', '');
    const tok = payload.ctx;   // measured context, not the turn's usage total
    if (tok) G.setSize(name, tok);
    if (live) {
      G.setState(name, 'awake');
      setStatus(name, 'idle');
    }
    stat(name, [tok && `ctx ${(tok / 1000).toFixed(0)}k`,
      payload.costUsd && money(payload.costUsd)]);
  }
}

const stats = new Map();       // survives the window being closed and reopened
const summaries = new Map();   // the newest one-liner per member, for the card

function stat(name, parts) {
  stats.set(name, parts.filter(Boolean).join(' · '));
  const el = W.getWindow(`m:${name}`)?.querySelector('.stat');
  if (el) el.textContent = stats.get(name);
  tip(name);
  I.refresh(name);
}

/**
 * Hover text. With a bench this size the sovereign will not remember what a
 * "quartermaster" does, and the rail deliberately shows only one word — so
 * the role's purpose lives here rather than as more text on screen.
 */
function tip(name) {
  const m = members.get(name) ?? {};
  G.setTip(name, [
    m.title ? `${name} — ${m.title}` : name,
    m.description,
    stats.get(name),
  ].filter(Boolean).join('\n'));
}

function connect() {
  const es = new EventSource('/stream');
  es.onopen = () => { $('#conn').className = 'conn up'; $('#conn').title = 'connected'; };
  es.onerror = () => { $('#conn').className = 'conn'; $('#conn').title = 'disconnected'; };
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    N.onEvent(d);   // desktop alerts for the few things that stall the court
    switch (d.type) {
      case 'snapshot':
        $('#repo').textContent = `${d.repo.split(/[\\/]/).pop()}${d.base ? ' · ' + d.base : ''}`;
        $('#repo').title = d.repo;
        if (d.models) MODELS = d.models;
        if (d.efforts) EFFORTS = d.efforts;
        if (d.advisor) ADVISOR = d.advisor;
        if (d.domains) DOMAINS = d.domains;
        if (d.skills) SKILLS = d.skills;
        if (d.summarizer) SUMMARIZER = d.summarizer;
        if (d.goal !== undefined) { GOAL = d.goal; paintGoal(); }
        applyRoster(d.roster);
        // An empty card on load teaches nothing. Start on the king: it is the
        // one member the sovereign always has.
        if (!I.selected()) I.select(d.roster.find((r) => r.role === 'king')?.name ?? d.roster[0]?.name);
        for (const ev of d.events) renderEvent({ name: ev.agent, kind: ev.type, payload: ev.payload }, false);
        for (const m of d.messages) renderMessage(m);
        for (const a of d.approvals) renderApproval(a);
        break;
      case 'agent': {
        G.upsertNode(d.name, d.role);
        if (d.state === 'awake' || d.state === 'ready') G.setState(d.name, 'awake');
        else if (d.state === 'verifying') G.setState(d.name, 'busy');
        else if (d.state === 'exited') G.setState(d.name, 'dead');
        if (d.state === 'awake') {
          append(d.name, 't-sys', `— awoken in ${d.cwd} —`);
          if (members.has(d.name)) members.get(d.name).awake = true;
          clearSticky(d.name);
          setStatus(d.name, 'idle');
          syncControls(d.name);
        }
        break;
      }
      case 'spend':
        // Cost only when there IS one. The CLIs that report no cost of their
        // own are priced from the rate card now (src/price.js), so this is a
        // real figure for a codex court too — but a model with no published
        // price still contributes nothing, and inventing $0.00 for it would be
        // worse than saying nothing.
        $('#spend').textContent =
          `${d.total > 0 ? money(d.total) + ' · ' : ''}${tokens(d.tokens)} · ${d.turns} turns`;
        if (d.name && d.ctx) {
          G.setSize(d.name, d.ctx);
          stat(d.name, [`ctx ${(d.ctx / 1000).toFixed(0)}k`, money(d.spentByAgent)]);
        }
        break;
      case 'roster':
        if (d.models) MODELS = d.models;
        if (d.efforts) EFFORTS = d.efforts;
        applyRoster(d.roster);
        break;
      case 'event': renderEvent(d); break;
      case 'delivered': renderMessage(d.msg); break;
      case 'approval': renderApproval(d); break;
      case 'verified':
        append(d.peasant, 't-sys',
          `— tests: ${d.tests.ran ? (d.tests.ok ? 'PASSED' : 'FAILED') : 'none found'} —\n${d.stat}`);
        break;
      case 'merged':
        append(d.peasant, 't-sys', '— MERGED into the base branch —');
        toast(`${d.peasant} merged`);
        PET.play('cheer');
        break;
      case 'mergeFailed':
        append(d.peasant, 't-error', `✖ MERGE REFUSED — your repo was not touched.\n${d.message}`);
        toast(`${d.peasant}: merge refused`, true);
        break;
      case 'limited':
        append(d.name, 't-error',
          `⏳ ${d.name} hit the account session limit — resets ${d.resetsAt}.\n` +
          'Not a fault. Retrying will not help; wait for the reset.');
        setStatus(d.name, 'limited');
        toast(`${d.name} rate limited until ${d.resetsAt}`, true);
        break;
      case 'budget':
        if (d.scope === 'kingdom') {
          append('king', 't-error',
            `⛔ KINGDOM SPEND CEILING reached ($${d.spent.toFixed(2)} of $${d.cap}). Everyone stopped.`);
          toast(`Kingdom spend ceiling $${d.cap} reached — everyone stopped`, true);
        } else {
          append(d.name, 't-error',
            `⛔ ${d.name} reached its spend ceiling ($${d.spent.toFixed(2)} of $${d.cap}) and was stopped.`);
          toast(`${d.name} hit its $${d.cap} ceiling`, true);
        }
        break;
      case 'failover':
        append(d.name, 't-sys',
          `— rate limited; moved to token ${d.attempt + 1}/${d.poolSize} and restarted —`);
        break;
      case 'failure':
        G.setState(d.name, 'dead');
        setStatus(d.name, 'failed');
        append(d.name, 't-error', `⚠ ${d.name} has FAILED and may be stuck:\n${d.message}`);
        toast(`${d.name} failed`, true);
        break;
      case 'advising':
        if (d.stage === 'start') {
          $('#cmd').classList.add('advising');
          $('#cmd').placeholder = 'the advisor is working on your brief…';
          setStatus('king', 'briefing');
        } else {
          $('#cmd').classList.remove('advising');
          $('#cmd').placeholder = CMD_PLACEHOLDER;
          clearSticky('king');
          if (d.rewritten && d.rewritten !== d.text) {
            append('king', 't-sys', `— brief rewritten by the advisor —\nyou said: ${d.text}`);
          }
          if (d.models?.length) {
            append('king', 't-sys', `— advisor set models: ${d.models.join(', ')} —`);
            toast(`Models chosen: ${d.models.length} member(s)`);
          }
        }
        break;
      case 'goal':
        GOAL = d && d.text ? d : null;
        paintGoal();
        W.getWindow('goal')?.dispatchEvent(new CustomEvent('kd:goal', { detail: GOAL }));
        toast(GOAL ? 'Standing goal set' : 'Standing goal cleared');
        break;
      case 'milestone':
        toast(`Milestone reached: ${d.text}`);
        PET.play('cheer');
        append('king', 't-sys', `— milestone reached: ${d.text}
${d.evidence ?? ''} —`);
        break;
      case 'summarizer':
        SUMMARIZER = d;
        W.getWindow('summarizer')?.dispatchEvent(new Event('kd:summarizer'));
        toast(`Summaries ${d.enabled ? 'on' : 'off'} · ${d.model} · ${d.maxWords} words`);
        break;
      case 'advisor':
        ADVISOR = d;
        W.getWindow('advisor')?.dispatchEvent(new Event('kd:advisor'));
        toast(`Advisor: ${d.model}${d.effort ? '/' + d.effort : ''}`
          + ` · rewrite ${d.promptEngineer ? 'on' : 'off'} · auto-model ${d.autoModel ? 'on' : 'off'}`);
        break;
      case 'resolved': {
        // Answered somewhere else — another window, or the Approvals panel.
        const card = [...$('#approvals').children].find((c) => c.dataset.id === String(d.id));
        card?.remove();
        badge();
        break;
      }
      case 'recycled': append(d.name, 't-sys', '— recycled, handover carried over —'); break;
      case 'compact': toast(d.message); break;
      case 'error': append('king', 't-error', d.message); toast(d.message, true); break;
    }
  };
}

/* ---------- boot ---------- */
$('#mark').append(icon('crown', 18));
setIcon($('#cmd-mic'), 'mic', 'Dictate');

C.initCanvas($('#surface'));        // must precede setHost: panels ride the canvas
W.setHost($('#windows'));
G.initRail($('#rail-list'), { onOpen: openMember });
G.initCollapse($('#rail-collapse'));
W.onChange(() => { G.setOpen(W.openIds()); I.refresh(); });
A.initBackground($('#bg'));
A.refresh();
// Under Electron the dog has his own always-on-top window, so the rail keeps
// its space. In a plain browser there is no such window, and the rail is where
// he lives. Nothing to configure — the environment decides.
const ELECTRON = navigator.userAgent.includes('Electron');
if (ELECTRON) $('#rail-pet').remove();
else PET.initPet($('#rail-pet'));

/* ---------- the hall / the grounds ----------
 * Two ways to hold the same panels. The hall ("board" internally) tiles
 * everything open into a grid that fills the stage — the layout you want when
 * you are watching a crew work. The grounds ("flow") is the free canvas: you
 * place panels and pan between them, which is the layout you want when you are
 * comparing two of them side by side. The hall is the default because an even
 * grid is the one that needs no setup.
 *
 * The internal names stay `board` and `flow`: they are in localStorage under
 * kd.mode and in CSS class names, and renaming them would log every sovereign
 * out of their chosen layout to change a word they never see.
 */
function setMode(m) {
  const board = m === 'board';
  localStorage.setItem('kd.mode', m);
  $('#stage').classList.toggle('board', board);
  document.body.classList.toggle('board', board);   // gather/zoom are flow-only
  W.setTiled(board);
  for (const b of $('#mode').children) b.classList.toggle('on', b.dataset.mode === m);
}

function buildModes() {
  const nav = $('#mode');
  // In-world names, plain-English tooltips. "Board" and "Flow" named the
  // mechanism (a tiling window manager and a canvas); the hall and the grounds
  // name the place, which is the thing you are actually choosing between.
  for (const [m, label, hint] of [
    ['board', 'Hall', 'Every open panel assembled in a grid'],
    ['flow', 'Grounds', 'Place panels yourself on a canvas you can pan and zoom'],
  ]) {
    const b = document.createElement('button');
    b.dataset.mode = m;
    b.textContent = label;
    b.title = `${label} — ${hint}  (Alt+L)`;
    b.onclick = () => setMode(m);
    nav.append(b);
  }
  setMode(localStorage.getItem('kd.mode') ?? 'board');
}
buildModes();

/* ---------- the member card ---------- */
I.initIdentity($('#who-body'), {
  info(name) {
    const m = members.get(name);
    if (!m) return null;
    return {
      ...m, name,
      status: statusOf.get(name),
      stat: stats.get(name),
      summary: summaries.get(name),
      open: W.isOpen(`m:${name}`),
    };
  },
  onOpen: openMember,
  onPower(name) {
    const action = members.get(name)?.awake ? 'sleep' : 'wake';
    append(name, 't-sys', `— ${action === 'sleep' ? 'sending ' + name + ' to sleep' : 'waking ' + name} —`);
    post(action, { name });
  },
});
I.initCollapse($('#who-collapse'));

// Selection follows attention: clicking anywhere in a member's panel selects
// it. Capture, because the panels stop the event reaching here otherwise.
$('#windows').addEventListener('pointerdown', (e) => {
  const id = e.target.closest('.win')?.dataset.id;
  if (id?.startsWith('m:')) I.select(id.slice(2));
}, true);

/* ---------- the summariser ---------- */
const saveSummarizer = (patch) => post('summarizer', patch);

function openSummarizer() {
  W.toggle('summarizer', {
    title: 'Summaries',
    build(el) {
      const box = document.createElement('div');
      box.className = 'log settings';
      el.append(box);

      const draw = () => {
        const s = SUMMARIZER;
        box.innerHTML = '';

        const on = document.createElement('input');
        on.type = 'checkbox';
        on.checked = s.enabled;
        on.onchange = () => saveSummarizer({ enabled: on.checked });
        const r1 = document.createElement('label');
        r1.className = 'srow';
        const t1 = document.createElement('span');
        t1.innerHTML = 'Summarise every turn<em>One line per turn from a cheap model, '
          + 'instead of the wall of text.</em>';
        r1.append(t1, on);
        box.append(r1);

        const mSel = document.createElement('select');
        mSel.className = 'model';
        fillModels(mSel, s.cli, s.model);
        mSel.onchange = () => {
          if (mSel.value === '__custom__') { draw(); return; }
          const [cli, ...rest] = mSel.value.split(':');
          const model = rest.join(':');
          const ok = EFFORTS.byModel?.[model] ?? EFFORTS[cli] ?? [];
          saveSummarizer({ cli, model, effort: ok.includes(s.effort) ? s.effort : '' });
        };
        const r2 = document.createElement('label');
        r2.className = 'srow';
        const t2 = document.createElement('span');
        t2.innerHTML = 'Runs on<em>Small and fast. This fires once per turn, for every member.</em>';
        r2.append(t2, mSel);
        box.append(r2);

        const eSel = document.createElement('select');
        eSel.className = 'model effort';
        fillEfforts(eSel, s.cli, s.effort, true, s.model);
        eSel.onchange = () => saveSummarizer({ effort: eSel.value });
        const r3 = document.createElement('label');
        r3.className = 'srow';
        const t3 = document.createElement('span');
        t3.innerHTML = 'Effort<em>“none” is right here — condensing is not reasoning.</em>';
        r3.append(t3, eSel);
        box.append(r3);

        box.append(range('Length', s.maxWords, 6, 40, 1, ' words',
          (v) => saveSummarizer({ maxWords: v })));

        const h = document.createElement('div');
        h.className = 'shead';
        h.innerHTML = 'How they should read<em>Your own words. This goes straight to the model, '
          + 'so write it as an instruction.</em>';
        box.append(h);

        const ta = document.createElement('textarea');
        ta.className = 'style';
        ta.rows = 4;
        ta.spellcheck = false;
        ta.value = s.style ?? '';
        // Saved on blur, not per keystroke: every save rewrites
        // kingdom.config.json on disk.
        ta.onblur = () => { if (ta.value !== s.style) saveSummarizer({ style: ta.value.trim() }); };
        box.append(ta);

        const presets = document.createElement('div');
        presets.className = 'act';
        for (const [label, style] of [
          ['Terse', 'Plain past tense. Lead with the verb. Name real files and symbols. '
            + 'No preamble, no praise, no hedging.'],
          ['Explain', 'One sentence saying what was done and why it mattered. '
            + 'Name the file. Plain English, no jargon.'],
          ['Blunt', 'Say what happened. If nothing was achieved, say that first. '
            + 'Never soften. Never congratulate.'],
        ]) {
          const b = document.createElement('button');
          b.textContent = label;
          b.onclick = () => { ta.value = style; saveSummarizer({ style }); };
          presets.append(b);
        }
        box.append(presets);
      };

      draw();
      el.addEventListener('kd:summarizer', draw);
    },
  });
}

/* ---------- notifications ---------- */
function openNotify() {
  W.toggle('notify', {
    title: 'Notifications',
    build(el) {
      const box = document.createElement('div');
      box.className = 'log settings';
      el.append(box);

      const draw = () => {
        const s = N.settings();
        box.innerHTML = '';

        if (s.permission !== 'granted') {
          const act = document.createElement('div');
          act.className = 'act';
          const ask = document.createElement('button');
          ask.className = 'primary';
          ask.textContent = s.permission === 'denied'
            ? 'Blocked — allow notifications in your browser settings'
            : 'Allow desktop notifications';
          ask.disabled = s.permission === 'denied' || s.permission === 'unsupported';
          // Asked from a click, never on load: a permission prompt that appears
          // unprompted is the one everyone reflexively blocks.
          ask.onclick = async () => { await N.request(); draw(); };
          act.append(ask);
          box.append(act);
        }

        const row = (key, label, hint) => {
          const d = document.createElement('label');
          d.className = 'srow';
          const t = document.createElement('span');
          t.innerHTML = `${label}<em>${hint}</em>`;
          const i = document.createElement('input');
          i.type = 'checkbox';
          i.checked = s[key];
          i.disabled = s.permission !== 'granted';
          i.onchange = () => N.setPref({ [key]: i.checked });
          d.append(t, i);
          box.append(d);
        };

        row('approvals', 'Waiting on you', 'A summons or a proposal the court cannot proceed without.');
        row('failures', 'Something broke', 'A member failed, a merge was refused, or an account hit its limit.');
        row('budget', 'Spend ceiling', 'A member or the whole court was stopped for money.');
        row('done', 'Work merged', 'Off by default — this one is good news, and good news can wait.');

        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'Nothing is sent while this window is focused — you are already looking.';
        box.append(note);
      };

      draw();
    },
  });
}

/* ---------- wallpaper ---------- */
function openWallpaper() {
  W.toggle('wallpaper', {
    title: 'Wallpaper',
    build(el) {
      const box = document.createElement('div');
      box.className = 'log settings';
      el.append(box);

      const draw = () => {
        const bg = A.background();
        box.innerHTML = '';

        const act = document.createElement('div');
        act.className = 'act';
        const up = document.createElement('button');
        up.className = 'primary';
        up.append(icon('upload'), document.createTextNode('Upload image'));
        up.onclick = async () => {
          const files = await A.pick('image/*');
          for (const f of files) {
            const r = await A.upload(f);
            if (!r.ok) toast(`${f.name}: ${r.error ?? 'upload failed'}`, true);
            else await A.useWallpaper(r.name);
          }
          draw();
        };
        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        reset.onclick = () => { A.resetBackground(); draw(); };
        act.append(up, reset);
        box.append(act);

        const grid = document.createElement('div');
        grid.className = 'gallery';

        const none = document.createElement('button');
        none.className = `tile none${bg.image ? '' : ' on'}`;
        none.textContent = 'No wallpaper';
        none.onclick = () => { A.setBackground({ image: null }); draw(); };
        grid.append(none);

        for (const a of A.list().filter((x) => x.kind === 'image')) {
          const t = document.createElement('button');
          t.className = `tile${bg.image === a.name ? ' on' : ''}`;
          t.style.backgroundImage = `url("${A.src(a.name)}")`;
          t.onclick = async () => { await A.useWallpaper(a.name); draw(); };
          const cap = document.createElement('span');
          cap.className = 'cap';
          cap.textContent = a.name;
          const kill = document.createElement('button');
          kill.className = 'kill';
          setIcon(kill, 'close', `Delete ${a.name}`);
          kill.onclick = async (e) => { e.stopPropagation(); await A.remove(a.name); draw(); };
          t.append(cap, kill);
          grid.append(t);
        }
        box.append(grid);

        // Dim and blur only matter once there is an image to dim or blur.
        if (!bg.image) return;

        // Glass keeps the backdrop's luminance, so a bright wallpaper at a low
        // scrim takes the panels' muted text under 2:1. The image was measured
        // when it was chosen; say so rather than let it quietly go unreadable.
        const flag = document.createElement('div');
        flag.className = 'note';
        const warn = () => {
          const now = A.background();
          const under = now.floor && now.dim < now.floor;
          flag.classList.toggle('bad', Boolean(under));
          flag.textContent = under
            ? `Below ${now.floor}% the panel text stops being readable over this image.`
            : 'Dim is the scrim between the image and the panels.';
        };
        box.append(
          range('Dim', bg.dim, 0, 90, 5, '%', (v) => { A.setBackground({ dim: v }); warn(); }),
          flag,
          range('Blur', bg.blur, 0, 24, 1, 'px', (v) => A.setBackground({ blur: v })),
        );
        warn();
      };

      draw();
      A.onAssets(draw);
      el.addEventListener('kd:assets', draw);
    },
    onClose: () => A.onAssets(() => {}),
  });
}

/** Labelled slider that reports live and saves as you drag. */
function range(label, value, min, max, step, unit, apply) {
  const d = document.createElement('label');
  d.className = 'slider';
  const t = document.createElement('span');
  t.textContent = label;
  const i = document.createElement('input');
  Object.assign(i, { type: 'range', min, max, step, value });
  const out = document.createElement('b');
  out.textContent = `${value}${unit}`;
  i.oninput = () => { out.textContent = `${i.value}${unit}`; apply(Number(i.value)); };
  d.append(t, i, out);
  return d;
}

/* ---------- music ---------- */
function openMusic() {
  W.toggle('music', {
    title: 'Music',
    build(el) {
      const box = document.createElement('div');
      box.className = 'log settings';
      el.append(box);

      const tracks = () => A.list().filter((x) => x.kind === 'audio').map((x) => x.name);

      const draw = () => {
        const s = A.state();
        box.innerHTML = '';

        const act = document.createElement('div');
        act.className = 'act';
        const up = document.createElement('button');
        up.className = 'primary';
        up.append(icon('upload'), document.createTextNode('Upload music'));
        up.onclick = async () => {
          const files = await A.pick('audio/*');
          for (const f of files) {
            const r = await A.upload(f);
            if (!r.ok) toast(`${f.name}: ${r.error ?? 'upload failed'}`, true);
          }
          A.setQueue(tracks());
          draw();
        };
        act.append(up);
        box.append(act);

        const list = tracks();
        if (!list.length) {
          const e = document.createElement('div');
          e.className = 'empty';
          e.textContent = 'Nothing here yet. Upload an mp3, m4a, ogg, wav or flac.';
          box.append(e);
          return;
        }

        // Now playing + transport
        const now = document.createElement('div');
        now.className = 'now';
        const title = document.createElement('span');
        title.className = `title${s.name ? '' : ' idle'}`;
        title.textContent = s.name ?? 'Nothing playing';
        const time = document.createElement('span');
        time.className = 't';
        time.textContent = `${A.fmt(s.time)} / ${A.fmt(s.duration)}`;
        now.append(title, time);

        const tp = document.createElement('div');
        tp.className = 'transport';
        const btn = (name, label, on, fn) => {
          const b = document.createElement('button');
          setIcon(b, name, label);
          if (on) b.classList.add('on');
          b.onclick = fn;
          return b;
        };
        tp.append(
          btn('prev', 'Previous', false, () => A.next(-1)),
          btn(s.playing ? 'pause' : 'play', s.playing ? 'Pause' : 'Play', false, () => A.toggle()),
          btn('next', 'Next', false, () => A.next(1)),
          btn('loop', 'Loop the queue', s.loop, () => A.setPlayer({ loop: !s.loop })),
          btn('shuffle', 'Shuffle', s.shuffle, () => A.setPlayer({ shuffle: !s.shuffle })),
        );
        box.append(now, tp);

        const scrub = range('', Math.floor(s.time), 0, Math.max(1, Math.floor(s.duration)), 1, '',
          (v) => A.seek(v));
        scrub.querySelector('b').remove();
        scrub.querySelector('span').remove();
        box.append(scrub);
        box.append(range('Volume', Math.round(s.volume * 100), 0, 100, 1, '%',
          (v) => A.setPlayer({ volume: v / 100 })));

        const ul = document.createElement('div');
        ul.className = 'tracks';
        for (const name of list) {
          const r = document.createElement('div');
          r.className = `trk${s.name === name ? ' on' : ''}`;
          const n = document.createElement('span');
          n.textContent = name;
          const kill = document.createElement('button');
          kill.className = 'kill';
          setIcon(kill, 'close', `Delete ${name}`);
          kill.onclick = async (e) => { e.stopPropagation(); await A.remove(name); A.setQueue(tracks()); draw(); };
          r.append(n, kill);
          r.onclick = () => A.play(name);
          ul.append(r);
        }
        box.append(ul);
      };

      // Redrawing the whole panel on every timeupdate would fight the sliders
      // being dragged, so the clock and the scrubber are patched in place and a
      // full redraw only happens when the track or the transport changes.
      let lastKey = '';
      const off = A.onMusic((s) => {
        const key = `${s.name}|${s.playing}|${s.loop}|${s.shuffle}|${s.queue.length}`;
        if (key !== lastKey) { lastKey = key; draw(); return; }
        const t = box.querySelector('.now .t');
        if (t) t.textContent = `${A.fmt(s.time)} / ${A.fmt(s.duration)}`;
        const scrub = box.querySelector('.slider input');
        if (scrub && document.activeElement !== scrub) {
          scrub.max = String(Math.max(1, Math.floor(s.duration)));
          scrub.value = String(Math.floor(s.time));
        }
      });

      A.setQueue(tracks());
      draw();
      el.addEventListener('kd:assets', draw);
      el._offMusic = off;
    },
    onClose: () => W.getWindow('music')?._offMusic?.(),
  });
}

/* ---------- the advisor ---------- */
// One panel for both AI-run features, because they share one model: it would
// be confusing to configure the same thing in two places.
const saveAdvisor = (patch) => post('advisor', patch);

function openAdvisor() {
  W.toggle('advisor', {
    title: 'Advisor',
    build(el) {
      const box = document.createElement('div');
      box.className = 'log settings';
      el.append(box);

      const draw = () => {
        box.innerHTML = '';
        const row = (label, hint, control) => {
          const d = document.createElement('label');
          d.className = 'srow';
          const t = document.createElement('span');
          t.innerHTML = `${label}<em>${hint}</em>`;
          d.append(t, control);
          box.append(d);
          return control;
        };

        const check = (on) => {
          const i = document.createElement('input');
          i.type = 'checkbox';
          i.checked = on;
          return i;
        };

        row('Prompt engineer', 'Rewrites what you type before the king reads it.',
          check(ADVISOR.promptEngineer)).onchange =
            (e) => saveAdvisor({ promptEngineer: e.target.checked });

        row('Automatic model selector', 'Picks each worker’s model and effort per task.',
          check(ADVISOR.autoModel)).onchange =
            (e) => saveAdvisor({ autoModel: e.target.checked });

        // Which model runs the advisor itself.
        const mSel = document.createElement('select');
        mSel.className = 'model';
        fillModels(mSel, ADVISOR.cli, ADVISOR.model);
        row('Runs on', 'The model doing the rewriting and choosing.', mSel).onchange = () => {
          if (mSel.value === '__custom__') { draw(); return; }
          const [cli, ...rest] = mSel.value.split(':');
          const model = rest.join(':');
          // Effort ladders differ per model; drop one the new model rejects.
          const ok = EFFORTS.byModel?.[model] ?? EFFORTS[cli] ?? [];
          saveAdvisor({ cli, model, effort: ok.includes(ADVISOR.effort) ? ADVISOR.effort : '' });
        };

        const eSel = document.createElement('select');
        eSel.className = 'model effort';
        fillEfforts(eSel, ADVISOR.cli, ADVISOR.effort, true, ADVISOR.model);
        row('Effort', 'How hard it thinks about your wording.', eSel).onchange =
          () => saveAdvisor({ effort: eSel.value });

        // --- whole-stack presets ---------------------------------------
        // One choice moves a whole side of the court, instead of opening six
        // panes and setting six dropdowns to the same thing.
        const dhead = document.createElement('div');
        dhead.className = 'shead';
        dhead.innerHTML = 'Model per domain<em>Sets every member of that domain at once — '
          + 'e.g. Claude on the frontend, GPT on the backend. Cross-cutting roles '
          + '(tester, reviewer, scout…) are in neither and keep their own model.</em>';
        box.append(dhead);

        for (const [domain, names] of Object.entries(DOMAINS)) {
          const dSel = document.createElement('select');
          dSel.className = 'model';
          // No single current value: the members may disagree. Show what they
          // are only when they actually agree, rather than inventing a winner.
          const cur = [...new Set(names.map((n) => {
            const m = members.get(n);
            return m ? (m.auto ? AUTO : `${m.cli ?? 'claude'}:${m.model ?? ''}`) : null;
          }).filter(Boolean))];
          fillModels(dSel, 'codex', '', false);
          if (cur.length === 1) dSel.value = cur[0];
          else {
            const mixed = document.createElement('option');
            mixed.value = '__mixed__';
            mixed.textContent = `mixed (${cur.length} models)`;
            dSel.insertBefore(mixed, dSel.firstChild);
            dSel.value = '__mixed__';
          }
          row(domain, names.join(', ') || 'no members', dSel).onchange = async () => {
            if (dSel.value === '__custom__' || dSel.value === '__mixed__') { draw(); return; }
            const auto = dSel.value === AUTO;
            const [cli, ...rest] = auto ? ['', ''] : dSel.value.split(':');
            const r = await post('domainModel', auto
              ? { domain, auto: true }
              : { domain, cli, model: rest.join(':') });
            if (!r.ok) toast(`Could not set ${domain}: ${r.error ?? 'unknown'}`, true);
            draw();
          };
        }

        const head = document.createElement('div');
        head.className = 'shead';
        head.innerHTML = 'Models the selector may choose<em>Unticked models are off limits to it. '
          + 'You can still set any model by hand.</em>';
        box.append(head);

        const all = Object.entries(MODELS)
          .flatMap(([cli, list]) => list.map((m) => `${cli}/${m}`));
        // An empty allowlist means "no restriction" to the backend; show that
        // honestly as everything ticked rather than as nothing ticked.
        const on = new Set(ADVISOR.allow?.length ? ADVISOR.allow : all);
        for (const ref of all) {
          const d = document.createElement('label');
          d.className = 'srow tick';
          const c = check(on.has(ref));
          c.onchange = () => {
            const next = new Set(on);
            c.checked ? next.add(ref) : next.delete(ref);
            // Never save an empty list: that reads as "unrestricted", the
            // opposite of what unticking everything means.
            if (!next.size) { toast('Leave at least one model selectable.', true); draw(); return; }
            saveAdvisor({ allow: [...next] });
          };
          const t = document.createElement('span');
          t.textContent = ref;
          d.append(t, c);
          box.append(d);
        }
      };

      draw();
      el.addEventListener('kd:advisor', draw);
    },
  });
}

/* ---------- the toolbar ----------
 * The command palette is gone. Sixteen members made it a list you searched
 * rather than a list you read, and every global action was two keystrokes and
 * a guess away. These are the ten things worth reaching for, always visible,
 * always in the same place. Per-member actions live on the member instead: the
 * rail opens it, its own title bar wakes it and picks its model.
 */
const TOOLS = [
  ['goal', 'Standing goal', 'What the court is working towards', () => P.openGoal({ post, toast, goal: () => GOAL })],
  ['approve', 'Approvals', 'What the court is asking permission for', () => P.openApprovals({ post, toast })],
  ['summon', 'Summon', 'Who is in the court, and who could be', () => openSummon()],
  ['chronicle', 'Chronicle', 'Everything the court did, searchable', () => P.openChronicle({ onOpenMember: openMember })],
  ['bus', 'Court bus', 'Every message between members', () => openBus()],
  ['metrics', 'Metrics', 'Turns, tokens and spend', () => P.openMetrics()],
  ['diff', 'Changes', 'Review a peasant’s work and merge it', () => pickPeasant()],
  ['vault', 'Vault', 'Search the sovereign’s notes', () => P.openVault()],
  ['summary', 'Summaries', 'The model that condenses each turn', () => openSummarizer()],
  ['advisor', 'Advisor', 'Prompt engineer and model selector', () => openAdvisor()],
  ['image', 'Wallpaper', 'Background image, dim and blur', () => openWallpaper()],
  ['music', 'Music', 'Upload and play', () => openMusic()],
  ['bell', 'Notifications', 'What the court may interrupt you for', () => openNotify()],
  ['who', 'Member card', 'Show or hide who the selected member is', () => I.toggleCollapse()],
  ['pet', 'Court dog', 'Show or hide HappyDog',
    () => toast(PET.toggle() ? 'HappyDog is back.' : 'HappyDog has gone for a walk.')],
  ['gather', 'Gather panels', 'Bring every open panel back into view', () => W.gather()],
  ['zoom', 'Reset zoom', 'Back to 1:1', () => C.resetZoom()],
  ['power', 'End the court', 'Stops every member. The court survives this window closing.',
    () => confirmToolbar('end', 'End the court?', () => { toast('Ending the court…'); post('shutdown'); })],
];

/**
 * Which of them stay out on the bar.
 *
 * Fourteen unlabelled hairline icons in a row is not a toolbar, it is a memory
 * test: you cannot tell "vault" from "metrics" from "chronicle" at 16px with no
 * text, and three passes of spacing did nothing about that. These six are the
 * ones opened during a working session; everything else is configuration you
 * touch once, so it moves behind one button that shows its actual name.
 * Nothing is lost — every tool keeps its Alt key and its label in the menu.
 */
const PRIMARY = new Set(['goal', 'approve', 'summon', 'chronicle', 'bus', 'metrics', 'diff']);

/**
 * The goal, in the header, always.
 *
 * A standing goal you have to open a panel to see is one you stop checking
 * against — which is the failure it exists to prevent. The bar shows the text
 * and how many milestones are left; clicking it opens the panel.
 */
function paintGoal() {
  const bar = $('#goalbar');
  if (!bar) return;
  bar.textContent = '';
  bar.hidden = false;
  // Hiding this when there is no goal hid it exactly when it had something to
  // say. An empty objective is a state worth showing — it is the difference
  // between "the court is working towards nothing" and "I forgot to look".
  if (!GOAL) {
    bar.classList.add('unset');
    bar.append(icon('goal', 13), Object.assign(
      document.createElement('span'), { className: 'gtext', textContent: 'Set a standing goal' }));
    bar.title = 'The court has no standing goal. Click to set what it is working towards.';
    bar.onclick = () => P.openGoal({ post, toast, goal: () => GOAL });
    return;
  }
  bar.classList.remove('unset');

  const open = (GOAL.milestones ?? []).filter((m) => !m.done).length;
  const total = (GOAL.milestones ?? []).length;
  const t = document.createElement('span');
  t.className = 'gtext';
  t.textContent = GOAL.text;
  bar.append(icon('goal', 13), t);
  if (total) {
    const c = document.createElement('span');
    c.className = `gcount num${open ? '' : ' done'}`;
    c.textContent = open ? `${total - open}/${total}` : 'complete';
    bar.append(c);
  }
  bar.title = `${GOAL.text}\n\n${(GOAL.milestones ?? [])
    .map((m) => `[${m.done ? 'x' : ' '}] ${m.text}`).join('\n') || 'No milestones.'}`;
  bar.onclick = () => P.openGoal({ post, toast, goal: () => GOAL });
  paintFirstRun();      // a goal means the court has a purpose; stand down
}

/**
 * One key per tool.
 *
 * Removing the palette took the keyboard with it, which was a regression: the
 * palette was slow to *find* things in but fast to *reach*. The toolbar is the
 * opposite, so it gets keys too — and the key is shown in the tooltip, because
 * a shortcut nobody is told about does not exist.
 *
 * Alt-modified on purpose. Bare letters would fire while typing a message to
 * the king, and the footer input is where the sovereign spends most of their
 * time.
 */
const KEYS = {
  goal: 'g', approve: 'a', bus: 'b', chronicle: 'c', metrics: 'm', diff: 'd', vault: 'v',
  summon: 'e',
  summary: 's', advisor: 'i', image: 'w', music: 'u', bell: 'n', who: 'p',
  pet: 'k', gather: 'j', zoom: '0',
};

const LAST_PRIMARY = TOOLS.filter(([ico]) => PRIMARY.has(ico)).at(-1)?.[0];

function buildTools() {
  const nav = $('#tools');
  const menu = $('#menu');
  nav.textContent = '';
  menu.textContent = '';

  const tip = (label, hint, ico) => {
    const key = KEYS[ico];
    return `${label} — ${hint}${key ? `  (Alt+${key.toUpperCase()})` : ''}`;
  };

  for (const [ico, label, hint, run] of TOOLS) {
    // In Electron the dog is a separate always-on-top window with its own
    // dismiss; a toggle here would claim to control something that is not in
    // this window at all.
    if (ico === 'pet' && ELECTRON) continue;
    if (ico === 'power' || PRIMARY.has(ico)) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.tool = ico;
      setIcon(b, ico, label);
      b.title = tip(label, hint, ico);
      b.onclick = run;
      nav.append(b);
      // The overflow button sits between the working tools and the
      // destructive one, so "end the court" stays last and alone.
      //
      // Anchored to whichever primary happens to be last, not to a name. This
      // read `ico === 'diff'`, so adding a primary after diff put the overflow
      // button in the middle of the working tools and left the new one stranded
      // on the far side of it.
      if (ico === LAST_PRIMARY) nav.append(moreButton());
      continue;
    }
    const row = document.createElement('button');
    row.dataset.tool = ico;
    row.append(icon(ico), document.createTextNode(label));
    row.title = hint;
    if (KEYS[ico]) {
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = `Alt+${KEYS[ico].toUpperCase()}`;
      row.append(k);
    }
    row.onclick = () => { closeMenu(); run(); };
    menu.append(row);
  }
}

const closeMenu = () => {
  $('#menu').hidden = true;
  $('.tool.more')?.classList.remove('on');
};

function moreButton() {
  const b = document.createElement('button');
  b.className = 'tool more';
  b.dataset.tool = 'more';
  setIcon(b, 'more', 'More');
  b.title = 'Everything else — settings, notes, wallpaper, music';
  b.onclick = (e) => {
    e.stopPropagation();
    const menu = $('#menu');
    menu.hidden = !menu.hidden;
    b.classList.toggle('on', !menu.hidden);
  };
  // Any click elsewhere dismisses it. A menu you have to hit the same button
  // twice to close is the one everyone leaves open by accident.
  window.addEventListener('pointerdown', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu, .tool.more')) closeMenu();
  });
  return b;
}

function initKeys() {
  const byKey = new Map();
  for (const [ico, , , run] of TOOLS) if (KEYS[ico]) byKey.set(KEYS[ico], run);

  window.addEventListener('keydown', (e) => {
    // Escape always closes the frontmost panel, even from inside a field —
    // it is the one key that must never be swallowed.
    if (e.key === 'Escape') {
      if (!$('#menu').hidden) return closeMenu();
      const open = [...W.openIds()];
      if (open.length) { W.close(open[open.length - 1]); G.setOpen(W.openIds()); }
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    // Layout is a mode, not a panel, so it is not in TOOLS — but it is the one
    // thing you flip most often, so it gets a key anyway.
    if (e.key.toLowerCase() === 'l') {
      e.preventDefault();
      return setMode(localStorage.getItem('kd.mode') === 'flow' ? 'board' : 'flow');
    }
    const run = byKey.get(e.key.toLowerCase());
    if (!run) return;
    e.preventDefault();
    run();
  });

  // The one bare key worth taking: "/" focuses the command bar, as it does in
  // every tool the sovereign already uses. Not while they are typing.
  window.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.activeElement?.matches('input, textarea, select')) return;
    e.preventDefault();
    $('#cmd').focus();
  });
}

/** Irreversible things ask once, on the button itself. */
let arming = null;
function confirmToolbar(key, question, fn) {
  const btn = $('.tool[data-tool="power"]');
  if (arming === key) { arming = null; btn?.classList.remove('arm'); return fn(); }
  arming = key;
  btn?.classList.add('arm');
  toast(`${question} Click again to confirm.`);
  // Disarm on its own, so a stray second click minutes later does not end the
  // court because of something you clicked before lunch.
  setTimeout(() => { if (arming === key) { arming = null; btn?.classList.remove('arm'); } }, 6000);
}

/** Which peasant's changes? A one-shot list rather than a permanent panel. */
function pickPeasant() {
  const peasants = [...members].filter(([, m]) => m.role === 'peasant').map(([n]) => n);
  if (!peasants.length) return toast('No peasants in the court.', true);
  W.toggle('pick-diff', {
    title: 'Review changes',
    build(el) {
      const box = document.createElement('div');
      box.className = 'log settings';
      for (const n of peasants) {
        const row = document.createElement('button');
        row.className = 'note-row';
        const p = document.createElement('span');
        p.className = 'p';
        p.textContent = n;
        row.append(p);
        row.onclick = () => { W.close('pick-diff'); P.openDiff(n, { post, toast }); };
        box.append(row);
      }
      el.append(box);
    },
  });
}

/**
 * Type `/` and the court's skills appear. Pick one and it goes in front of
 * whatever you were about to say.
 *
 * Only ever fires when `/` is the FIRST character: the sovereign types paths,
 * flags and dates constantly, and a menu that ambushed those would be worse
 * than no menu. Filtering is substring, not prefix, so `/a11y` finds
 * `design:a11y` without knowing which pack it lives in.
 *
 * The menu holds names and one-line triggers, which is all the daemon sends.
 * The steps stay on disk until a member asks for them — putting a skill body
 * in a message would paste it into that member's context forever.
 */
function attachSkills(input) {
  const menu = document.createElement('div');
  menu.className = 'skillmenu';
  menu.hidden = true;
  input.parentElement.style.position ||= 'relative';
  input.parentElement.append(menu);
  let items = [];
  let at = 0;

  const close = () => { menu.hidden = true; items = []; };
  const paint = () => {
    const q = input.value.slice(1).toLowerCase().split(/\s/)[0];
    // A `/word ` that already has arguments after it has been chosen — the
    // sovereign is writing the brief now, not still picking.
    if (!input.value.startsWith('/') || /^\/\S+\s/.test(input.value)) return close();
    // Combos first, then standalone skills, then the packs — same order the
    // court sees in its prompt. Alphabetical put `code:api-design` at the top
    // of a fresh `/`, which buries the six combos that answer a whole task.
    const rank = (s) => (s.combo?.length ? 0 : s.name.includes(':') ? 2 : 1);
    // Settings commands ride the same menu. They are not skills — nothing is
    // sent to the court — but a command nobody can find is half-built, and `/`
    // is where the sovereign already looks.
    items = [...LOCAL_COMMANDS, ...SKILLS].filter((s) => !q || s.name.toLowerCase().includes(q)
      || (s.description ?? '').toLowerCase().includes(q))
      .sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
    if (!items.length) return close();
    at = Math.min(at, items.length - 1);
    menu.innerHTML = '';
    items.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = `srow${i === at ? ' on' : ''}`;
      row.innerHTML = `<b></b><i></i><em></em>`;
      row.querySelector('b').textContent = `/${s.name}`;
      row.querySelector('i').textContent = s.description ?? '';
      if (s.combo?.length) row.querySelector('em').textContent = `${s.combo.length} steps`;
      // mousedown, not click: the input blurs before a click lands and the
      // menu would close out from under the pointer.
      row.onmousedown = (e) => { e.preventDefault(); choose(i); };
      menu.append(row);
    });
    menu.hidden = false;
    menu.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => {
    if (!items[i]) return;
    input.value = `/${items[i].name} `;
    close();
    input.focus();
  };

  input.addEventListener('input', () => { at = 0; paint(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      return paint();
    }
    // Enter and Tab both commit, and both must stop here — Enter would
    // otherwise send `/desi` as an order to the king.
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return choose(at); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);   // capture: the send handler is on the same element
}

const cmd = $('#cmd');
const CMD_PLACEHOLDER = cmd.placeholder;
attachMic($('#cmd-mic'), cmd);
attachSkills(cmd);
cmd.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const text = cmd.value.trim();
  if (!text) return;
  cmd.value = '';
  post('command', { text });
});

// buildTools() lives HERE, not in the boot block above: TOOLS is a const, so
// calling it earlier hits the temporal dead zone. Function declarations hoist;
// the array they read does not.
buildTools();
initKeys();

// The header's cost readout is painted by the `spend` event, which does not
// arrive until the first turn ends — so a court you have just opened showed an
// empty slot where a number belongs, which reads as broken rather than as zero.
$('#spend').textContent = '0 turns';

/**
 * Open the king on a first run.
 *
 * An empty canvas is the worst first impression this app can make: a wallpaper
 * and nothing else, with no hint that the rail on the left is how you get in.
 * Only on a FIRST run — once the sovereign has arranged their own workspace,
 * reopening a panel they closed would be the app arguing with them.
 */
if (!localStorage.getItem('kd.seen')) {
  localStorage.setItem('kd.seen', '1');
  setTimeout(() => openMember('king'), 400);
}
badge();
connect();
syncApprovals();
setInterval(syncApprovals, 2500);
