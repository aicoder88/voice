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

export class DictationSession {
  constructor({ safetyTimeoutMs = 1500, log = console.error } = {}) {
    this.busy = false;
    this.pressAt = null;
    this.releaseAt = null;
    this._safetyTimer = null;
    this._safetyTimeoutMs = safetyTimeoutMs;
    this._log = log;
  }

  // Returns true if the press was accepted, false if a previous dictation is
  // still in flight (caller should ignore the press in that case).
  tryStart() {
    if (this.busy) {
      this._log("[dictation-session] PRESS ignored — previous dictation still processing");
      return false;
    }
    this._clearSafetyTimer();
    this.busy = true;
    this.pressAt = Date.now();
    return true;
  }

  // Returns true if a dictation was active and we accepted the release,
  // false if there was nothing to release.
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

  // Called on the terminal event (transcript or error). Stops the safety
  // timer. Returns timing info for logging.
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
