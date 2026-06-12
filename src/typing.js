// @ts-check
import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { sendPasteShortcut } from "./foreground.js";

const isWin = process.platform === "win32";

const USE_CLIPBOARD = process.env.TYPE_VIA_CLIPBOARD !== "false";
const RELEASE_DELAY_MS = Number(process.env.TYPE_RELEASE_DELAY_MS || 80);
// How long to wait for the osascript paste helper before declaring the paste
// failed. Normally it returns in well under a second; the only time it doesn't
// is a system-level wedge (System Events not launching, or processes stuck in
// kernel exit — seen 2026-06-06), where waiting longer never helps. Without
// this cap, typeText awaits forever and the pill is stuck on "Transcribing…".
const PASTE_TIMEOUT_MS = Number(process.env.TYPE_PASTE_TIMEOUT_MS) || 4000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// nut-js pulls in a large image stack (jimp) at import time, and is only needed
// for the non-clipboard "type each character" path. The paste keystroke uses a
// native OS call on both macOS (osascript) and Windows (keybd_event, via
// foreground.js), so neither touches nut-js. Load it lazily so the default
// clipboard path never imports it — that keeps a heavy, packaging-fragile
// dependency off the hot path (its jimp sub-packages do not survive the
// electron-builder + pnpm bundle, which broke every Windows paste).
/** @type {Promise<typeof import("@nut-tree-fork/nut-js")> | null} */
let nutPromise = null;
function nut() {
  if (!nutPromise) {
    nutPromise = import("@nut-tree-fork/nut-js").then((mod) => {
      mod.keyboard.config.autoDelayMs = 0;
      return mod;
    });
  }
  return nutPromise;
}

/**
 * Pay the nut-js import cost (~300ms — it pulls in a large image stack) at
 * startup instead of on the user's FIRST paste, so the first dictation types
 * out as fast as every one after it. Fire-and-forget: the lazy path in
 * pasteShortcut() still covers it if this never ran or failed.
 *
 * Skipped entirely on the native-paste platforms (macOS, Windows) when in the
 * default clipboard mode — there the paste keystroke never goes through nut-js,
 * so importing the jimp stack would only waste startup time (and, in the
 * packaged Windows app, log a harmless-but-noisy missing-module error).
 * @returns {Promise<void>}
 */
export function prewarmTyping() {
  const nativePaste = USE_CLIPBOARD && (process.platform === "darwin" || isWin);
  if (nativePaste) return Promise.resolve();
  return nut().then(() => {}, () => {});
}

/**
 * Send the paste shortcut (⌘V / Ctrl+V) to the frontmost app. macOS uses the
 * built-in `osascript` and Windows a native `keybd_event` (both need only the
 * Accessibility / input permission the app already requires for typing, and
 * neither pulls in nut-js). Linux falls back to nut-js.
 * @returns {Promise<void>}
 */
function pasteShortcut() {
  if (isWin) {
    // Native Win32 Ctrl+V. Returns false only if koffi never loaded, in which
    // case we fall through to the nut-js path below as a last resort.
    if (sendPasteShortcut()) return Promise.resolve();
  }
  if (process.platform === "darwin") {
    return new Promise((resolve, reject) => {
      // Settle exactly once: on the child's exit, or on the timeout — whichever
      // comes first. execFile's own `timeout` SIGKILLs the child as a best
      // effort, but a kernel-stuck child ignores signals and never emits
      // 'close', so we must not rely on the callback alone.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("osascript paste helper did not return within " + PASTE_TIMEOUT_MS + "ms (System Events hung?)"));
      }, PASTE_TIMEOUT_MS);
      execFile(
        "/usr/bin/osascript",
        ["-e", 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: PASTE_TIMEOUT_MS, killSignal: "SIGKILL" },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve();
        }
      );
    });
  }
  return nut().then(async ({ keyboard, Key }) => {
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
  });
}

/**
 * Type or paste `text` into the focused app. With TYPE_VIA_CLIPBOARD=true
 * (default), saves the current clipboard, writes `text`, sends the paste
 * shortcut, then restores the original clipboard 250ms later. Otherwise, types
 * each character via nut-js.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function typeText(text) {
  if (!text) return;

  await sleep(RELEASE_DELAY_MS);

  const needsLeadingSpace = !/^[\s.,;:!?\-)\]"'`]/.test(text);
  const textToPaste = needsLeadingSpace ? " " + text : text;

  if (USE_CLIPBOARD) {
    const previousClipboard = clipboard.readText();
    // A copied image (screenshot) reads back as empty TEXT — capture it too,
    // or every dictation would destroy it (restore would write "" over it).
    // Files/rich clipboard content can't be fully round-tripped from Electron;
    // text + image covers the common cases.
    const previousImage = previousClipboard ? null : clipboard.readImage();
    clipboard.writeText(textToPaste);
    try {
      await pasteShortcut();
    } finally {
      setTimeout(() => {
        try {
          if (previousImage && !previousImage.isEmpty()) clipboard.writeImage(previousImage);
          else clipboard.writeText(previousClipboard);
        } catch {}
      }, 250);
    }
    return;
  }

  const { keyboard } = await nut();
  await keyboard.type(textToPaste);
}
