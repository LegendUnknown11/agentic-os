// The phone page for remote control (src/remote.js). It is served by the
// remote listener alongside app.css and nothing else of the UI bundle, so it
// is standalone on purpose: no store, no stream, no shared view modules
// (ui/views/util.js imports the store, which would open the full /stream).
//
// The token arrives once, in the URL fragment of the link Settings shows
// (`/remote#t=…`), which a browser never sends to a server. It is moved into
// this origin's storage and wiped from the address bar, then sent as a
// bearer token on every request. Turning remote control off and on in
// Settings mints a new one; the old link then answers 401 and this page says
// so instead of retrying forever.

const KEY = 'agenticos-remote-token';
const POLL_MS = 3000;
const root = document.getElementById('remote');

const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (value) => { try { localStorage.setItem(KEY, value); } catch { /* memory only, below */ } },
  clear: () => { try { localStorage.removeItem(KEY); } catch { /* nothing kept */ } },
};

let token = null;
{
  const fromLink = /^#t=([0-9a-f]{64})$/.exec(location.hash)?.[1] ?? null;
  if (fromLink) {
    store.set(fromLink);
    history.replaceState(null, '', location.pathname);
  }
  token = fromLink ?? store.get();
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}
const button = (label, action, cls = '') => h('button', { class: `button ${cls}`.trim(), type: 'button', on: { click: action } }, label);
const note = (text, cls = '') => h('p', { class: `note ${cls}`.trim(), text });
// Not .view-heading: that one is visually hidden because the shell's header
// carries the title, and this page has no shell.
const heading = () => h('header', { class: 'remote-heading' },
  h('h1', { text: 'Remote control' }), h('p', { text: 'Agentic OS, steered from this device.' }));
const section = (title, ...children) => h('section', { class: 'view-section' }, h('h2', { text: title }), ...children);

class Expired extends Error {}

async function call(path, body) {
  const init = { headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) throw new Expired();
  const data = await res.json().catch(() => ({ ok: false, error: `The team answered ${res.status}.` }));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `The team answered ${res.status}.`);
  return data;
}

const view = { cursor: 0, messages: [], state: null, error: '', sending: false, draft: '' };
let timer = 0;

const KINDS = { add: 'Team request', role: 'Role request', merge: 'Merge request', push: 'Push request', question: 'Question' };
const kindLabel = (kind) => KINDS[kind] ?? `${String(kind ?? 'request').replace(/[-_]+/g, ' ')} request`;
const money = (usd) => `$${Number(usd ?? 0).toFixed(2)}`;
const runLabel = (state) => String(state ?? 'idle').replace(/_/g, ' ');

function expired() {
  clearTimeout(timer);
  store.clear();
  root.replaceChildren(
    heading(),
    section('This link no longer works',
      note('Remote control was turned off, restarted, or given a new link. Open Settings → Remote control on your computer and scan the new code.')));
}

async function act(path, body, control) {
  if (control) control.disabled = true;
  try {
    await call(path, body);
    view.error = '';
  } catch (e) {
    if (e instanceof Expired) return expired();
    view.error = e.message;
  }
  await poll(true);
}

function statusSection(s) {
  const run = s.run;
  const parts = [];
  if (run) {
    parts.push(h('p', { class: 'remote-status' }, h('span', { class: 'status-dot' }), h('span', { text: s.paused ? 'Paused' : runLabel(run.state) })));
    if (run.objective) parts.push(h('p', { class: 'remote-objective', text: run.objective }));
    // src/agenticos.js #runBlock: {operation, next}.
    if (run.blocker?.operation) {
      parts.push(note(`Blocked: ${run.blocker.operation}.${run.blocker.next ? ` Next: ${run.blocker.next}` : ''}`, 'danger'));
    }
  } else {
    parts.push(note(s.paused ? 'No run. The team is paused.' : 'No run in progress.'));
  }
  parts.push(note(`Spent today: ${money(s.spend?.today?.usd)} · ${s.spend?.turns ?? 0} turns this session`));
  const row = h('div', { class: 'button-row' });
  if (s.paused || run?.state === 'paused' || run?.state === 'blocked') {
    const resume = button('Resume', () => act('/api/runResume', run ? { runId: run.id } : {}, resume), 'primary');
    row.append(resume);
  } else if (run) {
    const pause = button('Pause', () => act('/api/runPause', { runId: run.id, why: 'paused from remote control' }, pause));
    row.append(pause);
  }
  if (row.childElementCount) parts.push(row);
  return section('Run', ...parts);
}

function approvalCard(a) {
  const card = h('article', { class: 'approval-card pending' },
    h('div', { class: 'card-meta', text: `${kindLabel(a.kind)} · ${a.from ?? 'orchestrator'}` }));
  const what = a.names?.length ? a.names.join(', ') : a.agent ?? a.name ?? '';
  if (what) card.append(h('h3', { text: what }));
  if (a.reason) card.append(h('p', { text: a.reason }));
  if (a.kind === 'question') {
    const form = h('div', { class: 'question-options' });
    (a.questions ?? []).forEach((q, qi) => {
      const block = h('div', { class: 'question' }, h('h4', { text: q.question ?? `Question ${qi + 1}` }));
      (q.options ?? []).forEach((option) => {
        const label = option.label ?? option;
        block.append(h('label', {}, h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `q-${a.id}-${qi}`, value: label, 'data-q': qi }), h('span', { text: label })));
      });
      const other = h('input', { class: 'question-other', placeholder: 'Other…', 'aria-label': `Other answer for question ${qi + 1}`, 'data-other': qi });
      block.append(other);
      form.append(block);
    });
    const submit = button('Answer', () => {
      const answers = [...form.querySelectorAll('.question')].map((block) => {
        const chosen = [...block.querySelectorAll('[data-q]:checked')].map((el) => el.value);
        const other = block.querySelector('[data-other]')?.value.trim();
        return other ? [...chosen, other] : chosen;
      });
      if (!answers.length || answers.some((choice) => !choice.length)) {
        view.error = 'Answer every question before submitting.';
        return render();
      }
      act('/api/answerQuestion', { id: a.id, answers }, submit);
    }, 'primary');
    card.append(form, submit);
    return card;
  }
  const approve = button('Approve', () => act('/api/approve', { id: a.id }, approve), 'primary');
  const reject = button('Reject', () => act('/api/reject', { id: a.id, why: 'rejected from remote control' }, reject));
  card.append(h('div', { class: 'button-row' }, approve, reject));
  return card;
}

function threadSection() {
  const list = h('div', { class: 'remote-thread', role: 'log', 'aria-label': 'Conversation with the orchestrator' });
  if (!view.messages.length) list.append(note('No messages yet.'));
  for (const m of view.messages) {
    list.append(h('div', { class: `remote-message ${m.from === 'user' ? 'from-user' : 'from-team'}` },
      h('div', { class: 'card-meta', text: `${m.from === 'user' ? 'You' : 'Orchestrator'} · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }),
      h('p', { class: 'message-body', text: m.body })));
  }
  const box = h('textarea', { class: 'remote-draft', placeholder: 'Message the orchestrator', 'aria-label': 'Message the orchestrator', rows: '3' });
  box.value = view.draft;
  box.addEventListener('input', () => { view.draft = box.value; });
  const send = button('Send', async () => {
    const text = box.value.trim();
    if (!text) return;
    view.sending = true;
    await act('/api/remote/message', { text }, send);
    if (!view.error) view.draft = '';
    view.sending = false;
    render();
  }, 'primary');
  send.disabled = view.sending;
  return section('Orchestrator', list, box, h('div', { class: 'button-row' }, send));
}

function render() {
  const s = view.state;
  // Never repaint under a thumb that is typing: the poll would wipe focus.
  if (root.contains(document.activeElement) && document.activeElement.matches('textarea, input')) return;
  const parts = [heading()];
  if (view.error) parts.push(note(view.error, 'danger'));
  if (!s) parts.push(note('Connecting…'));
  else {
    parts.push(statusSection(s));
    parts.push(section(`Waiting on you${s.approvals.length ? ` (${s.approvals.length})` : ''}`,
      ...(s.approvals.length ? s.approvals.map(approvalCard) : [note('Nothing is waiting on you.')])));
    parts.push(threadSection());
  }
  root.replaceChildren(...parts);
}

async function poll(once = false) {
  clearTimeout(timer);
  try {
    const s = await call(`/api/remote/state${view.cursor ? `?since=${view.cursor}` : ''}`);
    const seen = new Set(view.messages.map((m) => m.id));
    view.messages = [...view.messages, ...s.messages.filter((m) => !seen.has(m.id))].slice(-50);
    view.cursor = s.cursor;
    view.state = s;
    if (view.error && !once) view.error = '';
  } catch (e) {
    if (e instanceof Expired) return expired();
    view.error = 'Cannot reach Agentic OS. Remote control may be off, or this device or your computer is not connected to Tailscale.';
  }
  render();
  timer = setTimeout(poll, POLL_MS);
}

if (!token) expired();
else { render(); poll(); }
