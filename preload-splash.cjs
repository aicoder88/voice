// @ts-check
// Bridge for the boot splash. main.js pushes { state, message } as it works
// through startup (relay → speech engine → ready), and the renderer swaps the
// status line / look. The exit animation (shrink toward the tray) is driven
// from the main process by moving this window's bounds, so there's nothing to
// call back for here — it's receive-only.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("splashBridge", {
  onStatus: (callback) => ipcRenderer.on("splash:status", (_event, data) => callback(data))
});
