// @ts-check
import "dotenv/config";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen } from "electron";

// Single-instance lock. Without this every `npm start` would spawn an extra
// Electron process whose global Alt hotkey listener competed with the
// existing one — pressing right-Alt once fired N parallel dictation sessions
// and Deepgram WebSockets stepped on each other. Second launches just bring
// the existing window to the front and exit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  // Headless app — there's no main window to refocus, just flash the tray
  // tooltip so the user knows the existing instance acknowledged them.
  if (tray) tray.displayBalloon?.({ title: "Voice Dictation", content: "Already running. Hold right Alt to dictate." });
});

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
import { captureForegroundWindow, restoreForegroundWindow, getWindowRect } from "./src/foreground.js";
import { appendFileSync, statSync, renameSync, unlinkSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

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

const DEBUG_LOG = join(__dirname, "debug.log");
const DEBUG_LOG_ROTATED = join(__dirname, "debug.log.1");
const DEBUG_LOG_MAX_BYTES = 1024 * 1024; // ~1 MB
/** @type {number} bytes appended to debug.log since boot; seeded from disk on first write */
let dlogBytesWritten = -1;
function dlog(/** @type {string} */ tag, /** @type {unknown} */ data) {
  try {
    const line = `[${new Date().toISOString()}] ${tag} ${typeof data === "string" ? data : JSON.stringify(data)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    // Seed the byte counter once with the file's current size so we account
    // for content carried over from previous runs.
    if (dlogBytesWritten < 0) {
      try { dlogBytesWritten = statSync(DEBUG_LOG).size; }
      catch { dlogBytesWritten = 0; }
    }
    if (dlogBytesWritten + lineBytes > DEBUG_LOG_MAX_BYTES) {
      try { if (existsSync(DEBUG_LOG_ROTATED)) unlinkSync(DEBUG_LOG_ROTATED); } catch {}
      try { renameSync(DEBUG_LOG, DEBUG_LOG_ROTATED); } catch {}
      dlogBytesWritten = 0;
    }
    appendFileSync(DEBUG_LOG, line);
    dlogBytesWritten += lineBytes;
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

function makeTrayIcon(/** @type {string} */ language) {
  try {
    const file = language === "en" ? "tray-en.png" : "tray-hr.png";
    const img = nativeImage.createFromPath(join(__dirname, "public", file));
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
    const result = await startServer({ recordingsDir });
    serverPort = result.port;
    return result;
  } catch (error) {
    serverError = error.message || String(error);
    return null;
  }
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

const PILL_W = 180;
const PILL_H = 56;
const PILL_MARGIN = 12;

// Place the pill near the top-right corner of the window the user was typing
// into when the hotkey fired (so it appears AT the work surface, not wherever
// the cursor happened to be). Falls back to the top-right of the cursor's
// display if the foreground window has no usable rectangle (some PWA/UWP
// windows return zero or off-screen bounds).
function showPillForWindow(/** @type {number | null} */ hwnd) {
  if (!pillWindow) return;
  const rect = hwnd ? getWindowRect(hwnd) : null;
  let x;
  let y;
  if (rect && rect.right > rect.left && rect.bottom > rect.top) {
    x = rect.right - PILL_W - PILL_MARGIN;
    y = rect.top + PILL_MARGIN;
  } else {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    x = display.bounds.x + display.bounds.width - PILL_W - PILL_MARGIN;
    y = display.bounds.y + PILL_MARGIN;
  }
  pillWindow.setBounds({ x, y, width: PILL_W, height: PILL_H });
  pillWindow.showInactive();
}

function hidePill() {
  if (pillWindow && pillWindow.isVisible()) {
    pillWindow.hide();
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

// Languages cycled by the right-Ctrl tap. Stored in process.env so deepgram.js
// can read the latest value on every new connection without an IPC round-trip.
const DICTATION_LANGUAGES = ["hr", "en"];

function getCurrentLanguage() {
  return (process.env.WHISPER_LANGUAGE || DICTATION_LANGUAGES[0]).toLowerCase();
}

function toggleLanguage() {
  const current = getCurrentLanguage();
  const idx = DICTATION_LANGUAGES.indexOf(current);
  const next = DICTATION_LANGUAGES[(idx + 1) % DICTATION_LANGUAGES.length];
  process.env.WHISPER_LANGUAGE = next;
  console.error("[main] language toggled " + current + " -> " + next);
  updateTrayTooltip();
  return next;
}

function updateTrayTooltip() {
  if (!tray) return;
  const lang = getCurrentLanguage();
  const keyLabel = process.platform === "darwin" ? "right Option" : "right Alt";
  tray.setToolTip(
    `Language: ${lang.toUpperCase()}\n` +
    `Hold ${keyLabel} to dictate.\n` +
    `Tap right Ctrl to toggle hr / en.`
  );
  try { tray.setImage(makeTrayIcon(lang)); } catch {}
}

async function setupHotkey() {
  if (!serverPort || !dictationWindow) return;
  try {
    const fireRelease = (/** @type {string} */ source) => {
      if (!dictation.release()) return;
      dlog("release", { source });
      console.error("[main] dictation:stop (" + source + ")");
      dictationWindow.webContents.send("dictation:stop");
      hidePill();
    };

    const mod = await import("./src/hotkey.js");
    hotkeyEngine = mod.startHotkey({
      onPress: () => {
        if (!dictation.tryStart()) return;
        const profile = { language: getCurrentLanguage(), model: process.env.DEEPGRAM_MODEL || "nova-3" };
        savedForegroundHwnd = captureForegroundWindow();
        dlog("press", { profile, hwnd: savedForegroundHwnd });
        console.error("[main] dictation:start lang=" + profile.language + " (hwnd=" + savedForegroundHwnd + ")");
        showPillForWindow(savedForegroundHwnd);
        dictationWindow.webContents.send("dictation:start", profile);
      },
      onRelease: () => {
        fireRelease("hotkey");
      },
      onToggleLanguage: () => {
        toggleLanguage();
      }
    });
    updateTrayTooltip();
    const altLabel = process.platform === "darwin" ? "right Option (⌥)" : "right Alt";
    console.log(`Global hotkeys active: hold ${altLabel} to dictate, tap right Ctrl to toggle hr/en.`);
  } catch (error) {
    console.error("Failed to start global hotkey:", error.message);
  }
}

// Clean up a raw transcript (strip Whisper noise tokens, optional LLM polish,
// trailing punctuation) and type it into the focused app. Shared by the live
// dictation path and the backup retry path. Returns the text that was typed,
// or null if there was nothing to type.
//
// `restoreHwnd` (live path only): the foreground window captured on key-press.
// Focus is restored to it immediately before the paste, so Ctrl/Cmd+V lands in
// the app the user was dictating into rather than whatever grabbed focus
// during the IPC round-trip. The retry path passes nothing (the user is
// interacting with the pop-up, so there's no window to restore).
//
// @param {string} transcript
// @param {number | null} [restoreHwnd]
// @returns {Promise<string | null>}
async function processTranscript(transcript, restoreHwnd = null) {
  if (!transcript || !transcript.trim()) return null;
  let textToType = stripWhisperNoiseTokens(transcript.trim());
  if (!textToType) {
    dlog("noise-only", { original: transcript });
    return null;
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
  if (!textToType) return null;
  if (!/[.!?…,;:"')\]]$/.test(textToType)) {
    textToType += ".";
  }

  const tType = Date.now();
  const { typeText } = await import("./src/typing.js");
  let restored = false;
  if (restoreHwnd != null) {
    restored = restoreForegroundWindow(restoreHwnd);
    dlog("paste", { hwnd: restoreHwnd, restored });
  }
  await typeText(textToType);
  console.error("[main] paste done (" + (Date.now() - tType) + "ms paste, restored=" + restored + ")");
  return textToType;
}

function setupIpc() {
  ipcMain.on("dictation:transcript", async (_event, transcript) => {
    const { releaseAt, sinceRelease } = dictation.finalize();
    console.error("[main] received transcript (" + sinceRelease + "ms after release):", JSON.stringify(transcript));
    hidePill();
    // Empty transcript = silence, a filtered hallucination, or a misfire
    // (too-short hold). Reopen the session immediately (don't wait on the
    // safety timer) so the next press works right away — empties are common by
    // design (silence gate + hallucination filter).
    if (!transcript || !transcript.trim()) {
      dictation.done();
      return;
    }

    try {
      // Restore focus to whichever app the user was dictating into, then type.
      // processTranscript strips Whisper noise tokens, runs the cleanup pass,
      // and pastes — restoring focus right before the paste lands.
      const typed = await processTranscript(transcript, savedForegroundHwnd);
      savedForegroundHwnd = null;
      if (!typed) console.error("[main] transcript was noise-only, dropped");
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
  tray = new Tray(makeTrayIcon(getCurrentLanguage()));
  updateTrayTooltip();

  const menu = Menu.buildFromTemplate([
    {
      label: serverPort ? `Relay: http://localhost:${serverPort}` : "Relay: not running",
      enabled: !!serverPort,
      click: () => serverPort && shell.openExternal(`http://localhost:${serverPort}`)
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (/** @type {import("electron").MenuItem} */ item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      }
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
  // Headless tray app — Electron's "no windows" default behaviour would quit
  // the process otherwise. The pill/dictation windows come and go; we want
  // the tray to stay live regardless.
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
  recordingsDir = join(app.getPath("userData"), "recordings");
  // Clear out recordings older than a week so dismissed/played-back backups
  // don't accumulate. Successful retries already delete their own file.
  const BACKUP_RETENTION_MS = Number(process.env.BACKUP_RETENTION_DAYS || 7) * 24 * 60 * 60 * 1000;
  pruneBackups(recordingsDir, BACKUP_RETENTION_MS, Date.now())
    .then((n) => { if (n) console.error("[main] pruned " + n + " old dictation backup(s)"); })
    .catch(() => {});
  await bootRelayServer();
  buildAppMenu();
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
