// @ts-check
// Bridge for the floating status pill. The pill is otherwise a passive,
// click-through window; on the success/error states main.js enables mouse
// events and the renderer calls back here to copy the transcript, open the
// temporary recording, or dismiss the pill early.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pillBridge", {
  // main pushes { state, canCopy, canOpen } on every state change.
  onState: (callback) => ipcRenderer.on("pill:state", (_event, data) => callback(data)),
  copy: () => ipcRenderer.send("pill:copy"),
  openRecording: () => ipcRenderer.send("pill:open"),
  hide: () => ipcRenderer.send("pill:hide"),
  // True while the pointer is over the visible pill: main flips the window
  // out of click-through so the buttons work; the transparent margins of the
  // fixed-size window stay click-through the rest of the time.
  setInteractive: (on) => ipcRenderer.send("pill:set-interactive", !!on)
});
