// @ts-check
// Push-to-talk dictation session state. One instance per Electron main
// process; replaces the ad-hoc globalThis.__dictation* slots that used to live
// in main.js.
//
// Lifecycle:
//   tryStart() -> release() -> finalize() -> done()
//
// `tryStart` rejects a second press while a previous dictation is still
// processing. `release` arms a safety timer so a missing transcript can't
// permanently jam the session (busy clears after safetyTimeoutMs even if no
// transcript ever arrives). `finalize` is called on the terminal event
// (transcript or error) and stops the safety timer. `done` is the last
// transition that re-opens the session for the next press.

/**
 * @typedef {object} DictationSessionOptions
 * @property {number} [safetyTimeoutMs]
 * @property {(...args: unknown[]) => void} [log]
 */

export class DictationSession {
  /** @param {DictationSessionOptions} [options] */
  constructor({ safetyTimeoutMs = 500, log = console.error } = {}) {
    /** @type {boolean} */
    this.busy = false;
    /** @type {number | null} */
    this.releaseAt = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._safetyTimer = null;
    this._safetyTimeoutMs = safetyTimeoutMs;
    this._log = log;
  }

  /**
   * Try to start a new dictation. Returns false if a previous dictation is
   * still in flight (caller should ignore the press in that case).
   *
   * @returns {boolean}
   */
  tryStart() {
    if (this.busy) {
      this._log("[dictation-session] PRESS ignored — previous dictation still processing");
      return false;
    }
    this._clearSafetyTimer();
    this.busy = true;
    // Forget the previous session's release stamp, or finalize() on a session
    // that errors before release would report timings from the LAST dictation.
    this.releaseAt = null;
    return true;
  }

  /**
   * Accept the hotkey release. Arms the safety timer so a missing transcript
   * can't permanently jam the session.
   *
   * @returns {boolean} false if no dictation was active to release
   */
  release() {
    if (!this.busy) return false;
    this.releaseAt = Date.now();
    this._clearSafetyTimer();
    this._safetyTimer = setTimeout(() => {
      if (this.busy) {
        this._log("[dictation-session] safety timeout — clearing busy");
        this.busy = false;
      }
    }, this._safetyTimeoutMs);
    return true;
  }

  /**
   * Called on the terminal event (transcript or error). Stops the safety
   * timer.
   *
   * @returns {{ releaseAt: number, sinceRelease: number }}
   */
  finalize() {
    this._clearSafetyTimer();
    const releaseAt = this.releaseAt || Date.now();
    return { releaseAt, sinceRelease: Date.now() - releaseAt };
  }

  // Final transition: re-open the session for the next press. Call once the
  // transcript has been typed (or on error).
  done() {
    this.busy = false;
  }

  _clearSafetyTimer() {
    if (this._safetyTimer) {
      clearTimeout(this._safetyTimer);
      this._safetyTimer = null;
    }
  }
}
