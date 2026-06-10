// Unit tests for the on-demand downloader's pure helpers (no network).
// Run: node --test scripts/unit/model-download.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelUrl,
  windowsBinaryUrl,
  progressFraction,
  MODELS,
  WINDOWS_BINARY_ZIPS,
  WHISPER_VERSION
} from "../../src/model-download.js";

test("modelUrl builds a HuggingFace resolve URL for a known model", () => {
  assert.equal(
    modelUrl("ggml-base-q5_1.bin"),
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
  );
});

test("modelUrl rejects an unknown model", () => {
  assert.throws(() => modelUrl("ggml-made-up.bin"), /Unknown model/);
});

test("windowsBinaryUrl points at the pinned release for each variant", () => {
  assert.equal(
    windowsBinaryUrl("cpu"),
    `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`
  );
  assert.match(windowsBinaryUrl("cuda"), /whisper-cublas-12\.4\.0-bin-x64\.zip$/);
});

test("windowsBinaryUrl rejects an unknown variant", () => {
  assert.throws(() => windowsBinaryUrl("rocm"), /Unknown variant/);
});

test("progressFraction is a clamped 0..1 ratio", () => {
  assert.equal(progressFraction(0, 100), 0);
  assert.equal(progressFraction(50, 100), 0.5);
  assert.equal(progressFraction(150, 100), 1); // clamped
});

test("progressFraction returns null when the total is unknown", () => {
  assert.equal(progressFraction(50, 0), null);
  assert.equal(progressFraction(50, undefined), null);
});

test("the model + variant tables stay in sync with the recommender's names", () => {
  // recommendedAssets (src/hardware.js) returns exactly these keys — guard against
  // a rename on one side silently breaking the download.
  assert.ok(MODELS["ggml-base-q5_1.bin"], "base model present");
  assert.ok(MODELS["ggml-small-q5_1.bin"], "small model present");
  assert.ok(WINDOWS_BINARY_ZIPS.cpu && WINDOWS_BINARY_ZIPS.cuda, "both variants present");
});
