import "dotenv/config";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { startServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(__dirname, "preload.cjs");

let mainWindow = null;
let pillWindow = null;
let dictationWindow = null;
let tray = null;
let serverPort = null;
let serverError = null;
let hotkeyEngine = null;

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
    serverError = "Missing OPENAI_API_KEY in C:\\dev\\voice\\.env";
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
      sandbox: true,
      preload: existsSync(preloadPath) ? preloadPath : undefined
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
  dictationWindow.loadURL(`http://localhost:${serverPort}/dictation.html`);
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
        showPillNearCursor();
        dictationWindow.webContents.send("dictation:start");
      },
      onRelease: () => {
        dictationWindow.webContents.send("dictation:stop");
      }
    });
    console.log("Global right-Alt hotkey active (hold to dictate).");
  } catch (error) {
    console.error("Failed to start global hotkey:", error.message);
    console.error("Run: npm install uiohook-napi");
  }
}

function setupIpc() {
  ipcMain.on("dictation:transcript", async (_event, transcript) => {
    hidePill();
    if (!transcript || !transcript.trim()) return;

    let textToType = transcript.trim();

    const cleanupEnabled = process.env.CLEANUP_ENABLED !== "false";
    if (cleanupEnabled) {
      try {
        const { polishTranscript } = await import("./src/cleanup.js");
        textToType = await polishTranscript(textToType);
      } catch (error) {
        console.error("Cleanup pass failed, using raw transcript:", error.message);
      }
    }

    try {
      const { typeText } = await import("./src/typing.js");
      await typeText(textToType);
    } catch (error) {
      console.error("Typing failed:", error.message);
      console.error("Run: npm install @nut-tree-fork/nut-js");
    }
  });

  ipcMain.on("dictation:error", (_event, message) => {
    hidePill();
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

app.whenReady().then(async () => {
  await bootRelayServer();
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
    try {
      hotkeyEngine.stop();
    } catch {}
  }
});
