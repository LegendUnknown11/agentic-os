import { h, section, note, button, field, input, textarea, select, get, post, apiError, requestToken } from './util.js';

// Starting a run from the interface. Before this nothing in the UI (or any
// member tool) posted `run/create`; a run could only be started over raw HTTP.
// Run templates are saved starting points: objective, acceptance criteria and
// allowed models, stored by the daemon (/api/runTemplates).

const ACTIVE = new Set(['planning', 'running', 'paused', 'blocked', 'verifying', 'ready_for_review']);
export const lines = (text) => String(text ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
export const commaList = (text) => String(text ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** The form's text fields -> the run/create (and template) body. Pure, for the suite. */
export function runBody(draft = {}) {
  return {
    objective: String(draft.objective ?? '').trim(),
    acceptanceCriteria: lines(draft.criteria),
    allowedModels: commaList(draft.models),
  };
}

/** A saved template -> the form's text fields. */
export const draftFrom = (template = {}) => ({
  objective: template.objective ?? '',
  criteria: (template.acceptanceCriteria ?? []).join('\n'),
  models: (template.allowedModels ?? []).join(', '),
  name: template.name ?? '',
  templateId: template.id ?? '',
});

export function loadRunTemplates(state, render) {
  const token = requestToken(state, 'runTemplatesRequest');
  return get('/api/runTemplates').then((data) => {
    if (state.runTemplatesRequest !== token) return;
    if (data?.ok !== false) { state.runTemplates = data.templates ?? []; state.runTemplatesError = null; }
    else state.runTemplatesError = apiError(data, 'Could not load run templates.');
    render?.();
  });
}

export function startRunSection(state, rerender) {
  // The Objective view repaints on stream events; the draft lives in state so
  // a half-typed run survives that.
  state.runDraft ??= { objective: state.goal?.text ?? '', criteria: '', models: '', name: '', templateId: '' };
  const draft = state.runDraft;
  const active = state.run && ACTIVE.has(String(state.run.state ?? state.run.status)) ? state.run : null;
  const templates = state.runTemplates ?? [];
  const feedback = note('', 'danger');
  feedback.hidden = true;
  feedback.setAttribute('role', 'alert');
  const say = (text, failed = true) => { feedback.textContent = text; feedback.className = `note ${failed ? 'danger' : 'success'}`; feedback.hidden = false; };
  const bindText = (control, key) => { control.addEventListener('input', () => { draft[key] = control.value; }); return control; };

  const picker = select([['', templates.length ? 'Start from a template…' : 'No saved templates yet'], ...templates.map((t) => [t.id, t.name])], draft.templateId);
  picker.disabled = !templates.length;
  picker.setAttribute('aria-label', 'Run template');
  picker.addEventListener('change', () => {
    const chosen = templates.find((t) => t.id === picker.value);
    state.runDraft = chosen ? draftFrom(chosen) : { ...draft, templateId: '' };
    rerender();
  });
  const objective = bindText(textarea(draft.objective, 'What should this run achieve?'), 'objective');
  const criteria = bindText(textarea(draft.criteria, 'One per line, e.g. "npm test passes"'), 'criteria');
  const models = bindText(input(draft.models, 'Blank = the team default, or e.g. codex/gpt-5.6-luna'), 'models');
  const name = bindText(input(draft.name, 'Template name'), 'name');

  const start = button('Start run', async () => {
    const body = runBody(draft);
    if (!body.objective) { say('Enter an objective first.'); return; }
    start.disabled = true;
    try {
      const result = await post('runCreate', body);
      if (result?.ok === false) throw new Error(result.error ?? 'The run did not start.');
      say('Run started in planning. Approve its plan from Overview.', false);
    } catch (error) { say(error?.message ?? 'The run did not start.'); }
    finally { if (start.isConnected) start.disabled = false; }
  }, 'primary');
  start.disabled = Boolean(active);
  const save = button(draft.templateId ? 'Update template' : 'Save as template', async () => {
    const body = runBody(draft);
    if (!String(draft.name ?? '').trim()) { say('Name the template first.'); return; }
    if (!body.objective) { say('Enter an objective first.'); return; }
    save.disabled = true;
    try {
      const result = await post('runTemplate', { op: 'save', id: draft.templateId || undefined, name: draft.name, ...body });
      if (result?.ok === false) throw new Error(result.error ?? 'The template was not saved.');
      state.runTemplates = result.templates ?? state.runTemplates;
      state.runDraft = { ...draft, templateId: result.template?.id ?? draft.templateId };
      rerender();
    } catch (error) { say(error?.message ?? 'The template was not saved.'); }
    finally { if (save.isConnected) save.disabled = false; }
  });
  const remove = draft.templateId ? button('Delete template', async () => {
    remove.disabled = true;
    try {
      const result = await post('runTemplate', { op: 'delete', id: draft.templateId });
      if (result?.ok === false) throw new Error(result.error ?? 'The template was not deleted.');
      state.runTemplates = result.templates ?? [];
      state.runDraft = { ...draft, templateId: '', name: '' };
      rerender();
    } catch (error) { say(error?.message ?? 'The template was not deleted.'); }
  }, 'danger') : null;

  return section('Start a run',
    // Also what the user sees right after starting one: the run event
    // repaints this form before any "started" message could be read.
    active ? h('div', { class: 'button-row run-active-note' },
      note(`Current run (${String(active.state ?? active.status).replace(/_/g, ' ')}): ${active.objective || active.id}. One run at a time; manage it from Overview.`),
      h('a', { class: 'button link', href: '#home', text: 'Open Overview' })) : null,
    state.runTemplatesError ? note(state.runTemplatesError, 'danger') : null,
    field('Template', picker),
    field('Objective', objective),
    field('Acceptance criteria', criteria, 'One per line. Verification checks the run against these.'),
    field('Allowed models', models, 'Comma separated. Leave blank for the team default.'),
    h('div', { class: 'button-row' }, start),
    h('div', { class: 'run-template-save' }, field('Save these fields as a template', name), h('div', { class: 'button-row' }, save, remove)),
    feedback);
}
