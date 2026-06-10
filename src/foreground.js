// @ts-check
// Win32 FFI helpers used by dictation:
//   1. captureForegroundWindow / restoreForegroundWindow / getWindowRect —
//      remember which app was focused when the hotkey was pressed so we can
//      paste back into it, even if Electron stole focus during the IPC
//      round-trip, and locate its on-screen rect to anchor the pill.
//   2. isRightAltDown / isRightCtrlDown — synchronous physical-key state
//      queries the polling hotkey loop in src/hotkey.js calls at ~30 Hz.
//
// All koffi/user32 calls are gated behind `isWin`. On macOS / Linux the
// capture/restore/getWindowRect exports are stubs that return null/false —
// the pill falls back to top-right of the cursor's display, and Electron
// generally doesn't steal focus during IPC on macOS the way it does on
// Windows, so focus restoration is a no-op. The key-state exports return
// false on non-Win because the only caller (the polling hotkey loop) is
// itself Windows-only — Mac uses uiohook-napi's event-based path instead.

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
    // koffi is a Windows-only need here, so load it lazily — macOS/Linux
    // never import it and stay immune to it being absent or broken.
    const koffi = (await import("koffi")).default;
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

const isMac = process.platform === "darwin";

// --- macOS: is an editable field actually focused? ----------------------------
// We paste with ⌘V, which silently goes nowhere if the user didn't click into a
// text field. There's no way to confirm a paste landed, but we CAN ask the
// Accessibility API what UI element has focus and whether it's editable — and
// classify the dictation as success vs error accordingly. Uses GVoice's own
// Accessibility permission (already granted for typing), so no extra prompt.
const kCFStringEncodingUTF8 = 0x08000100;
const AX_EDITABLE_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXComboBox",
  "AXSearchField",
  "AXSecureTextField"
]);

/** @type {(() => unknown) | null} */
let AXUIElementCreateSystemWide = null;
/** @type {((el: unknown, attr: unknown, out: unknown[]) => number) | null} */
let AXUIElementCopyAttributeValue = null;
/** @type {((el: unknown, attr: unknown, out: boolean[]) => number) | null} */
let AXUIElementIsAttributeSettable = null;
/** @type {(() => boolean) | null} */
let AXIsProcessTrusted = null;
/** @type {((cf: unknown) => void) | null} */
let CFRelease = null;
/** @type {((str: unknown, buf: Buffer, size: number, enc: number) => boolean) | null} */
let CFStringGetCString = null;
/** @type {((cf: unknown) => number) | null} */
let CFGetTypeID = null;
/** @type {(() => number) | null} */
let CFStringGetTypeID = null;
/** @type {unknown} */ let kAXFocusedUIElement = null;
/** @type {unknown} */ let kAXRole = null;
/** @type {unknown} */ let kAXValue = null;

if (isMac) {
  try {
    const koffi = (await import("koffi")).default;
    const CF = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
    const AX = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");

    const CFStringCreateWithCString = CF.func(
      "void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)"
    );
    CFStringGetCString = CF.func(
      "bool CFStringGetCString(void *theString, _Out_ char *buffer, long bufferSize, uint32_t encoding)"
    );
    CFRelease = CF.func("void CFRelease(void *cf)");
    CFGetTypeID = CF.func("unsigned long CFGetTypeID(void *cf)");
    CFStringGetTypeID = CF.func("unsigned long CFStringGetTypeID(void)");

    AXUIElementCreateSystemWide = AX.func("void *AXUIElementCreateSystemWide(void)");
    AXUIElementCopyAttributeValue = AX.func(
      "int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)"
    );
    AXUIElementIsAttributeSettable = AX.func(
      "int AXUIElementIsAttributeSettable(void *element, void *attribute, _Out_ bool *settable)"
    );
    AXIsProcessTrusted = AX.func("bool AXIsProcessTrusted(void)");

    // Attribute name constants — created once, intentionally never released.
    kAXFocusedUIElement = CFStringCreateWithCString(null, "AXFocusedUIElement", kCFStringEncodingUTF8);
    kAXRole = CFStringCreateWithCString(null, "AXRole", kCFStringEncodingUTF8);
    kAXValue = CFStringCreateWithCString(null, "AXValue", kCFStringEncodingUTF8);
  } catch (err) {
    console.error("[foreground] AX init failed:", err && err.message);
    AXUIElementCreateSystemWide = null;
  }
}

/**
 * Is the currently-focused element something the user can type into?
 *
 * @returns {boolean | null}  true = editable field focused, false = nothing
 *   editable focused (a paste would go nowhere), null = couldn't tell (AX
 *   unavailable / not trusted) — caller should not treat this as a failure.
 */
export function isEditableFieldFocused() {
  if (!isMac || !AXUIElementCreateSystemWide || !AXUIElementCopyAttributeValue) return null;
  try {
    if (AXIsProcessTrusted && !AXIsProcessTrusted()) return null; // permission missing
    const systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return null;
    try {
      const focusedOut = [null];
      // kAXErrorSuccess === 0. Only the codes that genuinely mean "nothing
      // focused" may return false — false downgrades a paste to a hard
      // "Couldn't paste" error. Transient codes (kAXErrorCannotComplete -25204:
      // target app busy or AX messaging timed out; kAXErrorAPIDisabled -25211)
      // mean "couldn't tell" ⇒ null, which the caller never holds against the
      // paste.
      const axErr = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElement, focusedOut);
      if (axErr !== 0) {
        const NO_FOCUS_CODES = new Set([-25212 /* NoValue */, -25202 /* InvalidUIElement */, -25205 /* NotImplemented */]);
        return NO_FOCUS_CODES.has(axErr) ? false : null;
      }
      const focused = focusedOut[0];
      if (!focused) return false;
      try {
        let editable = false;
        // 1) Role check covers native + browser/Electron text inputs.
        const roleOut = [null];
        if (AXUIElementCopyAttributeValue(focused, kAXRole, roleOut) === 0 && roleOut[0]) {
          const buf = Buffer.alloc(128);
          if (CFStringGetCString(roleOut[0], buf, buf.length, kCFStringEncodingUTF8)) {
            const end = buf.indexOf(0); const role = buf.toString("utf8", 0, end < 0 ? buf.length : end);
            editable = AX_EDITABLE_ROLES.has(role);
          }
          CFRelease(roleOut[0]);
        }
        // 2) Fallback: anything whose value is writable (custom editors that
        //    report an unusual role) still counts as editable.
        if (!editable && AXUIElementIsAttributeSettable) {
          const settableOut = [false];
          if (AXUIElementIsAttributeSettable(focused, kAXValue, settableOut) === 0) {
            editable = settableOut[0] === true;
          }
        }
        return editable;
      } finally {
        CFRelease(focused);
      }
    } finally {
      CFRelease(systemWide);
    }
  } catch (err) {
    console.error("[foreground] focus check failed:", err && err.message);
    return null;
  }
}

/**
 * Read the text content (AXValue) of the currently-focused element, so a
 * caller can verify a paste actually landed. Best-effort: many elements
 * (web areas, secure fields, custom editors) don't expose a string value.
 *
 * @returns {string | null}  the field's text, or null if it can't be read —
 *   callers must treat null as "couldn't verify", never as "paste failed".
 */
export function focusedFieldValue() {
  if (!isMac || !AXUIElementCreateSystemWide || !AXUIElementCopyAttributeValue) return null;
  try {
    if (AXIsProcessTrusted && !AXIsProcessTrusted()) return null;
    const systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return null;
    try {
      const focusedOut = [null];
      if (AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElement, focusedOut) !== 0) return null;
      const focused = focusedOut[0];
      if (!focused) return null;
      try {
        const valueOut = [null];
        if (AXUIElementCopyAttributeValue(focused, kAXValue, valueOut) !== 0 || !valueOut[0]) return null;
        try {
          // AXValue isn't always a string (sliders/checkboxes return numbers).
          // Calling CFStringGetCString on a non-string is undefined behavior,
          // so type-check first.
          if (!CFGetTypeID || !CFStringGetTypeID || CFGetTypeID(valueOut[0]) !== CFStringGetTypeID()) return null;
          // Large enough for any realistic dictation target; CFStringGetCString
          // returns false (→ null) if the value doesn't fit.
          const buf = Buffer.alloc(256 * 1024);
          if (!CFStringGetCString(valueOut[0], buf, buf.length, kCFStringEncodingUTF8)) return null;
          const end = buf.indexOf(0);
          return buf.toString("utf8", 0, end < 0 ? buf.length : end);
        } finally {
          CFRelease(valueOut[0]);
        }
      } finally {
        CFRelease(focused);
      }
    } finally {
      CFRelease(systemWide);
    }
  } catch (err) {
    console.error("[foreground] field value read failed:", err && err.message);
    return null;
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

/**
 * Is `hwnd` the window currently in the foreground? Used on Windows right AFTER
 * a paste to confirm focus didn't get stolen mid-paste (which would send ⌘V/
 * Ctrl+V somewhere other than the app the user dictated into). Returns null when
 * we can't tell (non-Windows, or koffi unavailable) — callers must treat null as
 * "couldn't verify", never as a failure.
 *
 * @param {number | null} hwnd
 * @returns {boolean | null}
 */
export function isForegroundWindow(hwnd) {
  if (!GetForegroundWindow || !hwnd) return null;
  try {
    const current = GetForegroundWindow();
    return current ? Number(current) === Number(hwnd) : false;
  } catch (err) {
    console.error("[foreground] foreground compare failed:", err && err.message);
    return null;
  }
}

// VK_RMENU = 0xA5 (right Alt only — VK_MENU 0x12 would match either Alt).
const VK_RMENU = 0xA5;
// VK_RCONTROL = 0xA3 (right Ctrl only — used for the language-toggle tap).
const VK_RCONTROL = 0xA3;
// VK_CONTROL / VK_SHIFT match EITHER side — the hold-to-talk chord is
// Ctrl+Shift from whichever hand the user prefers.
const VK_CONTROL = 0x11;
const VK_SHIFT = 0x10;

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
 * True iff EITHER Ctrl key is physically held down right now.
 * @returns {boolean}
 */
export function isCtrlDown() {
  return asyncKeyDown(VK_CONTROL);
}

/**
 * True iff EITHER Shift key is physically held down right now.
 * @returns {boolean}
 */
export function isShiftDown() {
  return asyncKeyDown(VK_SHIFT);
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
