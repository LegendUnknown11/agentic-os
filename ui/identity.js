// Who am I looking at — the card on the right.
//
// The rail says a member exists and one word about what it is doing. The panel
// says what it is *for*: its title, the role it was given, which model is
// answering as it, and what that has cost.
//
// Selection follows attention: opening a member selects it, and so does
// clicking anywhere in its panel.
import { statusDot } from './avatar.js';
import { ROLE_CATEGORIES } from './panels.js';
import { displayName, roleWord } from './names.js';

let root, api = {};
let current = null;

export function initIdentity(el, opts = {}) {
  root = el;
  api = opts;
  paint();
}

export const selected = () => current;

export function select(name) {
  if (name === current) return;
  current = name;
  paint();
}

/** Repaint, but only if the thing that changed is the thing on screen. */
export function refresh(name) {
  if (!name || name === current) paint();
}

function paint() {
  if (!root) return;
  root.textContent = '';
  const m = current ? api.info?.(current) : null;
  if (!m) {
    const e = document.createElement('div');
    e.className = 'who-empty';
    e.textContent = 'Pick someone from the list to see who they are.';
    root.append(e);
    return;
  }

  const head = document.createElement('div');
  head.className = `who-id role-${m.role ?? 'peasant'}${m.awake ? ' awake' : ''}`;
  head.innerHTML = '<span class="nm"></span><span class="rl"></span>';
  head.prepend(statusDot(m.name, m.role));
  // The role word is dropped when the name already is it: the orchestrator and
  // the monitor are singletons named after their role, so the card read
  // "Orchestrator … Orchestrator". A named one keeps both.
  const shownName = displayName(m.name, m.role);
  const role = roleWord(m.role);
  head.querySelector('.nm').textContent = shownName;
  head.querySelector('.rl').textContent = shownName === role ? '' : role;

  const cat = ROLE_CATEGORIES[m.name];
  if (cat) {
    const pill = document.createElement('span');
    pill.className = 'who-cat';
    pill.textContent = cat;
    pill.dataset.cat = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    head.append(pill);
  }
  root.append(head);

  if (m.title) {
    const t = document.createElement('div');
    t.className = 'who-title';
    t.textContent = m.title;
    root.append(t);
  }
  if (m.description) {
    const d = document.createElement('p');
    d.className = 'who-desc';
    d.textContent = m.description;
    root.append(d);
  }

  const facts = document.createElement('dl');
  facts.className = 'who-facts';
  const fact = (k, v, cls = '') => {
    if (!v) return;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.className = cls;
    dd.textContent = v;
    facts.append(dt, dd);
  };
  fact('Model', `${m.cli ?? 'claude'} · ${m.model || 'default'}`, 'mono');
  fact('Effort', m.takesEffort === false ? 'not applicable' : (m.effort || 'default'), 'mono');
  fact('State', m.awake ? 'awake' : m.summoned ? 'resting — wakes on its next message' : 'not added');
  if (m.awake) fact('Doing', m.status && m.status !== 'idle' ? m.status : 'idle');
  fact('Cost', m.stat, 'mono');
  root.append(facts);

  if (m.summary) {
    const s = document.createElement('div');
    s.className = 'who-sum';
    s.textContent = m.summary;
    root.append(s);
  }

  const act = document.createElement('div');
  act.className = 'act';
  const open = document.createElement('button');
  open.className = 'primary';
  open.textContent = m.open ? 'Close panel' : 'Open panel';
  open.onclick = () => api.onOpen?.(m.name);
  
  const power = document.createElement('button');
  power.textContent = m.awake ? 'Sleep' : 'Wake';
  power.title = m.awake
    ? `Stop ${shownName}. It leaves service and stops costing anything; its session is kept.`
    : `Start ${shownName} and hand it any messages waiting for it.`;
  power.onclick = () => api.onPower?.(m.name);
  act.append(open, power);

  if (m.role === 'peasant' && m.summoned) {
    const diff = document.createElement('button');
    diff.textContent = 'Diff';
    diff.title = `Inspect ${shownName}'s unmerged worktree changes against base.`;
    diff.onclick = () => api.onDiff?.(m.name);
    act.append(diff);
  }

  root.append(act);
}

/** Hide/show, remembered. Same contract as the rail's collapse. */
export function initCollapse(btn) {
  const apply = () =>
    document.body.classList.toggle('who-collapsed', localStorage.getItem('kd.who') === '1');
  btn.onclick = () => {
    localStorage.setItem('kd.who', localStorage.getItem('kd.who') === '1' ? '0' : '1');
    apply();
  };
  apply();
}

/** The toolbar's toggle, for getting it back once hidden. */
export function toggleCollapse() {
  localStorage.setItem('kd.who', localStorage.getItem('kd.who') === '1' ? '0' : '1');
  document.body.classList.toggle('who-collapsed', localStorage.getItem('kd.who') === '1');
}
