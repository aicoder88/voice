// Unit tests for the spoken-retraction routing gate (looksLikeRetraction).
// This is the cheap regex that decides whether a short/clean utterance still
// gets sent to the LLM cleanup pass so a self-correction can be dropped. The
// LLM prompt does the nuanced judgment; this only catches unambiguous cues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeRetraction } from "../../src/cleanup.js";

test("matches unambiguous multi-word retraction cues", () => {
  for (const s of [
    "buy milk no wait buy water",
    "wait no, the other one",
    "scratch that, start over",
    "strike that line",
    "call John, I mean Sarah",
    "ship it Tuesday, or rather Wednesday",
    "send it, never mind",
    "send it, nevermind",
    "MEET AT THREE NO WAIT FOUR" // case-insensitive
  ]) {
    assert.equal(looksLikeRetraction(s), true, `should match: ${s}`);
  }
});

test("does NOT match literal content that merely contains a cue word", () => {
  for (const s of [
    "the answer is no",
    "I actually agree with that",
    "I'm sorry for the delay",
    "delete that file from the server", // 'delete that' deliberately excluded
    "I'd rather walk than drive",
    "a rather large dog",
    "casino waiting room", // no false 'no wait' across word boundary
    "the meantime is fine"
  ]) {
    assert.equal(looksLikeRetraction(s), false, `should NOT match: ${s}`);
  }
});

test("handles non-string / empty input safely", () => {
  assert.equal(looksLikeRetraction(""), false);
  assert.equal(looksLikeRetraction(null), false);
  assert.equal(looksLikeRetraction(undefined), false);
  assert.equal(looksLikeRetraction(42), false);
});
