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
  const entries = membersOf(state).filter(([, member]) => member.role === 'peasant').sort(([a], [b]) => a.localeCompare(b));
  const active = entries.filter(([, member]) => member.summoned || member.serving || member.awake);
  const body = section(`Configured agents · ${entries.length}`);
  body.append(note(`${active.length} currently on the team.`));
  if (!entries.length) body.append(empty('No agents are configured.'));
  for (const [name, member] of entries) {
    const on = Boolean(member.summoned);
    const pending = !on && (state.approvals ?? []).some((approval) => !approval.resolved && approval.kind === 'summon' && approval.names?.includes(name));
    const bench = modeDef(state).crew;
    const inBench = bench === 'all' || bench?.includes(name);
    const stateLabel = on ? displayStatus(member) : pending ? 'requested' : 'available';
    const dot = statusDot(name, member.role);
    const dotTone = tone(stateLabel);
    if (dotTone) dot.classList.add(dotTone);
    dot.dataset.tip = stateLabel;
    const row = h('article', { class: `agent-card ${on ? 'on-team' : ''}${pending ? ' requested' : ''}` }, h('div', { class: 'agent-heading' }, dot, h('div', {}, h('h3', { text: displayName(name, member.role) }), h('p', { class: 'muted', text: member.title ?? member.description ?? stateLabel }))), h('p', { class: 'muted', text: on ? `On team · ${stateLabel}` : pending ? 'Awaiting approval' : inBench ? 'Available to add' : `Not available in ${state.mode ?? 'this'} mode` }));
    const actions = h('div', { class: 'button-row' });
    const actionMessage = note('', 'danger');
    actionMessage.hidden = true;
    const power = button(on ? (member.awake ? 'Rest' : 'Wake') : pending ? 'Awaiting approval' : 'Request for team', async () => {
      power.disabled = true;
      try {
        const result = on
          ? await post(member.awake ? 'sleep' : 'wake', { name })
          : await post('summon', { names: [name], reason: `You requested ${displayName(name, member.role)} from the Team page.` });
        if (result?.ok === false) throw new Error(result.error ?? 'The team action failed. Try again.');
        actionMessage.className = 'note success';
        actionMessage.textContent = on ? (member.awake ? 'Rest requested.' : 'Wake requested.') : 'Team request submitted for approval.';
        actionMessage.hidden = false;
      } catch (error) {
        actionMessage.textContent = error?.message ?? 'The team action failed. Try again.';
        actionMessage.hidden = false;
        power.disabled = false;
      }
    });
    power.disabled = !allowed || pending || (!on && !inBench);
    actions.append(power);
    if (on) actions.append(modelControls(state, name, member), button('Review changes', () => setView('changes')));
    row.append(actions, actionMessage); body.append(row);
  }
  shell.append(body); root.append(shell);
}

export function mountAgents(state, root) {
  renderAgents(state, root);
  return bind(state, root, renderAgents);
}
export const render = renderAgents;
export const mount = mountAgents;
