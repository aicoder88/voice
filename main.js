// @ts-check
import "dotenv/config";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen } from "electron";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  const stack = reason && typeof reason === "object" && "stack" in reason ? reason.stack : reason;
  console.error("[unhandledRejection]", stack);
});
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";
import { DictationSession } from "./src/dictation-session.js";
import { saveBackup, readBackupPcm, deleteBackup, retranscribe, pruneBackups } from "./src/backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let pillWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let dictationWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let backupWindow = null;
/** @type {string | null} */
let recordingsDir = null;
/** @type {import("electron").Tray | null} */
let tray = null;
/** @type {number | null} */
let serverPort = null;
/** @type {string | null} */
let serverError = null;
/** @type {{ stop: () => void } | null} */
let hotkeyEngine = null;
let isQuitting = false;
const dictation = new DictationSession();

const TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOUlEQVR42mNk+M9AGWAcNWBYGsCITwOyOAsmZ2NjI4SmaBgFRMxQB0YBh4ABjPgsoEoYUMUFVAlFAGZNCY+vXVwLAAAAAElFTkSuQmCC";

function makeTrayIcon() {
  try {
    const buf = Buffer.from(TRAY_PNG_BASE64, "base64");
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) return img;
  } catch {}
  return nativeImage.createEmpty();
}

async function bootRelayServer() {
  if (!process.env.OPENAI_API_KEY) {
    serverError = `Missing OPENAI_API_KEY in ${envPath}`;
    return null;
  }
  try {
    const result = await startServer({ recordingsDir });
    serverPort = result.port;
    return result;
  } catch (error) {
    serverError = error.message || String(error);
    return null;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    title: "Voice Dictation",
    backgroundColor: "#101820",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (serverPort) {
    mainWindow.loadURL(`http://localhost:${serverPort}/setup.html`);
  } else {
    mainWindow.loadFile(join(__dirname, "public", "setup.html"), {
      query: { error: serverError || "Server not started" }
    });
  }

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createPillWindow() {
  pillWindow = new BrowserWindow({
    width: 180,
    height: 56,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  pillWindow.setAlwaysOnTop(true, "screen-saver");
  pillWindow.setIgnoreMouseEvents(true);

  if (serverPort) {
    pillWindow.loadURL(`http://localhost:${serverPort}/pill.html`);
  } else {
    pillWindow.loadFile(join(__dirname, "public", "pill.html"));
  }
}

function createDictationWindow() {
  if (!serverPort) return;
  dictationWindow = new BrowserWindow({
    width: 400,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs")
    }
  });
  dictationWindow.webContents.on("console-message", (_e, level, message) => {
    console.error("[dictation/renderer]", message);
  });
  const provider = encodeURIComponent((process.env.STT_PROVIDER || "openai").toLowerCase());
  dictationWindow.loadURL(`http://localhost:${serverPort}/dictation.html?provider=${provider}`);
}

function showPillNearCursor() {
  if (!pillWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const x = Math.min(cursor.x + 16, display.bounds.x + display.bounds.width - 200);
  const y = Math.min(cursor.y + 16, display.bounds.y + display.bounds.height - 80);
  pillWindow.setBounds({ x, y, width: 180, height: 56 });
  pillWindow.showInactive();
}

function hidePill() {
  if (pillWindow && pillWindow.isVisible()) {
    pillWindow.hide();
  }
}

async function setupHotkey() {
  if (!serverPort || !dictationWindow) return;
  try {
    const mod = await import("./src/hotkey.js");
    hotkeyEngine = mod.startHotkey({
      onPress: () => {
        if (!dictation.tryStart()) return;
        console.error("[main] dictation:start");
        showPillNearCursor();
        dictationWindow.webContents.send("dictation:start");
      },
      onRelease: () => {
        if (!dictation.release()) return;
        console.error("[main] dictation:stop");
        dictationWindow.webContents.send("dictation:stop");
        hidePill();
      }
    });
    const keyLabel = process.platform === "darwin" ? "right Option (⌥)" : "right Alt";
    console.log(`Global ${keyLabel} hotkey active (hold to dictate).`);
  } catch (error) {
    console.error("Failed to start global hotkey:", error.message);
    console.error("Run: npm install uiohook-napi");
  }
}

// Clean up a raw transcript (optional LLM polish + trailing punctuation) and
// type it into the focused app. Shared by the live dictation path and the
// backup retry path. Returns the text that was typed, or null if there was
// nothing to type.
//
// @param {string} transcript
// @returns {Promise<string | null>}
async function processTranscript(transcript) {
  if (!transcript || !transcript.trim()) return null;
  let textToType = transcript.trim();

  const cleanupEnabled = process.env.CLEANUP_ENABLED !== "false";
  const commaCount = (textToType.match(/,/g) || []).length;
  const needsCleanup =
    textToType.length > 120 ||
    /\b(uh|um|uhh|er|erm)\b/i.test(textToType) ||
    !/[.!?…]$/.test(textToType) ||
    /\b(first|second|third|fourth|fifth|next,|finally,)\b/i.test(textToType) ||
    commaCount >= 4;
  if (cleanupEnabled && needsCleanup) {
    const t0 = Date.now();
    try {
      const { polishTranscript } = await import("./src/cleanup.js");
      textToType = await polishTranscript(textToType);
      console.error("[main] cleanup done (" + (Date.now() - t0) + "ms):", JSON.stringify(textToType));
    } catch (error) {
      console.error("[main] Cleanup pass failed, using raw:", error.message);
    }
  } else {
    console.error("[main] cleanup SKIPPED (short/clean, length=" + textToType.length + ")");
  }

  textToType = (textToType || "").trim();
  if (!textToType) return null;
  if (!/[.!?…,;:"')\]]$/.test(textToType)) {
    textToType += ".";
  }

  const tType = Date.now();
  const { typeText } = await import("./src/typing.js");
  await typeText(textToType);
  console.error("[main] paste done (" + (Date.now() - tType) + "ms paste)");
  return textToType;
}

function setupIpc() {
  ipcMain.on("dictation:transcript", async (_event, transcript) => {
    const { releaseAt, sinceRelease } = dictation.finalize();
    console.error("[main] received transcript (" + sinceRelease + "ms after release):", JSON.stringify(transcript));
    hidePill();
    // Empty transcript = silence or a filtered hallucination. Reopen the
    // session immediately (don't wait on the safety timer) so the next press
    // works right away — empties are now common by design (silence gate +
    // hallucination filter), so a stuck `busy` flag would be felt constantly.
    if (!transcript || !transcript.trim()) {
      dictation.done();
      return;
    }

    try {
      await processTranscript(transcript);
      console.error("[main] total since release: " + (Date.now() - releaseAt) + "ms");
    } catch (error) {
      console.error("[main] Typing failed:", error.stack || error.message);
    } finally {
      dictation.done();
    }
  });

  // A dictation couldn't be transcribed but audio was captured. Save it and
  // open the pop-up offering Retry / Play so the recording is never lost.
  ipcMain.on("dictation:failure", async (_event, payload) => {
    dictation.finalize();
    hidePill();
    dictation.done();
    try {
      const chunks = (payload && payload.chunks) || [];
      const pcm = Buffer.concat(chunks.map((b64) => Buffer.from(b64, "base64")));
      const { name } = await saveBackup({
        dir: recordingsDir,
        pcm,
        timestamp: Date.now(),
        sampleRate: payload && payload.sampleRate
      });
      console.error("[main] dictation backup saved:", name, "(" + pcm.length + " bytes)");
      openBackupWindow(name, (payload && payload.reason) || "Transcription failed.");
    } catch (error) {
      console.error("[main] Failed to save dictation backup:", error.stack || error.message);
    }
  });

  // Retry: re-transcribe a saved recording through the relay. On success, type
  // it in and delete the backup. Returns a result the pop-up shows the user.
  ipcMain.handle("backup:retry", async (_event, name) => {
    if (!recordingsDir || !name) return { ok: false, reason: "Recording not found." };
    if (!serverPort) return { ok: false, reason: "The transcriber isn't running." };
    const path = join(recordingsDir, name);
    try {
      const pcm = await readBackupPcm(path);
      const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
      const transcript = await retranscribe(pcm, { host: `127.0.0.1:${serverPort}`, provider });
      if (!transcript || !transcript.trim()) {
        return { ok: false, reason: "Still couldn't make out any speech. Try playing it back." };
      }
      const typed = await processTranscript(transcript);
      if (!typed) return { ok: false, reason: "Nothing to type after cleanup." };
      await deleteBackup(path);
      console.error("[main] backup retry succeeded, deleted:", name);
      return { ok: true, transcript: typed };
    } catch (error) {
      console.error("[main] backup retry failed:", error.message);
      return { ok: false, reason: error.message || "Retry failed." };
    }
  });

  ipcMain.on("backup:close", () => {
    if (backupWindow && !backupWindow.isDestroyed()) backupWindow.hide();
  });

  ipcMain.on("dictation:error", (_event, message) => {
    hidePill();
    dictation.done();
    console.error("Dictation error:", message);
  });
}

// Show the backup pop-up for a saved recording. Recreated each failure so the
// query params (file + reason) are fresh; a prior window is replaced.
function openBackupWindow(name, reason) {
  if (!serverPort) return;
  if (backupWindow && !backupWindow.isDestroyed()) {
    backupWindow.destroy();
    backupWindow = null;
  }
  backupWindow = new BrowserWindow({
    width: 440,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Dictation saved",
    backgroundColor: "#101820",
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-backup.cjs")
    }
  });
  const q = `file=${encodeURIComponent(name)}&msg=${encodeURIComponent(reason)}`;
  backupWindow.loadURL(`http://localhost:${serverPort}/backup-error.html?${q}`);
  backupWindow.on("closed", () => { backupWindow = null; });
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip("Voice Dictation - hold right-Alt to dictate");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: serverPort ? `Relay: http://localhost:${serverPort}` : "Relay: not running",
      enabled: !!serverPort,
      click: () => serverPort && shell.openExternal(`http://localhost:${serverPort}`)
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: /** @type {import("electron").MenuItemConstructorOptions[]} */ ([
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            {
              label: "Quit Voice Dictation",
              accelerator: "Cmd+Q",
              click: () => { isQuitting = true; app.quit(); }
            }
          ])
        }]
      : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  recordingsDir = join(app.getPath("userData"), "recordings");
  // Clear out recordings older than a week so dismissed/played-back backups
  // don't accumulate. Successful retries already delete their own file.
  const BACKUP_RETENTION_MS = Number(process.env.BACKUP_RETENTION_DAYS || 7) * 24 * 60 * 60 * 1000;
  pruneBackups(recordingsDir, BACKUP_RETENTION_MS, Date.now())
    .then((n) => { if (n) console.error("[main] pruned " + n + " old dictation backup(s)"); })
    .catch(() => {});
  await bootRelayServer();
  buildAppMenu();
  createMainWindow();
  createTray();
  if (serverPort) {
    createPillWindow();
    createDictationWindow();
    dictationWindow.webContents.once("did-finish-load", () => {
      setupHotkey();
    });
  }
  setupIpc();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (hotkeyEngine && typeof hotkeyEngine.stop === "function") {
    try { hotkeyEngine.stop(); } catch {}
  }
});
