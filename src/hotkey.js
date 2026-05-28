// @ts-check
import { uIOhook, UiohookKey } from "uiohook-napi";

// uiohook-napi's UiohookKey type exposes AltRight/Alt but not the AltLeft and
// AltGraph constants some platforms emit. We probe via bracket access (which
// types as `any`) and filter out the undefineds at runtime.
/** @type {Record<string, number | undefined>} */
const keyCodes = UiohookKey;
const ALT_KEYCODES = new Set(
  [
    keyCodes.AltRight,
    keyCodes.AltLeft,
    keyCodes.Alt,
    keyCodes.AltGraph,
    3640,
    56
  ].filter((v) => typeof v === "number")
);

// Right-Ctrl only. Left-Ctrl is deliberately excluded — Ctrl+C / Ctrl+V are
// everywhere and would constantly fire the toggle. On Windows uiohook emits
// 3613 for the extended right-ctrl scancode; UiohookKey.CtrlR is the named
// constant in newer versions of uiohook-napi.
const CTRL_R_KEYCODES = new Set(
  [
    keyCodes.CtrlR,
    keyCodes.ControlRight,
    3613
  ].filter((v) => typeof v === "number")
);

// Right-Ctrl tap window. If the user holds right-Ctrl longer than this, it's
// not a tap. If they press any OTHER key while right-Ctrl is down (e.g.
// Right-Ctrl + C if anyone has that bound), it's also not a tap.
const CTRL_TAP_WINDOW_MS = 350;

/**
 * Start listening for the global hotkeys via uiohook-napi.
 *
 *   - Right-Alt = hold-to-talk. Fires onPress on keydown, onRelease on keyup.
 *   - Right-Ctrl tap (press+release within {@link CTRL_TAP_WINDOW_MS}, with no
 *     other keydown in between) fires onToggleLanguage. Holding right-Ctrl,
 *     or pressing it as part of a chord, does NOT fire the toggle — so Ctrl-
 *     based shortcuts on the right hand still work normally.
 *
 * @param {{
 *   onPress?: (key: "alt") => void,
 *   onRelease?: (key: "alt") => void,
 *   onToggleLanguage?: () => void,
 * }} callbacks
 * @returns {{ stop: () => void }}
 */
export function startHotkey({ onPress, onRelease, onToggleLanguage }) {
  let altHeld = false;
  /** @type {number | null} */
  let ctrlDownAt = null;
  let ctrlSawOtherKey = false;

  const handleDown = (event) => {
    const code = event.keycode;
    if (ALT_KEYCODES.has(code)) {
      // Alt counts as "another key" if Ctrl's tap window is open.
      if (ctrlDownAt !== null) ctrlSawOtherKey = true;
      if (altHeld) return;
      altHeld = true;
      console.error("[hotkey] PRESS alt (keycode=" + code + ")");
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
    // Any other key cancels the in-progress Ctrl tap (so Ctrl-chord shortcuts
    // are not misread as a language toggle).
    if (ctrlDownAt !== null) ctrlSawOtherKey = true;
  };

  const handleUp = (event) => {
    const code = event.keycode;
    if (ALT_KEYCODES.has(code)) {
      if (!altHeld) return;
      altHeld = false;
      console.error("[hotkey] RELEASE alt (keycode=" + code + ")");
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
        console.error("[hotkey] TAP ctrl (held=" + held + "ms)");
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
  uIOhook.start();

  return {
    stop() {
      uIOhook.off("keydown", handleDown);
      uIOhook.off("keyup", handleUp);
      try {
        uIOhook.stop();
      } catch {}
    }
  };
}
