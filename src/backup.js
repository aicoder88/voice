// @ts-check
// Audio backup + retry for failed dictations.
//
// When transcription fails, the renderer ships the captured PCM here. We wrap
// it in a canonical WAV and write it under a recordings directory so it can be
// (a) listened to and (b) re-transcribed. Retry replays the saved WAV through
// the relay over a Node WebSocket — the exact wire protocol the parity test
// uses — so it works regardless of which provider is active and even after an
// app restart.

import { writeFile, readFile, mkdir, unlink, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { wrapWav } from "./providers/_shared.js";

const SAMPLE_RATE = 24000;
const WAV_HEADER_BYTES = 44;

/**
 * Write a failed dictation's PCM to disk as a WAV.
 *
 * @param {object} opts
 * @param {string} opts.dir          Recordings directory (created if missing).
 * @param {Buffer} opts.pcm          Raw PCM16 mono @ sampleRate.
 * @param {number} opts.timestamp    Epoch ms used in the filename.
 * @param {number} [opts.sampleRate]
 * @returns {Promise<{ name: string, path: string }>}
 */
export async function saveBackup({ dir, pcm, timestamp, sampleRate = SAMPLE_RATE }) {
  await mkdir(dir, { recursive: true });
  const name = `dictation-${timestamp}.wav`;
  const path = join(dir, name);
  await writeFile(path, wrapWav(pcm, sampleRate));
  return { name, path };
}

/**
 * Read the PCM payload back out of a saved WAV (drops the 44-byte header).
 *
 * @param {string} path
 * @returns {Promise<Buffer>}
 */
export async function readBackupPcm(path) {
  const wav = await readFile(path);
  return wav.subarray(WAV_HEADER_BYTES);
}

/**
 * Remove a saved backup. Never throws (a missing file is fine).
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function deleteBackup(path) {
  await unlink(path).catch(() => {});
}

/**
 * Delete saved recordings older than maxAgeMs. Backups are removed on a
 * successful retry, but ones the user dismissed or only played back would
 * otherwise pile up forever — this sweep (run at boot) caps the clutter.
 * Never throws.
 *
 * @param {string} dir
 * @param {number} maxAgeMs
 * @param {number} now  epoch ms
 * @returns {Promise<number>}  count deleted
 */
export async function pruneBackups(dir, maxAgeMs, now) {
  let deleted = 0;
  try {
    const names = await readdir(dir);
    for (const name of names) {
      if (!name.endsWith(".wav")) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > maxAgeMs) {
          await unlink(path);
          deleted += 1;
        }
      } catch {}
    }
  } catch {
    // No recordings dir yet — nothing to prune.
  }
  return deleted;
}

/**
 * Relay WebSocket URL for a provider. Mirrors the selection logic in
 * public/dictation.js so a retry hits the same backend the live capture did.
 *
 * @param {string} host
 * @param {string} provider
 * @returns {string}
 */
export function buildRelayUrl(host, provider) {
  const p = (provider || "openai").toLowerCase();
  if (p === "deepgram") return `ws://${host}/realtime?provider=deepgram`;
  if (p === "whisper-local" || p === "local") return `ws://${host}/realtime?provider=whisper-local`;
  return `ws://${host}/realtime?model=gpt-realtime-whisper`;
}

const APPEND_CHUNK_BYTES = 32000;

/**
 * Replay PCM through the relay and resolve the transcript. Opens a WebSocket to
 * the local relay, streams the audio as input_audio_buffer.append frames, sends
 * commit, and waits for the terminal transcription frame (or an error).
 *
 * @param {Buffer} pcm
 * @param {object} opts
 * @param {string} opts.host        e.g. "127.0.0.1:3000"
 * @param {string} opts.provider
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}  the transcript (may be "" for silence)
 */
export function retranscribe(pcm, { host, provider, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildRelayUrl(host, provider));
    const parts = [];
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("Retry timed out waiting for the transcriber")),
      timeoutMs
    );

    ws.on("open", () => {
      for (let off = 0; off < pcm.length; off += APPEND_CHUNK_BYTES) {
        const slice = pcm.subarray(off, Math.min(off + APPEND_CHUNK_BYTES, pcm.length));
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: slice.toString("base64") }));
      }
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const t = msg.type || "";

      if (t.endsWith(".delta") && typeof msg.delta === "string") {
        parts.push(msg.delta);
        return;
      }
      if (
        t === "conversation.item.input_audio_transcription.completed" ||
        t === "response.audio_transcript.done" ||
        t === "response.output_text.done" ||
        t === "response.text.done" ||
        t === "response.done"
      ) {
        const final =
          msg.transcript ||
          msg.text ||
          (msg.response && (msg.response.output_text || msg.response.transcript)) ||
          parts.join("");
        finish(resolve, (final || "").trim());
        return;
      }
      if (t === "error" || t === "local.error") {
        finish(reject, new Error(msg.error?.message || msg.message || "transcription error"));
      }
    });

    ws.on("error", (err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
    ws.on("close", () => finish(reject, new Error("Relay connection closed before a transcript arrived")));
  });
}
