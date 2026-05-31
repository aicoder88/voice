// @ts-check
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictationBridge", {
  sendError: (message) => ipcRenderer.send("dictation:error", message),
  sendMicWarning: (message) => ipcRenderer.send("dictation:mic-warning", message),
  sendTranscript: (text) => ipcRenderer.send("dictation:transcript", text),
  reportFailure: (payload) => ipcRenderer.send("dictation:failure", payload),
  onStart: (callback) => {
    ipcRenderer.on("dictation:start", (_event, profile) => callback(profile));
  },
  onStop: (callback) => {
    ipcRenderer.on("dictation:stop", () => callback());
  }
});
