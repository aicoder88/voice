// Unit tests for the recordings store (count + age pruning, save, clear).
// Run: node --test scripts/unit/recordings.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordingTimestamp,
  pruneRecordings,
  saveRecording,
  clearRecordings
} from "../../src/recordings.js";

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "gvoice-rec-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Create a placeholder recording file with a chosen timestamp in its name.
function touch(dir, ts, rand = "abcd") {
  const name = `dictation-${ts}-${rand}.wav`;
  writeFileSync(join(dir, name), "x");
  return name;
}

function wavs(dir) {
  return readdirSync(dir).filter((n) => n.endsWith(".wav")).sort();
}

test("recordingTimestamp: parses the epoch, null for foreign names", () => {
  assert.equal(recordingTimestamp("dictation-1700000000000-abcd.wav"), 1700000000000);
  // Legacy name from older builds (no random suffix) must still be recognised,
  // so it can be pruned and wiped — not orphaned on disk.
  assert.equal(recordingTimestamp("dictation-1700000000000.wav"), 1700000000000);
  assert.equal(recordingTimestamp("notes.txt"), null);
  assert.equal(recordingTimestamp("dictation-xx-abcd.wav"), null);
});

test("pruneRecordings: count cap drops the OLDEST first", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    touch(dir, 1000); touch(dir, 2000); touch(dir, 3000); touch(dir, 4000);
    const removed = await pruneRecordings(dir, { maxCount: 2, maxAgeMs: 0 });
    assert.equal(removed.length, 2);
    const left = wavs(dir).map(recordingTimestamp).sort((a, b) => a - b);
    assert.deepEqual(left, [3000, 4000]);
  } finally {
    cleanup();
  }
});

test("pruneRecordings: age cap removes clips older than the window", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const now = 1_000_000_000;
    touch(dir, now - 10_000); // old
    touch(dir, now - 1_000);  // fresh
    const removed = await pruneRecordings(dir, { maxCount: 50, maxAgeMs: 5_000, now });
    assert.equal(removed.length, 1);
    assert.deepEqual(wavs(dir).map(recordingTimestamp), [now - 1_000]);
  } finally {
    cleanup();
  }
});

test("pruneRecordings: maxAgeMs=0 disables the age cap", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    touch(dir, 1); touch(dir, 2);
    const removed = await pruneRecordings(dir, { maxCount: 50, maxAgeMs: 0, now: 1e12 });
    assert.equal(removed.length, 0);
  } finally {
    cleanup();
  }
});

test("pruneRecordings: ignores foreign files", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFileSync(join(dir, "keep.txt"), "x");
    touch(dir, 1000); touch(dir, 2000); touch(dir, 3000);
    await pruneRecordings(dir, { maxCount: 1, maxAgeMs: 0 });
    assert.ok(existsSync(join(dir, "keep.txt")), "non-recording file untouched");
    assert.equal(wavs(dir).length, 1);
  } finally {
    cleanup();
  }
});

test("saveRecording: writes a WAV and returns its path", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const pcm = Buffer.alloc(4800); // 0.1s of silence @ 24kHz int16
    const path = await saveRecording(dir, pcm, 24000, { now: 1700000000000, rand: " z9z9".trim() });
    assert.ok(path && existsSync(path));
    assert.ok(path.endsWith(".wav"));
    assert.equal(recordingTimestamp(path.split("/").pop()), 1700000000000);
  } finally {
    cleanup();
  }
});

test("saveRecording: returns null for empty input", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    assert.equal(await saveRecording(dir, Buffer.alloc(0), 24000), null);
  } finally {
    cleanup();
  }
});

test("saveRecording: prunes as it writes (count cap)", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    touch(dir, 1); touch(dir, 2);
    await saveRecording(dir, Buffer.alloc(100), 24000, { now: 3, rand: "newr", maxCount: 1 });
    // Only the just-written clip should remain.
    assert.equal(wavs(dir).length, 1);
    assert.equal(recordingTimestamp(wavs(dir)[0]), 3);
  } finally {
    cleanup();
  }
});

test("clearRecordings: removes all managed clips, returns the count", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    touch(dir, 1); touch(dir, 2); touch(dir, 3);
    writeFileSync(join(dir, "other.txt"), "x");
    const n = await clearRecordings(dir);
    assert.equal(n, 3);
    assert.equal(wavs(dir).length, 0);
    assert.ok(existsSync(join(dir, "other.txt")));
  } finally {
    cleanup();
  }
});
