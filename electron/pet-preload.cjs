// The only things the floating dog cannot do from a page: move his own window,
// resize it, and put himself away. Everything else — what the team is doing —
// he gets over HTTP like any other page.
//
// Dragging is driven ENTIRELY by the main process, from the OS cursor. The
// renderer only says when a drag starts and stops, and is told afterwards
// whether the dog actually travelled. See the comment on pet:dragStart.
//
// CommonJS on purpose: package.json is "type": "module", so a .js preload
// would be parsed as ESM, which a sandboxed preload cannot be.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agenticosPet', {
  state: () => ipcRenderer.invoke('pet:state'),
  dragStart: () => ipcRenderer.send('pet:dragStart'),
  dragEnd: () => ipcRenderer.invoke('pet:dragEnd'),
  scale: (s) => ipcRenderer.send('pet:scale', s),
  hide: () => ipcRenderer.send('pet:hide'),
});
