import { uIOhook, UiohookKey } from "uiohook-napi";

const RIGHT_ALT_KEYCODE = UiohookKey.AltRight ?? UiohookKey.AltGraph ?? 3640;

export function startHotkey({ onPress, onRelease }) {
  let pressed = false;

  const handleDown = (event) => {
    if (event.keycode !== RIGHT_ALT_KEYCODE) return;
    if (pressed) return;
    pressed = true;
    try {
      onPress?.();
    } catch (error) {
      console.error("hotkey onPress error:", error);
    }
  };

  const handleUp = (event) => {
    if (event.keycode !== RIGHT_ALT_KEYCODE) return;
    if (!pressed) return;
    pressed = false;
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
