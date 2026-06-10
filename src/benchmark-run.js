// @ts-check
// The LIVE speed test: actually transcribe a short clip on the real hardware,
// time it, and hand the number to the pure judge (src/benchmark.js). This is the
// only trustworthy answer to "is on-device faster than the cloud here?" — a
// hardware guess isn't.
//
// CRUCIAL: we measure the WARM, steady-state speed — the same warm whisper-server
// the running app uses for every dictation — NOT a cold command-line run. The
// cold path pays a one-time model-load each invocation (seconds), which is the
// first-dictation cost the app already hides by warming at boot; benchmarking it
// would wrongly reject machines that are fast in normal use. (Measured on a GTX
// 1660 Ti Max-Q: cold ~4.5s, warm ~200–400ms — the warm number is the truth.)
//
// Why a synthetic clip is fine: whisper.cpp pads every input shorter than 30s to
// one fixed 30s encoder window, so processing time reflects the MODEL + HARDWARE,
// not the clip's content. We generate a few seconds of quiet noise at 16 kHz —
// no sample file to bundle or download, and deterministic.

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapWav } from "./providers/_shared.js";
import { judgeLocalSpeed } from "./benchmark.js";
import { ensureWhisperServer, stopWhisperServer } from "./providers/whisper-local.js";

const SAMPLE_RATE = 16000; // whisper.cpp's native rate
const SAMPLE_SECONDS = 4;

/**
 * A few seconds of low-amplitude pseudo-noise PCM16. Deterministic (a simple
 * LCG, no Math.random) so two runs feed the encoder identical work.
 * @returns {Buffer}
 */
function makeSamplePcm() {
  const n = SAMPLE_RATE * SAMPLE_SECONDS;
  const buf = Buffer.alloc(n * 2);
  let seed = 1234567;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const s = ((seed % 3000) - 1500) | 0; // ~±1500: above silence, below clipping
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}

/**
 * Measure the warm, steady-state on-device transcription time and return the
 * verdict from judgeLocalSpeed. Warms a fresh whisper-server on the chosen model,
 * runs one throwaway transcription to settle caches, then times two and keeps the
 * faster (best achievable steady state). Falls back to a single cold whisper-cli
 * timing only if the server can't start — better a pessimistic number than none.
 *
 * @param {{ bin: string, model: string, onStage?: (msg: string) => void, cloudBaselineMs?: number }} opts
 * @returns {Promise<{ fastEnough: boolean, elapsedMs: number, ratio: number, thresholdMs: number, reason: string, warm: boolean }>}
 */
export async function runLocalBenchmark({ bin, model, onStage, cloudBaselineMs }) {
  if (!model || !existsSync(model)) throw new Error("model file not found: " + model);
  const dir = mkdtempSync(join(tmpdir(), "gvoice-bench-"));
  const wavPath = join(dir, "bench.wav");
  const wav = wrapWav(makeSamplePcm(), SAMPLE_RATE);
  writeFileSync(wavPath, wav);

  // ensureWhisperServer reads the model from WHISPER_MODEL; point it at the model
  // under test and restore the prior value afterward so a "keep cloud" choice
  // doesn't leave the env mutated.
  const prevModel = process.env.WHISPER_MODEL;
  process.env.WHISPER_MODEL = model;
  try {
    if (onStage) onStage("Warming up the on-device engine…");
    // Stop any server left from a previous benchmark so this one definitely runs
    // the selected model, then warm a fresh one.
    stopWhisperServer();
    await ensureWhisperServer(bin);
    const url = process.env.WHISPER_SERVER_URL;
    if (!url) throw new Error("no server url");

    if (onStage) onStage("Testing speed on your computer…");
    await postWav(url, wav); // throwaway: settle caches / first-token JIT
    const a = await timePost(url, wav);
    const b = await timePost(url, wav);
    const elapsedMs = Math.min(a, b);
    return { ...judgeLocalSpeed({ elapsedMs, cloudBaselineMs }), warm: true };
  } catch (serverErr) {
    // Server path unavailable — fall back to a single cold CLI run so the user
    // still gets a (conservative) answer rather than a hard failure.
    if (onStage) onStage("Testing speed on your computer…");
    const elapsedMs = await timeWhisperCli(bin, model, wavPath);
    return { ...judgeLocalSpeed({ elapsedMs, cloudBaselineMs }), warm: false };
  } finally {
    if (prevModel === undefined) delete process.env.WHISPER_MODEL;
    else process.env.WHISPER_MODEL = prevModel;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** POST a wav to the warm whisper-server (no timing). */
async function postWav(url, wav) {
  const form = new FormData();
  form.append("file", new Blob([/** @type {ArrayBuffer} */ (wav.buffer)], { type: "audio/wav" }), "bench.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error("whisper-server HTTP " + res.status);
  await res.json().catch(() => ({}));
}

/** Time one warm-server transcription in ms. */
async function timePost(url, wav) {
  const t = Date.now();
  await postWav(url, wav);
  return Date.now() - t;
}

/**
 * Cold fallback: spawn whisper-cli and time it (includes model-load). Only used
 * when the warm server can't start.
 * @returns {Promise<number>}
 */
function timeWhisperCli(bin, model, wavPath) {
  return new Promise((resolve, reject) => {
    const args = ["-m", model, "-f", wavPath, "-nt", "-np", "-l", "auto", "--no-fallback", "-t", "4"];
    const start = Date.now();
    const proc = spawn(bin, args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("whisper-cli exit " + code + ": " + stderr.slice(0, 300)));
      resolve(Date.now() - start);
    });
  });
}
