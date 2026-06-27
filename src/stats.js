// @ts-check
// Activity stats for the Settings "Activity" tab, computed from the dictation
// history (src/history.js getHistory()). Pure and deterministic given (history,
// now) so it's unit-testable — no Date.now()/IO inside.

/** @typedef {{ ts: number, text: string, pasted: boolean, recordingPath?: string | null }} HistoryEntry */

const MS_PER_DAY = 86_400_000;
// Average sustained typing speed. Words ÷ WPM = minutes the user would have
// spent typing the same text by hand — the "time saved" figure. 40 WPM is a
// common real-world average (not peak), deliberately conservative.
const TYPING_WPM = 40;

/** Count words in a string (whitespace-delimited, trimmed). */
function wordCount(text) {
  if (!text || typeof text !== "string") return 0;
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Local-midnight day index for a timestamp, for streak/day grouping. */
function dayIndex(ts) {
  // Use the timestamp's local midnight so "today" matches the user's clock.
  const d = new Date(ts);
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.floor(local / MS_PER_DAY);
}

/**
 * @param {HistoryEntry[]} history  newest-first or any order; we don't assume.
 * @param {number} now  current epoch ms (injected for testability).
 * @returns {{
 *   words: number,
 *   dictations: number,
 *   timeSavedMin: number,
 *   streakDays: number,
 *   recent: Array<{ text: string, ts: number, pasted: boolean, hasRecording: boolean }>
 * }}
 */
export function computeStats(history, now) {
  const entries = Array.isArray(history) ? history : [];
  let words = 0;
  for (const e of entries) words += wordCount(e && e.text);

  const timeSavedMin = Math.round(words / TYPING_WPM);

  // Streak = consecutive calendar days with at least one dictation, counting
  // back from today (or yesterday — a streak you haven't added to *today* yet
  // is still alive until tomorrow). Gaps end the streak.
  const days = new Set(
    entries
      .filter((e) => e && Number.isFinite(e.ts))
      .map((e) => dayIndex(e.ts))
  );
  const today = dayIndex(now);
  let streakDays = 0;
  if (days.has(today) || days.has(today - 1)) {
    let cursor = days.has(today) ? today : today - 1;
    while (days.has(cursor)) {
      streakDays++;
      cursor--;
    }
  }

  const recent = entries
    .filter((e) => e && (e.text || e.recordingPath))
    .slice(0, 8)
    .map((e) => ({
      text: (typeof e.text === "string" ? e.text : "").trim(),
      ts: e.ts,
      pasted: !!e.pasted,
      hasRecording: !!e.recordingPath
    }));

  return { words, dictations: entries.length, timeSavedMin, streakDays, recent };
}
