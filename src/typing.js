// @ts-check
import { clipboard } from "electron";
import { execFile } from "node:child_process";

const USE_CLIPBOARD = process.env.TYPE_VIA_CLIPBOARD !== "false";
const RELEASE_DELAY_MS = Number(process.env.TYPE_RELEASE_DELAY_MS || 80);

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// nut-js pulls in a large image stack (jimp) at import time, and is only needed
// for the non-clipboard "type each character" path and for the paste keystroke
// on non-macOS platforms. Load it lazily so the default macOS clipboard path
// never touches it — that keeps a heavy, packaging-fragile dependency off the
// hot path (a missing jimp sub-package once broke every dictation in the
// packaged app).
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
 * Send the paste shortcut (⌘V / Ctrl+V) to the frontmost app. macOS uses the
 * built-in `osascript` (no native module; needs the Accessibility / Automation
 * permission the app already requires for typing). Other platforms use nut-js.
 * @returns {Promise<void>}
 */
function pasteShortcut() {
  if (process.platform === "darwin") {
    return new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/osascript",
        ["-e", 'tell application "System Events" to keystroke "v" using command down'],
        (err) => (err ? reject(err) : resolve())
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
    clipboard.writeText(textToPaste);
    try {
      await pasteShortcut();
    } finally {
      setTimeout(() => {
        try { clipboard.writeText(previousClipboard); } catch {}
      }, 250);
    }
    return;
  }

  const { keyboard } = await nut();
  await keyboard.type(textToPaste);
}
