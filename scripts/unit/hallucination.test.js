// Unit tests for the multilingual hallucination filter.
// Run: node --test scripts/unit/hallucination.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTranscript, normalizeForMatch } from "../../src/providers/whisper-local.js";

test("normalizeForMatch folds Croatian diacritics to ASCII", () => {
  assert.equal(normalizeForMatch("Hvala na gledanju!"), "hvala na gledanju");
  assert.equal(normalizeForMatch("Pretplatite se na moj kanal."), "pretplatite se na moj kanal");
});

test("normalizeForMatch folds Turkish dotless i and friends", () => {
  assert.equal(
    normalizeForMatch("Bu kanalıma abone olmayı unutmayın"),
    "bu kanalima abone olmayi unutmayin"
  );
});

test("the exact Turkish hallucination the user hit is dropped", () => {
  assert.equal(sanitizeTranscript("Bu kanalıma abone olmayı unutmayın."), "");
});

test("Croatian subscribe/thanks hallucinations are dropped", () => {
  assert.equal(sanitizeTranscript("Hvala na gledanju!"), "");
  assert.equal(sanitizeTranscript("Pretplatite se."), "");
  assert.equal(sanitizeTranscript("Ne zaboravite se pretplatiti"), "");
});

test("English stock phrases still dropped (no regression)", () => {
  assert.equal(sanitizeTranscript("Thanks for watching"), "");
  assert.equal(sanitizeTranscript("[BLANK_AUDIO]"), "");
  assert.equal(sanitizeTranscript("(music)"), "");
});

test("German/Spanish/French junk dropped", () => {
  assert.equal(sanitizeTranscript("Vielen Dank"), "");
  assert.equal(sanitizeTranscript("Gracias por ver"), "");
  assert.equal(sanitizeTranscript("Merci d'avoir regardé"), "");
});

test("a real Croatian sentence is preserved", () => {
  const real = "Idemo sutra na sastanak u deset sati";
  assert.equal(sanitizeTranscript(real), real);
});

test("a real sentence that merely starts with a stock word is preserved", () => {
  const real = "Hvala ti što si mi pomogao s ovim zadatkom";
  assert.equal(sanitizeTranscript(real), real);
});

test("a real English sentence is preserved", () => {
  const real = "Please review the document before the meeting";
  assert.equal(sanitizeTranscript(real), real);
});
