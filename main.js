// @ts-check
import "dotenv/config";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen, Notification, clipboard } from "electron";

// Brand the app as "GVoice" even when run unpackaged (otherwise the menu bar,
// About panel, and userData folder all read "Electron"). Must run before the
// app is ready and before any getPath("userData") call.
app.setName("GVoice");

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
  if (tray) tray.displayBalloon?.({ title: "GVoice", content: "Already running. Hold right Alt to dictate." });
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
import { wrapWav } from "./src/providers/_shared.js";
import { captureForegroundWindow, restoreForegroundWindow, getWindowRect, isEditableFieldFocused } from "./src/foreground.js";
import { appendFileSync, statSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { writeFile as writeFileAsync, readdir, unlink as unlinkAsync, rm as rmAsync, mkdir as mkdirAsync } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

/** @type {import("electron").BrowserWindow | null} */
let pillWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let dictationWindow = null;
/** @type {string | null} */
let recordingsDir = null;
// The transcript + recording shown on the current result pill, so the pill's
// Copy / Open-recording buttons act on the right data. Set when a result pill
// is shown, cleared when it hides.
/** @type {string | null} */
let currentTranscript = null;
/** @type {string | null} */
let currentRecordingPath = null;
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
    width: 200,
    height: 56,
    frame: false,
    transparent: true,
    // Must stay resizable: a non-resizable window ignores setBounds() size
    // changes on macOS, which would pin the pill at its launch width and clip
    // the wider success/error states.
    resizable: true,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-pill.cjs")
    }
  });
  pillWindow.setAlwaysOnTop(true, "screen-saver");
  // This is an accessory app (Dock hidden). Without this, the always-on-top
  // pill won't appear over full-screen apps or on other Spaces. skipTransform
  // keeps the app from flipping to a regular Dock app when we call this.
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Click-through by default. Flipped on only for the success/error states so
  // the Copy / Open-recording buttons are clickable (see setPillState).
  pillWindow.setIgnoreMouseEvents(true);

  if (serverPort) {
    pillWindow.loadURL(`http://localhost:${serverPort}/pill.html`);
  } else {
    pillWindow.loadFile(join(__dirname, "public", "pill.html"));
  }
}

// The pill is a transparent window with the rounded pill centered inside it.
// The window is sized per state: small for listening/transcribing, wider for
// the success/error states that carry Copy / Open-recording buttons. It sits
// at the bottom-middle of whichever screen the user is working on.
const PILL_BOTTOM_MARGIN = 28; // gap above the dock / taskbar
const PILL_SIZES = {
  listening: { width: 200, height: 56 },
  transcribing: { width: 220, height: 56 },
  success: { width: 440, height: 56 },
  error: { width: 440, height: 56 }
};

// Pick the display the pill should appear on: the one holding the window the
// user was dictating into (Windows, where we have its rect), else the display
// under the cursor (macOS, where getWindowRect is a stub).
function pillDisplay() {
  const rect = savedForegroundHwnd ? getWindowRect(savedForegroundHwnd) : null;
  if (rect && rect.right > rect.left && rect.bottom > rect.top) {
    const cx = Math.round((rect.left + rect.right) / 2);
    const cy = Math.round((rect.top + rect.bottom) / 2);
    return screen.getDisplayNearestPoint({ x: cx, y: cy });
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// Center the pill window horizontally and sit it just above the bottom of the
// work area (which already excludes the dock / menu bar / taskbar).
function positionPill(/** @type {number} */ width, /** @type {number} */ height) {
  if (!pillWindow) return;
  const wa = pillDisplay().workArea;
  const x = Math.round(wa.x + (wa.width - width) / 2);
  const y = Math.round(wa.y + wa.height - height - PILL_BOTTOM_MARGIN);
  pillWindow.setBounds({ x, y, width, height });
}

function showPillForWindow(/** @type {number | null} */ _hwnd) {
  if (!pillWindow) return;
  clearTimeout(pillSafetyTimer);
  setPillState("listening");
  pillWindow.showInactive();
}

// Drive the pill's look + behaviour. listening/transcribing are passive and
// click-through; success/error carry action buttons, so mouse events are
// enabled and the renderer owns the auto-hide (with hover-pause). `opts` only
// applies to result states: { canCopy, canOpen }.
function setPillState(
  /** @type {"listening" | "transcribing" | "success" | "error"} */ state,
  /** @type {{ canCopy?: boolean, canOpen?: boolean }} */ opts = {}
) {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  const size = PILL_SIZES[state] || PILL_SIZES.listening;
  positionPill(size.width, size.height);
  const interactive = state === "success" || state === "error";
  pillWindow.setIgnoreMouseEvents(!interactive);
  pillWindow.webContents.send("pill:state", {
    state,
    canCopy: !!opts.canCopy,
    canOpen: !!opts.canOpen
  });
}

// Show a terminal result pill (success or error) and remember what its buttons
// act on. The renderer auto-hides it; the safety timer is a longer backstop in
// case the renderer's own timer is lost.
function showPillResult(
  /** @type {"success" | "error"} */ state,
  /** @type {string | null} */ transcript,
  /** @type {string | null} */ recordingPath
) {
  currentTranscript = transcript;
  currentRecordingPath = recordingPath;
  setPillState(state, { canCopy: !!transcript, canOpen: !!recordingPath });
  pillWindow?.showInactive();
  armPillSafetyHide(12000);
}

let pillSafetyTimer = null;

// Backstop: if the renderer ever fails to report back (crash, lost IPC), make
// sure the pill doesn't linger on screen. Normal completions clear this via
// hidePill() well before it fires.
function armPillSafetyHide(/** @type {number} */ ms = 15000) {
  clearTimeout(pillSafetyTimer);
  pillSafetyTimer = setTimeout(() => {
    pillSafetyTimer = null;
    hidePill();
  }, ms);
}

function hidePill() {
  clearTimeout(pillSafetyTimer);
  pillSafetyTimer = null;
  currentTranscript = null;
  currentRecordingPath = null;
  if (pillWindow && !pillWindow.isDestroyed()) {
    // Restore click-through so a hidden result pill can't swallow clicks.
    pillWindow.setIgnoreMouseEvents(true);
    if (pillWindow.isVisible()) pillWindow.hide();
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
      // Keep the pill visible but switch it to the pulsing-blue "Transcribing…"
      // state so the user can see work is still happening. A terminal event
      // (transcript / failure / error) flips it to success/error; the safety
      // timer covers a renderer that never reports back.
      setPillState("transcribing");
      armPillSafetyHide();
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
// @returns {Promise<{ text: string, pasted: boolean } | null>}
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

  // Check whether an editable field is actually focused BEFORE we paste, while
  // the user's app is still frontmost. On macOS this reads the Accessibility
  // API (true/false); on Windows it returns null (we fall back to the restore
  // signal). null = couldn't tell, so don't hold it against the paste.
  const fieldFocused = isEditableFieldFocused();

  const tType = Date.now();
  const { typeText } = await import("./src/typing.js");
  let restored = false;
  if (restoreHwnd != null) {
    restored = restoreForegroundWindow(restoreHwnd);
    dlog("paste", { hwnd: restoreHwnd, restored });
  }
  // Best-effort confidence that the text actually landed in a text field.
  // Clipboard paste is fire-and-forget, so we can't truly confirm — but these
  // signals tell us it did NOT: typeText threw; (Windows) we had a foreground
  // window to restore and the restore failed; or (macOS) no editable element
  // was focused, so ⌘V went nowhere.
  let typed = true;
  try {
    await typeText(textToType);
  } catch (error) {
    typed = false;
    console.error("[main] typeText failed:", error && (error.stack || error.message));
  }
  const pasted =
    typed &&
    !(restoreHwnd != null && restored === false) &&
    fieldFocused !== false;
  console.error("[main] paste done (" + (Date.now() - tType) + "ms paste, restored=" + restored + ", fieldFocused=" + fieldFocused + ", pasted=" + pasted + ")");
  dlog("typed", { len: textToType.length, ms: Date.now() - tType, fieldFocused, pasted });
  return { text: textToType, pasted };
}

// Write the just-captured audio to the temporary recordings folder so the
// pill's "Open recording" button has a file to open. Only the most recent clip
// is kept (the previous one is deleted), and the whole folder is wiped at boot
// — these are throwaway, "open it before you restart" recordings, not the
// long-lived backups the old failure pop-up kept. Returns the path, or null.
//
// @param {string[]} chunks   base64 PCM16 frames
// @param {number} [sampleRate]
// @returns {Promise<string | null>}
async function saveTempRecording(chunks, sampleRate) {
  if (!recordingsDir || !chunks || !chunks.length) return null;
  try {
    const pcm = Buffer.concat(chunks.map((b64) => Buffer.from(b64, "base64")));
    if (!pcm.length) return null;
    // Keep only the latest clip — drop any earlier ones from this session.
    const existing = await readdir(recordingsDir).catch(() => []);
    await Promise.all(
      existing
        .filter((n) => n.endsWith(".wav"))
        .map((n) => unlinkAsync(join(recordingsDir, n)).catch(() => {}))
    );
    const name = `dictation-${Date.now()}.wav`;
    const path = join(recordingsDir, name);
    await writeFileAsync(path, wrapWav(pcm, sampleRate || 24000));
    dlog("temp-recording", { name, bytes: pcm.length });
    return path;
  } catch (error) {
    console.error("[main] Failed to save temp recording:", error && (error.stack || error.message));
    return null;
  }
}

function setupIpc() {
  ipcMain.on("dictation:transcript", async (_event, payload) => {
    // payload is { text, chunks, sampleRate } on a real transcript, or "" on a
    // server-decided empty (silence gate / hallucination filter).
    const text = typeof payload === "string" ? payload : (payload && payload.text) || "";
    const chunks = (payload && typeof payload === "object" && payload.chunks) || null;
    const sampleRate = (payload && typeof payload === "object" && payload.sampleRate) || undefined;
    const { releaseAt, sinceRelease } = dictation.finalize();
    console.error("[main] received transcript (" + sinceRelease + "ms after release):", JSON.stringify(text));
    dlog("transcript", { len: (text || "").trim().length, sinceRelease });

    // Empty transcript = silence, a filtered hallucination, or a misfire
    // (too-short hold). Just hide the pill quietly — surfacing "Error" on every
    // accidental tap would be noise. Reopen the session immediately so the next
    // press works right away.
    if (!text || !text.trim()) {
      hidePill();
      dictation.done();
      return;
    }

    // Save the audio first so "Open recording" works even on a clean success.
    const recordingPath = await saveTempRecording(chunks, sampleRate);
    try {
      // Restore focus to whichever app the user was dictating into, then type.
      // processTranscript strips Whisper noise tokens, runs the cleanup pass,
      // and pastes — restoring focus right before the paste lands.
      const result = await processTranscript(text, savedForegroundHwnd);
      savedForegroundHwnd = null;
      console.error("[main] total since release: " + (Date.now() - releaseAt) + "ms");
      if (!result || !result.text) {
        // Noise-only after cleanup — nothing landed. Quiet hide.
        console.error("[main] transcript was noise-only, dropped");
        hidePill();
      } else {
        // Success only when we're confident the text was pasted somewhere;
        // otherwise show Error so the user can Copy it / open the recording.
        showPillResult(result.pasted ? "success" : "error", result.text, recordingPath);
      }
    } catch (error) {
      console.error("[main] Typing failed:", error.stack || error.message);
      showPillResult("error", text, recordingPath);
    } finally {
      dictation.done();
    }
  });

  // A dictation couldn't be transcribed but audio was captured. Save the clip
  // and show the Error pill so the user can open the recording and try again.
  ipcMain.on("dictation:failure", async (_event, payload) => {
    dictation.finalize();
    dictation.done();
    const chunks = (payload && payload.chunks) || [];
    const recordingPath = await saveTempRecording(chunks, payload && payload.sampleRate);
    if (recordingPath) console.error("[main] dictation recording saved:", recordingPath);
    // No transcript to copy; the recording is what we offer.
    showPillResult("error", null, recordingPath);
  });

  ipcMain.on("dictation:error", (_event, message) => {
    dictation.done();
    console.error("Dictation error:", message);
    // No audio, no transcript — a bare Error pill (e.g. mic blocked, relay down).
    showPillResult("error", null, null);
  });

  // Pill action buttons (success/error states only).
  ipcMain.on("pill:copy", () => {
    if (currentTranscript) {
      clipboard.writeText(currentTranscript);
      dlog("pill-copy", { len: currentTranscript.length });
    }
  });
  ipcMain.on("pill:open", () => {
    if (currentRecordingPath) {
      shell.openPath(currentRecordingPath).catch(() => {});
      dlog("pill-open", { path: currentRecordingPath });
    }
  });
  ipcMain.on("pill:hide", () => hidePill());

  // The renderer lost the microphone (disconnected, muted, seized by another
  // app, or silent for several holds in a row) and rebuilt its capture. Make
  // the failure visible instead of silently typing nothing.
  ipcMain.on("dictation:mic-warning", (_event, message) => {
    hidePill();
    dictation.done();
    console.error("[main] mic warning:", message);
    showMicWarning(message);
  });
}

let lastMicWarningAt = 0;

// Surface a microphone problem to the user. Throttled so a burst of silent
// holds can't spam the notification center.
function showMicWarning(/** @type {string} */ message) {
  const now = Date.now();
  if (now - lastMicWarningAt < 10000) return;
  lastMicWarningAt = now;
  try {
    if (Notification.isSupported()) {
      new Notification({ title: "GVoice — check your microphone", body: message }).show();
    }
  } catch (err) {
    console.error("[main] mic-warning notification failed:", err && err.message);
  }
  // Windows tray balloon as a secondary channel (no-op on macOS).
  try { tray?.displayBalloon?.({ title: "GVoice — check your microphone", content: message }); } catch {}
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
              label: "Quit GVoice",
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
  // Temporary recordings live here. They're throwaway — the pill's "Open
  // recording" button opens the latest clip, and the whole folder is wiped at
  // every boot ("erased on restart"). Recreated empty so the first dictation
  // has somewhere to write.
  recordingsDir = join(app.getPath("userData"), "temp-recordings");
  await rmAsync(recordingsDir, { recursive: true, force: true }).catch(() => {});
  await mkdirAsync(recordingsDir, { recursive: true }).catch(() => {});
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
