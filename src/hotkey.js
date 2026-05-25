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

/**
 * Start listening for the global Alt-right hotkey via uiohook-napi. Calls
 * `onPress` on the first qualifying keydown, `onRelease` on the subsequent
 * keyup. Returns a disposer that detaches both listeners and stops uIOhook.
 *
 * @param {{ onPress?: () => void, onRelease?: () => void }} callbacks
 * @returns {{ stop: () => void }}
 */
export function startHotkey({ onPress, onRelease }) {
  let pressed = false;

  const handleDown = (event) => {
    if (!ALT_KEYCODES.has(event.keycode)) return;
    if (pressed) return;
    pressed = true;
    console.error("[hotkey] PRESS (keycode=" + event.keycode + ")");
    try {
      onPress?.();
    } catch (error) {
      console.error("hotkey onPress error:", error);
    }
  };

  const handleUp = (event) => {
    if (!ALT_KEYCODES.has(event.keycode)) return;
    if (!pressed) return;
    pressed = false;
    console.error("[hotkey] RELEASE (keycode=" + event.keycode + ")");
    try {
      onRelease?.();
    } catch (error) {
      console.error("hotkey onRelease error:", error);
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
