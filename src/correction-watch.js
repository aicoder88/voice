// @ts-check
// Manual-correction watcher (macOS / Linux).
//
// After GVoice types a transcript, main.js arms this for a few seconds. It
// listens to the global keystroke stream — the SAME uiohook-napi singleton the
// hotkey already drives, so we just add our own keydown/mousedown listeners and
// never touch its start/stop lifecycle — and reconstructs the words the user
// types by hand. Each completed word is handed to the callback, which decides
// whether it looks like a fix of something GVoice just typed (see
// vocab.isLikelyCorrection) and, if so, offers to add it to the dictionary.
//
// Privacy: listeners are attached once but only ACT while armed (a short window
// right after a dictation). Only the current in-progress word is held in
// memory; it is passed to the callback and discarded. Nothing is logged or
// written to disk.
//
// Windows: the hotkey there is poll-based and never loads uiohook, so this is a
// no-op. Manual-edit suggestions are macOS/Linux only; transcript- and
// cleanup-based suggestions still work everywhere.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * @param {{ onWord: (word: string) => void }} opts
 * @returns {{ arm: (ms: number) => void, disarm: () => void, stop: () => void }}
 */
export function createCorrectionWatcher({ onWord }) {
  const noop = { arm() {}, disarm() {}, stop() {} };
  if (process.platform === "win32") return noop;

  /** @type {any} */
  let uiohook;
  try {
    uiohook = require("uiohook-napi");
  } catch {
    return noop;
  }
  const { uIOhook, UiohookKey } = uiohook;
  /** @type {Record<string, number | undefined>} */
  const K = UiohookKey || {};

  // keycode -> base lowercase letter (all we need to reconstruct a name),
  // built from UiohookKey's A..Z constants.
  /** @type {Map<number, string>} */
  const letterByCode = new Map();
  for (let c = 65; c <= 90; c++) {
    const code = K[String.fromCharCode(c)];
    if (typeof code === "number") letterByCode.set(code, String.fromCharCode(c + 32));
  }
  // Keys that extend a word rather than ending it.
  const MINUS = K.Minus;
  const QUOTE = K.Quote;

  let armedUntil = 0;
  let current = "";

  const isArmed = () => armedUntil > 0 && Date.now() <= armedUntil;

  function flush() {
    const word = current;
    current = "";
    if (word.length >= 2 && isArmed()) {
      try { onWord(word); } catch {}
    }
  }

  const onKeydown = (/** @type {any} */ e) => {
    // Window lapsed without an explicit disarm() — clean ourselves up so we're
    // not holding a live key listener past the watch window.
    if (!isArmed()) { current = ""; detach(); return; }
    const code = e && e.keycode;
    // Modifier chords are shortcuts (Cmd+A, Ctrl+V…), not typing.
    if (e && (e.metaKey || e.ctrlKey || e.altKey)) { current = ""; return; }

    const letter = letterByCode.get(code);
    if (letter) {
      current += e.shiftKey ? letter.toUpperCase() : letter;
      return;
    }
    if (code === K.Backspace) {
      current = current.slice(0, -1);
      return;
    }
    if (current && (code === MINUS || code === QUOTE)) {
      current += code === MINUS ? "-" : "'";
      return;
    }
    // Space / Enter / Tab / punctuation / arrows / delete — word boundary.
    flush();
  };

  // A mouse click usually means the caret jumped (e.g. the user selected a word
  // to replace it), so the half-typed token before it is meaningless.
  const onMousedown = () => { current = ""; };

  // Listeners are attached only while armed, so when GVoice isn't actively
  // watching for a correction the OS keystroke callback isn't even firing —
  // it's not a standing global key listener.
  let attached = false;
  function attach() {
    if (attached) return;
    attached = true;
    uIOhook.on("keydown", onKeydown);
    uIOhook.on("mousedown", onMousedown);
  }
  function detach() {
    if (!attached) return;
    attached = false;
    try { uIOhook.off("keydown", onKeydown); } catch {}
    try { uIOhook.off("mousedown", onMousedown); } catch {}
  }

  return {
    arm(ms) {
      armedUntil = Date.now() + Math.max(0, ms || 0);
      current = "";
      attach();
    },
    disarm() {
      armedUntil = 0;
      current = "";
      detach();
    },
    stop() {
      detach();
    }
  };
}
