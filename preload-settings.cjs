// @ts-check
// Bridge for the settings window (tray → "Settings…", and first-run auto-open).
// Request/response over ipcRenderer.invoke so the renderer always re-renders
// from the authoritative view main returns after a save.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settingsBridge", {
  get: () => ipcRenderer.invoke("settings:get"),
  save: (view) => ipcRenderer.invoke("settings:save", view),
  clearRecordings: () => ipcRenderer.invoke("settings:clear-recordings"),
  // First-run welcome / "what's missing" note pushed by main on open.
  onIntro: (callback) => {
    ipcRenderer.on("settings:intro", (_event, intro) => callback(intro));
  }
});
