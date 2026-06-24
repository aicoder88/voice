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

test("isLikelyCorrection: accepts lowercase tool names; rejects too-short, exact, far, and common words", () => {
  const { cleanup } = freshStore();
  try {
    // Lowercase corrections now qualify — terminal/editor tool and package names
    // (kubectl, pnpm, nginx) are rarely typed capitalized, so a lowercase
    // near-miss of a recent word is a genuine fix, not noise.
    assert.equal(vocab.isLikelyCorrection("kubctl", ["kubectl"]), "kubectl"); // lowercase tool name
    assert.equal(vocab.isLikelyCorrection("Cat", ["Catt"]), null);            // < 4 chars
    assert.equal(vocab.isLikelyCorrection("Debezium", ["Debezium"]), null);   // exact, not a fix
    assert.equal(vocab.isLikelyCorrection("Banana", ["Computer"]), null);     // too far
    // A common English word is never a custom term: typing "from" after GVoice
    // heard "form" is a grammar fix and must not nag, even though it's a 1-edit
    // near-miss — this is what the COMMON_WORDS stoplist guards against.
    assert.equal(vocab.isLikelyCorrection("from", ["form"]), null);           // common word
  } finally {
    cleanup();
  }
});

test("isLikelyCorrection: a near-miss of a COMMON misheard word never nags", () => {
  const { cleanup } = freshStore();
  try {
    // The misheard-word guard: if the word GVoice typed is itself common, a
    // typed near-miss is a grammar/homophone fix, not a custom term — even when
    // the TYPED word isn't in the stoplist. Bounds the false-positive class that
    // dropping the uppercase-only rule would otherwise reopen.
    assert.equal(vocab.isLikelyCorrection("form", ["from"]), null);  // misheard "from" is common
    assert.equal(vocab.isLikelyCorrection("thier", ["their"]), null); // misheard "their" is common
    assert.equal(vocab.isLikelyCorrection("wokr", ["work"]), null);   // misheard "work" is common
    // But a real lowercase term whose misheard form is NOT common still qualifies.
    assert.equal(vocab.isLikelyCorrection("kubctl", ["kubectl"]), "kubectl");
  } finally {
    cleanup();
  }
});

test("correctTranscript: fixes a genuine near-miss to the canonical spelling", () => {
  const { cleanup } = freshStore();
  try {
    vocab.addTerm("Claud");
    // whisper mishears the name as a common look-alike; same onset, distance 1.
    assert.equal(vocab.correctTranscript("I told Cloud to do it."), "I told Claud to do it.");
    assert.equal(vocab.correctTranscript("Purrify"), "Purrify"); // exact term untouched
  } finally {
    cleanup();
  }
});

test("correctTranscript: never replaces words that sound nothing like a term", () => {
  const { cleanup } = freshStore();
  try {
    vocab.addTerm("Unsplash");
    // The bug we are fixing: "US"/"a us price" must NOT become Unsplash.
    assert.equal(vocab.correctTranscript("a US price versus a normal price"), "a US price versus a normal price");
    assert.equal(vocab.correctTranscript("us"), "us");
  } finally {
    cleanup();
  }
});

test("correctTranscript: onset guard stops short-name collisions", () => {
  const { cleanup } = freshStore();
  try {
    vocab.addTerm("Mike");
    // "like"/"bike" are distance 1 from "Mike" but start with a different letter.
    assert.equal(vocab.correctTranscript("I would like a bike"), "I would like a bike");
  } finally {
    cleanup();
  }
});

test("correctTranscript: no-op with an empty dictionary", () => {
  const { cleanup } = freshStore();
  try {
    assert.equal(vocab.correctTranscript("nothing to change here"), "nothing to change here");
  } finally {
    cleanup();
  }
});

test("correctTranscript: preserves the spoken word's capitalization", () => {
  const { cleanup } = freshStore();
  try {
    vocab.addTerm("github"); // stored lowercase
    // Capitalized at sentence start stays capitalized; lowercase stays lowercase.
    assert.equal(vocab.correctTranscript("Githubb is great"), "Github is great");
    assert.equal(vocab.correctTranscript("on githubb today"), "on github today");
  } finally {
    cleanup();
  }
});

test("correctTranscript: never rewrites a word that is itself a known seed word", () => {
  const { cleanup } = freshStore();
  try {
    // "Anthropic" is a seed word (models/vocab.txt). A term one edit away must
    // not steal it. "Authropic" (a non-word mishear) still gets fixed.
    vocab.addTerm("Anthropoc");
    assert.equal(vocab.correctTranscript("I use Anthropic daily"), "I use Anthropic daily");
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
