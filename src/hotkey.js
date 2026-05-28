// @ts-check
// Polling-based hotkey detector. Reads physical key state via Win32
// GetAsyncKeyState (in src/foreground.js) at ~30 Hz and fires callbacks on
// edges. No global keyboard hook — uiohook-napi's low-level Windows hook
// could silently die under focus/security/RDP churn and produce a "frozen"
// app where the pill no longer appears. Polling can't be lost: it asks the
// kernel for the current bit, every tick.
//
//   - Right Alt = hold-to-talk. onPress on the down edge, onRelease on the up.
//   - Right Ctrl tap (down + up within CTRL_TAP_WINDOW_MS, with no Alt edge
//     during that span) fires onToggleLanguage. Holding right Ctrl, or
//     pressing it as part of a chord, does NOT toggle.
//
// Latency: poll period + 0 = ~33 ms worst case. Imperceptible for hold-to-
// talk. CPU: negligible (two GetAsyncKeyState calls per tick).

import { isRightAltDown, isRightCtrlDown } from "./foreground.js";

const POLL_INTERVAL_MS = 33;
const CTRL_TAP_WINDOW_MS = 300;

/**
 * @param {{
 *   onPress?: (key: "alt") => void,
 *   onRelease?: (key: "alt") => void,
 *   onToggleLanguage?: () => void,
 * }} callbacks
 * @returns {{ stop: () => void }}
 */
export function startHotkey({ onPress, onRelease, onToggleLanguage }) {
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
      console.error("[hotkey] PRESS alt");
      try {
        onPress?.("alt");
      } catch (error) {
        console.error("hotkey onPress error:", error);
      }
    } else if (!altNow && altWas) {
      console.error("[hotkey] RELEASE alt");
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
        console.error("[hotkey] TAP ctrl (held=" + held + "ms)");
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
