// @ts-check
// Pure decision logic shared by both hotkey backends (Windows polling and
// macOS/Linux uiohook events). No native modules, no timers, no globals — just
// state machines with an injectable clock — so the timing-sensitive rules can be
// unit-tested deterministically and the two platforms provably share ONE
// implementation instead of two that drift.

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
