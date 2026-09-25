import * as Graph from '../graph.js';
import { h, page, section, empty, note, button, field, input, select, textarea, check, modeAllows, get, post, subscribe, requestToken } from './util.js';

const editorDisposals = new WeakMap();
function disposeEditor(root) {
  editorDisposals.get(root)?.();
  editorDisposals.delete(root);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "1-5", "1,3,5", "1-3,6" -> sorted weekday numbers; '' -> null (every day); bad -> false. */
export function parseDays(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const days = new Set();
  for (const part of value.split(',')) {
    const m = /^\s*([0-6])\s*(?:-\s*([0-6])\s*)?$/.exec(part);
    if (!m) return false;
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (to < from) return false;
    for (let d = from; d <= to; d++) days.add(d);
  }
  return [...days].sort((x, y) => x - y);
}

export function daysText(days) {
  if (!Array.isArray(days) || !days.length || days.length === 7) return 'daily';
  if (days.join() === '1,2,3,4,5') return 'weekdays';
  return days.map((d) => `${DAY_NAMES[d]}s`).join(', ');
}

export const triggerText = (trigger = {}) => ({
  interval: `every ${Math.round((trigger.everyMs ?? 0) / 1000)}s`,
  daily: `${daysText(trigger.days)} at ${trigger.at ?? '?'}`,
  bus: `on message containing “${trigger.pattern ?? ''}”`,
  webhook: 'webhook',
  manual: 'manual',
}[trigger.type] ?? 'manual');

function workflowList(state, root) {
  disposeEditor(root);
  delete root.dataset.automationEditor;
  root.replaceChildren();
  const shell = page('Automations', 'Build small, inspectable workflows with real triggers and run traces.');
  if (!modeAllows(state, 'workflows')) {
  shell.append(note(`Automations are available in Cowork mode. Current mode: ${state.mode ?? 'unknown'}.`));
    root.append(shell);
    return;
  }
  const source = state.workflows?.workflows ?? state.workflows;
  const workflows = Array.isArray(source) ? source : [];
  const add = button('+ New automation', () => editor(state, root), 'primary');
  add.disabled = Boolean(state.workflowsLoading);
  const body = section('Saved automations', add);
  if (state.workflowsLoading) body.append(empty('Loading automations…'));
  else if (state.workflowsError ?? state.workflows?.ok === false) {
    const message = state.workflowsError ?? state.workflows.error ?? 'Could not load automations.';
    body.append(h('div', { class: 'button-row' }, note(message, 'danger'), button('Retry', () => reload(state, root), 'primary')));
    if (!state.workflows || state.workflows?.ok === false) { shell.append(body); root.append(shell); return; }
  }
  else if (!workflows.length) body.append(empty('No automations yet. Start from a template below.'));
  // Every store update anywhere in the app (SSE ticks, cost updates, ...)
  // re-renders this whole list via the subscribe() below, which would tear
  // out a plain local message element before the user ever saw it. Keyed
  // state instead of a DOM reference survives that churn.
  state.workflowRunMessages ??= {};
  workflows.forEach((workflow) => {
    const row = h('article', { class: 'workflow-row' }, h('div', {}, h('h3', { text: workflow.name }), h('p', { class: 'muted', text: triggerText(workflow.trigger) })), workflow.enabled === false && note('disabled'));
    const actions = h('div', { class: 'button-row' });
    const rowState = state.workflowRunMessages[workflow.id] ?? {};
    const actionMessage = note(rowState.text ?? '', `workflow-run-message workflow-action-message${rowState.text ? (rowState.failed ? ' danger' : ' success') : ''}`);
    actionMessage.hidden = !rowState.text;
    const updateRow = (patch) => {
      state.workflowRunMessages[workflow.id] = { ...state.workflowRunMessages[workflow.id], ...patch };
      workflowList(state, root);
    };
    const showAction = (message, failed = false) => updateRow({ text: message, failed });
    actions.append(button('Edit', () => editor(state, root, workflow)));
    const run = button('Run now', async () => {
      run.disabled = true;
      run.textContent = 'Running…';
      try {
        const response = await post('workflows/run', { id: workflow.id });
        const result = response?.result;
        const failed = response?.ok === false || result?.ok === false;
        showAction(failed
          ? `Run failed: ${response?.error ?? result?.steps?.find((step) => !step.ok)?.error ?? 'the workflow stopped.'}`
          : `Run complete · ${result?.steps?.length ?? 0} step${result?.steps?.length === 1 ? '' : 's'}.`, failed);
      } catch (error) { showAction(`Run failed: ${error?.message ?? 'the workflow stopped.'}`, true); }
      finally { run.disabled = false; run.textContent = 'Run now'; }
    });
    const del = button(rowState.armed ? 'Confirm delete' : 'Delete', async () => {
      if (!rowState.armed) { updateRow({ armed: true }); return; }
      del.disabled = true;
      let response;
      try { response = await post('workflows/delete', { id: workflow.id }); }
      catch (error) { response = { ok: false, error: error?.message ?? 'the automation was not removed.' }; }
      if (root.isConnected === false || root.dataset.automationEditor === '1') return;
      if (response?.ok === false) {
        del.disabled = false;
        updateRow({ armed: false, text: `Delete failed: ${response.error ?? 'the automation was not removed.'}`, failed: true });
        return;
      }
      let data;
      try { data = await get('/api/workflows'); }
      catch (error) { data = { ok: false, error: error?.message ?? 'Deleted, but the automation list could not refresh.' }; }
      if (root.isConnected === false || root.dataset.automationEditor === '1') return;
      if (data?.ok === false) {
        del.disabled = false;
        updateRow({ armed: false, text: data.error ?? 'Deleted, but the automation list could not refresh.', failed: true });
        return;
      }
      delete state.workflowRunMessages[workflow.id];
      state.workflows = data;
      state.workflowsError = null;
      workflowList(state, root);
    });
    actions.append(run, del); row.append(actions, actionMessage); body.append(row);
  });
  shell.append(body, templateShelf(state, root, workflows)); root.append(shell);
}

/** Built-in automations (src/workflow-templates.js); installing saves an editable copy. */
function templateShelf(state, root, workflows) {
  const templates = state.workflowTemplates ?? [];
  const shelf = section('Templates', note('Switch one on to get an ordinary automation you can edit, pause or delete.'));
  if (state.workflowTemplatesError) shelf.append(note(state.workflowTemplatesError, 'danger'));
  if (!templates.length && !state.workflowTemplatesError) shelf.append(empty('Loading templates…'));
  state.templateMessages ??= {};
  for (const template of templates) {
    const installed = workflows.some((wf) => wf.template === template.id);
    const message = state.templateMessages[template.id];
    const install = button(installed ? 'Installed' : 'Switch on', async () => {
      install.disabled = true;
      let response;
      try { response = await post('workflows/install', { template: template.id }); }
      catch (error) { response = { ok: false, error: error?.message ?? 'The template was not installed.' }; }
      if (root.isConnected === false || root.dataset.automationEditor === '1') return;
      state.templateMessages[template.id] = response?.ok === false
        ? { text: `Not installed: ${response.error ?? 'unknown error'}`, failed: true }
        : { text: `Installed as “${response.workflow?.name ?? template.name}”. Edit it to change the time or recipient.` };
      await reload(state, root);
    }, installed ? '' : 'primary');
    install.disabled = installed;
    install.dataset.template = template.id;
    shelf.append(h('article', { class: 'workflow-row workflow-template' },
      h('div', {}, h('h3', { text: template.name }), h('p', { class: 'muted', text: template.description }),
        template.needs ? note(`Needs: ${template.needs}`) : null,
        message ? note(message.text, message.failed ? 'danger' : 'success') : null),
      h('div', { class: 'button-row' }, install)));
  }
  return shelf;
}

function editor(state, root, existing = null) {
  disposeEditor(root);
  root.dataset.automationEditor = '1';
  root.replaceChildren();
  const workflow = existing ? structuredClone(existing) : { name: '', trigger: { type: 'manual' }, nodes: [{ id: 'log', type: 'log', config: { message: 'hello from a new automation' } }], enabled: true };
  const shell = page('Automations', existing ? `Edit ${existing.name}` : 'Create an automation');
  const name = input(workflow.name, 'Automation name');
  const trigger = select(['manual', 'interval', 'daily', 'webhook', 'bus'].map((x) => [x, x]), workflow.trigger?.type);
  const detail = input('', 'Trigger detail');
  const enabled = check(workflow.enabled !== false);
  const detailField = field('Trigger detail', detail);
  const days = input(Array.isArray(workflow.trigger?.days) ? workflow.trigger.days.join(',') : '', 'Blank = every day; 1-5 = weekdays');
  const daysField = field('Days (0 = Sunday)', days);
  const detailPaint = () => { daysField.hidden = trigger.value !== 'daily'; detailField.hidden = !['interval', 'daily', 'bus'].includes(trigger.value); detail.placeholder = trigger.value === 'interval' ? 'Every N seconds' : trigger.value === 'daily' ? 'Time, e.g. 09:00' : 'Message pattern'; detail.value = trigger.value === 'interval' ? String((workflow.trigger?.everyMs ?? 60000) / 1000) : workflow.trigger?.[trigger.value === 'daily' ? 'at' : 'pattern'] ?? ''; };
  trigger.addEventListener('change', detailPaint); detailPaint();
  const form = section('Details', h('div', { class: 'form-grid' }, h('label', {}, h('span', { text: 'Name' }), name), h('label', {}, h('span', { text: 'Trigger' }), trigger), detailField, daysField, field('Enabled', enabled, 'Run when its trigger fires.')));
  const graphHost = h('div', { class: 'workflow-graph' });
  const inspector = h('div', { class: 'workflow-inspector' });
  const palette = h('div', { class: 'workflow-palette' });
  for (const type of Graph.PALETTE) palette.append(button(type, () => {
    const graphRect = graphHost.getBoundingClientRect();
    graph?.dropNew(type, graphRect.left + graphRect.width / 2, graphRect.top + graphRect.height / 2);
  }, 'chip'));
  let graph;
  const invalidFields = new Set();
  const paintInspector = (node) => {
    inspector.replaceChildren();
    if (!node) return;
    const spec = Graph.TYPES[node.type];
    inspector.append(h('h3', { text: `${node.type} · ${node.id}` }), note(spec?.blurb ?? 'Unknown node type.'));
    for (const [key, kind, options] of spec?.fields ?? []) {
      if (node.type === 'http' && key === 'body' && ['GET', 'HEAD'].includes(String(node.config?.method ?? 'GET').toUpperCase())) continue;
      const fieldKey = `${node.id}:${key}`;
      const control = kind === 'select' ? select(options, node.config?.[key]) : kind === 'json' ? textarea(node.config?.[key] ? JSON.stringify(node.config[key], null, 2) : '') : input(node.config?.[key] ?? '');
      if (kind === 'number') { control.type = 'number'; control.min = '0'; control.step = '1'; }
      control.addEventListener(kind === 'select' ? 'change' : 'input', () => {
        try {
          node.config ??= {};
          node.config[key] = kind === 'json' ? JSON.parse(control.value) : kind === 'number' ? Number(control.value) : control.value;
          invalidFields.delete(fieldKey);
          control.classList.remove('bad');
          graph.paint();
          if (key === 'method') invalidFields.delete(`${node.id}:body`);
          if (key === 'method') paintInspector(node);
        } catch {
          invalidFields.add(fieldKey);
          control.classList.add('bad');
        }
      });
      inspector.append(h('label', { class: 'field' }, h('span', { text: key }), control));
    }
  };
  graph = Graph.mount(graphHost, workflow.nodes, { onSelect: paintInspector, onChange: () => paintInspector(graph.selected()) });
  editorDisposals.set(root, () => graph?.destroy?.());
  const raw = textarea(JSON.stringify(workflow.nodes, null, 2));
  raw.setAttribute('aria-label', 'Workflow nodes JSON');
  const rawField = field('Nodes JSON', raw);
  rawField.hidden = true;
  const parseNodes = () => {
    const parsed = JSON.parse(raw.value);
    if (!Array.isArray(parsed)) throw new Error('Workflow nodes must be an array.');
    return parsed;
  };
  const toggle = button('Edit as JSON', () => {
    if (!rawField.hidden) {
      try {
        const parsed = parseNodes();
        workflow.nodes.splice(0, workflow.nodes.length, ...parsed);
        invalidFields.clear();
        graph.paint();
        paintInspector(graph.selected());
      } catch (error) {
        saveMessage.textContent = error.message ?? 'The workflow JSON is not valid.';
        saveMessage.hidden = false;
        return;
      }
    }
    rawField.hidden = !rawField.hidden;
    graphHost.hidden = !rawField.hidden;
    palette.hidden = !rawField.hidden;
    inspector.hidden = !rawField.hidden;
    if (!rawField.hidden) raw.value = JSON.stringify(workflow.nodes, null, 2);
  });
  const saveMessage = note('', 'danger');
  saveMessage.hidden = true;
  const save = button(existing ? 'Save' : 'Create', async () => {
    saveMessage.hidden = true;
    if (!name.value.trim()) { saveMessage.textContent = 'Give the automation a name first.'; saveMessage.hidden = false; return; }
    let nodes = workflow.nodes;
    if (!rawField.hidden) {
      try { nodes = parseNodes(); }
      catch (error) { saveMessage.textContent = error.message ?? 'The workflow JSON is not valid.'; saveMessage.hidden = false; return; }
    } else if (invalidFields.size) {
      saveMessage.textContent = 'Fix the invalid node fields before saving.';
      saveMessage.hidden = false;
      return;
    }
    const dayList = trigger.value === 'daily' ? parseDays(days.value) : null;
    if (dayList === false) { saveMessage.textContent = 'Days must be weekday numbers 0-6, like 1-5 or 1,3,5.'; saveMessage.hidden = false; return; }
    const triggerValue = trigger.value === 'interval' ? { type: 'interval', everyMs: Math.max(1, Number(detail.value) || 60) * 1000 } : trigger.value === 'daily' ? { type: 'daily', at: detail.value.trim(), ...(dayList ? { days: dayList } : {}) } : trigger.value === 'bus' ? { type: 'bus', pattern: detail.value.trim() } : { type: trigger.value };
    save.disabled = true;
    let result;
    // `template` rides along so an edited template still reads as installed.
    try { result = await post('workflows', { id: existing?.id, name: name.value.trim(), trigger: triggerValue, nodes, enabled: enabled.checked, ...(existing?.template ? { template: existing.template } : {}) }); }
    catch (error) { result = { ok: false, error: error?.message ?? 'The automation could not be saved.' }; }
    if (root.isConnected === false || root.dataset.automationEditor !== '1') return;
    if (result?.ok === false) {
      save.disabled = false;
      saveMessage.textContent = result.error ?? 'The automation could not be saved.';
      saveMessage.hidden = false;
      return;
    }
    let data;
    try { data = await get('/api/workflows'); }
    catch (error) { data = { ok: false, error: error?.message ?? 'Saved, but the automation list could not refresh.' }; }
    if (root.isConnected === false || root.dataset.automationEditor !== '1') return;
    if (data?.ok === false) {
      save.disabled = false;
      saveMessage.textContent = data.error ?? 'Saved, but the automation list could not refresh.';
      saveMessage.hidden = false;
      return;
    }
    state.workflows = data;
    state.workflowsError = null;
    workflowList(state, root);
  }, 'primary');
  shell.append(form, section('Graph', palette, h('div', { class: 'graph-shell' }, graphHost, inspector), rawField, h('div', { class: 'button-row' }, toggle, save, button('Back', () => workflowList(state, root))), saveMessage));
  root.append(shell);
}

export function renderAutomations(state, root) { workflowList(state, root); }
async function reload(state, root) {
  const token = requestToken(state, 'workflowsRequest');
  state.workflowsLoading = true;
  state.workflowsError = null;
  workflowList(state, root);
  let data;
  try { data = await get('/api/workflows'); }
  catch (error) { data = { ok: false, error: error?.message ?? 'Could not load automations.' }; }
  if (!state.workflowTemplates) {
    try {
      const shelf = await get('/api/workflows/templates');
      if (shelf?.ok === false) state.workflowTemplatesError = shelf.error ?? 'Could not load templates.';
      else { state.workflowTemplates = shelf.templates ?? []; state.workflowTemplatesError = null; }
    } catch (error) { state.workflowTemplatesError = error?.message ?? 'Could not load templates.'; }
  }
  if (root.isConnected === false || state.workflowsRequest !== token) {
    if (state.workflowsRequest === token) state.workflowsLoading = false;
    return;
  }
  state.workflowsLoading = false;
  if (data?.ok === false) state.workflowsError = data.error ?? 'Could not load automations.';
  else state.workflows = data;
  workflowList(state, root);
}
export function mountAutomations(state, root) {
  const off = subscribe(() => { if (root.isConnected && root.dataset.automationEditor !== '1') workflowList(state, root); });
  void reload(state, root);
  return () => { requestToken(state, 'workflowsRequest'); disposeEditor(root); off?.(); };
}
export const render = renderAutomations;
export const mount = mountAutomations;
