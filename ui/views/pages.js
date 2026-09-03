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

// Compatibility exports keep older callers stable while each view owns its implementation.
export {
  changeStage, mountApprovals, mountChanges, mountActivity, mountAgents, mountDoctor,
  mountMemory, mountMessages, mountNotes, mountObjective, mountUsage,
  pushState, renderApprovals, renderChanges, renderActivity, renderAgents, renderDoctor,
  renderMemory, renderMessages, renderNotes, renderObjective, renderUsage,
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
};

