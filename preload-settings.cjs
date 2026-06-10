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
  },

  // On-device engine setup. probe = hardware hint + before-suggestion;
  // benchmark = download (if needed) + the real timed speed test; apply =
  // commit the chosen engine/model. onEngineProgress streams download/stage
  // updates while benchmark runs.
  engineProbe: () => ipcRenderer.invoke("engine:probe"),
  engineBenchmark: (opts) => ipcRenderer.invoke("engine:benchmark", opts),
  engineApply: (opts) => ipcRenderer.invoke("engine:apply", opts),
  onEngineProgress: (callback) => {
    ipcRenderer.on("engine:progress", (_event, p) => callback(p));
  }
});
