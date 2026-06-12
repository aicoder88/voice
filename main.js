// @ts-check
// Must be first: prepares PATH + loads .env from the app home before any module
// reads process.env (see src/bootstrap-env.js). Replaces the old
// `import "dotenv/config"`, which only worked when launched from the repo dir.
import "./src/bootstrap-env.js";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen, Notification, clipboard, powerMonitor } from "electron";

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
  if (tray) tray.displayBalloon?.({ title: "GVoice", content: "Already running. Hold Ctrl+Shift to dictate." });
});

process.on("uncaughtException", (err) => {
  const stack = err && err.stack ? err.stack : String(err);
  console.error("[uncaughtException]", stack);
  // dlog is a hoisted function declaration, so it's reachable here even though
  // it's defined further down. Capture the crash in the file too (console alone
  // is invisible in a packaged launch).
  try { dlog("uncaughtException", stack); } catch {}
});
process.on("unhandledRejection", (reason) => {
  const stack = reason && typeof reason === "object" && "stack" in reason ? reason.stack : String(reason);
  console.error("[unhandledRejection]", stack);
  try { dlog("unhandledRejection", String(stack)); } catch {}
});
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { startServer } from "./server.js";
import { DictationSession } from "./src/dictation-session.js";
import * as vocab from "./src/vocab.js";
import { createCorrectionWatcher } from "./src/correction-watch.js";
import { captureForegroundWindow, restoreForegroundWindow, getWindowRect, isEditableFieldFocused, focusedFieldValue, isForegroundWindow } from "./src/foreground.js";
import { initHistory, getHistory, getHistoryPath, recordTranscript } from "./src/history.js";
import { ensureWhisperServer, stopWhisperServer } from "./src/providers/whisper-local.js";
import { ENV_FILE, MODELS_DIR, BIN_DIR } from "./src/bootstrap-env.js";
import { writeEnvFile, settingsView, patchFromView } from "./src/settings.js";
import { probeCapability, recommendedAssets } from "./src/hardware.js";
import { suggestBeforeBenchmark } from "./src/benchmark.js";
import { runLocalBenchmark } from "./src/benchmark-run.js";
import { ensureModel, ensureWindowsBinaries, MODELS, WINDOWS_BINARY_ZIPS } from "./src/model-download.js";
import { saveRecording, pruneRecordings, clearRecordings } from "./src/recordings.js";
import { appendFileSync, statSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = ENV_FILE;

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
/** @type {import("electron").BrowserWindow | null} */
let settingsWindow = null;
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
// True when the global hotkey failed to start. Without it the app LOOKS alive
// (tray, splash "Ready") while every key-hold silently does nothing — so the
// tooltip and splash must tell the truth instead.
let hotkeyFailed = false;
let isQuitting = false;
// The busy guard must outlive the renderer's 20s transcriber watchdog
// (public/dictation.js FAILURE_MS): with the old 500ms default it expired on
// nearly every dictation, so a second press mid-transcription wiped
// savedForegroundHwnd and could paste into the wrong window. A terminal event
// always ends the session sooner; this is only the anti-jam backstop.
const dictation = new DictationSession({ safetyTimeoutMs: 25000 });

// The diagnostic log MUST live in userData, not next to main.js. When the app
// is packaged, __dirname is inside the read-only .app/.asar bundle, so the old
// join(__dirname, "debug.log") made every appendFileSync throw — silently, since
// dlog swallows errors — and the INSTALLED app logged nothing at all (that's why
// a real incident was a forensic dig). userData is writable in every launch.
// app.getPath("userData") is valid here because app.setName ran at the top.
const DEBUG_LOG = join(app.getPath("userData"), "debug.log");
const DEBUG_LOG_ROTATED = join(app.getPath("userData"), "debug.log.1");
const DEBUG_LOG_MAX_BYTES = 1024 * 1024; // ~1 MB
/** @type {number} bytes appended to debug.log since boot; seeded from disk on first write */
let dlogBytesWritten = -1;
function dlog(/** @type {string} */ tag, /** @type {unknown} */ data) {
  try {
    const line = `[${new Date().toISOString()}] ${tag} ${typeof data === "string" ? data : JSON.stringify(data)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    // Seed the byte counter once with the file's current size so we account
    // for content carried over from previous runs. Ensure the userData dir
    // exists first — early boot lines can land before it's otherwise created.
    if (dlogBytesWritten < 0) {
      try { mkdirSync(dirname(DEBUG_LOG), { recursive: true }); } catch {}
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

// Per-event tracing is noisy (a line per press/release/cleanup/paste, plus the
// renderer and relay diagnostics). Keep the durable record in debug.log; only
// echo to the console when GVOICE_DEBUG is set.
const VERBOSE = process.env.GVOICE_DEBUG === "1" || process.env.GVOICE_DEBUG === "true";
function debug(/** @type {any[]} */ ...args) {
  if (VERBOSE) console.error(...args);
}

// In a packaged launch there's normally no terminal, so every console.error —
// the relay diagnostics, provider warnings ("deepgram ALL EMPTY"), the whisper
// silence gate, typing failures — would vanish. Mirror them into debug.log so
// the installed app's failures are diagnosable in one file. We only ALSO echo
// to the real console when GVOICE_DEBUG is set: a packaged app that happens to
// inherit a console (e.g. launched from a parent shell) would otherwise flood
// it with per-event traces. Dev launches (not packaged) keep the console
// untouched — the terminal already shows everything.
if (app.isPackaged) {
  const consoleError = console.error.bind(console);
  console.error = (/** @type {any[]} */ ...args) => {
    if (VERBOSE) consoleError(...args);
    try {
      const msg = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a && a.stack) return a.stack;
          // A rich error object can carry a circular reference; JSON.stringify
          // would throw and (caught below) silently drop the MOST interesting
          // log line. Fall back to String() so it's never lost.
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(" ");
      dlog("console.error", msg);
    } catch {}
  };
}

/** @type {number | null} */
let savedForegroundHwnd = null;

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
    // No dedicated "auto" art — fall back to the app icon for auto mode so the
    // tray doesn't claim a specific language.
    const file = language === "en" ? "tray-en.png" : language === "hr" ? "tray-hr.png" : "tray.ico";
    const img = nativeImage.createFromPath(join(__dirname, "public", file));
    if (!img.isEmpty()) return img;
  } catch {}
  return nativeImage.createEmpty();
}

async function bootRelayServer() {
  // The relay only needs OPENAI_API_KEY when the dictation window will
  // actually open an OpenAI WebSocket. whisper-local and deepgram providers
  // talk to their own backends, so don't gate boot on the OpenAI key.
  // Clear any error from a previous (failed) attempt so a successful retry —
  // e.g. after the user saves a key in Settings on first run — doesn't leave a
  // stale "Missing …" string behind for a later code path to surface.
  serverError = null;
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
  success: { width: 480, height: 56 },
  error: { width: 480, height: 56 }
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
  /** @type {{ canCopy?: boolean, canOpen?: boolean, holdMs?: number, reason?: string }} */ opts = {}
) {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  const size = PILL_SIZES[state] || PILL_SIZES.listening;
  positionPill(size.width, size.height);
  const interactive = state === "success" || state === "error";
  // Result states stay click-through but FORWARD mouse moves to the renderer,
  // which flips real interactivity on only while the pointer is over the
  // visible pill (pill:set-interactive). Without forwarding, the invisible
  // margins of the fixed 480px window would eat clicks at the bottom-center
  // of the screen for the whole 6–30s linger.
  if (interactive) pillWindow.setIgnoreMouseEvents(true, { forward: true });
  else pillWindow.setIgnoreMouseEvents(true);
  pillWindow.webContents.send("pill:state", {
    state,
    canCopy: !!opts.canCopy,
    canOpen: !!opts.canOpen,
    holdMs: opts.holdMs,
    // A short, plain-English reason shown on result pills so a red "Error" isn't
    // a mystery ("No audio reached the app — mic restarted, try again", etc.).
    reason: opts.reason || ""
  });
}

// Show a terminal result pill (success or error) and remember what its buttons
// act on. The renderer auto-hides it; the safety timer is a longer backstop in
// case the renderer's own timer is lost.
function showPillResult(
  /** @type {"success" | "error"} */ state,
  /** @type {string | null} */ transcript,
  /** @type {string | null} */ recordingPath,
  /** @type {{ uncertain?: boolean, reason?: string }} */ opts = {}
) {
  currentTranscript = transcript;
  currentRecordingPath = recordingPath;
  // How long the pill lingers before the renderer auto-hides it.
  //  - A genuine error (no speech, failed paste, transcribe failure) lingers 30s
  //    so the text/recording stays recoverable from the pill.
  //  - A confirmed-landed success clears fast (6s — it worked, get out of the way).
  //  - The common macOS middle case — pasted, but no readable field to verify it
  //    landed (browsers / Slack / editors) — used to also sit 30s, which felt as
  //    sticky as a failure. It almost always DID land, and the text is still in
  //    the tray's Recent dictations if it didn't, so give it a short-ish 10s. The
  //    new ✕ on the pill lets the user clear any of these instantly.
  const holdMs = state === "error" ? 30000 : opts.uncertain ? 10000 : 6000;
  setPillState(state, { canCopy: !!transcript, canOpen: !!recordingPath, holdMs, reason: opts.reason });
  pillWindow?.showInactive();
  // Crash backstop only — must outlive the renderer's own timer so it never
  // cuts the pill short. Normal completions clear it via hidePill() first.
  armPillSafetyHide(holdMs + 15000);
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

// The Settings window — a normal, focusable window (tray → "Settings…", and
// opened automatically on first run when a required key/model is missing). Lets
// the user pick the speech engine, default language, cleanup, API keys, and
// recording privacy without hand-editing the .env file. `firstRun` shows a short
// welcome line; `reason` (optional) explains what's missing.
function openSettingsWindow(opts = {}) {
  // Accessory app (Dock hidden) — pull the app forward so the text fields accept
  // typing, same as the dictionary window.
  app.focus({ steal: true });
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (opts.firstRun || opts.reason) sendSettingsIntro(opts);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 620,
    title: "GVoice settings",
    show: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#14181e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-settings.cjs")
    }
  });
  settingsWindow.on("closed", () => { settingsWindow = null; });
  settingsWindow.webContents.once("did-finish-load", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      sendSettingsIntro(opts);
    }
  });
  if (serverPort) {
    settingsWindow.loadURL(`http://localhost:${serverPort}/settings.html`);
  } else {
    settingsWindow.loadFile(join(__dirname, "public", "settings.html"));
  }
}

// Push the first-run welcome / "what's missing" note to the settings renderer.
function sendSettingsIntro(opts = {}) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  if (!opts.firstRun && !opts.reason) return;
  settingsWindow.webContents.send("settings:intro", {
    firstRun: !!opts.firstRun,
    reason: opts.reason || ""
  });
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
  // The hidden renderer owns mic capture + the WebSocket. If it crashes, the
  // hotkey would keep IPCing into a dead webContents and every press would
  // silently do nothing until an app restart — the same "works until it doesn't"
  // trap. Reload it so the next press has a live renderer, and capture the crash
  // in the log (invisible on the console in a packaged launch).
  dictationWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[dictation/renderer] process gone:", details && details.reason);
    dlog("render-process-gone", details || {});
    // Small delay so we don't tight-loop if it dies again on load.
    setTimeout(() => {
      try { if (dictationWindow && !dictationWindow.isDestroyed()) reloadDictationWindow(); } catch {}
    }, 800);
  });
  dictationWindow.webContents.on("unresponsive", () => {
    console.error("[dictation/renderer] unresponsive");
    dlog("renderer-unresponsive", {});
  });
  const provider = encodeURIComponent((process.env.STT_PROVIDER || "openai").toLowerCase());
  dictationWindow.loadURL(`http://localhost:${serverPort}/dictation.html?provider=${provider}`);
}

// Languages cycled by the right-Ctrl tap. Stored in process.env so deepgram.js
// can read the latest value on every new connection without an IPC round-trip.
// "auto" (the default) races parallel hr+en Deepgram connections and keeps the
// more confident transcript; hr/en remain as manual overrides.
const DICTATION_LANGUAGES = ["auto", "hr", "en"];

function getCurrentLanguage() {
  return (process.env.WHISPER_LANGUAGE || DICTATION_LANGUAGES[0]).toLowerCase();
}

/** Human label for a language code, used in the tooltip + toggle notification. */
function languageLabel(lang) {
  if (lang === "hr") return "Croatian";
  if (lang === "en") return "English";
  return "Auto (Croatian + English)";
}

function toggleLanguage() {
  const current = getCurrentLanguage();
  const idx = DICTATION_LANGUAGES.indexOf(current);
  const next = DICTATION_LANGUAGES[(idx + 1) % DICTATION_LANGUAGES.length];
  process.env.WHISPER_LANGUAGE = next;
  // Persist so the choice survives a restart (auto-detect is unreliable for short
  // Croatian, so a user who forces HR expects it to stick). Surgical .env write.
  try { writeEnvFile(envPath, { WHISPER_LANGUAGE: next }); } catch (err) {
    console.error("[main] could not persist language:", err && err.message);
  }
  debug("[main] language toggled " + current + " -> " + next);
  updateTrayTooltip();
  // Brief on-screen confirmation — the tray icon is easy to miss, and forcing the
  // language is now the reliable way to get Croatian, so the user needs to SEE it.
  try {
    if (Notification.isSupported()) {
      new Notification({ title: "GVoice — dictation language", body: languageLabel(next) }).show();
    }
  } catch {}
  return next;
}

function updateTrayTooltip() {
  if (!tray) return;
  const lang = getCurrentLanguage();
  if (hotkeyFailed) {
    tray.setToolTip("GVoice — the dictation key couldn't start.\nQuit and reopen the app. Details: debug.log");
    try { tray.setImage(makeTrayIcon(lang)); } catch {}
    return;
  }
  const keyLabel = process.platform === "darwin" ? "right Option" : "Ctrl+Shift";
  tray.setToolTip(
    `Language: ${languageLabel(lang)}\n` +
    `Hold ${keyLabel} to dictate.\n` +
    `Tap right Ctrl to cycle Auto / Croatian / English.`
  );
  try { tray.setImage(makeTrayIcon(lang)); } catch {}
}

async function setupHotkey() {
  if (!serverPort || !dictationWindow) return false;
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
      // Must outlive the renderer's 20s FAILURE_MS watchdog, or the
      // transcribing pill vanishes mid-work and the result pops up later
      // with no context.
      armPillSafetyHide(25000);
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
      : "Ctrl+Shift (either side)";
    console.log(`Global hotkeys active: hold ${altLabel} to dictate, tap right Ctrl to toggle hr/en.`);
    return true;
  } catch (error) {
    hotkeyFailed = true;
    console.error("Failed to start global hotkey:", error.message);
    dlog("hotkey-failed", error && (error.stack || error.message));
    // The app would otherwise look alive while every key-hold does nothing.
    updateTrayTooltip();
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: "GVoice — the dictation key couldn't start",
          body: "Quit and reopen the app. Details are in debug.log."
        }).show();
      }
    } catch {}
    return false;
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
// @returns {Promise<{ text: string, pasted: boolean, verified: boolean | null } | null>}
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
  // Windows paste verification: confirm focus is STILL the window we restored to
  // right after sending Ctrl+V. If another app grabbed the foreground mid-paste,
  // the keystroke went somewhere else — downgrade so the text stays recoverable
  // from the pill instead of a false "Success". isForegroundWindow returns null
  // off Windows (and when koffi is unavailable), which we never hold against a
  // paste. This is the Windows counterpart to macOS's AX focus/read-back check.
  if (pasted && process.platform === "win32" && restoreHwnd != null) {
    const stillForeground = isForegroundWindow(restoreHwnd);
    if (stillForeground === false) {
      pasted = false;
      dlog("paste-foreground-lost", { hwnd: restoreHwnd });
    }
  }
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
  // verified: true = read back and confirmed, false = read back and missing
  // (already downgraded pasted), null = couldn't read the field to check.
  return { text: textToType, pasted, verified };
}

// How many recent recordings to keep on disk — matched to the history length so
// every dictation in the tray's "Recent dictations" list can still be played.
const MAX_RECORDINGS = 50;

// Privacy controls for the saved recordings (everything the user dictated sits
// here unencrypted). RECORDINGS_ENABLED=false turns saving off entirely;
// RECORDING_RETENTION_DAYS bounds how long clips linger on top of the count cap.
// Both are read fresh each call so a Settings change applies without a restart.
function recordingsEnabled() {
  return !/^(false|0|no|off)$/i.test(String(process.env.RECORDINGS_ENABLED ?? "true").trim());
}
function recordingMaxAgeMs() {
  const days = Number(process.env.RECORDING_RETENTION_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) return 0; // 0 = no age cap
  return days * 24 * 60 * 60 * 1000;
}

// Write the just-captured audio to the recordings folder so the pill's "Open
// recording" button and the tray's "Play recording" items have a file to open.
// Clips are pruned by BOTH a count cap (MAX_RECORDINGS) and an age cap, and they
// survive a restart. Returns the path, or null (nothing to save, or the user
// turned recording off).
//
// @param {string[]} chunks   base64 PCM16 frames
// @param {number} [sampleRate]
// @returns {Promise<string | null>}
async function saveTempRecording(chunks, sampleRate) {
  if (!recordingsDir || !chunks || !chunks.length || !recordingsEnabled()) return null;
  try {
    const pcm = Buffer.concat(chunks.map((b64) => Buffer.from(b64, "base64")));
    if (!pcm.length) return null;
    const path = await saveRecording(recordingsDir, pcm, sampleRate || 24000, {
      maxCount: MAX_RECORDINGS,
      maxAgeMs: recordingMaxAgeMs()
    });
    dlog("temp-recording", { bytes: pcm.length });
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

    // Empty transcript. If the renderer still sent the captured audio, this was
    // a real attempt that came back blank (mis-recognition, both auto-language
    // legs silent, a flush race) — save the recording and show an Error pill so
    // the user knows it failed and can listen to what they said. If there's no
    // audio (a too-short accidental tap), hide quietly; an Error on every
    // misfire would just be noise.
    if (!text || !text.trim()) {
      if (chunks && chunks.length) {
        const failedPath = await saveTempRecording(chunks, sampleRate);
        // Only claim a recording was saved when one actually was (saving can
        // be off in Settings, or the write can fail).
        showPillResult("error", null, failedPath, { reason: failedPath ? "No speech detected — recording saved." : "No speech detected." });
        recordTranscript("", false, failedPath);
        rebuildTrayMenu();
      } else {
        hidePill();
      }
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
        // A success we couldn't verify landed (verified !== true) lingers like an
        // error so a silent miss is still recoverable from the pill.
        showPillResult(
          result.pasted ? "success" : "error",
          result.text,
          recordingPath,
          {
            uncertain: result.pasted && result.verified !== true,
            // Only the hard-miss case gets an explanatory reason; a confirmed
            // success keeps the plain "Success" label.
            // Action first: the label can ellipsize, so the instruction must
            // survive truncation.
            reason: result.pasted ? "" : "Click Copy — the paste didn't land."
          }
        );
        // Keep the last 50 dictations on disk and in the tray menu, so a
        // missed paste is recoverable — and listenable — even after the pill is
        // gone.
        recordTranscript(result.text, result.pasted, recordingPath);
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
      showPillResult("error", text, recordingPath, { reason: "Something went wrong typing it out — click Copy." });
      // Cleanup never ran on this path — at least strip Whisper noise tokens
      // so the history entry matches the others as closely as possible.
      recordTranscript(stripWhisperNoiseTokens(text.trim()) || text, false, recordingPath);
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
    // The renderer sends a plain-English reason ("didn't respond in time", "lost
    // the connection…"); show it on the pill. No transcript to copy; the
    // recording is what we offer. Logged in history too for tray playback.
    const reason = (payload && payload.reason) || (recordingPath ? "Couldn't transcribe — recording saved." : "Couldn't transcribe.");
    showPillResult("error", null, recordingPath, { reason });
    if (recordingPath) {
      recordTranscript("", false, recordingPath);
      rebuildTrayMenu();
    }
  });

  ipcMain.on("dictation:error", (_event, message) => {
    dictation.done();
    console.error("Dictation error:", message);
    dlog("dictation-error", message);
    // No audio, no transcript (mic blocked, relay down, offline). Show the
    // reason on the pill so the user knows WHY, not just that it failed.
    showPillResult("error", null, null, { reason: typeof message === "string" ? message : "" });
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
  // Pointer entered/left the visible pill (renderer detects it from the
  // forwarded mouse moves). On=real clicks land; off=back to forward-only.
  ipcMain.on("pill:set-interactive", (_event, on) => {
    if (!pillWindow || pillWindow.isDestroyed()) return;
    if (on) pillWindow.setIgnoreMouseEvents(false);
    else pillWindow.setIgnoreMouseEvents(true, { forward: true });
  });

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

  // Settings window (request/response). get returns the current view; save
  // writes the .env, applies the change live, and returns the fresh view.
  ipcMain.handle("settings:get", () => settingsView(process.env));
  ipcMain.handle("settings:save", async (_event, payload) => {
    const patch = patchFromView(payload || {});
    try {
      writeEnvFile(envPath, patch);
    } catch (err) {
      console.error("[main] settings write failed:", err && err.message);
    }
    await applyEnvPatchLive(patch, "settings-save");
    return settingsView(process.env);
  });

  // --- On-device engine setup: probe → download+benchmark → apply ---------
  // The settings window's "speech engine" panel drives these. The benchmark is
  // the real decision-maker (a hardware guess is unreliable), so local is only
  // ever kept after it measurably beats the cloud — or the user opts in anyway.
  let benchmarkInFlight = false;
  ipcMain.handle("engine:probe", () => {
    const probe = probeCapability();
    return {
      probe,
      suggestion: suggestBeforeBenchmark(probe),
      models: MODELS,
      recommendedModel: recommendedAssets(probe).model,
      currentProvider: (process.env.STT_PROVIDER || "openai").toLowerCase(),
      currentModel: process.env.WHISPER_MODEL ? basename(process.env.WHISPER_MODEL) : "",
      platform: process.platform
    };
  });

  ipcMain.handle("engine:benchmark", async (event, payload) => {
    // Single-flight: the Settings window's disabled-button guard dies with the
    // window. A second concurrent run would stream into the same .part file
    // and rename a corrupt model into place — which then passes the
    // "already downloaded" size check forever.
    if (benchmarkInFlight) {
      return { ok: false, error: "A speed test is already running — give it a moment to finish." };
    }
    benchmarkInFlight = true;
    const probe = probeCapability();
    const modelName = (payload && payload.model) || recommendedAssets(probe).model;
    const variant = recommendedAssets(probe).variant; // cuda for NVIDIA, else cpu
    const send = (stage, extra = {}) => {
      try { event.sender.send("engine:progress", { stage, ...extra }); } catch {}
    };
    try {
      if (process.platform !== "win32") {
        throw new Error("The on-device engine isn't available on this platform yet — use a cloud engine.");
      }
      // 1) Engine binaries (skipped instantly if already present). The CUDA
      // build is a 700 MB pull — say so up front instead of surprising a
      // metered connection.
      const zipMB = WINDOWS_BINARY_ZIPS[variant] ? WINDOWS_BINARY_ZIPS[variant].sizeMB : "?";
      send(`Getting the on-device engine ready (${zipMB} MB download if not yet installed)…`);
      const bin = await ensureWindowsBinaries(variant, BIN_DIR, {
        onProgress: (p) => send(`Downloading the on-device engine (${zipMB} MB)…`, p)
      });
      // 2) The speech model (only downloaded if missing).
      const sizeMB = MODELS[modelName] ? MODELS[modelName].sizeMB : "?";
      send(`Downloading the speech model (${sizeMB} MB)…`);
      const model = await ensureModel(modelName, MODELS_DIR, {
        onProgress: (p) => send(`Downloading the speech model (${sizeMB} MB)…`, p)
      });
      // 3) The real, timed speed test on this hardware.
      send("Testing speed on your computer…");
      const verdict = await runLocalBenchmark({ bin, model, onStage: (m) => send(m) });
      dlog("engine-benchmark", { modelName, variant, elapsedMs: verdict.elapsedMs, fastEnough: verdict.fastEnough });
      return { ok: true, verdict, modelName };
    } catch (err) {
      console.error("[main] engine benchmark failed:", err && err.message);
      return { ok: false, error: (err && err.message) || "The speed test couldn't run." };
    } finally {
      benchmarkInFlight = false;
    }
  });

  // Commit the user's choice: which engine to use (and, for local, which model).
  ipcMain.handle("engine:apply", async (_event, payload) => {
    const provider = (payload && payload.provider) || "deepgram";
    /** @type {Record<string,string>} */
    const patch = { STT_PROVIDER: provider };
    if (provider === "whisper-local" && payload && payload.modelName) {
      const modelPath = join(MODELS_DIR, payload.modelName);
      // Never write a config pointing at a model that isn't on disk — a failed
      // download would otherwise brick every dictation until re-setup.
      if (!existsSync(modelPath)) {
        return { error: "That speech model isn't downloaded yet — run the speed test first." };
      }
      patch.WHISPER_MODEL = modelPath;
      if (process.platform === "win32") patch.WHISPER_BIN = join(BIN_DIR, "whisper-cli.exe");
    }
    try {
      writeEnvFile(envPath, patch);
    } catch (err) {
      console.error("[main] engine apply write failed:", err && err.message);
    }
    await applyEnvPatchLive(patch, "engine-apply");
    return settingsView(process.env);
  });
  // Delete every saved recording (the privacy "wipe my voice clips" button).
  ipcMain.handle("settings:clear-recordings", async () => {
    if (!recordingsDir) return 0;
    const removed = await clearRecordings(recordingsDir);
    dlog("recordings-cleared", { removed });
    rebuildTrayMenu();
    return removed;
  });

  // The renderer lost the microphone (disconnected, muted, seized by another
  // app, or silent for several holds in a row) and rebuilt its capture. Make
  // the failure visible instead of silently typing nothing.
  ipcMain.on("dictation:mic-warning", (_event, message) => {
    dictation.done();
    console.error("[main] mic warning:", message);
    dlog("mic-warning", message);
    // Show the reason ON the pill (not just a system notification the user may
    // have muted) so a dead-mic rebuild visibly says "press and try again"
    // instead of a bare red dot. Keep the throttled notification as a backup.
    showPillResult("error", null, null, { reason: message });
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

// Rebuild the mic pipeline proactively when the machine wakes. Sleep/wake (and
// screen unlock) is exactly when the macOS capture stream goes dead and starts
// delivering pure silence — so instead of waiting for the FIRST post-sleep
// dictation to be the silent one that trips recovery, we tell the renderer to
// rebuild the moment we wake. Wired once.
let powerMonitorWired = false;
function setupPowerMonitor() {
  if (powerMonitorWired) return;
  powerMonitorWired = true;
  const rebuild = (/** @type {string} */ reason) => {
    dlog("power", reason);
    if (dictationWindow && !dictationWindow.isDestroyed()) {
      dictationWindow.webContents.send("dictation:rebuild-capture", reason);
    }
  };
  powerMonitor.on("resume", () => rebuild("resume"));
  powerMonitor.on("unlock-screen", () => rebuild("unlock-screen"));
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

  // One row per saved dictation, newest first: time + a preview. Each opens a
  // submenu to copy the text or play the recording (whichever exists). A failed
  // attempt has no text — only the recording to listen back to.
  const history = getHistory();
  const historyItems = history.map((entry) => {
    const time = new Date(entry.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // Newlines break NSMenu labels (display cuts at the first one) — flatten.
    const flat = (entry.text || "").replace(/\s+/g, " ").trim();
    const preview = flat
      ? (flat.length > 60 ? flat.slice(0, 60) + "…" : flat)
      : "(no transcript — recording only)";
    const hasRecording = !!entry.recordingPath && existsSync(entry.recordingPath);
    /** @type {import("electron").MenuItemConstructorOptions[]} */
    const sub = [];
    // The ⚠ on the parent row needs a legend — say what it means right where
    // the user looks for the text.
    if (!entry.pasted) sub.push({ label: "⚠ Wasn't pasted into any app", enabled: false });
    if (flat) sub.push({ label: "Copy text", click: () => clipboard.writeText(entry.text) });
    sub.push({
      label: hasRecording ? "Play recording" : "Recording unavailable",
      enabled: hasRecording,
      click: () => { if (entry.recordingPath) shell.openPath(entry.recordingPath).catch(() => {}); }
    });
    return {
      label: `${time}${entry.pasted ? "" : " ⚠"}  ${preview}`,
      submenu: sub
    };
  });

  // The newest saved recording, for the one-click "play my last attempt" item.
  const lastRecording = history.find((e) => e.recordingPath && existsSync(e.recordingPath));

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
    {
      label: "Play last recording",
      enabled: !!lastRecording,
      click: () => {
        const p = lastRecording && lastRecording.recordingPath;
        if (p) shell.openPath(p).catch(() => {});
      }
    },
    { type: "separator" },
    // Engine-room jargon that opened a leftover dev page — dev runs only.
    ...(VERBOSE ? [{
      label: serverPort ? `Relay: http://localhost:${serverPort}` : "Relay: not running",
      enabled: !!serverPort,
      click: () => { if (serverPort) shell.openExternal(`http://localhost:${serverPort}`); }
    }] : []),
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
    {
      // Engine, language, cleanup, API keys, and recording privacy.
      label: "Settings…",
      click: () => openSettingsWindow()
    },
    {
      // Delete the saved voice clips on disk (privacy). Enabled whenever the
      // folder exists — clips can linger on disk even when none are in the
      // (capped, in-memory) history, and the wipe should still reach them.
      label: "Clear recordings",
      enabled: !!recordingsDir,
      click: async () => {
        if (!recordingsDir) return;
        await clearRecordings(recordingsDir);
        rebuildTrayMenu();
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

// Bring up the live dictation machinery: the pill, the vocab pop-up, the hidden
// dictation renderer, and the global hotkey. Idempotent — guarded so the
// first-run "save your key" path can call it after the relay finally boots
// without double-creating windows. `onReady` fires once the dictation renderer
// has loaded and the hotkey is armed.
let dictationBroughtUp = false;
async function bringUpDictation(onReady) {
  if (!serverPort) return;
  if (dictationBroughtUp) { onReady?.(!hotkeyFailed); return; }
  dictationBroughtUp = true;
  createPillWindow();
  createVocabWindow();
  createDictationWindow();
  setupPowerMonitor();
  if (!dictationWindow) return;
  dictationWindow.webContents.once("did-finish-load", async () => {
    const hotkeyOk = await setupHotkey();
    onReady?.(hotkeyOk);
  });
}

// Reload the hidden dictation renderer pointed at the current provider. The
// provider is carried in the URL query and read once at renderer load, so a
// Settings change to the engine takes effect by reloading (the hotkey closures
// reference the module-level dictationWindow, so they keep working). No-op if
// the window isn't up yet.
function reloadDictationWindow() {
  if (!serverPort || !dictationWindow || dictationWindow.isDestroyed()) return;
  const provider = encodeURIComponent((process.env.STT_PROVIDER || "openai").toLowerCase());
  dictationWindow.loadURL(`http://localhost:${serverPort}/dictation.html?provider=${provider}`);
}

// Apply an already-written .env patch to the LIVE app without a restart: mirror
// it into process.env, then boot the relay (first run) or reload the dictation
// window (provider switch) so the next dictation honors it. Shared by
// settings:save and engine:apply so both take effect identically.
async function applyEnvPatchLive(patch, source) {
  const prevProvider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
  const newProvider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  dlog(source, { keys: Object.keys(patch), providerChanged: newProvider !== prevProvider });

  if (!serverPort) {
    // First-run path: the relay never booted (no key at launch). Now that a key
    // may be present, try again and bring dictation fully up.
    await bootRelayServer();
    if (serverPort) await bringUpDictation();
  } else if (newProvider !== prevProvider) {
    reloadDictationWindow();
  }
  updateTrayTooltip();
  rebuildTrayMenu();
}

// First-run / misconfiguration check: returns a short, plain-English reason the
// app can't dictate yet (no .env, or the active engine's key/model is missing),
// or null when everything needed is present. Drives the auto-opened Settings
// window so a fresh install guides the user instead of silently doing nothing.
function needsOnboarding() {
  if (!existsSync(envPath)) {
    return "Welcome to GVoice. Add your speech engine details below to start dictating.";
  }
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    return "Add your OpenAI API key to start dictating.";
  }
  if (provider === "deepgram" && !process.env.DEEPGRAM_API_KEY) {
    return "Add your Deepgram API key to start dictating.";
  }
  if ((provider === "whisper-local" || provider === "local") &&
      !(process.env.WHISPER_MODEL && existsSync(process.env.WHISPER_MODEL))) {
    return "Point GVoice at a local Whisper model file to dictate offline.";
  }
  return null;
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
  // Recent recordings live here. The pill's "Open recording" button and the
  // tray's "Play recording" / "Play last recording" items open them, so they
  // persist across restarts (the last MAX_RECORDINGS clips are kept, older ones
  // pruned as new ones are saved — see saveTempRecording). Created if missing.
  recordingsDir = join(app.getPath("userData"), "temp-recordings");
  await mkdirAsync(recordingsDir, { recursive: true }).catch(() => {});
  // Enforce the count + age caps at boot too, so clips that aged out while the
  // app was closed (or a freshly-lowered retention setting) are cleared now, not
  // only as new recordings are saved.
  await pruneRecordings(recordingsDir, { maxCount: MAX_RECORDINGS, maxAgeMs: recordingMaxAgeMs() }).catch(() => {});
  // Custom dictionary lives in userData so it survives reinstalls/updates and
  // isn't bundled into the read-only app. The providers read it on every
  // connection; the cursor pop-up writes to it.
  vocab.init(join(app.getPath("userData"), "custom-vocab.json"));
  // Last-50 dictation history, persisted across restarts; shown in the tray's
  // "Recent dictations" menu. Loaded before the tray builds its first menu.
  await initHistory();

  setSplashStatus("Getting things ready…");
  await bootRelayServer();
  buildAppMenu();
  createTray();
  setupIpc();

  // First run / misconfiguration: guide the user to Settings instead of silently
  // doing nothing. The tray stays live either way.
  const onboard = needsOnboarding();

  if (serverPort) {
    setSplashStatus("Connecting to your speech engine…");
    // Backstop: if the dictation window's load never completes (relay route
    // hangs, renderer crash), still tuck the splash away instead of leaving it
    // pinned on screen. The normal ready path below fires well before this.
    setTimeout(dismissSplashToTray, 9000);
    await bringUpDictation((hotkeyOk) => {
      // Fully live now: flip the splash to its "ready" look, let it land for a
      // beat, then animate it down into the tray and disappear. If the hotkey
      // failed to arm, say THAT instead of a false "Ready".
      if (hotkeyOk === false) {
        setSplashStatus("The dictation key couldn't start — quit GVoice and reopen it.", "error");
        setTimeout(dismissSplashToTray, 4500);
        return;
      }
      const holdKey = process.platform === "darwin" ? "right Option" : "Ctrl+Shift";
      setSplashStatus(`Ready — hold ${holdKey} to dictate.`, "ready");
      setTimeout(dismissSplashToTray, 650);
    });
  } else {
    // Relay couldn't start (usually a missing API key). Surface it on the
    // splash instead of failing silently, then tuck it away — the tray stays.
    // serverError is raw Node text (EADDRINUSE etc.) — keep that in the log,
    // show plain words on screen.
    if (serverError) dlog("boot-error", serverError);
    setSplashStatus(
      onboard || (serverError
        ? "Couldn't start — another copy of GVoice may be running. Quit it and reopen."
        : "Couldn't start. Check your settings."),
      onboard ? "loading" : "error"
    );
    setTimeout(dismissSplashToTray, onboard ? 1800 : 4500);
  }

  // Open Settings on first run (or when the active engine is missing its key /
  // model) so a fresh install isn't a dead end. Saving a working key there boots
  // the relay and brings dictation up without a restart (see settings:save).
  if (onboard) openSettingsWindow({ firstRun: true, reason: onboard });

  // Prewarm the typing module at startup. In the default clipboard mode this
  // returns immediately (paste is a native keybd_event — no nut-js), so it only
  // pays the ~300ms nut-js import cost up front when the character-by-character
  // typing path (TYPE_VIA_CLIPBOARD=false) is in use.
  if (process.platform === "win32") {
    import("./src/typing.js").then((m) => m.prewarmTyping()).catch(() => {});
  }

  // Warm whisper-server at boot so the first dictation doesn't pay the model
  // load cost — and so any server orphaned by a previous crash is reaped now,
  // not on the first dictation. One retry covers a transient spawn hiccup;
  // after that the per-dictation path still falls back to whisper-cli.
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "whisper-local" || provider === "local") {
    const bin = process.env.WHISPER_BIN || process.env.WHISPER_CLI || "whisper-cli";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await ensureWhisperServer(bin);
        dlog("whisper", "warmed at boot");
        console.error("[main] whisper-server warmed at boot");
        break;
      } catch (err) {
        dlog("whisper", "warm attempt " + attempt + " failed: " + (err && err.message));
        console.error("[main] whisper warm attempt " + attempt + " failed:", err && err.message);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

// Shut everything this app started back down: hotkey listener, correction
// watcher, and the local whisper-server (so the model never lingers in memory
// after the app is closed). Synchronous so it completes even if the app exits
// immediately after.
function shutdownAll() {
  if (hotkeyEngine && typeof hotkeyEngine.stop === "function") {
    try { hotkeyEngine.stop(); } catch {}
  }
  try { correctionWatcher.stop(); } catch {}
  try { stopWhisperServer(); } catch {}
}

app.on("before-quit", () => {
  isQuitting = true;
  shutdownAll();
});

// Terminal-launched runs (dev / debugging) don't get 'before-quit' on Ctrl-C or
// a kill — tear down the whisper-server here too so no orphan is left behind.
for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(sig, () => {
    shutdownAll();
    app.quit();
    // If the event loop is already unwinding, make sure we actually exit.
    setTimeout(() => process.exit(0), 300).unref?.();
  });
}
