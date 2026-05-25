import "dotenv/config";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen } from "electron";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";
import { DictationSession } from "./src/dictation-session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

let mainWindow = null;
let pillWindow = null;
let dictationWindow = null;
let tray = null;
let serverPort = null;
let serverError = null;
let hotkeyEngine = null;
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
    const result = await startServer();
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
    if (!app.isQuitting) {
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
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
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

function setupIpc() {
  ipcMain.on("dictation:transcript", async (_event, transcript) => {
    const { releaseAt, sinceRelease } = dictation.finalize();
    console.error("[main] received transcript (" + sinceRelease + "ms after release):", JSON.stringify(transcript));
    hidePill();
    // NOTE: matches historical behavior — on an empty transcript we return
    // without calling dictation.done(), so `busy` stays true. The session is
    // unstuck only by the next successful press cycle. Pre-existing quirk;
    // worth fixing in a follow-up but out of scope for this refactor.
    if (!transcript || !transcript.trim()) return;

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
    if (textToType && !/[.!?…,;:"')\]]$/.test(textToType)) {
      textToType += ".";
    }

    try {
      const tType = Date.now();
      const { typeText } = await import("./src/typing.js");
      await typeText(textToType);
      const totalSinceRelease = Date.now() - releaseAt;
      console.error("[main] paste done (" + (Date.now() - tType) + "ms paste, " + totalSinceRelease + "ms total since release)");
    } catch (error) {
      console.error("[main] Typing failed:", error.stack || error.message);
    } finally {
      dictation.done();
    }
  });

  ipcMain.on("dictation:error", (_event, message) => {
    hidePill();
    dictation.done();
    console.error("Dictation error:", message);
  });
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
        app.isQuitting = true;
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
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            {
              label: "Quit Voice Dictation",
              accelerator: "Cmd+Q",
              click: () => { app.isQuitting = true; app.quit(); }
            }
          ]
        }]
      : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
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
  app.isQuitting = true;
  if (hotkeyEngine && typeof hotkeyEngine.stop === "function") {
    try { hotkeyEngine.stop(); } catch {}
  }
});
