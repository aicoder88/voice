// Unit tests for src/stats.js (Activity tab). Pure given (history, now).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats } from "../../src/stats.js";

const DAY = 86_400_000;
// A fixed "now" at local noon so day-bucketing is stable regardless of when the
// suite runs. Using a midday anchor avoids midnight-boundary flakiness.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime(); // 2026-06-15 12:00 local

test("empty history → zeros", () => {
  const s = computeStats([], NOW);
  assert.deepEqual(s, { words: 0, dictations: 0, timeSavedMin: 0, streakDays: 0, recent: [] });
});

test("counts words and time saved (40 wpm)", () => {
  const hist = [
    { ts: NOW, text: "one two three four five", pasted: true },
    { ts: NOW, text: "  six   seven ", pasted: true }
  ];
  const s = computeStats(hist, NOW);
  assert.equal(s.words, 7);
  assert.equal(s.dictations, 2);
  assert.equal(s.timeSavedMin, Math.round(7 / 40)); // 0
});

test("streak counts consecutive days back from today", () => {
  const hist = [
    { ts: NOW, text: "today", pasted: true },
    { ts: NOW - DAY, text: "yesterday", pasted: true },
    { ts: NOW - 2 * DAY, text: "two days ago", pasted: true },
    { ts: NOW - 4 * DAY, text: "gap before this one", pasted: true }
  ];
  assert.equal(computeStats(hist, NOW).streakDays, 3);
});

test("streak still alive if last dictation was yesterday (not today)", () => {
  const hist = [
    { ts: NOW - DAY, text: "yesterday", pasted: true },
    { ts: NOW - 2 * DAY, text: "day before", pasted: true }
  ];
  assert.equal(computeStats(hist, NOW).streakDays, 2);
});

test("streak is 0 when the most recent day is older than yesterday", () => {
  const hist = [{ ts: NOW - 3 * DAY, text: "stale", pasted: true }];
  assert.equal(computeStats(hist, NOW).streakDays, 0);
});

test("recent caps at 8 and keeps order, flags recording/pasted", () => {
  const hist = Array.from({ length: 12 }, (_, i) => ({
    ts: NOW - i * 1000,
    text: `entry ${i}`,
    pasted: i % 2 === 0,
    recordingPath: i === 1 ? "/x.wav" : null
  }));
  const s = computeStats(hist, NOW);
  assert.equal(s.recent.length, 8);
  assert.equal(s.recent[0].text, "entry 0");
  assert.equal(s.recent[0].pasted, true);
  assert.equal(s.recent[1].hasRecording, true);
});

test("recent skips empty entries with no recording", () => {
  const hist = [
    { ts: NOW, text: "", pasted: false, recordingPath: null },
    { ts: NOW, text: "real one", pasted: true }
  ];
  const s = computeStats(hist, NOW);
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].text, "real one");
});

test("tolerates malformed entries", () => {
  const hist = [null, { text: 5 }, { ts: NOW, text: "ok" }, {}];
  const s = computeStats(hist, NOW);
  assert.equal(s.words, 1);
  assert.equal(s.dictations, 4);
});
