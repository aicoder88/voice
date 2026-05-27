// @ts-check
// Win32 FFI helpers used by dictation:
//   1. captureForegroundWindow / restoreForegroundWindow — remember which app
//      was focused when the hotkey was pressed so we can paste back into it,
//      even if Electron stole focus during the IPC round-trip.
//   2. isAltKeyDown — async-polled keystate query that lets the hotkey loop
//      detect a release even if uiohook-napi missed the keyup event.

import koffi from "koffi";

const isWin = process.platform === "win32";

/** @type {((hwnd: number) => number) | null} */
let SetForegroundWindow = null;
/** @type {(() => number) | null} */
let GetForegroundWindow = null;
/** @type {((vk: number) => number) | null} */
let GetAsyncKeyState = null;

if (isWin) {
  try {
    const user32 = koffi.load("user32.dll");
    // HWND is officially a pointer, but Win32 docs (and 32/64-bit interop)
    // guarantee the value fits in 32 bits. Use intptr_t so koffi returns a
    // plain JS number we can stash and pass back later.
    GetForegroundWindow = user32.func("__stdcall", "GetForegroundWindow", "intptr_t", []);
    SetForegroundWindow = user32.func("__stdcall", "SetForegroundWindow", "int", ["intptr_t"]);
    GetAsyncKeyState = user32.func("__stdcall", "GetAsyncKeyState", "short", ["int"]);
  } catch (err) {
    console.error("[foreground] koffi load failed:", err && err.message);
  }
}

/**
 * Snapshot of the foreground window at hotkey press time. Pass back to
 * restoreForegroundWindow() before pasting.
 * @returns {number | null}
 */
export function captureForegroundWindow() {
  if (!GetForegroundWindow) return null;
  try {
    const hwnd = GetForegroundWindow();
    return hwnd ? Number(hwnd) : null;
  } catch (err) {
    console.error("[foreground] capture failed:", err && err.message);
    return null;
  }
}

/**
 * Re-focus a window captured by captureForegroundWindow().
 * Best-effort — SetForegroundWindow can silently fail if Windows decides
 * the requesting process isn't allowed to steal focus. In that case we
 * just fall through and the paste lands wherever focus currently is.
 * @param {number | null} hwndNum
 */
export function restoreForegroundWindow(hwndNum) {
  if (!SetForegroundWindow || !hwndNum) return false;
  try {
    return Boolean(SetForegroundWindow(hwndNum));
  } catch (err) {
    console.error("[foreground] restore failed:", err && err.message);
    return false;
  }
}

// VK_MENU = 0x12 (either Alt). High bit of GetAsyncKeyState return = "is down right now".
const VK_MENU = 0x12;

/**
 * True iff either Alt key is physically held down right now. Used as a
 * uiohook-keyup-missed safety net.
 * @returns {boolean}
 */
export function isAltKeyDown() {
  if (!GetAsyncKeyState) return false;
  try {
    const state = GetAsyncKeyState(VK_MENU);
    return (state & 0x8000) !== 0;
  } catch {
    return false;
  }
}
