// @ts-check
// Pure decision logic for spotting a dead microphone capture pipeline from the
// loudest frame of a single recorded hold. Shared by the dictation renderer
// (imported over HTTP as an ES module) and the unit tests (imported by node) —
// ONE implementation, provably the same on both sides, instead of a copy in the
// renderer that drifts from a copy in a test.
//
// The signal is digital silence. A real microphone in a real room always
// carries a noise floor, so the loudest frame of any hold is strictly > 0. A
// peak of EXACTLY 0 across a long-enough hold means no audio reached the app at
// all — the capture stream went dead (the classic macOS/Electron failure after
// sleep/wake or an audio-device change, where the track stays "live" but pipes
// zeros). That is proof on a SINGLE hold, so we rebuild immediately. A
// low-but-nonzero peak is ambiguous (a genuinely quiet room, a distant mic, or a
// partly-wedged device), so we only treat a RUN of those as a dead mic.

/**
 * Classify one finished hold.
 *
 * @param {object} p
 * @param {number} p.bytes        bytes captured during this hold
 * @param {number} p.peak         loudest worklet frame this hold (0..1)
 * @param {number} p.minBytes     below this the hold is a misfire (a tap), not judged
 * @param {number} p.silencePeak  peak at/under which a long hold counts as "silent"
 * @param {number} p.silentStreak consecutive silent holds BEFORE this one
 * @param {number} p.streakLimit  this many silent holds in a row ⇒ dead mic
 * @returns {{ action: "ignore" | "ok" | "silent" | "dead", silentStreak: number }}
 *   "dead"   ⇒ rebuild the capture pipeline now (zero peak, or the streak hit);
 *   "silent" ⇒ a silent hold counted toward the streak, not yet dead;
 *   "ok"     ⇒ real audio arrived;
 *   "ignore" ⇒ too short to judge.
 *   `silentStreak` is the new running count to carry into the next hold.
 */
export function classifyHold({ bytes, peak, minBytes, silencePeak, silentStreak, streakLimit }) {
  // A tap, not a held dictation — nothing to judge, leave the streak untouched.
  if (bytes < minBytes) return { action: "ignore", silentStreak };

  // Pure digital silence is a dead pipeline, never a quiet room: one is enough.
  if (peak === 0) return { action: "dead", silentStreak: 0 };

  // Below the noise threshold but not truly zero — ambiguous. Count it; only a
  // run of these is the mic rather than the user choosing silence.
  if (peak < silencePeak) {
    const next = silentStreak + 1;
    if (next >= streakLimit) return { action: "dead", silentStreak: 0 };
    return { action: "silent", silentStreak: next };
  }

  // Real audio — reset the streak.
  return { action: "ok", silentStreak: 0 };
}
