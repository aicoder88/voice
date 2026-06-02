// @ts-check
// Bridge for the dictionary manager window (tray → "Manage dictionary…").
// Request/response over ipcRenderer.invoke so the renderer always re-renders
// from the authoritative list main returns after each change.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictBridge", {
  list: () => ipcRenderer.invoke("vocab:list"),
  // `text` may be a single word or several separated by commas / newlines.
  add: (text) => ipcRenderer.invoke("vocab:add-many", text),
  remove: (term) => ipcRenderer.invoke("vocab:remove", term)
});
