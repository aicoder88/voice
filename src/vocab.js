// @ts-check
// Custom dictionary — the single source of truth for user-added vocabulary.
//
// The Electron main process and the STT relay providers run in the SAME Node
// process (main.js boots server.js in-process), so this one module, backed by
// one JSON file, is shared by both:
//   - main.js WRITES to it when the user clicks "Add" on the cursor pop-up.
//   - the providers READ from it on every connection to bias recognition
//     (whisper initial-prompt, Deepgram keyterm, OpenAI transcription prompt).
//
// Storage: a JSON file. Defaults to a repo-local path so non-Electron hosts
// (the parity harness, `node server.js`) work unchanged; main.js calls init()
// to point it at the app's userData dir for the packaged app.

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo-local default. main.js overrides via init() to userData/custom-vocab.json.
let storePath = join(__dirname, "..", "models", "custom-vocab.json");
const SEED_FILE = join(__dirname, "..", "models", "vocab.txt");

/** @type {{ terms: string[], dismissed: string[] }} */
let store = { terms: [], dismissed: [] };
let loadedFrom = "";       // which path `store` was last read from
let loadedMtimeMs = -1;    // mtime of that read, so external edits get re-read

/** @type {Set<string> | null} */
let seedWords = null;

const MAX_TERM_LEN = 40;

/**
 * Point the store at a specific file (the app's userData dir in production).
 * Resets the in-memory cache so the next read loads from the new path.
 * @param {string} path
 */
export function init(path) {
  if (typeof path === "string" && path) {
    storePath = path;
    loadedFrom = "";
    loadedMtimeMs = -1;
  }
}

/** @returns {string} lowercased, trimmed, punctuation-stripped key for a term */
function normalize(term) {
  return String(term || "")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toLowerCase();
}

/**
 * Load the store from disk, re-reading only when the file's mtime changed (so
 * a hand-edit via the tray "Edit dictionary" item is picked up without a
 * restart). Never throws — a missing/corrupt file yields an empty store.
 */
function load() {
  let mtimeMs = -1;
  try { mtimeMs = statSync(storePath).mtimeMs; } catch { mtimeMs = -1; }
  if (loadedFrom === storePath && mtimeMs === loadedMtimeMs) return store;
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    store = {
      terms: Array.isArray(parsed.terms) ? parsed.terms.filter((t) => typeof t === "string") : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed.filter((t) => typeof t === "string") : []
    };
  } catch {
    store = { terms: [], dismissed: [] };
  }
  loadedFrom = storePath;
  loadedMtimeMs = mtimeMs;
  return store;
}

function save() {
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
    try { loadedMtimeMs = statSync(storePath).mtimeMs; } catch {}
    loadedFrom = storePath;
  } catch {
    // Disk failure is non-fatal: the in-memory store still biases this session.
  }
}

/** Words pulled from the hand-curated models/vocab.txt seed (loaded once). */
function seedSet() {
  if (seedWords) return seedWords;
  seedWords = new Set();
  try {
    const text = readFileSync(SEED_FILE, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      for (const w of line.match(/[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*/g) || []) {
        if (w.length >= 3) seedWords.add(w.toLowerCase());
      }
    }
  } catch {}
  return seedWords;
}

/** Lowercased set of everything we already know (custom terms + seed words). */
function knownSet() {
  const set = new Set(seedSet());
  for (const t of load().terms) set.add(normalize(t));
  return set;
}

function dismissedSet() {
  return new Set(load().dismissed.map(normalize));
}

/** @param {string} term */
export function isKnown(term) {
  return knownSet().has(normalize(term));
}

/** @param {string} term */
export function isDismissed(term) {
  return dismissedSet().has(normalize(term));
}

/** Current custom terms, in insertion order (excludes the seed file). */
export function getTerms() {
  return load().terms.slice();
}

/**
 * Add a term to the dictionary (and clear it from the dismissed list).
 * Returns true if it was newly added.
 * @param {string} term
 */
export function addTerm(term) {
  const cleaned = String(term || "").trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > MAX_TERM_LEN) return false;
  load();
  const key = normalize(cleaned);
  if (!key) return false;
  store.dismissed = store.dismissed.filter((d) => normalize(d) !== key);
  if (store.terms.some((t) => normalize(t) === key)) {
    save();
    return false;
  }
  store.terms.push(cleaned);
  save();
  return true;
}

/**
 * Remove a term from the dictionary. Returns true if it was present.
 * @param {string} term
 */
export function removeTerm(term) {
  const key = normalize(term);
  if (!key) return false;
  load();
  const before = store.terms.length;
  store.terms = store.terms.filter((t) => normalize(t) !== key);
  if (store.terms.length === before) return false;
  save();
  return true;
}

/**
 * Remember that the user declined this term, so it's never suggested again.
 * @param {string} term
 */
export function dismissTerm(term) {
  const key = normalize(term);
  if (!key) return;
  load();
  if (!store.dismissed.some((d) => normalize(d) === key)) {
    store.dismissed.push(String(term).trim());
    save();
  }
}

// --- Word tokenization -----------------------------------------------------

const WORD_RE = /[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*/g;

/** All word tokens in a string. @param {string} text */
export function wordsOf(text) {
  return String(text || "").match(WORD_RE) || [];
}

/**
 * Decide whether a word the user just typed by hand looks like a correction of
 * something GVoice typed (a near-miss within edit distance 2). Returns the
 * original misheard word if so, else null. Used by the manual-edit watcher.
 *
 * @param {string} typed         a word the user typed in the watch window
 * @param {string[]} recentWords words GVoice typed in the just-finished dictation
 * @returns {string | null}
 */
export function isLikelyCorrection(typed, recentWords) {
  // Require the hand-typed word to start uppercase — a fix of a misheard *name*
  // (the thing this feature is for) is almost always capitalized. This is the
  // key guard against nagging on every lowercase word typed in the watch window.
  if (!typed || typed.length < 4 || !/^\p{Lu}/u.test(typed)) return null;
  const lower = typed.toLowerCase();
  if (knownSet().has(lower) || dismissedSet().has(lower)) return null;
  for (const rw of recentWords || []) {
    if (!rw || rw.length < 4) continue;
    const rl = rw.toLowerCase();
    if (rl === lower) continue;
    const d = levenshtein(lower, rl);
    if (d > 0 && d <= 2 && d <= Math.ceil(Math.max(lower.length, rl.length) * 0.4)) {
      return rw;
    }
  }
  return null;
}

/** Classic O(n·m) Levenshtein, bounded by the short term lengths we feed it. */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// --- Per-provider formatting -----------------------------------------------

/** Sentence appended to whisper's initial prompt. "" when no custom terms. */
export function whisperPromptAddition() {
  const terms = getTerms();
  if (!terms.length) return "";
  return "Words that may appear: " + terms.join(", ") + ".";
}

/**
 * Terms for Deepgram keyterm / keywords boosting (English only — see caller).
 * Capped so the handshake URL (each term is a repeated query param) can't grow
 * unbounded as the dictionary fills up; the most recent terms win.
 */
export function deepgramKeyterms() {
  const terms = getTerms();
  return terms.length > 100 ? terms.slice(-100) : terms;
}

/** Prompt fragment for the OpenAI transcription model. "" when no custom terms. */
export function openaiPromptAddition() {
  const terms = getTerms();
  if (!terms.length) return "";
  return "Proper nouns and terms that may appear: " + terms.join(", ") + ".";
}
