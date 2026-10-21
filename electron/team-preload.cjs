// The one thing the dashboard's own page cannot do: open a native folder
// picker. Everything else it already gets over HTTP/SSE like any other page —
// this bridge exists only so Code mode can ask for a repository on demand,
// instead of blocking the whole app behind a dialog before it can even open.
//
// CommonJS on purpose: package.json is "type": "module", so a .js preload
// would be parsed as ESM, which a sandboxed preload cannot be.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agenticosShell', {
  chooseRepo: () => ipcRenderer.invoke('repo:choose'),
  switchRepo: (path) => ipcRenderer.invoke('team:switchRepo', path),
  openPet: () => ipcRenderer.send('pet:open'),
  // Multiple teams at once (issue #42): list every live team, open (or
  // start) one for a repository WITHOUT ending the current team, and end
  // one by name. None of these touch the window this call was made from.
  listTeams: () => ipcRenderer.invoke('teams:list'),
  // Existing teams are addressed by port (a repo-less team has no path);
  // openTeam(path) starts, or focuses, the team for a repository.
  openTeam: (path) => ipcRenderer.invoke('teams:open', path),
  focusTeam: (port) => ipcRenderer.invoke('teams:focus', port),
  endTeam: (port) => ipcRenderer.invoke('teams:end', port),
});
