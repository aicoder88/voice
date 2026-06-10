// @ts-check
// "Is the on-device engine actually fast enough?" — answered by MEASURING, not
// guessing. A hardware probe (cores/RAM/GPU-name) is only a hint; a 2019 laptop
// GPU can read as "capable" yet lose to the cloud. So before the app ever keeps
// local as the default, it transcribes a short bundled clip on the real machine,
// times it, and runs the verdict below.
//
// Pure decision function (judgeLocalSpeed) + tests; the timed run that produces
// `elapsedMs` lives in the wiring layer (main.js), which shells the bundled
// sample through the existing whisper-local path and hands the number here.

// What the cloud engine realistically costs the user, end to end, after they
// release the key: Deepgram streaming finalizes a short clip in roughly half a
// second. This is the bar local has to clear to be worth keeping.
export const CLOUD_BASELINE_MS = 700;

// Local must be at least this good *relative to the cloud baseline* to win. We
// give local a small handicap (it avoids the network and per-clip cost, and runs
// offline), so "a bit slower than the cloud" is still acceptable — but "much
// slower" is not. 1.5 = local may take up to ~1.5x the cloud baseline and still
// be kept; beyond that, the cloud is the better default.
export const ACCEPTABLE_RATIO = 1.5;

/**
 * Decide whether a measured local transcription is fast enough to keep as the
 * default, versus falling back to the cloud engine. Pure: takes the measured
 * numbers, returns the verdict + a plain-English reason for the setup UI.
 *
 * @param {{ elapsedMs: number, cloudBaselineMs?: number, acceptableRatio?: number }} m
 * @returns {{ fastEnough: boolean, elapsedMs: number, ratio: number, thresholdMs: number, reason: string }}
 */
export function judgeLocalSpeed(m) {
  const cloud = m.cloudBaselineMs ?? CLOUD_BASELINE_MS;
  const ratioLimit = m.acceptableRatio ?? ACCEPTABLE_RATIO;
  const thresholdMs = Math.round(cloud * ratioLimit);
  const elapsedMs = m.elapsedMs;
  const ratio = cloud > 0 ? elapsedMs / cloud : Infinity;
  const fastEnough = elapsedMs <= thresholdMs;

  const localS = (elapsedMs / 1000).toFixed(1);
  const reason = fastEnough
    ? `On-device transcription took ${localS}s — fast enough to use locally (no per-clip cost, works offline).`
    : `On-device transcription took ${localS}s, slower than the cloud engine (~${(cloud / 1000).toFixed(1)}s). Keeping the cloud engine so dictation stays snappy.`;

  return { fastEnough, elapsedMs, ratio, thresholdMs, reason };
}

/**
 * The recommendation shown BEFORE any benchmark runs, from the cheap hardware
 * probe alone. It's a hint, not a verdict — it always tells the user they can
 * try local anyway and that we'll measure it for real. Pure string-building so
 * it's unit-testable.
 *
 * @param {{ tier: "capable"|"limited", gpu?: string, cores?: number, ramGB?: number, reason?: string }} probe
 * @returns {{ recommend: "cloud"|"local-worth-trying", text: string }}
 */
export function suggestBeforeBenchmark(probe) {
  if (probe.tier === "capable") {
    return {
      recommend: "local-worth-trying",
      text:
        `This computer looks capable of running the on-device engine (${probe.reason}). ` +
        `It's free and works offline. Pick a model and run the quick speed test — ` +
        `we'll only keep it as your default if it's actually fast enough.`
    };
  }
  return {
    recommend: "cloud",
    text:
      `For this computer we suggest the cloud engine — it'll likely be faster than ` +
      `running speech recognition on-device (${probe.reason}). You can still try the ` +
      `on-device engine below; the speed test will tell you for sure.`
  };
}
