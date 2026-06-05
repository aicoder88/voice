// @ts-check
// Must be first: prepares PATH + loads .env from the app home before any module
// reads process.env (see src/bootstrap-env.js). Replaces the old
// `import "dotenv/config"`, which only worked when launched from the repo dir.
import "./src/bootstrap-env.js";
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
import * as vocab from "./src/vocab.js";
import { createCorrectionWatcher } from "./src/correction-watch.js";
import { captureForegroundWindow, restoreForegroundWindow, getWindowRect, isEditableFieldFocused, focusedFieldValue } from "./src/foreground.js";
import { initHistory, getHistory, getHistoryPath, recordTranscript } from "./src/history.js";
import { appendFileSync, statSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { writeFile as writeFileAsync, readdir, unlink as unlinkAsync, rm as rmAsync, mkdir as mkdirAsync } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

/** @type {import("electron").BrowserWindow | null} */
let splashWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let pillWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let dictationWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let vocabWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let dictionaryWindow = null;
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

// Per-event tracing is noisy (a line per press/release/cleanup/paste). Keep the
// durable record in debug.log via dlog(); only echo these to the console when
// GVOICE_DEBUG is set. Genuine errors stay on console.error unconditionally.
const VERBOSE = process.env.GVOICE_DEBUG === "1" || process.env.GVOICE_DEBUG === "true";
function debug(/** @type {any[]} */ ...args) {
  if (VERBOSE) console.error(...args);
}

// --- Custom-dictionary suggestion state ---
// Cursor pop-up size (fixed; the card height is set in CSS). One source so the
// window bounds and the cursor-anchoring math can't drift apart.
const VOCAB_SIZE = { width: 300, height: 104 };
// How long after a dictation we watch for a manual correction (macOS/Linux).
// Kept short so we're not comparing every word typed in normal post-dictation
// prose against the last transcript.
const CORRECTION_WATCH_MS = Number(process.env.GVOICE_CORRECTION_WATCH_MS || 12000);
// Set once the pop-up window's HTML has loaded and registered its IPC handler,
// so the very first prompt isn't sent into the void.
let vocabWindowReady = false;
// Words GVoice typed in the just-finished dictation, used to recognise a manual
// fix as a near-miss of one of them.
/** @type {string[]} */
let recentTypedWords = [];
// The term currently shown on the cursor pop-up (one at a time).
/** @type {string | null} */
let pendingVocabTerm = null;
// Terms already offered this session, so an ignored prompt isn't re-shown until
// restart (an explicit "No thanks" persists in vocab's dismissed list forever).
const promptedThisSession = new Set();
let vocabHideTimer = null;
const correctionWatcher = createCorrectionWatcher({
  onWord: (word) => {
    const matched = vocab.isLikelyCorrection(word, recentTypedWords);
    if (matched) showVocabPrompt(word, "correction");
  }
});

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

// Splash readiness, mirroring vocabWindowReady: a status pushed before the
// renderer has attached its IPC listener would be dropped, so we hold the
// latest one and flush it on load. `splashDismissed` makes the tuck-away
// animation run exactly once even if two code paths request it.
let splashReady = false;
let splashDismissed = false;
/** @type {{ message: string, state: string } | null} */
let pendingSplashStatus = null;

// The boot splash: a small, frameless, branded "Starting GVoice…" card shown
// the instant the app launches, so the first thing the user sees is the app —
// not a terminal or a bare window. It reports boot progress, then animates
// itself down into the menu-bar / tray icon and closes, leaving the app running
// silently. Centered on whichever display the cursor is on.
function createSplashWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 360;
  const height = 300;
  const wa = display.workArea;
  splashWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-splash.cjs")
    }
  });
  splashWindow.setAlwaysOnTop(true, "screen-saver");
  splashWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Once the renderer's IPC handler is live, flush whatever the latest status
  // was (boot stages set before this point would otherwise be dropped).
  splashWindow.webContents.once("did-finish-load", () => {
    splashReady = true;
    if (pendingSplashStatus) splashWindow?.webContents.send("splash:status", pendingSplashStatus);
  });
  // Loaded from disk (not the relay) because the splash must appear before the
  // relay server is up.
  splashWindow.loadFile(join(__dirname, "public", "splash.html"));
  splashWindow.once("ready-to-show", () => splashWindow?.showInactive());
}

// Push a boot-progress line to the splash. `state` drives the look:
// "loading" (default), "ready" (green), or "error" (red). Held until the
// renderer is ready (see createSplashWindow); the latest status wins.
function setSplashStatus(
  /** @type {string} */ message,
  /** @type {"loading" | "ready" | "error"} */ state = "loading"
) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  pendingSplashStatus = { message, state };
  if (splashReady) splashWindow.webContents.send("splash:status", pendingSplashStatus);
}

// Animate the splash shrinking and sliding down into the tray icon, then close
// it — the visual "the app tucked itself into the menu bar" moment. Falls back
// to the top-right corner if the tray bounds aren't reported (some Linux DEs,
// or before the tray exists). Pure main-process bounds/opacity animation so it
// works on a transparent, non-focusable window.
function dismissSplashToTray() {
  if (splashDismissed) return;
  splashDismissed = true;
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null;
    return;
  }
  const win = splashWindow;
  const start = win.getBounds();
  const trayBounds = (() => {
    try { return tray?.getBounds?.(); } catch { return null; }
  })();
  let targetCx;
  let targetCy;
  if (trayBounds && trayBounds.width) {
    targetCx = trayBounds.x + trayBounds.width / 2;
    targetCy = trayBounds.y + trayBounds.height / 2;
  } else {
    // No tray rect: aim for the top-right (macOS menu bar) corner of the display.
    const wa = screen.getDisplayNearestPoint({ x: start.x, y: start.y }).workArea;
    targetCx = wa.x + wa.width - 24;
    targetCy = wa.y + 12;
  }
  const startCx = start.x + start.width / 2;
  const startCy = start.y + start.height / 2;
  const steps = 22;
  let i = 0;
  const timer = setInterval(() => {
    i++;
    if (!splashWindow || splashWindow.isDestroyed()) {
      clearInterval(timer);
      splashWindow = null;
      return;
    }
    // Ease-in (accelerate toward the tray) on a 0..1 progress.
    const p = i / steps;
    const e = p * p;
    const scale = 1 - 0.82 * e; // shrink to ~18% of its size
    const w = Math.max(24, Math.round(start.width * scale));
    const h = Math.max(20, Math.round(start.height * scale));
    const cx = startCx + (targetCx - startCx) * e;
    const cy = startCy + (targetCy - startCy) * e;
    win.setBounds({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h });
    win.setOpacity(Math.max(0, 1 - e));
    if (i >= steps) {
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      splashWindow = null;
    }
  }, 16);
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
  // Renderer auto-hides the pill itself (3s success / 8s error, pill.html).
  // These are only crash backstops in case the renderer never reports back.
  armPillSafetyHide(state === "error" ? 45000 : 12000);
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

// The "add to dictionary?" pop-up. Like the pill, it's a frameless,
// non-focusable, always-on-top window so clicking its buttons never steals the
// caret from whatever the user is typing into. It appears next to the mouse
// cursor (the text caret's screen position isn't reliably available across apps
// on macOS, but the cursor is where the user's attention already is).
function createVocabWindow() {
  vocabWindow = new BrowserWindow({
    width: VOCAB_SIZE.width,
    height: VOCAB_SIZE.height,
    frame: false,
    transparent: true,
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
      preload: join(__dirname, "preload-vocab.cjs")
    }
  });
  vocabWindow.setAlwaysOnTop(true, "screen-saver");
  vocabWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // It has clickable buttons, so (unlike the passive pill) mouse events stay on.
  vocabWindow.setIgnoreMouseEvents(false);
  vocabWindow.webContents.once("did-finish-load", () => { vocabWindowReady = true; });
  if (serverPort) {
    vocabWindow.loadURL(`http://localhost:${serverPort}/vocab-prompt.html`);
  } else {
    vocabWindow.loadFile(join(__dirname, "public", "vocab-prompt.html"));
  }
}

// Place the pop-up just below-right of the mouse cursor, flipping/clamping so it
// always stays inside the work area of the display under the cursor.
function positionVocabAtCursor(/** @type {number} */ width, /** @type {number} */ height) {
  if (!vocabWindow) return;
  const pt = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(pt).workArea;
  let x = pt.x + 16;
  let y = pt.y + 18;
  if (x + width > wa.x + wa.width) x = pt.x - width - 16;
  if (y + height > wa.y + wa.height) y = pt.y - height - 18;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  vocabWindow.setBounds({ x, y, width, height });
}

// Offer to add `term` to the custom dictionary. No-ops if a prompt is already
// up, the term is already known/declined, or we've already asked this session.
function showVocabPrompt(/** @type {string} */ term, /** @type {"name" | "correction"} */ reason) {
  if (!vocabWindow || vocabWindow.isDestroyed() || !term) return;
  if (pendingVocabTerm) return;
  const key = term.toLowerCase();
  if (promptedThisSession.has(key)) return;
  try { if (vocab.isKnown(term) || vocab.isDismissed(term)) return; } catch { return; }
  pendingVocabTerm = term;
  promptedThisSession.add(key);
  positionVocabAtCursor(VOCAB_SIZE.width, VOCAB_SIZE.height);
  // Send only once the renderer has registered its onPrompt handler, or the
  // first prompt of a session (before the window finishes loading) would be
  // dropped and the card would show its empty placeholder.
  const send = () => vocabWindow?.webContents.send("vocab:prompt", { term, reason });
  if (vocabWindowReady) send();
  else vocabWindow.webContents.once("did-finish-load", send);
  vocabWindow.showInactive();
  dlog("vocab-prompt", { term, reason });
  clearTimeout(vocabHideTimer);
  // If the user ignores it, fade out after a bit. Not a decision either way:
  // the term stays un-dismissed, just not re-asked until next restart.
  vocabHideTimer = setTimeout(hideVocab, 7000);
}

function hideVocab() {
  clearTimeout(vocabHideTimer);
  vocabHideTimer = null;
  pendingVocabTerm = null;
  if (vocabWindow && !vocabWindow.isDestroyed() && vocabWindow.isVisible()) {
    vocabWindow.hide();
  }
}

// After a successful dictation, arm the manual-correction watcher. The ONLY
// signal worth a pop-up is the user hand-typing a fix of a just-dictated word
// (a near-miss the watcher recognises) — that's real evidence the engine
// mis-heard it. We deliberately do NOT offer mid-sentence capitalized words on
// their own: a correctly-spelled name means the engine already got it right, so
// "save it?" is pure noise — and saving common-word homophones like "Stripe" or
// "Mike" actively degrades recognition (see models/vocab.txt).
function maybeSuggestVocab(/** @type {string} */ typedText) {
  try {
    recentTypedWords = vocab.wordsOf(typedText);
    correctionWatcher.arm(CORRECTION_WATCH_MS);
  } catch (err) {
    debug("[vocab] suggestion failed:", err && err.message);
  }
}

// The dictionary manager — a normal, focusable window (tray → "Manage
// dictionary…") where the user types in the names and made-up words the engine
// should spell exactly. This is the reliable way to seed words the engine
// mishears: the cursor pop-up can only confirm what was transcribed, but a
// made-up word gets transcribed as something else, so it can never be captured
// that way. Words added here bias every engine on the next dictation.
function openDictionaryWindow() {
  // This is an accessory app (Dock hidden), so a window won't become key on its
  // own — pull the whole app forward so the text field actually accepts typing.
  app.focus({ steal: true });
  if (dictionaryWindow && !dictionaryWindow.isDestroyed()) {
    dictionaryWindow.show();
    dictionaryWindow.focus();
    return;
  }
  dictionaryWindow = new BrowserWindow({
    width: 440,
    height: 540,
    title: "GVoice dictionary",
    show: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#14181e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-dictionary.cjs")
    }
  });
  dictionaryWindow.on("closed", () => { dictionaryWindow = null; });
  dictionaryWindow.webContents.once("did-finish-load", () => {
    if (dictionaryWindow && !dictionaryWindow.isDestroyed()) dictionaryWindow.focus();
  });
  if (serverPort) {
    dictionaryWindow.loadURL(`http://localhost:${serverPort}/dictionary.html`);
  } else {
    dictionaryWindow.loadFile(join(__dirname, "public", "dictionary.html"));
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
  debug("[main] language toggled " + current + " -> " + next);
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
      debug("[main] dictation:stop (" + source + ")");
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
        // A new dictation supersedes any correction-watch window from the last
        // one, and clears a pop-up the user never answered.
        correctionWatcher.disarm();
        recentTypedWords = [];
        hideVocab();
        const profile = { language: getCurrentLanguage(), model: process.env.DEEPGRAM_MODEL || "nova-3" };
        savedForegroundHwnd = captureForegroundWindow();
        dlog("press", { profile, hwnd: savedForegroundHwnd });
        debug("[main] dictation:start lang=" + profile.language + " (hwnd=" + savedForegroundHwnd + ")");
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
    const altLabel = process.platform === "darwin"
      ? "right Option (⌥), left Ctrl+Cmd, or mouse back button"
      : "right Alt";
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
      debug("[main] cleanup done (" + (Date.now() - t0) + "ms):", JSON.stringify(textToType));
    } catch (error) {
      console.error("[main] Cleanup pass failed, using raw:", error.message);
    }
  } else {
    debug("[main] cleanup SKIPPED (short/clean, length=" + textToType.length + ")");
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
  let pasted =
    typed &&
    !(restoreHwnd != null && restored === false) &&
    fieldFocused !== false;
  // Post-paste verification (macOS, best-effort): re-read the focused field and
  // check our text actually appeared in it. Only DOWNGRADE on a readable string
  // that's missing the text — null means "couldn't verify" (web areas, secure
  // fields), which must never turn a good paste into a false error.
  let verified = null;
  if (pasted) {
    await new Promise((resolve) => setTimeout(resolve, 150)); // let the paste settle
    const fieldValue = focusedFieldValue();
    if (typeof fieldValue === "string") {
      // Normalize what apps auto-substitute (smart quotes, em-dashes, NBSP,
      // collapsed whitespace) so autocorrect can't turn a good paste into a
      // false error.
      const norm = (/** @type {string} */ s) =>
        s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
         .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
      verified = norm(fieldValue).includes(norm(textToType));
      if (!verified) pasted = false;
    }
  }
  debug("[main] paste done (" + (Date.now() - tType) + "ms paste, restored=" + restored + ", fieldFocused=" + fieldFocused + ", verified=" + verified + ", pasted=" + pasted + ")");
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
    debug("[main] received transcript (" + sinceRelease + "ms after release):", JSON.stringify(text));
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
      debug("[main] total since release: " + (Date.now() - releaseAt) + "ms");
      if (!result || !result.text) {
        // Noise-only after cleanup — nothing landed. Quiet hide.
        console.error("[main] transcript was noise-only, dropped");
        hidePill();
      } else {
        // Success only when we're confident the text was pasted somewhere;
        // otherwise show Error so the user can Copy it / open the recording.
        showPillResult(result.pasted ? "success" : "error", result.text, recordingPath);
        // Keep the last 50 dictations on disk and in the tray menu, so a
        // missed paste is recoverable even after the pill is gone.
        recordTranscript(result.text, result.pasted);
        rebuildTrayMenu();
        // Failed paste: also put the text on the clipboard so it's recoverable
        // with ⌘V even if the pill is missed. Delayed past typeText's 250ms
        // clipboard restore, which would otherwise overwrite it.
        if (!result.pasted) {
          const lostText = result.text;
          setTimeout(() => { try { clipboard.writeText(lostText); } catch {} }, 450);
        }
        // Offer to teach the dictionary any likely-misheard names, and start
        // watching for a hand-typed correction. Only when the text actually
        // landed somewhere.
        if (result.pasted) maybeSuggestVocab(result.text);
      }
    } catch (error) {
      console.error("[main] Typing failed:", error.stack || error.message);
      showPillResult("error", text, recordingPath);
      // Cleanup never ran on this path — at least strip Whisper noise tokens
      // so the history entry matches the others as closely as possible.
      recordTranscript(stripWhisperNoiseTokens(text.trim()) || text, false);
      rebuildTrayMenu();
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

  // Cursor "add to dictionary?" pop-up actions.
  ipcMain.on("vocab:add", (_event, term) => {
    const added = vocab.addTerm(term);
    dlog("vocab-add", { term, added });
    hideVocab();
  });
  ipcMain.on("vocab:dismiss", (_event, term) => {
    vocab.dismissTerm(term);
    dlog("vocab-dismiss", { term });
    hideVocab();
  });

  // Dictionary manager window (request/response — each returns the updated list).
  ipcMain.handle("vocab:list", () => vocab.getTerms());
  ipcMain.handle("vocab:add-many", (_event, text) => {
    const parts = (Array.isArray(text) ? text : String(text || "").split(/[,\n]/));
    let added = 0;
    for (const part of parts) {
      const word = String(part).trim();
      if (word && vocab.addTerm(word)) added++;
    }
    dlog("vocab-add-many", { added });
    return vocab.getTerms();
  });
  ipcMain.handle("vocab:remove", (_event, term) => {
    vocab.removeTerm(term);
    dlog("vocab-remove", { term });
    return vocab.getTerms();
  });

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
  rebuildTrayMenu();
}

// The "Recent dictations" submenu changes after every dictation, and Electron
// tray menus are static once set — so the whole menu is rebuilt on demand.
function rebuildTrayMenu() {
  if (!tray) return;

  // One submenu row per saved dictation, newest first: time + a preview.
  // Clicking a row copies the full text to the clipboard.
  const historyItems = getHistory().map((entry) => {
    const time = new Date(entry.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // Newlines break NSMenu labels (display cuts at the first one) — flatten.
    const flat = entry.text.replace(/\s+/g, " ").trim();
    const preview = flat.length > 60 ? flat.slice(0, 60) + "…" : flat;
    return {
      label: `${time}${entry.pasted ? "" : " ⚠"}  ${preview}`,
      click: () => clipboard.writeText(entry.text)
    };
  });

  const menu = Menu.buildFromTemplate([
    {
      label: "Recent dictations",
      enabled: historyItems.length > 0,
      submenu: [
        ...historyItems,
        { type: /** @type {const} */ ("separator") },
        {
          label: "Open history file…",
          click: () => { const p = getHistoryPath(); if (p) shell.showItemInFolder(p); }
        }
      ]
    },
    { type: "separator" },
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
    {
      // Open the dictionary manager: add the names/made-up words the engine
      // should spell exactly, and review or remove existing ones.
      label: "Manage dictionary…",
      click: () => openDictionaryWindow()
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
  // The very first thing on screen: a branded splash, not a terminal or a bare
  // window. It reports boot progress and later tucks itself into the tray.
  createSplashWindow();
  setSplashStatus("Starting up…");

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
  // Custom dictionary lives in userData so it survives reinstalls/updates and
  // isn't bundled into the read-only app. The providers read it on every
  // connection; the cursor pop-up writes to it.
  vocab.init(join(app.getPath("userData"), "custom-vocab.json"));
  // Last-50 dictation history, persisted across restarts; shown in the tray's
  // "Recent dictations" menu. Loaded before the tray builds its first menu.
  await initHistory();

  setSplashStatus("Starting the local relay…");
  await bootRelayServer();
  buildAppMenu();
  createTray();
  if (serverPort) {
    createPillWindow();
    createVocabWindow();
    createDictationWindow();
    setSplashStatus("Connecting to your speech engine…");
    // Backstop: if the dictation window's load never completes (relay route
    // hangs, renderer crash), still tuck the splash away instead of leaving it
    // pinned on screen. The normal ready path below fires well before this.
    setTimeout(dismissSplashToTray, 9000);
    dictationWindow.webContents.once("did-finish-load", async () => {
      await setupHotkey();
      // Fully live now: flip the splash to its "ready" look, let it land for a
      // beat, then animate it down into the tray and disappear.
      const holdKey = process.platform === "darwin" ? "right Option" : "right Alt";
      setSplashStatus(`Ready — hold ${holdKey} to dictate.`, "ready");
      setTimeout(dismissSplashToTray, 650);
    });
  } else {
    // Relay couldn't start (usually a missing API key). Surface it on the
    // splash instead of failing silently, then tuck it away — the tray stays.
    setSplashStatus(serverError || "Couldn't start. Check your settings.", "error");
    setTimeout(dismissSplashToTray, 4500);
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

app.on("before-quit", async () => {
  isQuitting = true;
  if (hotkeyEngine && typeof hotkeyEngine.stop === "function") {
    try { hotkeyEngine.stop(); } catch {}
  }
  try { correctionWatcher.stop(); } catch {}
  try {
    const { stopWhisperServer } = await import("./src/providers/whisper-local.js");
    stopWhisperServer();
  } catch {}
});
