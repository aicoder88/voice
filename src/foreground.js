// @ts-check
// Win32 FFI helpers used by dictation:
//   1. captureForegroundWindow / restoreForegroundWindow — remember which app
//      was focused when the hotkey was pressed so we can paste back into it,
//      even if Electron stole focus during the IPC round-trip.
//   2. isRightAltDown / isRightCtrlDown — synchronous physical-key state
//      queries the polling hotkey loop in src/hotkey.js calls at ~30 Hz.

import koffi from "koffi";

const isWin = process.platform === "win32";

/** @type {((hwnd: number) => number) | null} */
let SetForegroundWindow = null;
/** @type {(() => number) | null} */
let GetForegroundWindow = null;
/** @type {((vk: number) => number) | null} */
let GetAsyncKeyState = null;
/** @type {((hwnd: number, rect: Buffer) => number) | null} */
let GetWindowRect = null;

if (isWin) {
  try {
    const user32 = koffi.load("user32.dll");
    // HWND is officially a pointer, but Win32 docs (and 32/64-bit interop)
    // guarantee the value fits in 32 bits. Use intptr_t so koffi returns a
    // plain JS number we can stash and pass back later.
    GetForegroundWindow = user32.func("__stdcall", "GetForegroundWindow", "intptr_t", []);
    SetForegroundWindow = user32.func("__stdcall", "SetForegroundWindow", "int", ["intptr_t"]);
    GetAsyncKeyState = user32.func("__stdcall", "GetAsyncKeyState", "short", ["int"]);
    // RECT is 16 bytes: left, top, right, bottom (all int32).
    GetWindowRect = user32.func("__stdcall", "GetWindowRect", "int", ["intptr_t", "void *"]);
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

// VK_RMENU = 0xA5 (right Alt only — VK_MENU 0x12 would match either Alt).
const VK_RMENU = 0xA5;
// VK_RCONTROL = 0xA3 (right Ctrl only — VK_CONTROL 0x11 would match both).
const VK_RCONTROL = 0xA3;

function asyncKeyDown(/** @type {number} */ vk) {
  if (!GetAsyncKeyState) return false;
  try {
    const state = GetAsyncKeyState(vk);
    return (state & 0x8000) !== 0;
  } catch {
    return false;
  }
}

/**
 * True iff the right Alt key is physically held down right now.
 * @returns {boolean}
 */
export function isRightAltDown() {
  return asyncKeyDown(VK_RMENU);
}

/**
 * True iff the right Ctrl key is physically held down right now.
 * @returns {boolean}
 */
export function isRightCtrlDown() {
  return asyncKeyDown(VK_RCONTROL);
}

/**
 * Return the screen-space rectangle of an HWND (left/top/right/bottom in
 * physical pixels), or null if the call fails. Used to anchor the listening
 * pill to the window the user was typing into.
 * @param {number | null} hwnd
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
export function getWindowRect(hwnd) {
  if (!GetWindowRect || !hwnd) return null;
  try {
    const buf = Buffer.alloc(16);
    const ok = GetWindowRect(hwnd, buf);
    if (!ok) return null;
    return {
      left: buf.readInt32LE(0),
      top: buf.readInt32LE(4),
      right: buf.readInt32LE(8),
      bottom: buf.readInt32LE(12)
    };
  } catch (err) {
    console.error("[foreground] GetWindowRect failed:", err && err.message);
    return null;
  }
}
