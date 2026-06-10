// Unit tests for the hr/en dual-leg winner pick (whisper-local auto mode).
// Run: node --test scripts/unit/pick-transcript.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTranscript } from "../../src/providers/whisper-local.js";

const leg = (language, text, confidence) => ({ text, confidence, language });

test("both legs clean: higher confidence wins, regardless of which finished first", () => {
  // Croatian speech: the forced-EN decode is garbled-but-real-looking text that
  // passes the sanitizer. Confidence is what must separate them.
  const en = leg("en", "each more snow you yeah that custody", -0.92);
  const hr = leg("hr", "idemo sutra na sastanak u deset sati", -0.21);
  assert.equal(pickTranscript(en, hr), hr);
  assert.equal(pickTranscript(hr, en), hr); // argument order must not matter
});

test("a sanitizer-surviving leg beats a stock-hallucination leg even at lower confidence", () => {
  const en = leg("en", "Thanks for watching", -0.1); // stock junk, high confidence
  const hr = leg("hr", "dobro jutro svima", -0.8);
  assert.equal(pickTranscript(en, hr), hr);
});

test("equal confidence ties go to the EN leg (stable, documented)", () => {
  const en = leg("en", "send the file please", -0.3);
  const hr = leg("hr", "pošalji datoteku molim te", -0.3);
  assert.equal(pickTranscript(en, hr), en);
});

test("a failed leg loses to a successful one", () => {
  const hr = leg("hr", "vidimo se sutra ujutro", -0.5);
  assert.equal(pickTranscript(null, hr), hr);
  const en = leg("en", "see you tomorrow morning", -0.5);
  assert.equal(pickTranscript(en, null), en);
});

test("both legs failed returns null", () => {
  assert.equal(pickTranscript(null, null), null);
});

test("both legs junk: higher confidence still returned (caller's sanitizer drops it)", () => {
  const en = leg("en", "Thanks for watching", -0.4);
  const hr = leg("hr", "Hvala na gledanju", -0.9);
  assert.equal(pickTranscript(en, hr), en);
});
