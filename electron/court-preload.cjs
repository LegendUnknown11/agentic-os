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
});
