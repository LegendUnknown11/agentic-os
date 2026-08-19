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
import { statusDot } from './avatar.js';
import * as PET from './pet.js';
// The rail-vs-roster rule, apart from the DOM so `npm test` can check it.
import { inCourt } from './court.js';
import { cue, soundOn, setSound } from './feel.js';
import { displayName, agentCount } from './names.js';
import * as O from './overview.js';
import { mdToHtml } from './markdown.js';
// Served straight from src/ by the daemon — the SAME table the orchestrator
// enforces, so the switcher can never offer a shape the court does not have.
import { MODES, MODE_NAMES, modeOf, canSummon } from '/modes.js';

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
let MODELS = { claude: ['opus', 'sonnet', 'haiku', 'fable'], codex: [], agy: [], opencode: [] };
let EFFORTS = { claude: ['low', 'medium', 'high'], codex: ['low', 'medium', 'high', 'xhigh', 'max'], agy: ['low', 'medium', 'high'], opencode: ['low', 'medium', 'high'] };
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
// What the court is doing. `PENDING` is a mode chosen but not yet in force
// because somebody is mid-turn — shown, not hidden, or pressing the button
// looks like it did nothing.
let MODE = 'code';
let PENDING = null;
let SUMMARIZER = { enabled: true, cli: 'codex', model: 'gpt-5.4-mini', effort: 'none', maxWords: 16, style: '' };

const post = (action, body = {}) =>
  fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));

/**
 * `action` turns a toast into the only place something can be taken back.
 *
 * Used by the automatic mode switch, which happens without asking: the court
 * changing shape under you is fine as long as putting it back is one click and
 * you can see the click. The timer is longer with an action for the obvious
 * reason — six seconds is enough to read a sentence and not enough to decide.
 */
function toast(text, bad = false, action = null) {
  const d = document.createElement('div');
  if (bad) d.className = 'bad';
  d.append(text);
  if (action) {
    const b = document.createElement('button');
    b.className = 'undo';
    b.textContent = action.label;
    b.onclick = () => { d.remove(); action.run(); };
    d.append(b);
  }
  $('#toast').append(d);
  setTimeout(() => d.remove(), action ? 12000 : 6000);
}
onNotice(toast);

/* ---------- transcripts ---------- */
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

// Only what a model actually WROTE gets markdown — a status line like
// "— switching to codex —" or a tool-call summary is the app's own voice,
// plain by design, and running it through the same renderer would let a
// literal "*" in a file path turn into stray emphasis.
const MD_CLASSES = new Set(['t-text', 't-sum']);
const setBody = (d, cls, text) => {
  if (MD_CLASSES.has(cls)) d.innerHTML = mdToHtml(text);
  else d.textContent = text;
};

// A vault: link (see markdown.js) is a citation, not a real href — it never
// gets an <a target> of its own. One delegated listener catches every one of
// them, in every transcript, present or future, rather than an onclick wired
// per rendered link.
document.addEventListener('click', (e) => {
  const a = e.target.closest('.vault-link');
  if (!a) return;
  e.preventDefault();
  const [rawPath] = (a.dataset.vault || '').split('#');
  let path; try { path = decodeURIComponent(rawPath); } catch { path = rawPath; }
  if (path) P.openVault(path);
});

function render(el, entry) {
  const d = document.createElement('div');
  d.className = entry.cls;
  if (entry.text.length > 700) {
    setBody(d, entry.cls, entry.text.slice(0, 700));
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = ` …+${entry.text.length - 700}`;
    more.onclick = () => setBody(d, entry.cls, entry.text);
    d.append(more);
  } else setBody(d, entry.cls, entry.text);

  // Group everything between two turn_end boundaries into one card, so the
  // transcript reads as a sequence of turns instead of one seamless stream.
  // `_openCard` lives on the log element itself so live append() and the
  // full-buffer replay on panel reopen (below) use the exact same logic.
  let card = el._openCard;
  if (!card) {
    card = document.createElement('div');
    card.className = 'turn';
    el.append(card);
    el._openCard = card;
  }
  card.append(d);
  if (entry.cls === 't-end') el._openCard = null;
  return d;
}

/** Undo one render() — the counterpart LOG_CAP trimming needs. */
function unrender(el) {
  const card = el.firstElementChild;
  card?.firstElementChild?.remove();
  if (card && !card.childElementCount) {
    card.remove();
    if (el._openCard === card) el._openCard = null;
  }
}

function append(name, cls, text) {
  // LOG_CAP bounds the number of ENTRIES, not their size, and a member that
  // cats a file puts the whole file in one of them — 400 of those is a
  // transcript buffer measured in megabytes, per member, held for the life of
  // the page whether the panel is open or not. Nothing on screen shows more
  // than this anyway.
  if (text.length > 4000) text = `${text.slice(0, 4000)}\n… (${text.length - 4000} more characters)`;
  G.upsertNode(name, members.get(name)?.role);
  const buf = log.get(name) ?? (log.set(name, []), log.get(name));
  const prev = buf[buf.length - 1];

  // Tool calls are the bulk of the noise. Collapse a run into one counted line.
  if (cls === 't-tool' && prev?.cls === 't-tool') {
    prev.n = (prev.n ?? 1) + 1;
    prev.text = `→ ${prev.first} +${prev.n - 1} more`;
    const el = body(name);
    if (el) el._openCard.lastElementChild.textContent = prev.text;
    return;
  }

  const entry = { cls, text, first: text.replace(/^→ /, '') };
  buf.push(entry);
  const overflowed = buf.length > LOG_CAP;
  if (overflowed) buf.shift();

  const el = body(name);
  if (el) {
    const stick = atBottom(el);
    render(el, entry);
    if (overflowed) unrender(el);
    if (stick) el.scrollTop = el.scrollHeight;
  }
}

const body = (name) => W.getWindow(`m:${name}`)?.querySelector('.log');

/* ---------- member windows ---------- */
function openMember(name) {
  I.select(name);
  const m = members.get(name) ?? {};
  // The id stays keyed on the real name — it is how the bus, the log map and
  // every post() find this member. Only what is printed changes.
  const shown = displayName(name, m.role);
  W.toggle(`m:${name}`, {
    title: shown,
    cls: `member role-${m.role ?? 'peasant'} ${m.awake ? '' : 'asleep'}`,
    build(el) {
      const bar = el.querySelector('.slot');
      // Whether this member is actually running, on its own title bar. The
      // panel's `.asleep` class is what paints it (.win:not(.asleep)>.bar .av i).
      el.querySelector('.bar').prepend(statusDot(name, m.role));

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
      sel.title = 'CLI and model for this agent';
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
      const modelChip = pillChip(sel, 'command', 'Model');
      const effortChip = pillChip(eff, 'target', 'Effort');
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
      logEl.dataset.who = shown;
      const form = document.createElement('form');
      form.innerHTML = `<div class="row1">
          <input placeholder="Message ${shown}…" autocomplete="off">
          <button type="button" class="mic"></button>
          <button type="submit" class="send"></button>
        </div>
        <div class="chips"></div>`;
      el.append(logEl, form);

      // Chips: model, effort, and the summaries toggle — everything that
      // shapes the next turn, in one row you can read without opening a menu.
      const chips = form.querySelector('.chips');
      const sep = () => { const s = document.createElement('span'); s.className = 'sep'; return s; };
      chips.append(modelChip, effortChip, sep(), quiet);

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

/** A <select> alone reads as a form control; wrapped with a leading icon in a
 * rounded pill it reads as what it is — a property of the next turn you can
 * tap to change, the same shape the model and effort pickers use in the
 * reference this panel is styled after. */
function pillChip(selectEl, iconName, label) {
  const chip = document.createElement('label');
  chip.className = 'chip';
  chip.append(icon(iconName), selectEl);
  chip.title = label;
  return chip;
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
    else toast(`Unknown CLI "${cli.trim()}". Use claude:, codex:, agy: or opencode:<model>.`, true);
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
  // A row can exist for a name the roster no longer mentions at all — not
  // "dismissed", just gone (a rename, a deleted role). The loop below only
  // ever visits names IN `roster`, so a role that vanished from config never
  // reaches the `!inCourt` branch that would remove its row. Left alone, the
  // next replayed historical message bearing that name (upsertNode auto-
  // creates on any rail call) resurrects it as a permanent ghost — this is
  // what left "king"/"jester" rows on the rail after the roster renamed them
  // to "orchestrator"/"briefer". Prune first, so the loop below only ever
  // adds back what the roster actually still says exists.
  const known = new Set(roster.map((r) => r.name));
  for (const name of G.names()) {
    if (known.has(name)) continue;
    G.remove(name);
    members.delete(name);
    I.refresh(name);
  }
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
    G.admit(r.name, r.role);   // the roster is the only thing that may create a row
    G.setState(r.name, r.awake ? 'awake' : 'asleep');
    G.setServing(r.name, r.summoned);
    // Sleeping clears a stuck "limited"/"failed" — that state died with the process.
    // "resting" rather than "asleep" for a summoned member: it is in the crew
    // and wakes on its next message, which is a different thing entirely.
    if (!r.awake) {
      clearSticky(r.name);
      setStatus(r.name, r.summoned ? 'resting' : 'not added');
    }
    else if (!statusOf.has(r.name)) setStatus(r.name, 'idle');
    tip(r.name);
    syncControls(r.name);
    I.refresh(r.name);
  }
  paintCourtCount();
  O.paintOverview();
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
  n.title = `${agentCount(here)} on the team, ${total - here} more available to add`;
}

const openSummon = () => P.openSummon({
  post,
  toast,
  // The bench belongs to the mode. Offering a role the approval will refuse is
  // worse than not offering it: the card gets raised, the sovereign says yes,
  // and the court rejects its own summons for a reason nobody was shown.
  // Anyone already ON the team stays listed whatever the mode — hiding a live
  // member from the panel that names the team would be the bigger lie.
  roster: () => new Map(
    [...members].filter(([n, m]) => m.summoned || canSummon(MODE, n, m.role))),
});
$('#summon-btn').onclick = openSummon;

/* the Overview is wired further down, once statusOf and summaries exist */

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
    title: 'Messages',
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
const TITLES = { summon: 'SUMMON', role: 'NEW ROLE', merge: 'MERGE', question: 'QUESTION' };

function renderApproval(a) {
  if (document.getElementById(`ap-${a.id}`)) return;
  if (a.kind === 'question') return renderQuestion(a);
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
      toast(r.error ?? 'That decision could not be recorded.', true);
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

/**
 * The interview-style card for ask_question: one block per question, options
 * as pill buttons (radio behavior, or checkbox behavior under multiSelect),
 * plus an always-present "Other" free-text fallback — same shape as Claude's
 * own AskUserQuestion. Selection state lives in `picked` (one Set per
 * question), not the DOM, mirroring pillChip's approach elsewhere in this file.
 */
function renderQuestion(a) {
  const el = document.createElement('details');
  el.className = 'approval question';
  el.id = `ap-${a.id}`;
  el.open = true;
  el.dataset.id = String(a.id);
  el.innerHTML = `<summary><span></span><span class="who"></span></summary>
    <div class="qlist"></div><div class="btns"><button class="go submit">Submit</button></div>`;
  el.querySelector('summary span').textContent = `${TITLES.question} #${a.id}`;
  el.querySelector('summary .who').textContent = a.from ? `from ${a.from}` : '';

  const qlist = el.querySelector('.qlist');
  const picked = a.questions.map(() => new Set());
  a.questions.forEach((q, i) => {
    const block = document.createElement('div');
    block.className = 'q';
    const head = document.createElement('span');
    head.className = 'qhead';
    head.textContent = q.header;
    const text = document.createElement('div');
    text.className = 'qtext';
    text.textContent = q.question;
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const o of q.options ?? []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt';
      const b = document.createElement('b');
      b.textContent = o.label;
      btn.append(b);
      if (o.description) {
        const small = document.createElement('small');
        small.textContent = o.description;
        btn.append(small);
      }
      btn.onclick = () => {
        if (picked[i].has(o.label)) {
          picked[i].delete(o.label);
          btn.classList.remove('picked');
        } else {
          if (!q.multiSelect) {
            picked[i].clear();
            opts.querySelectorAll('.opt').forEach((x) => x.classList.remove('picked'));
          }
          picked[i].add(o.label);
          btn.classList.add('picked');
        }
      };
      opts.append(btn);
    }
    const other = document.createElement('input');
    other.className = 'other';
    other.placeholder = 'Other…';
    block.append(head, text, opts, other);
    qlist.append(block);
  });

  const submit = el.querySelector('.submit');
  submit.onclick = async () => {
    const answers = a.questions.map((q, i) => {
      const chosen = [...picked[i]];
      const other = qlist.children[i].querySelector('.other').value.trim();
      return other ? [...chosen, other] : chosen;
    });
    if (answers.some((ans) => !ans.length)) {
      toast('Answer every question before submitting.', true);
      return;
    }
    submit.disabled = true;
    const r = await post('answerQuestion', { id: a.id, answers });
    if (!r.ok) {
      submit.disabled = false;
      toast(r.error ?? 'That answer could not be recorded.', true);
      return;
    }
    el.remove();
    badge();
    syncApprovals();
  };

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
    : 'Approvals — what the team is asking permission for';
}

/* ---------- stream ---------- */
const statusOf = new Map();

/** One word under the node. A blocked member is not relabelled by a stray tool. */
function setStatus(name, word) {
  if (STICKY.has(statusOf.get(name)) && !STICKY.has(word)) return;
  statusOf.set(name, word);
  G.setStatus(name, word, toneOf(word));
  I.refresh(name);
  // A working member's panel says so on its own top edge. The status word
  // already names WHAT it is doing; this answers "is anything happening" from
  // across the room, without reading — which is the question you actually ask
  // of a court of six while doing something else.
  W.getWindow(`m:${name}`)?.classList.toggle('working', isBusy(word));
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
 * "build-engineer" does, and the rail deliberately shows only one word — so
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

/** Render a list where one bad row costs one row, not the rest of the list. */
function each(list, fn) {
  for (const item of list ?? []) {
    try { fn(item); } catch (err) { console.error('dropped a malformed row', err, item); }
  }
}

function connect() {
  const es = new EventSource('/stream');
  es.onopen = () => { $('#conn').className = 'conn up'; $('#conn').title = 'connected'; };
  es.onerror = () => { $('#conn').className = 'conn'; $('#conn').title = 'disconnected'; };
  es.onmessage = (e) => {
    try { onStreamEvent(JSON.parse(e.data)); }
    catch (err) { console.error('dropped a malformed stream event', err, e.data); }
  };

  function paintRepo(repo, base) {
    $('#repo').textContent = repo ? `${repo.split(/[\\/]/).pop()}${base ? ' · ' + base : ''}` : 'no repository';
    $('#repo').title = repo ?? '';
  }

  function onStreamEvent(d) {
    N.onEvent(d);   // desktop alerts for the few things that stall the court
    switch (d.type) {
      case 'snapshot':
        paintRepo(d.repo, d.base);
        if (d.models) MODELS = d.models;
        if (d.efforts) EFFORTS = d.efforts;
        if (d.advisor) ADVISOR = d.advisor;
        if (d.domains) DOMAINS = d.domains;
        if (d.skills) SKILLS = d.skills;
        if (d.summarizer) SUMMARIZER = d.summarizer;
        if (d.goal !== undefined) { GOAL = d.goal; paintGoal(); }
        if (d.mode) { MODE = d.mode; PENDING = null; paintMode(); }
        applyRoster(d.roster);
        // An empty card on load teaches nothing. Start on the orchestrator: it is the
        // one member the sovereign always has.
        if (!I.selected()) I.select(d.roster.find((r) => r.role === 'orchestrator')?.name ?? d.roster[0]?.name);
        // Per ITEM, not per snapshot. The snapshot is roster → ~400 events →
        // ~200 messages → approvals in one handler, so a single malformed row
        // threw and everything after it never rendered — no transcript, no
        // messages, no approvals, and no error on screen to say why. A reload
        // replays the same bad row, so it stayed broken. daemon.js:230 already
        // learned this for /api/approvals; the SSE snapshot never did.
        each(d.events, (ev) => renderEvent({ name: ev.agent, kind: ev.type, payload: ev.payload }, false));
        each(d.messages, renderMessage);
        each(d.approvals, renderApproval);
        // The replay above just called upsertNode for every name any historical
        // event or message ever mentioned — including names the roster stopped
        // carrying before this page even loaded. The first applyRoster ran on
        // an empty rail, so it had nothing to prune; run it again now that
        // replay has (re)created whatever it was going to create.
        applyRoster(d.roster);
        break;
      // Fires once, when a repo is attached live from the picker — the header
      // label must not wait for a reload to say what Code mode is now pointed at.
      case 'repo':
        paintRepo(d.repo, d.base);
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
          append('orchestrator', 't-error',
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
          setStatus('orchestrator', 'briefing');
        } else {
          $('#cmd').classList.remove('advising');
          $('#cmd').placeholder = CMD_PLACEHOLDER;
          clearSticky('orchestrator');
          if (d.rewritten && d.rewritten !== d.text) {
            append('orchestrator', 't-sys', `— brief rewritten by the advisor —\nyou said: ${d.text}`);
          }
          if (d.models?.length) {
            append('orchestrator', 't-sys', `— advisor set models: ${d.models.join(', ')} —`);
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
      case 'mode':
        onModeChanged(d);
        break;
      case 'milestone':
        toast(`Milestone reached: ${d.text}`);
        PET.play('cheer');
        append('orchestrator', 't-sys', `— milestone reached: ${d.text}
${d.evidence ?? ''} —`);
        break;
      case 'summarizer':
        SUMMARIZER = d;
        W.getWindow('settings')?.dispatchEvent(new Event('kd:summarizer'));
        toast(`Summaries ${d.enabled ? 'on' : 'off'} · ${d.model} · ${d.maxWords} words`);
        break;
      case 'advisor':
        ADVISOR = d;
        W.getWindow('settings')?.dispatchEvent(new Event('kd:advisor'));
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
      case 'error': append('orchestrator', 't-error', d.message); toast(d.message, true); break;
    }
  }
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
 * out of their chosen layout to change a word they never see. The FUNCTION and
 * the element are `layout`, because "mode" now means what the court is doing —
 * renaming a label is not renaming a state.
 */
function setLayout(m) {
  const board = m === 'board';
  localStorage.setItem('kd.mode', m);
  $('#stage').classList.toggle('board', board);
  document.body.classList.toggle('board', board);   // gather/zoom are flow-only
  W.setTiled(board);
  for (const b of $('#layout').children) b.classList.toggle('on', b.dataset.layout === m);
}

function buildLayouts() {
  const nav = $('#layout');
  // Named for what they do. These were "Hall" and "Grounds", which named the
  // place rather than the mechanism and left you guessing which one tiled —
  // the two words a sovereign has to distinguish under time pressure are
  // "arranged for me" and "arranged by me".
  for (const [m, label, hint] of [
    ['board', 'Grid', 'Every open panel assembled in a grid'],
    ['flow', 'Canvas', 'Place panels yourself on a canvas you can pan and zoom'],
  ]) {
    const b = document.createElement('button');
    b.dataset.layout = m;
    b.textContent = label;
    b.title = `${label} — ${hint}  (Alt+L)`;
    b.onclick = () => setLayout(m);
    nav.append(b);
  }
  setLayout(localStorage.getItem('kd.mode') ?? 'board');
}
buildLayouts();

/* ---------- what the court is doing ----------
 * Four shapes, not four flags: the mode decides whether there is a crew, what
 * gets a worktree, whether anything may ever merge, and where the deliverable
 * lands. The table is src/modes.js, served to this page so there is exactly one
 * of it.
 *
 * NOT gold. --crown is the sovereign's alone, and this is the court's state,
 * not theirs.
 */
function paintMode() {
  for (const b of $('#court').children) {
    b.classList.toggle('on', b.dataset.mode === MODE);
    b.classList.toggle('pending', b.dataset.mode === PENDING);
  }
  // Everything downstream reads MODE, so it all repaints from here.
  document.body.dataset.mode = MODE;
  // The rail's own CTA, which is not in TOOLS and would otherwise be the one
  // way left to open a panel that this mode has nobody to fill.
  $('#summon-btn').hidden = !inMode('summon');
  buildTools();
  O.paintOverview();
}

function buildCourtModes() {
  const nav = $('#court');
  for (const m of MODE_NAMES) {
    const b = document.createElement('button');
    b.dataset.mode = m;
    b.textContent = MODES[m].label;
    b.title = `${MODES[m].label} — ${MODES[m].blurb}`;
    b.onclick = async () => {
      const r = await post('mode', { mode: m });
      if (!r.ok) {
        toast(r.error ?? 'Could not switch mode.', true,
          /repository/i.test(r.error ?? '') ? { label: 'Choose repo…', run: openRepoPicker } : null);
      }
    };
    nav.append(b);
  }
  paintMode();
}

/**
 * Code mode has nothing to edit without a repo — asked for here, live, rather
 * than blocking the whole app behind a picker before it can even open (see
 * electron/main.js). Electron gets a native folder dialog; the plain-browser
 * path (no window.kingdomShell — daemon.js served straight to a tab, README's
 * headless mode) falls back to a path typed into a small panel.
 */
async function openRepoPicker() {
  if (window.kingdomShell?.chooseRepo) {
    const r = await window.kingdomShell.chooseRepo();
    if (r.canceled) return;
    if (r.error) return toast(r.error, true);
    return attachRepo(r.path);
  }
  openSettings('repo');
}

async function attachRepo(path) {
  const r = await post('attachRepo', { path });
  if (!r.ok) return toast(r.error ?? 'Could not attach that repository.', true);
  W.close('settings');
  toast('Repository attached — switching to Code mode.');
  post('mode', { mode: 'code' });
}

function buildRepoSection(el) {
  const body = document.createElement('div');
  body.className = 'log settings';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Path to a git repository…';
  const go = document.createElement('button');
  go.textContent = 'Attach';
  go.onclick = () => { if (input.value.trim()) attachRepo(input.value.trim()); };
  input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
  body.append(input, go);
  el.append(body);
}
// Called from the boot block at the bottom, NOT here: paintMode() repaints the
// toolbar and the overview, and both `TOOLS` and the overview's wiring are
// declared further down. Reading a const before its declaration is a
// temporal-dead-zone ReferenceError that takes the whole module with it.

/**
 * The advisor switched the court. Say so, and offer it back.
 *
 * The sovereign chose "never asks" over "asks first", which is only a fair
 * trade if the undo is right there and costs nothing. It restores the MODE and
 * nothing else: the message that triggered the switch has already gone to the
 * orchestrator, and a button that implied a turn could be recalled would be a lie.
 */
function onModeChanged(d) {
  MODE = d.mode;
  PENDING = d.pending ?? null;
  paintMode();
  if (d.by !== 'advisor') return;

  if (PENDING) {
    return toast(`${modeOf(PENDING).label} mode next — waiting for the current turn to finish.`);
  }
  if (!d.previous || d.previous === d.mode) return;
  // Short on purpose: the toast has to fit beside its own button in a stage
  // that may be a third of the window wide. What the mode MEANS is on the
  // switcher's tooltip; what this has to say is that it moved, and how to
  // move it back.
  toast(`Switched to ${modeOf(d.mode).label} mode.`, false, {
    label: `Back to ${modeOf(d.previous).label}`,
    run: () => post('mode', { mode: d.previous }),
  });
}

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
  onDiff(name) { P.openDiff(name, { post, toast }); },
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

/* ---------- the overview ----------
 * The floor of the room.
 *
 * This replaces `paintFirstRun`, a three-step tour that hid itself the moment a
 * goal was set — so on a real boot with an objective and nobody added, the stage
 * rendered zero panels and zero guidance. The default state of the application
 * was an empty room. The three steps survive as its empty state; everything
 * else it says is live.
 *
 * Wired HERE and not beside applyRoster, which is where it is painted from:
 * `statusOf` and `summaries` are const and declared below that point, and
 * reading them from the init call is a temporal-dead-zone ReferenceError that
 * takes the whole module with it. */
O.initOverview($('#overview'), {
  members: () => members,
  goal: () => GOAL,
  mode: () => modeOf(MODE),
  statusOf: () => statusOf,
  summaries: () => summaries,
  // Read off the cards on screen rather than a parallel list, for the reason
  // badge() already gives: a counter and a DOM can disagree, and the one the
  // sovereign believes is the one they can see.
  approvals: () => [...$('#approvals').children].map((c) => ({
    kind: c.querySelector('summary span')?.textContent?.split(' #')[0] ?? 'REQUEST',
    who: c.querySelector('summary .who')?.textContent ?? '',
  })),
  openGoal: () => P.openGoal({ post, toast, goal: () => GOAL }),
  openApprovals: () => P.openApprovals({ post, toast }),
  openSummon,
  focusCommand: () => $('#cmd').focus(),
  onOpenMember: openMember,
  onDiff: (name) => P.openDiff(name, { post, toast }),
});

/* ---------- the summariser ---------- */
const saveSummarizer = (patch) => post('summarizer', patch);

function buildSummarySection(pane, panel) {
      const box = document.createElement('div');
      box.className = 'log settings';
      pane.append(box);

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
      panel.addEventListener('kd:summarizer', draw);
}

/* ---------- notifications ---------- */
function buildNotifySection(pane) {
      const box = document.createElement('div');
      box.className = 'log settings';
      pane.append(box);

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
          t.textContent = label;
          const h = document.createElement('em');
          h.textContent = hint;
          t.append(h);
          const i = document.createElement('input');
          i.type = 'checkbox';
          i.checked = s[key];
          i.disabled = s.permission !== 'granted';
          i.onchange = () => N.setPref({ [key]: i.checked });
          d.append(t, i);
          box.append(d);
        };

        row('approvals', 'Waiting on you', 'A request the team cannot proceed without.');
        row('failures', 'Something broke', 'A member failed, a merge was refused, or an account hit its limit.');
        row('budget', 'Spend ceiling', 'An agent or the whole team was stopped for money.');
        row('done', 'Work merged', 'Off by default — this one is good news, and good news can wait.');

        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'Nothing is sent while this window is focused — you are already looking.';
        box.append(note);
      };

      draw();
}

/* ---------- wallpaper ---------- */
function buildWallpaperSection(pane) {
      const box = document.createElement('div');
      box.className = 'log settings';
      pane.append(box);

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
      return () => A.onAssets(() => {});
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
function buildMusicSection(pane) {
      const box = document.createElement('div');
      box.className = 'log settings';
      pane.append(box);

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
      return off;
}

/* ---------- documents ---------- */
// Source material the sovereign feeds the court, distinct from the vault
// (notes the court writes itself). Same upload/list/delete plumbing as
// wallpaper and music — daemon.js's asset store just also accepts pdf, txt,
// md, csv and json now — but no player state, so the panel is the plain
// upload+list+delete shape music uses minus the transport.
function buildDocumentsSection(pane) {
      const box = document.createElement('div');
      box.className = 'log settings';
      pane.append(box);

      const draw = () => {
        box.innerHTML = '';

        const act = document.createElement('div');
        act.className = 'act';
        const up = document.createElement('button');
        up.className = 'primary';
        up.append(icon('upload'), document.createTextNode('Upload document'));
        up.onclick = async () => {
          const files = await A.pick('.pdf,.txt,.md,.csv,.json');
          for (const f of files) {
            const r = await A.upload(f);
            if (!r.ok) toast(`${f.name}: ${r.error ?? 'upload failed'}`, true);
          }
          draw();
        };
        act.append(up);
        box.append(act);

        const docs = A.list().filter((x) => x.kind === 'document');
        if (!docs.length) {
          const e = document.createElement('div');
          e.className = 'empty';
          e.textContent = 'Nothing here yet. Upload a pdf, txt, md, csv or json file for the court to read.';
          box.append(e);
          return;
        }

        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'Any court member can find and read these with list_uploads.';
        box.append(note);

        const ul = document.createElement('div');
        ul.className = 'tracks';
        for (const d of docs) {
          const r = document.createElement('div');
          r.className = 'trk';
          const n = document.createElement('span');
          n.textContent = d.name;
          const kill = document.createElement('button');
          kill.className = 'kill';
          setIcon(kill, 'close', `Delete ${d.name}`);
          kill.onclick = async (e) => { e.stopPropagation(); await A.remove(d.name); draw(); };
          r.append(n, kill);
          ul.append(r);
        }
        box.append(ul);
      };

      draw();
      A.onAssets(draw);
      return () => A.onAssets(() => {});
}

/* ---------- the advisor ---------- */
// One panel for both AI-run features, because they share one model: it would
// be confusing to configure the same thing in two places.
const saveAdvisor = (patch) => post('advisor', patch);

function buildAdvisorSection(pane, panel) {
      const box = document.createElement('div');
      box.className = 'log settings';
      pane.append(box);

      const draw = () => {
        box.innerHTML = '';
        // textContent, not innerHTML. Every other caller passes a literal, but
        // the domain rows below pass `domain` and `names` straight out of
        // kingdom.config — which the court itself has write access to by
        // design. A domain key of `<img src=x onerror=…>` would then run
        // same-origin with every /api action, shutdown and merge included.
        const row = (label, hint, control) => {
          const d = document.createElement('label');
          d.className = 'srow';
          const t = document.createElement('span');
          t.textContent = label;
          const h = document.createElement('em');
          h.textContent = hint;
          t.append(h);
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

        row('Prompt engineer', 'Rewrites what you type before the orchestrator reads it.',
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
          + '(tester, reviewer, researcher…) are in neither and keep their own model.</em>';
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
      panel.addEventListener('kd:advisor', draw);
}

/* ---------- settings (consolidated) ---------- */
// Six panels that were each "configuration you touch once" (Wallpaper, Music,
// Advisor, Summaries, Notifications, Repository) merged into one window with a
// tab strip, reusing the summon panel's category-tab styling rather than
// inventing new CSS for it.
const SETTINGS_SECTIONS = [
  ['repo', 'Repository', buildRepoSection],
  ['summary', 'Summaries', buildSummarySection],
  ['advisor', 'Advisor', buildAdvisorSection],
  ['image', 'Wallpaper', buildWallpaperSection],
  ['music', 'Music', buildMusicSection],
  ['document', 'Documents', buildDocumentsSection],
  ['bell', 'Notifications', buildNotifySection],
];

let settingsTeardown = null;

function openSettings(section) {
  const panel = W.open('settings', {
    title: 'Settings',
    build(el) {
      const nav = document.createElement('div');
      nav.className = 'sum-cat-tabs';
      const pane = document.createElement('div');
      el.append(nav, pane);
      el._settingsPane = pane;
      for (const [key, label] of SETTINGS_SECTIONS) {
        const btn = document.createElement('button');
        btn.className = 'sum-cat-tab';
        btn.textContent = label;
        btn.dataset.key = key;
        btn.onclick = () => openSettings(key);
        nav.append(btn);
      }
    },
    onClose: () => { settingsTeardown?.(); settingsTeardown = null; },
  });
  settingsTeardown?.();
  panel.querySelectorAll('.sum-cat-tab').forEach((b) => b.classList.toggle('on', b.dataset.key === section));
  const pane = panel._settingsPane;
  pane.innerHTML = '';
  const entry = SETTINGS_SECTIONS.find(([key]) => key === section) ?? SETTINGS_SECTIONS[0];
  settingsTeardown = entry[2](pane, panel) ?? null;
}

/* ---------- the toolbar ----------
 * The command palette is gone. Sixteen members made it a list you searched
 * rather than a list you read, and every global action was two keystrokes and
 * a guess away. These are the ten things worth reaching for, always visible,
 * always in the same place. Per-member actions live on the member instead: the
 * rail opens it, its own title bar wakes it and picks its model.
 */
const TOOLS = [
  ['goal', 'Objective', 'What the team is working towards', () => P.openGoal({ post, toast, goal: () => GOAL })],
  ['approve', 'Approvals', 'What the team is asking permission for', () => P.openApprovals({ post, toast })],
  ['summon', 'Add agents', 'Who is on the team, and who could be', () => openSummon()],
  ['chronicle', 'Activity', 'Everything the team did, searchable', () => P.openChronicle({ onOpenMember: openMember })],
  ['bus', 'Messages', 'Every message between agents', () => openBus()],
  ['metrics', 'Usage', 'Turns, tokens and spend', () => P.openMetrics()],
  ['diff', 'Changes', 'Review an agent’s work and merge it', () => pickPeasant()],
  ['vault', 'Notes', 'Search your notes', () => P.openVault()],
  ['recall', 'Memory', 'Search everything the court remembers — history and notes together', () => P.openRecall()],
  ['workflows', 'Automations', 'The court’s n8n-style automations', () => P.openWorkflows({ post, toast })],
  ['summary', 'Summaries', 'The model that condenses each turn', () => openSettings('summary')],
  ['advisor', 'Advisor', 'Prompt engineer and model selector', () => openSettings('advisor')],
  ['image', 'Wallpaper', 'Background image, dim and blur', () => openSettings('image')],
  ['music', 'Music', 'Upload and play', () => openSettings('music')],
  ['document', 'Documents', 'Upload something for the court to read', () => openSettings('document')],
  ['bell', 'Notifications', 'What the team may interrupt you for', () => openSettings('bell')],
  ['who', 'Details panel', 'Show or hide who the selected agent is', () => I.toggleCollapse()],
  ['pet', 'Desk pet', 'Show or hide HappyDog',
    () => toast(PET.toggle() ? 'HappyDog is back.' : 'HappyDog has gone for a walk.')],
  ['sound', 'Sounds', 'The short cues when an agent joins and when you decide', () => {
    setSound(!soundOn());
    // The confirmation IS the cue when turning it on: you hear what you just
    // agreed to. Turning it off can only be confirmed in words.
    if (soundOn()) cue('summon');
    toast(soundOn() ? 'Sounds are on.' : 'Sounds are off.');
    buildTools();                    // repaint so the menu row shows the state
  }],
  ['gather', 'Gather panels', 'Bring every open panel back into view', () => W.gather()],
  ['zoom', 'Reset zoom', 'Back to 1:1', () => C.resetZoom()],
  ['power', 'Stop everything', 'Stops every agent. The team survives this window closing.',
    () => confirmToolbar('end', 'Stop everything?', () => { toast('Stopping…'); post('shutdown'); })],
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
      document.createElement('span'), { className: 'gtext', textContent: 'Set an objective' }));
    bar.title = 'No objective set. Click to say what the team is working towards.';
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
  O.paintOverview();    // the objective block leads the overview; keep it true
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
 * the orchestrator, and the footer input is where the sovereign spends most of their
 * time.
 */
const KEYS = {
  goal: 'g', approve: 'a', bus: 'b', chronicle: 'c', metrics: 'm', diff: 'd', vault: 'v',
  summon: 'e', recall: 'r', workflows: 'f',
  summary: 's', advisor: 'i', image: 'w', music: 'u', bell: 'n', who: 'p', sound: 'h',
  pet: 'k', gather: 'j', zoom: '0',
};

/**
 * Tools that are not reachable concepts in every shape.
 *
 * Keyed by what the tool NEEDS rather than by which modes may have it, so a new
 * mode gets the right toolbar without editing this, and a new tool declares its
 * own requirement once. In Chat there is nobody to approve, nobody to add and
 * no worktree to diff — three buttons that could only ever say "nothing here".
 */
const NEEDS = { approve: 'crew', summon: 'crew', diff: 'worktrees' };
const inMode = (ico) => {
  const m = modeOf(MODE);
  const need = NEEDS[ico];
  if (!need) return true;
  return need === 'crew' ? m.crew === 'all' || m.crew.length > 0 : Boolean(m[need]);
};

function buildTools() {
  const nav = $('#tools');
  const menu = $('#menu');
  nav.textContent = '';
  menu.textContent = '';

  // Recomputed per build, not once at module load: the overflow button is
  // anchored to the last VISIBLE primary, and in Chat the static last primary
  // ('diff') is not rendered at all — which left the menu with nothing to hang
  // off and made every secondary tool unreachable.
  const lastPrimary = TOOLS.filter(([ico]) => PRIMARY.has(ico) && inMode(ico)).at(-1)?.[0];

  const tip = (label, hint, ico) => {
    const key = KEYS[ico];
    return `${label} — ${hint}${key ? `  (Alt+${key.toUpperCase()})` : ''}`;
  };
  // Two tooltips, deliberately. `data-tip` is the styled one CSS draws on
  // hover; it names the tool and its key and appears instantly, which is the
  // only thing that makes a row of 16px hairlines usable. `title` is the
  // browser's own — it arrives about a second later with the full sentence, and
  // it is what a screen reader and a keyboard user actually get.
  const short = (label, ico) =>
    `${label}${KEYS[ico] ? `  ·  Alt+${KEYS[ico].toUpperCase()}` : ''}`;

  for (const [ico, label, hint, run] of TOOLS) {
    // In Electron the dog is a separate always-on-top window with its own
    // dismiss; a toggle here would claim to control something that is not in
    // this window at all.
    if (ico === 'pet' && ELECTRON) continue;
    if (!inMode(ico)) continue;
    if (ico === 'power' || PRIMARY.has(ico)) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.tool = ico;
      setIcon(b, ico, label);
      b.title = tip(label, hint, ico);
      b.dataset.tip = short(label, ico);
      b.onclick = run;
      nav.append(b);
      // The overflow button sits between the working tools and the
      // destructive one, so "end the court" stays last and alone.
      //
      // Anchored to whichever primary happens to be last, not to a name. This
      // read `ico === 'diff'`, so adding a primary after diff put the overflow
      // button in the middle of the working tools and left the new one stranded
      // on the far side of it.
      // `data-edge` draws the hairline that separates the working tools from
      // the overflow button and the destructive one. It is an attribute rather
      // than a selector in app.css naming a tool, because the last primary
      // changes whenever PRIMARY does and CSS cannot know which one that is.
      if (ico === lastPrimary) { b.dataset.edge = ''; nav.append(moreButton()); }
      continue;
    }
    const row = document.createElement('button');
    row.dataset.tool = ico;
    row.append(icon(ico), document.createTextNode(label));
    row.title = hint;
    // A toggle in a menu has to show its state, or it is a coin flip. Sound is
    // the only row here that is on or off rather than a panel to open.
    if (ico === 'sound') row.classList.toggle('on', soundOn());
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
  b.dataset.tip = 'Everything else';
  b.onclick = (e) => {
    e.stopPropagation();
    const menu = $('#menu');
    menu.hidden = !menu.hidden;
    b.classList.toggle('on', !menu.hidden);
  };
  return b;
}

// Any click elsewhere dismisses it. A menu you have to hit the same button
// twice to close is the one everyone leaves open by accident.
//
// Registered once at module load, not inside moreButton(): the Sound toggle
// calls buildTools() to repaint itself, which builds a fresh more button and
// used to add another permanent window listener every time it was flipped.
window.addEventListener('pointerdown', (e) => {
  if (!$('#menu').hidden && !e.target.closest('#menu, .tool.more')) closeMenu();
});

function initKeys() {
  // Keyed by icon, not by run: which tools apply changes with the mode, and a
  // shortcut that still fired would open a panel the toolbar had just removed.
  const byKey = new Map();
  for (const [ico, , , run] of TOOLS) if (KEYS[ico]) byKey.set(KEYS[ico], [ico, run]);

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
    // Layout is not a panel, so it is not in TOOLS — but it is the one thing
    // you flip most often, so it gets a key anyway.
    if (e.key.toLowerCase() === 'l') {
      e.preventDefault();
      return setLayout(localStorage.getItem('kd.mode') === 'flow' ? 'board' : 'flow');
    }
    const hit = byKey.get(e.key.toLowerCase());
    if (!hit || !inMode(hit[0])) return;
    e.preventDefault();
    hit[1]();
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
  if (!peasants.length) return toast('No agents on the team.', true);
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
    // otherwise send `/desi` as an order to the orchestrator.
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
// Same reason, one level further out: this paints the toolbar and the overview,
// so it can only run once both exist.
buildCourtModes();
initKeys();

// The header's cost readout is painted by the `spend` event, which does not
// arrive until the first turn ends — so a court you have just opened showed an
// empty slot where a number belongs, which reads as broken rather than as zero.
$('#spend').textContent = '0 turns';

/**
 * Open the orchestrator on a first run.
 *
 * An empty canvas is the worst first impression this app can make: a wallpaper
 * and nothing else, with no hint that the rail on the left is how you get in.
 * Only on a FIRST run — once the sovereign has arranged their own workspace,
 * reopening a panel they closed would be the app arguing with them.
 */
if (!localStorage.getItem('kd.seen')) {
  localStorage.setItem('kd.seen', '1');
  setTimeout(() => openMember('orchestrator'), 400);
}
badge();
connect();
syncApprovals();
// SSE already delivers `approval` and `resolved` as they happen; this is the
// net for a dropped event, not the delivery path. At 2.5s it was a poll —
// 1,440 an hour, each one scanning 2000 bus messages and JSON.parsing every
// candidate server-side, for an event that arrives on the stream anyway.
setInterval(syncApprovals, 30_000);
