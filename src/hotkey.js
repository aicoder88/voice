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
//   CPU: negligible (two GetAsyncKeyState calls per tick).
//
// macOS / Linux:
//   Event-based via uiohook-napi. Uses its global keydown/keyup/mouse stream
//   and matches three hold-to-talk triggers by uiohook keycode/button:
//   right-Alt, left-Ctrl + left-Cmd held together, and the mouse "back"
//   button. Right-Ctrl tap toggles language. macOS requires Accessibility
//   permission for the app to receive these events.
//
// Both paths honor the same contract:
//   - Hold-to-talk trigger(s): onPress on the down edge, onRelease on the up.
//     On macOS several triggers feed one shared press/release state, so
//     overlapping holds (e.g. mouse button + right Option) act as one press.
//   - Right Ctrl tap (down + up within CTRL_TAP_WINDOW_MS, with no other key
//     going down in between) fires onToggleLanguage. Holding right Ctrl, or
//     pressing it as part of a chord, does NOT toggle.

import { createRequire } from "node:module";
import { isRightAltDown, isRightCtrlDown } from "./foreground.js";

const require = createRequire(import.meta.url);

const POLL_INTERVAL_MS = 33;
const CTRL_TAP_WINDOW_MS = 300;

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
 *   onToggleLanguage?: () => void,
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
function startHotkeyWindows({ onPress, onRelease, onToggleLanguage }) {
  let altWas = false;
  let ctrlWas = false;
  /** @type {number | null} */
  let ctrlDownAt = null;
  let ctrlChorded = false;

  const tick = () => {
    const altNow = isRightAltDown();
    const ctrlNow = isRightCtrlDown();

    if (altNow && !altWas) {
      if (ctrlDownAt !== null) ctrlChorded = true;
      debug("[hotkey] PRESS alt");
      try {
        onPress?.("alt");
      } catch (error) {
        console.error("hotkey onPress error:", error);
      }
    } else if (!altNow && altWas) {
      debug("[hotkey] RELEASE alt");
      try {
        onRelease?.("alt");
      } catch (error) {
        console.error("hotkey onRelease error:", error);
      }
    }
    altWas = altNow;

    if (ctrlNow && !ctrlWas) {
      ctrlDownAt = Date.now();
      ctrlChorded = false;
    } else if (!ctrlNow && ctrlWas && ctrlDownAt !== null) {
      const held = Date.now() - ctrlDownAt;
      const wasTap = !ctrlChorded && held <= CTRL_TAP_WINDOW_MS;
      ctrlDownAt = null;
      ctrlChorded = false;
      if (wasTap) {
        debug("[hotkey] TAP ctrl (held=" + held + "ms)");
        try {
          onToggleLanguage?.();
        } catch (error) {
          console.error("hotkey onToggleLanguage error:", error);
        }
      }
    }
    ctrlWas = ctrlNow;
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
 *   - Right Control = tap-to-toggle. UiohookKey.CtrlR / ControlRight, plus
 *     the 3613 scancode fallback.
 *
 * @param {HotkeyCallbacks} callbacks
 * @returns {{ stop: () => void }}
 */
function startHotkeyUiohook({ onPress, onRelease, onToggleLanguage }) {
  // Lazy require so Windows builds don't choke if uiohook-napi isn't present
  // (e.g. native rebuild skipped, prebuild missing). The project is ESM, so
  // we go through createRequire to keep this synchronous and preserve the
  // startHotkey contract. Any failure here just disables hotkeys with a
  // logged error — the rest of the app keeps running.
  /** @type {any} */
  let uiohook;
  try {
    uiohook = require("uiohook-napi");
  } catch (err) {
    console.error("[hotkey] uiohook-napi load failed:", err && /** @type {any} */ (err).message);
    return { stop() {} };
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
  // Right-Ctrl only. Left-Ctrl is deliberately excluded — Ctrl+C / Ctrl+V
  // are everywhere and would constantly fire the toggle.
  const CTRL_R_KEYCODES = new Set(
    [
      keyCodes.CtrlR,
      keyCodes.ControlRight,
      // Raw scancode fallback for the extended right-ctrl.
      3613
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
  /** @type {Set<string>} */
  const sourcesHeld = new Set();
  function pressSource(/** @type {string} */ name) {
    if (sourcesHeld.has(name)) return; // auto-repeat
    const wasIdle = sourcesHeld.size === 0;
    sourcesHeld.add(name);
    if (!wasIdle) return;
    debug("[hotkey] PRESS (" + name + ")");
    try {
      onPress?.("alt");
    } catch (error) {
      console.error("hotkey onPress error:", error);
    }
  }
  function releaseSource(/** @type {string} */ name) {
    if (!sourcesHeld.delete(name)) return;
    if (sourcesHeld.size > 0) return;
    debug("[hotkey] RELEASE (" + name + ")");
    try {
      onRelease?.("alt");
    } catch (error) {
      console.error("hotkey onRelease error:", error);
    }
  }

  let ctrlLDown = false;
  let cmdLDown = false;
  /** @type {number | null} */
  let ctrlDownAt = null;
  let ctrlSawOtherKey = false;

  const handleDown = (/** @type {any} */ event) => {
    const code = event && event.keycode;
    // Self-heal stale chord state: if a keyup was swallowed (lock screen,
    // emoji picker, focus churn) a flag can stay latched and a later lone
    // Ctrl or Cmd press would start dictation. The event's live modifier
    // mask says whether the key is really down right now — trust it.
    if (event) {
      if (ctrlLDown && event.ctrlKey === false) ctrlLDown = false;
      if (cmdLDown && event.metaKey === false) cmdLDown = false;
    }
    // Any hold-to-talk key counts as "another key" if the right-Ctrl tap
    // window is open, so a chord involving right Ctrl never toggles language.
    if (ALT_KEYCODES.has(code)) {
      if (ctrlDownAt !== null) ctrlSawOtherKey = true;
      pressSource("alt");
      return;
    }
    if (CTRL_L_KEYCODES.has(code)) {
      if (ctrlDownAt !== null) ctrlSawOtherKey = true;
      ctrlLDown = true;
      if (cmdLDown) pressSource("ctrlCmd");
      return;
    }
    if (CMD_L_KEYCODES.has(code)) {
      if (ctrlDownAt !== null) ctrlSawOtherKey = true;
      cmdLDown = true;
      if (ctrlLDown) pressSource("ctrlCmd");
      return;
    }
    if (CTRL_R_KEYCODES.has(code)) {
      if (ctrlDownAt !== null) return; // auto-repeat
      ctrlDownAt = Date.now();
      ctrlSawOtherKey = false;
      return;
    }
    // Any other key cancels the in-progress Ctrl tap, so Ctrl-chord shortcuts
    // are not misread as a language toggle.
    if (ctrlDownAt !== null) ctrlSawOtherKey = true;
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
    if (CTRL_R_KEYCODES.has(code)) {
      if (ctrlDownAt === null) return;
      const held = Date.now() - ctrlDownAt;
      const wasTap = !ctrlSawOtherKey && held <= CTRL_TAP_WINDOW_MS;
      ctrlDownAt = null;
      ctrlSawOtherKey = false;
      if (wasTap) {
        debug("[hotkey] TAP ctrl (held=" + held + "ms)");
        try {
          onToggleLanguage?.();
        } catch (error) {
          console.error("hotkey onToggleLanguage error:", error);
        }
      }
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
