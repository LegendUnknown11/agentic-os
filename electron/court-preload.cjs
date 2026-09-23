// The one thing the throne room's own page cannot do: open a native folder
// picker. Everything else it already gets over HTTP/SSE like any other page —
// this bridge exists only so Code mode can ask for a repository on demand,
// instead of blocking the whole app behind a dialog before it can even open.
//
// CommonJS on purpose: package.json is "type": "module", so a .js preload
// would be parsed as ESM, which a sandboxed preload cannot be.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kingdomShell', {
  chooseRepo: () => ipcRenderer.invoke('repo:choose'),
  switchRepo: (path) => ipcRenderer.invoke('court:switchRepo', path),
  openPet: () => ipcRenderer.send('pet:open'),
  // Multiple courts at once (issue #42): list every live court, open (or
  // start) one for a repository WITHOUT ending the current court, and end
  // one by name. None of these touch the window this call was made from.
  listCourts: () => ipcRenderer.invoke('courts:list'),
  openCourt: (path) => ipcRenderer.invoke('courts:open', path),
  endCourt: (path) => ipcRenderer.invoke('courts:end', path),
});
