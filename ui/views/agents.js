import {
  h, page, section, empty, note, button, field, select,
  membersOf, modeAllows, modeDef, displayName, modelLabel, post, setView, subscribe, editing, tone,
} from './util.js';
import { statusDot } from '../avatar.js';
import { displayStatus } from '../sidebar.js';

function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

function modelControls(state, name, member) {
  const models = Object.entries(state.models ?? {}).flatMap(([cli, values]) => (values ?? []).map((model) => [`${cli}:${model}`, `${cli} · ${modelLabel(model)}`]));
  let previous = member.auto ? '__auto__' : `${member.cli ?? ''}:${member.model ?? ''}`;
  const model = select([['__auto__', 'Advisor chooses'], ...models], previous);
  const feedback = note('', 'danger');
  feedback.hidden = true;
  model.addEventListener('change', async () => {
    const next = model.value;
    feedback.hidden = true;
    model.disabled = true;
    try {
      const result = next === '__auto__'
        ? await post('model', { name, auto: true })
        : await (() => { const [cli, ...rest] = next.split(':'); return post('model', { name, cli, model: rest.join(':') }); })();
      if (result?.ok === false) throw new Error(result.error ?? 'The model could not be changed. Try again.');
      previous = next;
    } catch (error) {
      model.value = previous;
      feedback.textContent = error?.message ?? 'The model could not be changed. Try again.';
      feedback.hidden = false;
    } finally { model.disabled = false; }
  });
  const wrapper = field('Model', model);
  wrapper.append(feedback);
  return wrapper;
}

export function renderAgents(state, root) {
  root.replaceChildren();
  const shell = page('Agents', 'Who is configured, who is on the team, and what each one is doing.');
  if (state.ready === false) { shell.append(section('Team', empty('Loading the roster…'))); root.append(shell); return; }
  const allowed = modeAllows(state, 'crew');
  const entries = membersOf(state).filter(([, member]) => member.role === 'agent').sort(([a], [b]) => a.localeCompare(b));
  const active = entries.filter(([, member]) => member.added || member.serving || member.awake);
  const working = active.filter(([, member]) => tone(displayStatus(member)) === 'live').length;
  shell.append(note(`${active.length} on the team · ${working} working · ${entries.length} configured`, 'team-summary'));
  if (!entries.length) { shell.append(section('Team', empty('No agents are configured.'))); root.append(shell); return; }

  // As in the canvas: the team is a grid of cards, and everyone else is one
  // row of chips under "Available to add".
  const grid = h('div', { class: 'agent-grid' });
  const bench = h('div', { class: 'agent-bench' });
  for (const [name, member] of entries) {
    const on = Boolean(member.added);
    const pending = !on && (state.approvals ?? []).some((approval) => !approval.resolved && approval.kind === 'add' && approval.names?.includes(name));
    const crew = modeDef(state).crew;
    const inBench = crew === 'all' || crew?.includes(name);
    const stateLabel = on ? displayStatus(member) : pending ? 'requested' : 'available';
    const actionMessage = note('', 'danger');
    actionMessage.hidden = true;
    const act = async (control) => {
      control.disabled = true;
      try {
        const result = on
          ? await post(member.awake ? 'sleep' : 'wake', { name })
          : await post('add', { names: [name], reason: `You requested ${displayName(name, member.role)} from the Team page.` });
        if (result?.ok === false) throw new Error(result.error ?? 'The team action failed. Try again.');
        actionMessage.className = 'note success';
        actionMessage.textContent = on ? (member.awake ? 'Rest requested.' : 'Wake requested.') : 'Team request submitted for approval.';
        actionMessage.hidden = false;
      } catch (error) {
        actionMessage.textContent = error?.message ?? 'The team action failed. Try again.';
        actionMessage.hidden = false;
        control.disabled = false;
      }
    };

    if (!on && !pending) {
      const chip = button(`+ ${displayName(name, member.role)}`, () => act(chip), 'chip');
      chip.dataset.tip = inBench ? (member.title ?? member.description ?? 'Request for team') : `Not available in ${state.mode ?? 'this'} mode`;
      chip.setAttribute('aria-label', `Request ${displayName(name, member.role)} for the team`);
      chip.disabled = !allowed || !inBench;
      bench.append(chip);
      continue;
    }

    const dot = statusDot(name, member.role);
    const dotTone = tone(stateLabel);
    if (dotTone) dot.classList.add(dotTone);
    dot.dataset.tip = stateLabel;
    const card = h('article', { class: `agent-card ${on ? 'on-team' : ''}${pending ? ' requested' : ''} ${dotTone ?? ''}`.trim() },
      h('div', { class: 'agent-heading' },
        h('span', { class: 'agent-initial', 'aria-hidden': 'true', text: displayName(name, member.role).slice(0, 1).toUpperCase() }),
        h('div', {}, h('h3', { text: displayName(name, member.role) }),
          h('p', { class: 'agent-state', text: on ? `${stateLabel}${member.title ? ` · ${member.title}` : ''}` : 'Awaiting approval' })),
        dot));
    const actions = h('div', { class: 'button-row' });
    const power = button(on ? (member.awake ? 'Rest' : 'Wake') : 'Awaiting approval', () => act(power), 'chip');
    power.disabled = !allowed || pending;
    if (on) card.append(modelControls(state, name, member));
    actions.append(power);
    if (on) actions.append(button('Review changes', () => setView('changes'), 'chip'));
    card.append(actions, actionMessage);
    grid.append(card);
  }
  if (grid.children.length) shell.append(grid);
  else shell.append(section('On the team', empty('No one is on the team yet. Request an agent below.')));
  if (bench.children.length) shell.append(h('section', { class: 'agent-available' }, h('h2', { text: 'Available to add' }), bench));
  root.append(shell);
}

export function mountAgents(state, root) {
  renderAgents(state, root);
  return bind(state, root, renderAgents);
}
export const render = renderAgents;
export const mount = mountAgents;
