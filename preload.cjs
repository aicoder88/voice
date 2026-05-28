// @ts-check
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictationBridge", {
  sendError: (message) => ipcRenderer.send("dictation:error", message),
  sendTranscript: (text) => ipcRenderer.send("dictation:transcript", text),
  onStart: (callback) => {
    ipcRenderer.on("dictation:start", (_event, profile) => callback(profile));
  },
  onStop: (callback) => {
    ipcRenderer.on("dictation:stop", () => callback());
  }
});
