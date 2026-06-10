// Unit tests for the local-speed verdict.
// Run: node --test scripts/unit/benchmark.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeLocalSpeed, suggestBeforeBenchmark, CLOUD_BASELINE_MS, ACCEPTABLE_RATIO } from "../../src/benchmark.js";

test("fast local run is kept", () => {
  const v = judgeLocalSpeed({ elapsedMs: 400 });
  assert.equal(v.fastEnough, true);
  assert.match(v.reason, /fast enough/);
});

test("local run right at the threshold is kept (inclusive)", () => {
  const threshold = CLOUD_BASELINE_MS * ACCEPTABLE_RATIO; // 1050ms
  const v = judgeLocalSpeed({ elapsedMs: threshold });
  assert.equal(v.fastEnough, true);
});

test("slow local run falls back to cloud", () => {
  const v = judgeLocalSpeed({ elapsedMs: 4200 });
  assert.equal(v.fastEnough, false);
  assert.match(v.reason, /cloud engine/);
});

test("just over the threshold falls back", () => {
  const threshold = CLOUD_BASELINE_MS * ACCEPTABLE_RATIO;
  const v = judgeLocalSpeed({ elapsedMs: threshold + 1 });
  assert.equal(v.fastEnough, false);
});

test("caller can override the cloud baseline (e.g. a measured cloud round-trip)", () => {
  // With a generous 2s cloud baseline, a 2s local run is acceptable.
  const v = judgeLocalSpeed({ elapsedMs: 2000, cloudBaselineMs: 2000 });
  assert.equal(v.fastEnough, true);
});

test("caller can tighten the acceptable ratio", () => {
  // ratio 1.0 = local must be at least as fast as the baseline.
  const v = judgeLocalSpeed({ elapsedMs: 800, acceptableRatio: 1.0 });
  assert.equal(v.fastEnough, false);
});

test("the verdict reports the numbers the UI shows", () => {
  const v = judgeLocalSpeed({ elapsedMs: 1400 });
  assert.equal(v.elapsedMs, 1400);
  assert.equal(v.thresholdMs, Math.round(CLOUD_BASELINE_MS * ACCEPTABLE_RATIO));
  assert.ok(v.ratio > 0);
});

test("before-benchmark: a capable machine is told local is worth trying", () => {
  const s = suggestBeforeBenchmark({ tier: "capable", reason: "NVIDIA GPU (CUDA-accelerated)" });
  assert.equal(s.recommend, "local-worth-trying");
  assert.match(s.text, /speed test/);
});

test("before-benchmark: a limited machine is steered to cloud but still offered local", () => {
  const s = suggestBeforeBenchmark({ tier: "limited", reason: "only 4 cores / 8 GB RAM and no GPU — cloud will be faster" });
  assert.equal(s.recommend, "cloud");
  assert.match(s.text, /cloud engine/);
  assert.match(s.text, /still try/);
});

test("this machine's real cold experience would fall back", () => {
  // The dev laptop (GTX 1660 Ti Max-Q) the user reported as 'not fast enough':
  // a multi-second cold transcription must NOT be kept as the default.
  assert.equal(judgeLocalSpeed({ elapsedMs: 3000 }).fastEnough, false);
});
