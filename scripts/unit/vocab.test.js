// Unit tests for the custom dictionary (vocab.js).
// Run: node --test scripts/unit/vocab.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vocab from "../../src/vocab.js";

// Each test points the store at a fresh empty file so they're order-independent.
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "gvoice-vocab-"));
  const path = join(dir, "custom-vocab.json");
  vocab.init(path);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("addTerm: adds a new term, dedupes case-insensitively", () => {
  const { cleanup } = freshStore();
  try {
    assert.equal(vocab.addTerm("Debezium"), true);
    assert.equal(vocab.addTerm("debezium"), false); // same normalized key
    assert.deepEqual(vocab.getTerms(), ["Debezium"]);
  } finally {
    cleanup();
  }
});

test("addTerm: rejects empty and over-long terms", () => {
  const { cleanup } = freshStore();
  try {
    assert.equal(vocab.addTerm("   "), false);
    assert.equal(vocab.addTerm("x".repeat(41)), false);
  } finally {
    cleanup();
  }
});

test("isKnown: true for added terms, false otherwise", () => {
  const { cleanup } = freshStore();
  try {
    vocab.addTerm("Zylofant");
    assert.equal(vocab.isKnown("zylofant"), true);
    assert.equal(vocab.isKnown("nonexistentword"), false);
  } finally {
    cleanup();
  }
});

test("removeTerm: removes a present term, reports absence", () => {
  const { cleanup } = freshStore();
  try {
    vocab.addTerm("Foobarium");
    assert.equal(vocab.removeTerm("foobarium"), true);
    assert.equal(vocab.isKnown("Foobarium"), false);
    assert.equal(vocab.removeTerm("foobarium"), false);
  } finally {
    cleanup();
  }
});

test("dismissTerm: dismissed terms are remembered and excluded from suggestions", () => {
  const { cleanup } = freshStore();
  try {
    vocab.dismissTerm("Skipme");
    assert.equal(vocab.isDismissed("skipme"), true);
    // A dismissed term should never be offered as a correction.
    assert.equal(vocab.isLikelyCorrection("Skipme", ["Skpme"]), null);
  } finally {
    cleanup();
  }
});

test("addTerm: clears a prior dismissal", () => {
  const { cleanup } = freshStore();
  try {
    vocab.dismissTerm("Comeback");
    assert.equal(vocab.isDismissed("Comeback"), true);
    vocab.addTerm("Comeback");
    assert.equal(vocab.isDismissed("Comeback"), false);
    assert.equal(vocab.isKnown("Comeback"), true);
  } finally {
    cleanup();
  }
});

test("wordsOf: tokenizes words, drops punctuation", () => {
  assert.deepEqual(vocab.wordsOf("Hello, world! It's fine."), ["Hello", "world", "It's", "fine"]);
  assert.deepEqual(vocab.wordsOf(""), []);
});

test("isLikelyCorrection: a capitalized near-miss of a recent word matches", () => {
  const { cleanup } = freshStore();
  try {
    // typed by hand (uppercase) is a 1-edit fix of what GVoice typed.
    assert.equal(vocab.isLikelyCorrection("Debezum", ["Debezium"]), "Debezium");
  } finally {
    cleanup();
  }
});

test("isLikelyCorrection: rejects lowercase, too-short, exact, and far words", () => {
  const { cleanup } = freshStore();
  try {
    assert.equal(vocab.isLikelyCorrection("debezum", ["Debezium"]), null); // lowercase
    assert.equal(vocab.isLikelyCorrection("Cat", ["Catt"]), null);          // < 4 chars
    assert.equal(vocab.isLikelyCorrection("Debezium", ["Debezium"]), null); // exact, not a fix
    assert.equal(vocab.isLikelyCorrection("Banana", ["Computer"]), null);   // too far
  } finally {
    cleanup();
  }
});

test("whisperPromptAddition: empty without terms, lists them with terms", () => {
  const { cleanup } = freshStore();
  try {
    assert.equal(vocab.whisperPromptAddition(), "");
    vocab.addTerm("Debezium");
    assert.match(vocab.whisperPromptAddition(), /Debezium/);
  } finally {
    cleanup();
  }
});

test("deepgramKeyterms: caps at the 100 most recent terms", () => {
  const { cleanup } = freshStore();
  try {
    for (let i = 0; i < 105; i++) vocab.addTerm("Termnumber" + i);
    const keyterms = vocab.deepgramKeyterms();
    assert.equal(keyterms.length, 100);
    // Most-recent-wins: the last added term survives, the first is dropped.
    assert.ok(keyterms.includes("Termnumber104"));
    assert.ok(!keyterms.includes("Termnumber0"));
  } finally {
    cleanup();
  }
});
