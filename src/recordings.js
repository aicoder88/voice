// @ts-check
// Recordings store. The audio of recent dictations is kept on disk so a missed
// paste stays recoverable (the pill's "Open recording" button, the tray's
// "Play recording" items). This module owns that folder: writing new clips and
// pruning old ones by BOTH a count cap and an age cap.
//
// Privacy: these are unencrypted recordings of everything the user dictated.
// The age cap (RECORDING_RETENTION_DAYS) bounds how long they linger; the user
// can also turn recording off entirely or clear the folder on demand (main.js).
//
// Kept free of any Electron import so it can be unit-tested with a temp dir.

import { writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { wrapWav } from "./providers/_shared.js";

// The random suffix is optional so clips written by older builds
// (`dictation-<ts>.wav`, no suffix) are still recognised — otherwise they'd be
// invisible to pruning AND to "Clear recordings", quietly breaking the privacy
// promise that the folder can be wiped.
const NAME_RE = /^dictation-(\d+)(?:-[a-z0-9]+)?\.wav$/i;

/**
 * Epoch-millis a recording filename encodes, or null if the name doesn't match
 * the `dictation-<ts>-<rand>.wav` shape this module writes.
 * @param {string} name
 * @returns {number | null}
 */
export function recordingTimestamp(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts : null;
}

/** List recording filenames (just the `.wav`s this module manages), unsorted. */
async function listRecordings(dir) {
  const all = await readdir(dir).catch(() => []);
  return all.filter((n) => NAME_RE.test(n));
}

/**
 * Delete recordings that exceed the count cap (oldest first) or are older than
 * the age cap. Best-effort: individual unlink failures are swallowed so a
 * locked file can't break a dictation. Returns the names removed.
 *
 * @param {string} dir
 * @param {{ maxCount?: number, maxAgeMs?: number, now?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function pruneRecordings(dir, { maxCount = 50, maxAgeMs = 0, now = Date.now() } = {}) {
  const names = await listRecordings(dir);
  // Chronological by the epoch in the filename; fall back to lexical for any
  // legacy name without a parseable timestamp.
  names.sort((a, b) => (recordingTimestamp(a) ?? 0) - (recordingTimestamp(b) ?? 0));

  const toRemove = new Set();
  // Age cap: anything older than the window. Skipped when maxAgeMs <= 0.
  if (maxAgeMs > 0) {
    for (const name of names) {
      const ts = recordingTimestamp(name);
      if (ts != null && now - ts > maxAgeMs) toRemove.add(name);
    }
  }
  // Count cap: drop the oldest beyond maxCount.
  if (names.length > maxCount) {
    for (const name of names.slice(0, names.length - maxCount)) toRemove.add(name);
  }

  await Promise.all([...toRemove].map((n) => unlink(join(dir, n)).catch(() => {})));
  return [...toRemove];
}

/**
 * Write a PCM buffer as a WAV into `dir`, then prune. Returns the new file path,
 * or null if there was nothing to write. Creates `dir` if missing.
 *
 * @param {string} dir
 * @param {Buffer} pcm
 * @param {number} sampleRate
 * @param {{ maxCount?: number, maxAgeMs?: number, now?: number, rand?: string }} [opts]
 * @returns {Promise<string | null>}
 */
export async function saveRecording(dir, pcm, sampleRate, opts = {}) {
  if (!dir || !pcm || !pcm.length) return null;
  const now = opts.now ?? Date.now();
  // Epoch-millis prefix keeps the sort chronological; the random suffix avoids
  // two same-millisecond saves clobbering one file.
  const rand = opts.rand || Math.random().toString(36).slice(2, 6);
  const name = `dictation-${now}-${rand}.wav`;
  const path = join(dir, name);
  await mkdir(dir, { recursive: true }).catch(() => {});
  await writeFile(path, wrapWav(pcm, sampleRate || 24000));
  await pruneRecordings(dir, { maxCount: opts.maxCount, maxAgeMs: opts.maxAgeMs, now });
  return path;
}

/**
 * Delete every managed recording in `dir`. Returns the count removed.
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function clearRecordings(dir) {
  const names = await listRecordings(dir);
  await Promise.all(names.map((n) => unlink(join(dir, n)).catch(() => {})));
  return names.length;
}
