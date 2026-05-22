import { uIOhook, UiohookKey } from "uiohook-napi";

const ALT_KEYCODES = new Set(
  [
    UiohookKey.AltRight,
    UiohookKey.AltLeft,
    UiohookKey.Alt,
    UiohookKey.AltGraph,
    3640,
    56
  ].filter((v) => typeof v === "number")
);

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
