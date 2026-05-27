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
import { captureForegroundWindow, restoreForegroundWindow } from "./src/foreground.js";
import { appendFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let pillWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let dictationWindow = null;
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

const DEBUG_LOG = join(__dirname, "debug.log");
function dlog(/** @type {string} */ tag, /** @type {unknown} */ data) {
  try {
    const line = `[${new Date().toISOString()}] ${tag} ${typeof data === "string" ? data : JSON.stringify(data)}\n`;
    appendFileSync(DEBUG_LOG, line);
  } catch {}
}

/** @type {number | null} */
let savedForegroundHwnd = null;

// Whisper "non-speech" tokens that the model emits for music, applause,
// keyboard noise, silence, etc. These are model artifacts, not speech the
// user wants pasted. Strip them before the cleanup pass.
const NOISE_TOKEN_PATTERNS = [
  /\[\s*music[^\]]*\]/gi,
  /\[\s*applause[^\]]*\]/gi,
  /\[\s*laughter[^\]]*\]/gi,
  /\[\s*silence[^\]]*\]/gi,
  /\[\s*sounds?\s+of[^\]]*\]/gi,
  /\[\s*background\s+noise[^\]]*\]/gi,
  /\(\s*music[^)]*\)/gi,
  /\(\s*applause[^)]*\)/gi,
  /\(\s*laughter[^)]*\)/gi,
  /\(\s*keyboard[^)]*\)/gi,
  /\(\s*clicking[^)]*\)/gi,
  /\(\s*typing[^)]*\)/gi,
  /\(\s*coughing[^)]*\)/gi,
  /\(\s*breathing[^)]*\)/gi
];

function stripWhisperNoiseTokens(/** @type {string} */ text) {
  let out = text;
  for (const re of NOISE_TOKEN_PATTERNS) out = out.replace(re, "");
  return out.replace(/\s+/g, " ").trim();
}

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
  // The relay only needs OPENAI_API_KEY when the dictation window will
  // actually open an OpenAI WebSocket. whisper-local and deepgram providers
  // talk to their own backends, so don't gate boot on the OpenAI key.
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
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
    const { isAltKeyDown } = await import("./src/foreground.js");

    /** @type {ReturnType<typeof setInterval> | null} */
    let altPollTimer = null;

    const fireRelease = (/** @type {string} */ source) => {
      if (!dictation.release()) return;
      dlog("release", { source });
      console.error("[main] dictation:stop (" + source + ")");
      dictationWindow.webContents.send("dictation:stop");
      hidePill();
      if (altPollTimer) { clearInterval(altPollTimer); altPollTimer = null; }
    };

    const mod = await import("./src/hotkey.js");
    hotkeyEngine = mod.startHotkey({
      onPress: () => {
        if (!dictation.tryStart()) return;
        savedForegroundHwnd = captureForegroundWindow();
        dlog("press", { hwnd: savedForegroundHwnd });
        console.error("[main] dictation:start (hwnd=" + savedForegroundHwnd + ")");
        showPillNearCursor();
        dictationWindow.webContents.send("dictation:start");
        // Safety net for uiohook-napi missing the keyup event (Issue 1).
        // Poll the physical Alt key every 80 ms; if it goes up and we
        // haven't seen onRelease yet, fire one manually.
        if (altPollTimer) clearInterval(altPollTimer);
        altPollTimer = setInterval(() => {
          if (!dictation.busy) {
            if (altPollTimer) { clearInterval(altPollTimer); altPollTimer = null; }
            return;
          }
          if (!isAltKeyDown()) {
            fireRelease("poll-fallback");
          }
        }, 80);
      },
      onRelease: () => {
        fireRelease("uiohook");
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
    // Empty transcript = misfire (too-short hold). Release the session
    // immediately so the next press isn't blocked for the safety-timer
    // window — previously this returned without calling done() and the user
    // had to wait out the timeout.
    if (!transcript || !transcript.trim()) {
      dictation.done();
      return;
    }

    let textToType = stripWhisperNoiseTokens(transcript.trim());
    if (!textToType) {
      dlog("noise-only", { original: transcript });
      console.error("[main] transcript was noise-only, dropping");
      dictation.done();
      return;
    }

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
      // Restore focus to whichever app the user was typing in when they
      // hit the hotkey, so Ctrl+V lands there instead of whatever Electron
      // window may have grabbed focus during the IPC round-trip.
      const restored = restoreForegroundWindow(savedForegroundHwnd);
      dlog("paste", { hwnd: savedForegroundHwnd, restored });
      savedForegroundHwnd = null;
      await typeText(textToType);
      const totalSinceRelease = Date.now() - releaseAt;
      console.error("[main] paste done (" + (Date.now() - tType) + "ms paste, " + totalSinceRelease + "ms total since release, restored=" + restored + ")");
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

  // Warm whisper-server at boot so the first dictation doesn't pay the
  // 3-second model-load cost. Falls back to CLI silently if it can't spawn.
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "whisper-local" || provider === "local") {
    try {
      const { ensureWhisperServer } = await import("./src/providers/whisper-local.js");
      const bin = process.env.WHISPER_BIN || process.env.WHISPER_CLI || "whisper-cli";
      await ensureWhisperServer(bin);
      dlog("whisper", "warmed at boot");
      console.error("[main] whisper-server warmed at boot");
    } catch (err) {
      dlog("whisper", "warm failed: " + (err && err.message));
      console.error("[main] whisper warm failed:", err && err.message);
    }
  }

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
