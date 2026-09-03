import * as Graph from '../graph.js';
import { h, page, section, empty, note, button, field, input, select, textarea, check, modeAllows, get, post, subscribe } from './util.js';

const editorDisposals = new WeakMap();
const requestToken = (state) => { state.workflowsRequest = (state.workflowsRequest ?? 0) + 1; return state.workflowsRequest; };
function disposeEditor(root) {
  editorDisposals.get(root)?.();
  editorDisposals.delete(root);
}

const triggerText = (trigger = {}) => ({
  interval: `every ${Math.round((trigger.everyMs ?? 0) / 1000)}s`,
  daily: `daily at ${trigger.at ?? '?'}`,
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
  else if (!workflows.length) body.append(empty('No automations yet.'));
  workflows.forEach((workflow) => {
    const row = h('article', { class: 'workflow-row' }, h('div', {}, h('h3', { text: workflow.name }), h('p', { class: 'muted', text: triggerText(workflow.trigger) })), workflow.enabled === false && note('disabled'));
    const actions = h('div', { class: 'button-row' });
    const actionMessage = note('', 'workflow-run-message workflow-action-message');
    actionMessage.hidden = true;
    const showAction = (message, failed = false) => {
      actionMessage.className = `note workflow-run-message workflow-action-message ${failed ? 'danger' : 'success'}`;
      actionMessage.textContent = message;
      actionMessage.hidden = false;
    };
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
    const del = button('Delete', async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Confirm delete'; return; }
      del.disabled = true;
      let response;
      try { response = await post('workflows/delete', { id: workflow.id }); }
      catch (error) { response = { ok: false, error: error?.message ?? 'the automation was not removed.' }; }
      if (root.isConnected === false || root.dataset.automationEditor === '1') return;
      if (response?.ok === false) {
        del.disabled = false;
        delete del.dataset.armed;
        del.textContent = 'Delete';
        showAction(`Delete failed: ${response.error ?? 'the automation was not removed.'}`, true);
        return;
      }
      let data;
      try { data = await get('/api/workflows'); }
      catch (error) { data = { ok: false, error: error?.message ?? 'Deleted, but the automation list could not refresh.' }; }
      if (root.isConnected === false || root.dataset.automationEditor === '1') return;
      if (data?.ok === false) {
        del.disabled = false;
        showAction(data.error ?? 'Deleted, but the automation list could not refresh.', true);
        return;
      }
      state.workflows = data;
      state.workflowsError = null;
      workflowList(state, root);
    });
    actions.append(run, del); row.append(actions, actionMessage); body.append(row);
  });
  shell.append(body); root.append(shell);
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
  const detailPaint = () => { detailField.hidden = !['interval', 'daily', 'bus'].includes(trigger.value); detail.placeholder = trigger.value === 'interval' ? 'Every N seconds' : trigger.value === 'daily' ? 'Time, e.g. 09:00' : 'Message pattern'; detail.value = trigger.value === 'interval' ? String((workflow.trigger?.everyMs ?? 60000) / 1000) : workflow.trigger?.[trigger.value === 'daily' ? 'at' : 'pattern'] ?? ''; };
  trigger.addEventListener('change', detailPaint); detailPaint();
  const form = section('Details', h('div', { class: 'form-grid' }, h('label', {}, h('span', { text: 'Name' }), name), h('label', {}, h('span', { text: 'Trigger' }), trigger), detailField, field('Enabled', enabled, 'Run when its trigger fires.')));
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
    const triggerValue = trigger.value === 'interval' ? { type: 'interval', everyMs: Math.max(1, Number(detail.value) || 60) * 1000 } : trigger.value === 'daily' ? { type: 'daily', at: detail.value.trim() } : trigger.value === 'bus' ? { type: 'bus', pattern: detail.value.trim() } : { type: trigger.value };
    save.disabled = true;
    let result;
    try { result = await post('workflows', { id: existing?.id, name: name.value.trim(), trigger: triggerValue, nodes, enabled: enabled.checked }); }
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
  const token = requestToken(state);
  state.workflowsLoading = true;
  state.workflowsError = null;
  workflowList(state, root);
  let data;
  try { data = await get('/api/workflows'); }
  catch (error) { data = { ok: false, error: error?.message ?? 'Could not load automations.' }; }
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
  return () => { requestToken(state); disposeEditor(root); off?.(); };
}
export const render = renderAutomations;
export const mount = mountAutomations;
