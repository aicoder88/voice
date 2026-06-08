// Unit tests for the .env settings reader/writer.
// Run: node --test scripts/unit/settings.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnv,
  applyEnv,
  readEnvFile,
  writeEnvFile,
  settingsView,
  patchFromView
} from "../../src/settings.js";

function tmpEnv(contents) {
  const dir = mkdtempSync(join(tmpdir(), "gvoice-settings-"));
  const path = join(dir, ".env");
  if (contents != null) writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("parseEnv: reads simple assignments, ignores comments/blanks", () => {
  const { index } = parseEnv("# comment\nA=1\n\nB = two \nnotakey\n");
  assert.equal(index.get("A").value, "1");
  assert.equal(index.get("B").value, "two");
  assert.equal(index.has("notakey"), false);
});

test("parseEnv: strips surrounding quotes from values", () => {
  const { index } = parseEnv('A="hello world"\nB=\'x\'');
  assert.equal(index.get("A").value, "hello world");
  assert.equal(index.get("B").value, "x");
});

test("applyEnv: updates an existing key in place, preserves comments", () => {
  const before = "# header\nSTT_PROVIDER=openai\nPORT=3000\n";
  const after = applyEnv(before, { STT_PROVIDER: "deepgram" });
  assert.ok(after.includes("# header"));
  assert.ok(after.includes("STT_PROVIDER=deepgram"));
  assert.ok(after.includes("PORT=3000"));
  // Only the one line changed — original openai gone.
  assert.ok(!after.includes("STT_PROVIDER=openai"));
});

test("applyEnv: appends a missing key", () => {
  const after = applyEnv("A=1\n", { B: "2" });
  assert.ok(after.includes("A=1"));
  assert.ok(after.includes("B=2"));
});

test("applyEnv: quotes values with spaces or #", () => {
  const after = applyEnv("", { OPENAI_API_KEY: "a b", NOTE: "x#y" });
  assert.ok(after.includes('OPENAI_API_KEY="a b"'));
  assert.ok(after.includes('NOTE="x#y"'));
});

test("applyEnv: rejects newlines in a value", () => {
  assert.throws(() => applyEnv("", { X: "a\nb" }), /newline/);
});

test("applyEnv: does not grow trailing blank lines on repeated appends", () => {
  let text = "A=1\n";
  text = applyEnv(text, { B: "2" });
  text = applyEnv(text, { C: "3" });
  assert.ok(!/\n\n$/.test(text), "no double trailing newline");
});

test("writeEnvFile + readEnvFile round-trips and preserves unmanaged keys", () => {
  const { path, cleanup } = tmpEnv("# mine\nPORT=3000\nSTT_PROVIDER=openai\n");
  try {
    writeEnvFile(path, { STT_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "dg-key" });
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes("# mine"));
    assert.ok(text.includes("PORT=3000"));
    assert.ok(text.includes("STT_PROVIDER=deepgram"));
    assert.ok(text.includes("DEEPGRAM_API_KEY=dg-key"));
  } finally {
    cleanup();
  }
});

test("readEnvFile: missing file yields empty string (no throw)", () => {
  assert.equal(readEnvFile(join(tmpdir(), "definitely-not-here-gvoice.env")), "");
});

test("settingsView: defaults when env is empty", () => {
  const v = settingsView({});
  assert.equal(v.provider, "openai");
  assert.equal(v.language, "auto");
  assert.equal(v.cleanupEnabled, false);
  assert.equal(v.recordingsEnabled, true);
  assert.equal(v.retentionDays, 7);
});

test("settingsView: reads + coerces values, falls back on invalid enums", () => {
  const v = settingsView({
    STT_PROVIDER: "deepgram",
    WHISPER_LANGUAGE: "hr",
    CLEANUP_ENABLED: "true",
    RECORDINGS_ENABLED: "false",
    RECORDING_RETENTION_DAYS: "14",
    OPENAI_API_KEY: "k"
  });
  assert.equal(v.provider, "deepgram");
  assert.equal(v.language, "hr");
  assert.equal(v.cleanupEnabled, true);
  assert.equal(v.recordingsEnabled, false);
  assert.equal(v.retentionDays, 14);
  assert.equal(v.openaiKey, "k");

  assert.equal(settingsView({ STT_PROVIDER: "bogus" }).provider, "openai");
  assert.equal(settingsView({ WHISPER_LANGUAGE: "fr" }).language, "auto");
});

test("patchFromView: maps fields to env keys and drops unknowns/invalids", () => {
  const patch = patchFromView({
    provider: "whisper-local",
    language: "en",
    cleanupEnabled: true,
    openaiKey: "  trimmed  ",
    recordingsEnabled: false,
    retentionDays: 30,
    bogus: "ignored"
  });
  assert.equal(patch.STT_PROVIDER, "whisper-local");
  assert.equal(patch.WHISPER_LANGUAGE, "en");
  assert.equal(patch.CLEANUP_ENABLED, "true");
  assert.equal(patch.OPENAI_API_KEY, "trimmed");
  assert.equal(patch.RECORDINGS_ENABLED, "false");
  assert.equal(patch.RECORDING_RETENTION_DAYS, "30");
  assert.equal("bogus" in patch, false);
});

test("patchFromView: invalid provider/language are omitted (not corrupted)", () => {
  const patch = patchFromView({ provider: "hax", language: "zz" });
  assert.equal("STT_PROVIDER" in patch, false);
  assert.equal("WHISPER_LANGUAGE" in patch, false);
});

test("patchFromView: retentionDays clamps to [0,365] and rounds", () => {
  assert.equal(patchFromView({ retentionDays: 999 }).RECORDING_RETENTION_DAYS, "365");
  assert.equal(patchFromView({ retentionDays: -5 }).RECORDING_RETENTION_DAYS, "7");
  assert.equal(patchFromView({ retentionDays: 2.6 }).RECORDING_RETENTION_DAYS, "3");
});
