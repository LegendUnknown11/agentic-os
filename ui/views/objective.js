import { h, page, section, empty, note, button, field, input, textarea, check, meter, post, subscribe, editing } from './util.js';
import { loadRunTemplates, startRunSection } from './start-run.js';

function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

export function renderObjective(state, root) {
  root.replaceChildren();
  const goal = state.goal;
  const shell = page('Objective', 'The standing outcome every new member is told about.');
  if (state.ready === false) { shell.append(section('Outcome', empty('Loading the objective…'))); root.append(shell); return; }
  const text = textarea(goal?.text ?? '', 'What is the team working towards?');
  const feedback = note('', 'danger');
  feedback.hidden = true;
  const showFailure = (message) => { feedback.textContent = message; feedback.hidden = false; };
  const save = button(goal ? 'Update objective' : 'Set objective', async () => {
    const value = text.value.trim();
    feedback.hidden = true;
    if (!value) { showFailure('Enter an objective first.'); return; }
    save.disabled = true;
    try {
      const result = await post('goal', { text: value });
      if (result?.ok === false) showFailure(result.error ?? 'Could not save the objective.');
    } catch (error) { showFailure(error?.message ?? 'Could not save the objective.'); }
    finally { save.disabled = false; }
  }, 'primary');
  const body = section('Outcome', field('Objective', text), h('div', { class: 'button-row' }, save), feedback);
  if (goal) {
    const milestones = goal.milestones ?? [];
    const done = milestones.filter((m) => m.done).length;
    if (milestones.length) body.append(meter((done / milestones.length) * 100, `${done}/${milestones.length} complete`));
    body.append(section('Milestones', ...milestones.map((milestone, index) => {
      const c = check(milestone.done);
      c.addEventListener('change', async () => {
        const next = c.checked;
        c.disabled = true;
        try {
          const result = await post('milestone', { index, done: next });
          if (result?.ok === false) throw new Error(result.error ?? 'Could not update that milestone.');
        } catch (error) {
          c.checked = !next;
          showFailure(error?.message ?? 'Could not update that milestone.');
        } finally { c.disabled = false; }
      });
      return h('label', { class: 'check-row' }, c, h('span', { text: milestone.text }));
    })));
    const add = input('', 'Add a milestone…');
    add.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = add.value.trim();
      if (!value) { showFailure('Enter a milestone first.'); return; }
      add.disabled = true;
      try {
        const result = await post('goal', { milestones: [...milestones, { text: value, done: false }] });
        if (result?.ok === false) showFailure(result.error ?? 'Could not add that milestone.');
        else milestones.push({ text: value, done: false });
      } catch (error) { showFailure(error?.message ?? 'Could not add that milestone.'); }
      finally { add.disabled = false; }
    });
    body.append(field('New milestone', add));
    const clear = button('Clear objective', async () => {
      clear.disabled = true;
      try {
        const result = await post('goal', { text: null });
        if (result?.ok === false) showFailure(result.error ?? 'Could not clear the objective.');
      } catch (error) { showFailure(error?.message ?? 'Could not clear the objective.'); }
      finally { clear.disabled = false; }
    }, 'danger');
    body.append(clear);
  }
  shell.append(body, startRunSection(state, () => { if (root.isConnected !== false) renderObjective(state, root); }));
  root.append(shell);
}

export function mountObjective(state, root) {
  renderObjective(state, root);
  void loadRunTemplates(state, () => { if (root.isConnected !== false && !editing(root)) renderObjective(state, root); });
  return bind(state, root, renderObjective);
}
export const render = renderObjective;
export const mount = mountObjective;
