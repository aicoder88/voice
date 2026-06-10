// Unit tests for the hardware capability classifier.
// Run: node --test scripts/unit/hardware.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCapability, recommendedAssets } from "../../src/hardware.js";

const FAST_CPU = { cores: 12, ramGB: 32, platform: "win32", arch: "x64", gpu: "none" };
const SLOW_CPU = { cores: 4, ramGB: 8, platform: "win32", arch: "x64", gpu: "none" };

test("Apple Silicon is always capable", () => {
  const r = classifyCapability({ cores: 8, ramGB: 16, platform: "darwin", arch: "arm64", gpu: "apple" });
  assert.equal(r.tier, "capable");
  assert.match(r.reason, /Apple Silicon/);
});

test("an NVIDIA GPU makes even a modest CPU capable", () => {
  const r = classifyCapability({ cores: 4, ramGB: 8, platform: "win32", arch: "x64", gpu: "nvidia" });
  assert.equal(r.tier, "capable");
  assert.match(r.reason, /NVIDIA/);
});

test("a beefy CPU with no GPU is capable", () => {
  assert.equal(classifyCapability(FAST_CPU).tier, "capable");
});

test("too few cores → limited", () => {
  const r = classifyCapability({ ...FAST_CPU, cores: 4 });
  assert.equal(r.tier, "limited");
});

test("too little RAM → limited", () => {
  const r = classifyCapability({ ...FAST_CPU, ramGB: 4 });
  assert.equal(r.tier, "limited");
});

test("a slow laptop with no GPU → limited (defaults to cloud)", () => {
  const r = classifyCapability(SLOW_CPU);
  assert.equal(r.tier, "limited");
  assert.match(r.reason, /cloud/);
});

test("the result echoes the input facts for the UI", () => {
  const r = classifyCapability(FAST_CPU);
  assert.equal(r.cores, 12);
  assert.equal(r.ramGB, 32);
  assert.equal(r.gpu, "none");
});

test("Intel Mac without a GPU follows the CPU rule, not the Apple path", () => {
  const capable = classifyCapability({ cores: 8, ramGB: 16, platform: "darwin", arch: "x64", gpu: "none" });
  assert.equal(capable.tier, "capable");
  const limited = classifyCapability({ cores: 2, ramGB: 8, platform: "darwin", arch: "x64", gpu: "none" });
  assert.equal(limited.tier, "limited");
});

test("recommendedAssets: NVIDIA → CUDA build + the larger small model", () => {
  assert.deepEqual(recommendedAssets({ gpu: "nvidia" }), { variant: "cuda", model: "ggml-small-q5_1.bin" });
});

test("recommendedAssets: no GPU → CPU build + the lighter base model", () => {
  assert.deepEqual(recommendedAssets({ gpu: "none" }), { variant: "cpu", model: "ggml-base-q5_1.bin" });
});
