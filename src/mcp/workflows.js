// workflows tools. See src/mcp.js for how these reach a member.
import { listWorkflows, saveWorkflow, deleteWorkflow, runWorkflow, logRun } from '../workflows.js';
import { join } from 'node:path';
import {
  bus, WORKFLOWS_DIR, str,
} from './ctx.js';

export const workflows = {
  workflow_list: {
    roles: ['orchestrator'],
    description: 'List every saved automation, with its trigger and node count.',
    schema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const all = await listWorkflows(WORKFLOWS_DIR);
      if (!all.length) return 'No automations saved yet.';
      return all.map((w) =>
        `${w.id} "${w.name}" — trigger:${w.trigger?.type ?? 'manual'}, ${w.nodes?.length ?? 0} nodes` +
        (w.enabled === false ? ' (disabled)' : '')).join('\n');
    },
  },

  workflow_get: {
    roles: ['orchestrator'],
    description: 'Read one automation\'s full node graph and trigger, to edit or debug it.',
    schema: { type: 'object', properties: { id: str('Workflow id') }, required: ['id'] },
    run: async ({ id }) => {
      const wf = (await listWorkflows(WORKFLOWS_DIR)).find((w) => w.id === id);
      return wf ? JSON.stringify(wf, null, 2) : `No workflow "${id}".`;
    },
  },

  workflow_save: {
    roles: ['orchestrator'],
    description:
      'Create or overwrite an automation. Omit id to create a new one; pass an ' +
      'existing id to edit it in place. See the mode instructions for the node ' +
      'and trigger vocabulary.',
    schema: {
      type: 'object',
      properties: {
        id: str('Existing workflow id to overwrite (optional — a new one is generated if omitted)'),
        name: str('Short human name'),
        nodes: {
          type: 'array',
          description: 'The node graph, first entry is the start node',
          items: { type: 'object' },
        },
        trigger: {
          type: 'object',
          description: '{type: "manual"|"interval"|"webhook"|"bus", ...its own config}',
        },
        enabled: { type: 'boolean', description: 'Default true; set false to save without scheduling it' },
      },
      required: ['name', 'nodes', 'trigger'],
    },
    run: async ({ id, name, nodes, trigger, enabled }) => {
      const wf = { id: id || `wf-${Date.now()}`, name, nodes, trigger, ...(enabled === undefined ? {} : { enabled }) };
      await saveWorkflow(WORKFLOWS_DIR, wf);
      return `Saved ${wf.id} "${wf.name}" (trigger: ${wf.trigger?.type}, ${wf.nodes.length} nodes).`;
    },
  },

  workflow_delete: {
    roles: ['orchestrator'],
    description: 'Delete an automation permanently.',
    schema: { type: 'object', properties: { id: str('Workflow id') }, required: ['id'] },
    run: async ({ id }) => {
      await deleteWorkflow(WORKFLOWS_DIR, id);
      return `Deleted ${id}.`;
    },
  },

  workflow_run: {
    roles: ['orchestrator'],
    description: 'Run an automation now, regardless of its trigger, and report what actually happened.',
    schema: { type: 'object', properties: { id: str('Workflow id') }, required: ['id'] },
    run: async ({ id }) => {
      const wf = (await listWorkflows(WORKFLOWS_DIR)).find((w) => w.id === id);
      if (!wf) return `No workflow "${id}".`;
      const result = await runWorkflow(wf, { bus });
      if (bus) logRun(bus, wf, result);
      const lines = result.steps.map((s) => `  ${s.ok ? 'ok' : 'FAIL'} ${s.id}${s.error ? `: ${s.error}` : ''}`);
      return `${result.ok ? 'Succeeded' : 'Failed'} (${result.steps.length} steps):\n${lines.join('\n')}`;
    },
  },
};
