// @ts-check
import { uIOhook, UiohookKey } from "uiohook-napi";

// We bind ONLY the right Option / right Alt key. uiohook reports it as
// UiohookKey.AltRight (0x0E38 = 3640) on every platform we target; the left
// Option/Alt key reports UiohookKey.Alt (0x0038 = 56) and must NOT trigger
// dictation. Bracket access types as `any`, so we filter undefineds at
// runtime in case a future uiohook build drops the constant.
/** @type {Record<string, number | undefined>} */
const keyCodes = UiohookKey;
const ALT_KEYCODES = new Set(
  [
    keyCodes.AltRight,
    3640
  ].filter((v) => typeof v === "number")
);

/**
 * Start listening for the global right-Option (right-Alt) hotkey via
 * uiohook-napi. Calls
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
