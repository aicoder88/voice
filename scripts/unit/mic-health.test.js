// Unit tests for the pure dead-mic decision logic shared by the dictation
// renderer and these tests. Run: node --test scripts/unit/mic-health.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHold } from "../../public/mic-health.js";

// Defaults mirroring dictation.js so the tests exercise the real thresholds.
const BASE = { minBytes: 4800, silencePeak: 0.01, streakLimit: 3 };

test("too-short hold is ignored and leaves the streak untouched", () => {
  const r = classifyHold({ ...BASE, bytes: 100, peak: 0, silentStreak: 2 });
  assert.equal(r.action, "ignore");
  assert.equal(r.silentStreak, 2);
});

test("a single zero-peak hold is an instant dead-mic (the production bug)", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0, silentStreak: 0 });
  assert.equal(r.action, "dead");
  assert.equal(r.silentStreak, 0);
});

test("real audio is ok and resets any prior streak", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.4, silentStreak: 2 });
  assert.equal(r.action, "ok");
  assert.equal(r.silentStreak, 0);
});

test("low-but-nonzero peak counts as silent, not dead, on the first hold", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.005, silentStreak: 0 });
  assert.equal(r.action, "silent");
  assert.equal(r.silentStreak, 1);
});

test("a tiny nonzero peak is NOT treated as digital silence", () => {
  // A real mic noise floor can sit just above zero; it must not trip the
  // instant zero-peak path — only an exact 0 does.
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.0001, silentStreak: 0 });
  assert.equal(r.action, "silent");
  assert.equal(r.silentStreak, 1);
});

test("the streak reaching the limit is a dead-mic and clears the streak", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.005, silentStreak: 2 });
  assert.equal(r.action, "dead");
  assert.equal(r.silentStreak, 0);
});

test("peak exactly at the silence threshold is silent (boundary)", () => {
  // < silencePeak is silent; == silencePeak is treated as real (not silent).
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.01, silentStreak: 0 });
  assert.equal(r.action, "ok");
});
