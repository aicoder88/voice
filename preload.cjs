// @ts-check
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictationBridge", {
  sendError: (message) => ipcRenderer.send("dictation:error", message),
  sendMicWarning: (message) => ipcRenderer.send("dictation:mic-warning", message),
  // payload is { text, chunks, sampleRate } on a real transcript, or "" for a
  // server-decided empty (silence / hallucination filter).
  sendTranscript: (payload) => ipcRenderer.send("dictation:transcript", payload),
  reportFailure: (payload) => ipcRenderer.send("dictation:failure", payload),
  onStart: (callback) => {
    ipcRenderer.on("dictation:start", (_event, profile) => callback(profile));
  },
  onStop: (callback) => {
    ipcRenderer.on("dictation:stop", () => callback());
  },
  // main asks the renderer to rebuild its whole mic pipeline (system wake).
  onRebuildCapture: (callback) => {
    ipcRenderer.on("dictation:rebuild-capture", (_event, reason) => callback(reason));
  }
});
