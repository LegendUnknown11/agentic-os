import { renderApprovals, mountApprovals } from './approvals.js';
import { renderChanges, mountChanges, changeStage, pushState } from './changes.js';
import { renderUsage, mountUsage } from './usage.js';
import { renderActivity, mountActivity } from './activity.js';
import { renderMessages, mountMessages } from './messages.js';
import { renderAgents, mountAgents } from './agents.js';
import { renderObjective, mountObjective } from './objective.js';
import { renderMemory, mountMemory } from './memory.js';
import { renderNotes, mountNotes } from './notes.js';
import { renderDoctor, mountDoctor } from './doctor.js';
import { renderTasks, mountTasks } from './tasks.js';
import { renderInbox, mountInbox } from './inbox.js';

// Compatibility exports keep older callers stable while each view owns its implementation.
export {
  changeStage, mountApprovals, mountChanges, mountActivity, mountAgents, mountDoctor,
  mountInbox, mountMemory, mountMessages, mountNotes, mountObjective, mountTasks, mountUsage,
  pushState, renderApprovals, renderChanges, renderActivity, renderAgents, renderDoctor,
  renderInbox, renderMemory, renderMessages, renderNotes, renderObjective, renderTasks, renderUsage,
};

export const VIEW_RENDERERS = {
  approvals: renderApprovals,
  changes: renderChanges,
  usage: renderUsage,
  activity: renderActivity,
  messages: renderMessages,
  agents: renderAgents,
  objective: renderObjective,
  memory: renderMemory,
  notes: renderNotes,
  doctor: renderDoctor,
  tasks: renderTasks,
  inbox: renderInbox,
};

export const VIEW_MOUNTS = {
  approvals: mountApprovals,
  changes: mountChanges,
  usage: mountUsage,
  activity: mountActivity,
  messages: mountMessages,
  agents: mountAgents,
  objective: mountObjective,
  memory: mountMemory,
  notes: mountNotes,
  doctor: mountDoctor,
  tasks: mountTasks,
  inbox: mountInbox,
};

