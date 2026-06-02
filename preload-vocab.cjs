// @ts-check
// Bridge for the "add to dictionary?" pop-up that appears at the cursor after a
// dictation. The window is non-focusable and always-on-top (like the pill);
// main.js enables mouse events so the Add / No-thanks buttons are clickable
// without stealing focus from whatever the user is typing into.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vocabBridge", {
  // main pushes { term, reason } when a candidate is found.
  onPrompt: (callback) => ipcRenderer.on("vocab:prompt", (_event, data) => callback(data)),
  add: (term) => ipcRenderer.send("vocab:add", term),
  dismiss: (term) => ipcRenderer.send("vocab:dismiss", term)
});
