// @ts-check
// Platform-split hotkey detector.
//
// Windows (process.platform === "win32"):
//   Polling-based. Reads physical key state via Win32 GetAsyncKeyState (in
//   src/foreground.js) at ~30 Hz and fires callbacks on edges. No global
//   keyboard hook — uiohook-napi's low-level Windows hook could silently die
//   under focus/security/RDP churn and produce a "frozen" app where the pill
//   no longer appears. Polling can't be lost: it asks the kernel for the
//   current bit, every tick. Latency: poll period + 0 = ~33 ms worst case.
//   CPU: negligible (a few GetAsyncKeyState calls per tick).
//
//   Hold-to-talk is Ctrl+Shift held together (EITHER side — left Ctrl+Shift,
//   right Ctrl+Shift, or mixed). Earlier builds used right Alt, but on Windows
//   the poll doesn't swallow the key, so a bare Alt activated the menu bar in
//   classic apps (Notepad) and ate the paste. Ctrl+Shift never touches a menu
//   or the Start menu, and — with no layout-switch hotkey assigned — never
//   switches keyboard layout.
//
// macOS / Linux:
//   Event-based via uiohook-napi. Uses its global keydown/keyup/mouse stream
//   and matches three hold-to-talk triggers by uiohook keycode/button:
//   right-Alt, left-Ctrl + left-Cmd held together, and the mouse "back"
//   button. macOS requires Accessibility permission for the app to receive
//   these events.
//
// Both paths honor the same contract:
//   - Hold-to-talk trigger(s): onPress on the down edge, onRelease on the up.
//     On macOS several triggers feed one shared press/release state, so
//     overlapping holds (e.g. mouse button + right Option) act as one press.

import { createRequire } from "node:module";
import { isCtrlDown, isShiftDown } from "./foreground.js";
import { createHoldTracker } from "./hotkey-logic.js";

const require = createRequire(import.meta.url);

const POLL_INTERVAL_MS = 33;

// Edge traces (press/release/tap) are useful when debugging a stuck hotkey but
// noisy in normal use. Gate them behind GVOICE_DEBUG; real errors stay loud.
const VERBOSE = process.env.GVOICE_DEBUG === "1" || process.env.GVOICE_DEBUG === "true";
function debug(/** @type {any[]} */ ...args) {
  if (VERBOSE) console.error(...args);
}

/**
 * @typedef {{
 *   onPress?: (key: "alt") => void,
 *   onRelease?: (key: "alt") => void,
 * }} HotkeyCallbacks
 */

/**
 * @param {HotkeyCallbacks} callbacks
 * @returns {{ stop: () => void }}
 */
export function startHotkey(callbacks) {
  if (process.platform === "win32") {
    return startHotkeyWindows(callbacks);
  }
  return startHotkeyUiohook(callbacks);
}

/**
 * Windows polling implementation. Logic is byte-identical to the pre-split
 * version — only relocated inside this function.
 * @param {HotkeyCallbacks} callbacks
 * @returns {{ stop: () => void }}
 */
function startHotkeyWindows({ onPress, onRelease }) {
  let holdWas = false;
  const hold = createHoldTracker({
    onPress: () => {
      debug("[hotkey] PRESS ctrl+shift");
      try { onPress?.("alt"); } catch (error) { console.error("hotkey onPress error:", error); }
    },
    onRelease: () => {
      debug("[hotkey] RELEASE ctrl+shift");
      try { onRelease?.("alt"); } catch (error) { console.error("hotkey onRelease error:", error); }
    }
  });

  const tick = () => {
    const holdNow = isCtrlDown() && isShiftDown(); // hold-to-talk = Ctrl+Shift together

    if (holdNow && !holdWas) {
      hold.press("ctrlShift");
    } else if (!holdNow && holdWas) {
      hold.release("ctrlShift");
    }
    holdWas = holdNow;
  };

  const timer = setInterval(tick, POLL_INTERVAL_MS);

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

/**
 * macOS / Linux implementation via uiohook-napi. Imported lazily so Windows
 * builds never pay for the native binding (and don't need it installed).
 *
 *   Hold-to-talk triggers (any of these, all feeding one shared press state):
 *   - Right Option (Alt): UiohookKey.AltRight and UiohookKey.AltGraph, plus
 *     the raw 3640 scancode seen in older uiohook builds.
 *   - Left Ctrl + Left Cmd held together: the chord arms on the second key's
 *     down edge and releases when either key comes up. Left-only, so the
 *     right-side modifiers keep their existing meanings.
 *   - Mouse "back" button (uiohook button 4): hold to talk, release to stop.
 *     If a mouse-remapper app swallows the raw button, mapping the button to
 *     a held Ctrl+Cmd keystroke triggers the chord path instead.
 *
 * @param {HotkeyCallbacks} callbacks
 * @returns {{ stop: () => void }}
 */
function startHotkeyUiohook({ onPress, onRelease }) {
  // Lazy require so Windows builds don't choke if uiohook-napi isn't present
  // (e.g. native rebuild skipped, prebuild missing). The project is ESM, so
  // we go through createRequire to keep this synchronous and preserve the
  // startHotkey contract. A load failure THROWS: returning a stub here once
  // made the app boot to a "Ready" splash with a dead hotkey — the caller
  // must know so it can tell the user.
  /** @type {any} */
  let uiohook;
  try {
    uiohook = require("uiohook-napi");
  } catch (err) {
    console.error("[hotkey] uiohook-napi load failed:", err && /** @type {any} */ (err).message);
    throw new Error("uiohook-napi failed to load: " + (err && /** @type {any} */ (err).message));
  }
  const { uIOhook, UiohookKey } = uiohook;

  /** @type {Record<string, number | undefined>} */
  const keyCodes = UiohookKey || {};
  const ALT_KEYCODES = new Set(
    [
      keyCodes.AltRight,
      keyCodes.AltGraph,
      // Raw scancode fallback for the EXTENDED right-Alt (0xE038 = 3640) seen in
      // older uiohook builds. The bare 0x38 (= 56) is LEFT Alt/Option and is
      // deliberately NOT listed — including it made the left Option key also
      // fire dictation on macOS.
      3640
    ].filter((v) => typeof v === "number")
  );
  // Left Ctrl / left Cmd for the chord trigger. Raw fallbacks: 29 (left Ctrl)
  // and 3675 (left Meta/Cmd) match uiohook's scancode table.
  const CTRL_L_KEYCODES = new Set(
    [keyCodes.Ctrl, keyCodes.CtrlLeft, 29].filter((v) => typeof v === "number")
  );
  const CMD_L_KEYCODES = new Set(
    [keyCodes.Meta, keyCodes.MetaLeft, 3675].filter((v) => typeof v === "number")
  );
  // uiohook mouse buttons: 1 left, 2 right, 3 middle, 4 back, 5 forward.
  const MOUSE_BACK_BUTTON = 4;

  // All hold-to-talk triggers share one press/release state. Dictation starts
  // when the first trigger goes down and stops when the last one is released,
  // so overlapping holds can't double-start or cut each other off.
  const hold = createHoldTracker({
    onPress: (name) => {
      debug("[hotkey] PRESS (" + name + ")");
      try { onPress?.("alt"); } catch (error) { console.error("hotkey onPress error:", error); }
    },
    onRelease: (name) => {
      debug("[hotkey] RELEASE (" + name + ")");
      try { onRelease?.("alt"); } catch (error) { console.error("hotkey onRelease error:", error); }
    }
  });
  const pressSource = (/** @type {string} */ name) => hold.press(name);
  const releaseSource = (/** @type {string} */ name) => hold.release(name);

  let ctrlLDown = false;
  let cmdLDown = false;

  const handleDown = (/** @type {any} */ event) => {
    const code = event && event.keycode;
    // Self-heal stale chord state: if a keyup was swallowed (lock screen,
    // emoji picker, focus churn) a flag can stay latched and a later lone
    // Ctrl or Cmd press would start dictation. The event's live modifier
    // mask says whether the key is really down right now — trust it.
    if (event) {
      if (ctrlLDown && event.ctrlKey === false) ctrlLDown = false;
      if (cmdLDown && event.metaKey === false) cmdLDown = false;
      // Also free the shared hold tracker. Clearing the flags alone isn't
      // enough: a swallowed keyup mid-dictation leaves the hold latched, so
      // onRelease never fires and the mic keeps recording until the same
      // trigger is pressed AND released again. release() of a source that
      // isn't held is a no-op, so normal typing is unaffected. (The mouse
      // back button has no modifier-mask equivalent to heal from.)
      if (event.altKey === false) releaseSource("alt");
      if (event.ctrlKey === false || event.metaKey === false) releaseSource("ctrlCmd");
    }
    if (ALT_KEYCODES.has(code)) {
      pressSource("alt");
      return;
    }
    if (CTRL_L_KEYCODES.has(code)) {
      ctrlLDown = true;
      if (cmdLDown) pressSource("ctrlCmd");
      return;
    }
    if (CMD_L_KEYCODES.has(code)) {
      cmdLDown = true;
      if (ctrlLDown) pressSource("ctrlCmd");
      return;
    }
  };

  const handleUp = (/** @type {any} */ event) => {
    const code = event && event.keycode;
    if (ALT_KEYCODES.has(code)) {
      releaseSource("alt");
      return;
    }
    if (CTRL_L_KEYCODES.has(code)) {
      ctrlLDown = false;
      releaseSource("ctrlCmd");
      return;
    }
    if (CMD_L_KEYCODES.has(code)) {
      cmdLDown = false;
      releaseSource("ctrlCmd");
      return;
    }
  };

  const handleMouseDown = (/** @type {any} */ event) => {
    if (event && event.button === MOUSE_BACK_BUTTON) pressSource("mouseBack");
  };
  const handleMouseUp = (/** @type {any} */ event) => {
    if (event && event.button === MOUSE_BACK_BUTTON) releaseSource("mouseBack");
  };

  uIOhook.on("keydown", handleDown);
  uIOhook.on("keyup", handleUp);
  uIOhook.on("mousedown", handleMouseDown);
  uIOhook.on("mouseup", handleMouseUp);
  try {
    uIOhook.start();
  } catch (err) {
    console.error("[hotkey] uIOhook.start failed:", err && /** @type {any} */ (err).message);
    // Detach so a caller retry can't double-register, then surface the
    // failure — a silent catch here leaves the app looking alive with a
    // dead hotkey.
    try { uIOhook.off("keydown", handleDown); } catch {}
    try { uIOhook.off("keyup", handleUp); } catch {}
    try { uIOhook.off("mousedown", handleMouseDown); } catch {}
    try { uIOhook.off("mouseup", handleMouseUp); } catch {}
    throw new Error("uIOhook.start failed: " + (err && /** @type {any} */ (err).message));
  }

  return {
    stop() {
      try { uIOhook.off("keydown", handleDown); } catch {}
      try { uIOhook.off("keyup", handleUp); } catch {}
      try { uIOhook.off("mousedown", handleMouseDown); } catch {}
      try { uIOhook.off("mouseup", handleMouseUp); } catch {}
      try { uIOhook.stop(); } catch {}
    }
  };
}
