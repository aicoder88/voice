// @ts-check
// Pure decision logic shared by both hotkey backends (Windows polling and
// macOS/Linux uiohook events). No native modules, no timers, no globals — just
// state machines with an injectable clock — so the timing-sensitive rules can be
// unit-tested deterministically and the two platforms provably share ONE
// implementation instead of two that drift.

/**
 * Tracks the right-Ctrl "tap to toggle language" gesture.
 *
 * A tap = Ctrl goes down and back up within `windowMs`, with no other key/button
 * activity in between. Holding Ctrl, or pressing it as part of a chord, is NOT a
 * tap. Both backends feed it edges: down(), up(), and other() for any unrelated
 * activity while the gesture is open.
 *
 * @param {{ windowMs?: number, now?: () => number }} [opts]
 */
export function createTapDetector({ windowMs = 300, now = () => Date.now() } = {}) {
  /** @type {number | null} */
  let downAt = null;
  let sawOther = false;
  return {
    /** Ctrl pressed. Ignores auto-repeat (a second down with no intervening up). */
    down() {
      if (downAt !== null) return;
      downAt = now();
      sawOther = false;
    },
    /** Some other key/button became active while the gesture was open → not a tap. */
    other() {
      if (downAt !== null) sawOther = true;
    },
    /**
     * Ctrl released. Returns true iff this completed a clean tap.
     * @returns {boolean}
     */
    up() {
      if (downAt === null) return false;
      const held = now() - downAt;
      const isTap = !sawOther && held <= windowMs;
      downAt = null;
      sawOther = false;
      return isTap;
    },
    /** Is a Ctrl press currently in progress (gesture open)? */
    isOpen() {
      return downAt !== null;
    }
  };
}

/**
 * Tracks multiple hold-to-talk triggers (right Option, mouse back button, the
 * left Ctrl+Cmd chord) as ONE shared press state: dictation starts when the
 * first trigger goes down and stops when the last one is released, so
 * overlapping holds can't double-start or cut each other off.
 *
 * @param {{ onPress?: (name: string) => void, onRelease?: (name: string) => void }} [callbacks]
 */
export function createHoldTracker({ onPress, onRelease } = {}) {
  /** @type {Set<string>} */
  const held = new Set();
  return {
    /** A trigger went down. Fires onPress only on the idle→held transition. */
    press(/** @type {string} */ name) {
      if (held.has(name)) return; // auto-repeat
      const wasIdle = held.size === 0;
      held.add(name);
      if (wasIdle) onPress?.(name);
    },
    /** A trigger came up. Fires onRelease only when the last one is released. */
    release(/** @type {string} */ name) {
      if (!held.delete(name)) return;
      if (held.size === 0) onRelease?.(name);
    },
    /** How many triggers are held right now. */
    size() {
      return held.size;
    }
  };
}
