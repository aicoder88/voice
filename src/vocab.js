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
 * Fix-after-the-fact vocabulary correction. Whisper transcribes naturally (the
 * custom dictionary is NOT fed into its initial prompt anymore — that bias made
 * it hallucinate rare words onto unrelated audio). Here we repair the output:
 * each transcribed word that is a GENUINE near-miss of a saved term is swapped
 * for the term's canonical spelling. A word that sounds nothing like a term is
 * left alone, which is the whole point.
 *
 * Guards that keep this from mangling ordinary speech:
 *  - same first letter as the term (whisper mishears rarely change the onset:
 *    "Cloud"→"Claud" yes; "like"→"Mike" no). This alone blocks most collisions.
 *  - edit distance 1–2 AND ≤25% of the longer word, so only true look-alikes
 *    match ("US" never becomes "Unsplash" — the distance is enormous).
 *  - terms shorter than 4 chars are skipped: too little signal, too risky.
 *  - a spoken word that is already a known/common word (seed or an exact term)
 *    is left alone — a desired correction always starts from a garbled non-word,
 *    never from a word whisper already got right.
 *
 * INHERENT LIMITATION: a term that is one edit from a common word ("Stripe" vs
 * "strip", "Resend" vs "resent") will rewrite that common word too — it is
 * structurally identical to the "Cloud"→"Claud" case we WANT, so no rule can
 * separate them. Keep the dictionary to genuinely rare proper nouns, exactly as
 * models/vocab.txt cautions. Capitalization of the spoken word is preserved.
 *
 * @param {string} text
 * @returns {string}
 */
export function correctTranscript(text) {
  if (!text) return text;
  const known = knownSet(); // seed words + exact terms — never rewrite these
  const targets = getTerms()
    .map((term) => ({ term, key: normalize(term) }))
    .filter((t) => t.key.length >= 4 && !seedSet().has(t.key));
  if (!targets.length) return text;
  return text.replace(WORD_RE, (word) => {
    const lower = word.toLowerCase();
    if (known.has(lower)) return word; // already a real word — don't touch it
    let best = null;
    let bestDist = Infinity;
    for (const t of targets) {
      if (t.key[0] !== lower[0]) continue; // onset must match
      const dist = levenshtein(lower, t.key);
      const maxLen = Math.max(lower.length, t.key.length);
      if (dist > 0 && dist <= 2 && dist <= Math.floor(maxLen * 0.25) && dist < bestDist) {
        best = t;
        bestDist = dist;
      }
    }
    return best ? applyCase(word, best.term) : word;
  });
}

/**
 * Put the spoken word's capitalization onto the canonical replacement so a fix
 * never corrupts sentence position: ALL-CAPS spoken → upper-case; a capitalized
 * spoken word → ensure the term starts capitalized; otherwise keep the term's
 * stored casing (so internal caps like "GitHub" survive).
 * @param {string} spoken @param {string} term
 */
function applyCase(spoken, term) {
  if (spoken.length > 1 && spoken === spoken.toUpperCase()) return term.toUpperCase();
  if (/^\p{Lu}/u.test(spoken) && !/^\p{Lu}/u.test(term)) {
    return term.charAt(0).toUpperCase() + term.slice(1);
  }
  return term;
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

// NOTE: there is deliberately no whisper initial-prompt helper here. Feeding
// custom terms into whisper's prompt biased it into hallucinating rare words
// onto unrelated audio; custom terms are applied AFTER transcription instead via
// correctTranscript(). Deepgram/OpenAI keep their biasing — their keyterm/prompt
// boosting is far less hallucination-prone than whisper's free-text prompt.

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
