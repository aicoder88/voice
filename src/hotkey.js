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
//   Event-based via uiohook-napi. Uses its global keydown/keyup stream and
//   matches right-Alt (hold-to-talk) and right-Ctrl (tap-to-toggle) by
//   uiohook keycode. macOS requires Accessibility permission for the app to
//   receive these events.
//
// Both paths honor the same contract:
//   - Right Alt = hold-to-talk. onPress on the down edge, onRelease on the up.
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
 *   - Right Option (Alt) = hold-to-talk. We match against UiohookKey.AltRight
 *     and UiohookKey.AltGraph, plus the common raw scancodes (3640, 56) seen
 *     in older uiohook builds, filtering undefineds.
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

  let altHeld = false;
  /** @type {number | null} */
  let ctrlDownAt = null;
  let ctrlSawOtherKey = false;

  const handleDown = (/** @type {any} */ event) => {
    const code = event && event.keycode;
    if (ALT_KEYCODES.has(code)) {
      // Alt counts as "another key" if Ctrl's tap window is open.
      if (ctrlDownAt !== null) ctrlSawOtherKey = true;
      if (altHeld) return; // auto-repeat
      altHeld = true;
      debug("[hotkey] PRESS alt (keycode=" + code + ")");
      try {
        onPress?.("alt");
      } catch (error) {
        console.error("hotkey onPress error:", error);
      }
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
      if (!altHeld) return;
      altHeld = false;
      debug("[hotkey] RELEASE alt (keycode=" + code + ")");
      try {
        onRelease?.("alt");
      } catch (error) {
        console.error("hotkey onRelease error:", error);
      }
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

  uIOhook.on("keydown", handleDown);
  uIOhook.on("keyup", handleUp);
  try {
    uIOhook.start();
  } catch (err) {
    console.error("[hotkey] uIOhook.start failed:", err && /** @type {any} */ (err).message);
  }

  return {
    stop() {
      try { uIOhook.off("keydown", handleDown); } catch {}
      try { uIOhook.off("keyup", handleUp); } catch {}
      try { uIOhook.stop(); } catch {}
    }
  };
}
