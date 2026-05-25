import "dotenv/config";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen } from "electron";
import { spawn } from "node:child_process";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

let mainWindow = null;
let pillWindow = null;
let dictationWindow = null;
let tray = null;
let serverPort = null;
let serverError = null;
let hotkeyEngine = null;
let whisperServerProc = null;

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

async function bootWhisperServer() {
  if ((process.env.STT_PROVIDER || "").toLowerCase() !== "whisper-local") return;
  const bin = process.env.WHISPER_CLI ? process.env.WHISPER_CLI.replace(/-cli$/, "-server") : "whisper-server";
  const model = process.env.WHISPER_MODEL || "./models/ggml-base.en.bin";
  const port = process.env.WHISPER_PORT || "8081";
  const args = [
    "-m", model,
    "--host", "127.0.0.1",
    "--port", port,
    "-t", "4",
    "--no-fallback"
  ];
  whisperServerProc = spawn(bin, args);
  let spawnError = null;
  whisperServerProc.on("error", (err) => {
    spawnError = err;
    console.error("[whisper-server] spawn error:", err.message);
    whisperServerProc = null;
  });
  whisperServerProc.stderr?.on("data", (d) => {
    const s = d.toString();
    if (/error|fail/i.test(s)) console.error("[whisper-server]", s.trim());
  });
  whisperServerProc.on("exit", (code) => {
    console.error("[whisper-server] exited with code " + code);
    whisperServerProc = null;
  });
  process.env.WHISPER_SERVER_URL = `http://127.0.0.1:${port}/inference`;
  await waitForServer(`http://127.0.0.1:${port}`, 10000, () => spawnError || (whisperServerProc === null ? new Error("whisper-server died before ready") : null));
  console.error("[whisper-server] ready at " + process.env.WHISPER_SERVER_URL);
}

async function waitForServer(baseUrl, timeoutMs, abortCheck) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const fatal = abortCheck && abortCheck();
    if (fatal) throw fatal;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 500);
      try {
        const res = await fetch(baseUrl, { signal: ctrl.signal });
        if (res.status < 600) return;
      } finally {
        clearTimeout(timer);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("whisper-server did not start within " + timeoutMs + "ms");
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
        if (global.__dictationBusy) {
          console.error("[main] PRESS ignored — previous dictation still processing");
          return;
        }
        clearTimeout(global.__dictationBusyTimer);
        global.__dictationBusy = true;
        global.__dictationPressAt = Date.now();
        console.error("[main] dictation:start");
        showPillNearCursor();
        dictationWindow.webContents.send("dictation:start");
      },
      onRelease: () => {
        if (!global.__dictationBusy) return;
        global.__dictationReleaseAt = Date.now();
        console.error("[main] dictation:stop");
        dictationWindow.webContents.send("dictation:stop");
        hidePill();
        clearTimeout(global.__dictationBusyTimer);
        global.__dictationBusyTimer = setTimeout(() => {
          if (global.__dictationBusy) {
            console.error("[main] dictation:busy safety timeout — clearing");
            global.__dictationBusy = false;
          }
        }, 1500);
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
    clearTimeout(global.__dictationBusyTimer);
    const releaseAt = global.__dictationReleaseAt || Date.now();
    const sinceRelease = Date.now() - releaseAt;
    console.error("[main] received transcript (" + sinceRelease + "ms after release):", JSON.stringify(transcript));
    hidePill();
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
      global.__dictationBusy = false;
    }
  });

  ipcMain.on("dictation:error", (_event, message) => {
    hidePill();
    global.__dictationBusy = false;
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
  try { await bootWhisperServer(); } catch (e) { console.error("[main] whisper-server failed:", e.message); }
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
  if (whisperServerProc) {
    try { whisperServerProc.kill("SIGTERM"); } catch {}
  }
});
