// @ts-check
// Transcript history: the last MAX_ENTRIES dictations, persisted to a JSON
// file in userData so a missed paste is never lost — even across restarts.
// Newest first. Reads happen once at boot; writes are serialized so rapid
// dictations can't interleave and corrupt the file.
import { app } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_ENTRIES = 50;

/** @typedef {{ ts: number, text: string, pasted: boolean, recordingPath?: string | null }} HistoryEntry */

/** @type {HistoryEntry[]} */
let entries = [];
/** @type {string | null} */
let historyPath = null;
/** @type {Promise<void>} */
let writeChain = Promise.resolve();

/** Load existing history from disk. Call once after app is ready. */
export async function initHistory() {
  historyPath = join(app.getPath("userData"), "history.json");
  try {
    const raw = JSON.parse(await readFile(historyPath, "utf8"));
    if (Array.isArray(raw)) {
      entries = raw
        .filter((e) => e && typeof e.text === "string" && typeof e.ts === "number")
        .map((e) => ({
          ts: e.ts,
          text: e.text,
          pasted: !!e.pasted,
          recordingPath: typeof e.recordingPath === "string" ? e.recordingPath : null
        }))
        .slice(0, MAX_ENTRIES);
    }
  } catch {
    // Missing or unreadable file — start fresh.
    entries = [];
  }
}

/** @returns {string | null} absolute path of the history file (after init) */
export function getHistoryPath() {
  return historyPath;
}

/** @returns {HistoryEntry[]} newest-first copy */
export function getHistory() {
  return entries.slice();
}

/**
 * Record a finished dictation and persist. Fire-and-forget: failures are
 * logged, never thrown into the dictation path. An entry is worth keeping if it
 * has text OR a recording to listen to (a failed/empty attempt has only audio).
 * @param {string} text
 * @param {boolean} pasted
 * @param {string | null} [recordingPath]
 */
export function recordTranscript(text, pasted, recordingPath = null) {
  if ((!text || !text.trim()) && !recordingPath) return;
  entries.unshift({ ts: Date.now(), text: text || "", pasted, recordingPath: recordingPath || null });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  const snapshot = JSON.stringify(entries, null, 2);
  writeChain = writeChain
    .then(() => historyPath ? writeFile(historyPath, snapshot, "utf8") : undefined)
    .catch((err) => console.error("[history] write failed:", err && err.message));
}
