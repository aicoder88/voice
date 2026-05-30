// @ts-check
// Bridge for the backup-error pop-up window. Exposes just enough to retry the
// saved recording and to close the window. Playback is handled by a plain
// <audio> element in the page pointing at the served WAV — no IPC needed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("backupBridge", {
  retry: (name) => ipcRenderer.invoke("backup:retry", name),
  close: () => ipcRenderer.send("backup:close")
});
