// @ts-check
// Local whisper.cpp transport. Selected via ?provider=whisper-local (alias:
// local). No upstream WebSocket — instead, accumulates PCM in memory until
// the browser commits, then either POSTs a WAV to a long-running
// whisper-server (if WHISPER_SERVER_URL is set; ~10–100x faster) or shells
// out to whisper-cli on a tempfile (fallback).
//
// The whisper-server child process is owned by this module: lazily spawned on
// the first attach() and torn down via a process-exit handler. This keeps the
// relay self-sufficient regardless of host (Electron, plain `npm run dev`,
// or the parity harness).

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sendToClient, wrapWav } from "./_shared.js";
import * as vocab from "../vocab.js";

const SAMPLE_RATE = 24000;
// Anything shorter than this is almost certainly a misfire (the user tapped
// the hotkey rather than holding it). Skip the transcription round-trip and
// return an empty string immediately.
const MIN_PCM_BYTES = 4800; // 0.1s @ 24 kHz mono int16

// Silence gate. Whisper hallucinates plausible-but-invented text ("Thank you",
// "(music)", training-data fragments) when handed a near-silent buffer — the
// classic failure when the user holds the key but doesn't speak. We refuse to
// transcribe a buffer whose loudest sample never crosses this int16 amplitude
// (~1.5% of full scale). Tunable via WHISPER_SILENCE_PEAK; set to 0 to disable.
const SILENCE_PEAK = Number(process.env.WHISPER_SILENCE_PEAK ?? 500);

// Stock phrases Whisper emits on silence/noise. Matched against the transcript
// after lowercasing and stripping everything but letters/digits/spaces, so
// "Thank you." and "thank you" collapse to the same key. Whole-string match
// only — a real sentence that merely starts with one of these is untouched.
const HALLUCINATION_PHRASES = new Set([
  "you", "thank you", "thank you very much", "thanks", "thanks for watching",
  "thank you for watching", "thanks for watching everyone", "please subscribe",
  "dont forget to subscribe", "like and subscribe", "bye", "bye bye", "goodbye",
  "okay", "ok", "so", "hello", "hi", "the", "yeah", "uh", "um", "mm", "mhm",
  "i", "co authored by", "subtitles by", "transcription by", "transcribed by",
  "amaraorg", "music", "applause", "silence", "blank audio"
]);

/**
 * Peak absolute amplitude across an int16 PCM buffer (0..32768).
 *
 * @param {Buffer} pcm
 * @returns {number}
 */
function peakAmplitude(pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Strip Whisper's non-speech annotations and reject stock hallucinations.
 * Bracketed/parenthesized/asterisked spans (e.g. "[BLANK_AUDIO]", "(music)",
 * "*laughs*") are never produced by literal speech, so they are always sound
 * tags and get removed. If what remains is empty or a known stock phrase, the
 * whole thing was noise — return "" so nothing is typed.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeTranscript(text) {
  if (!text) return "";
  const stripped = text
    .replace(/\([^()]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const normalized = stripped.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  if (HALLUCINATION_PHRASES.has(normalized)) return "";
  return stripped;
}

// Whisper's initial-prompt accepts ~224 tokens (~1000 chars of typical
// English). Anything longer gets silently truncated by the model, so we
// truncate here too and surface it in the load log.
const MAX_PROMPT_CHARS = 1000;
// Resolve vocab.txt against this source file, not process.cwd() — cwd varies
// by launch method (npm start vs Finder vs packaged) and would silently miss.
const __dirname = dirname(fileURLToPath(import.meta.url));
const VOCAB_FILE = join(__dirname, "..", "..", "models", "vocab.txt");

let promptLogged = false;

/**
 * Initial-prompt text that biases whisper toward custom vocabulary. Resolves
 * from WHISPER_PROMPT env var or models/vocab.txt, truncates to whisper's
 * limit, and logs once per process so operators can confirm it loaded.
 *
 * Re-read on every commit so editing vocab.txt takes effect without restart.
 *
 * @returns {Promise<string>}
 */
async function loadPrompt() {
  const { raw, source } = await resolvePrompt();
  // Fold in the user's custom dictionary (the words added via the cursor
  // pop-up) on top of the hand-curated seed prompt. Re-read every commit so a
  // just-added word biases the very next dictation.
  let combined = raw;
  try {
    const addition = vocab.whisperPromptAddition();
    if (addition) combined = combined ? combined + " " + addition : addition;
  } catch {}
  const truncated = combined.length > MAX_PROMPT_CHARS;
  const prompt = truncated ? combined.slice(0, MAX_PROMPT_CHARS) : combined;
  if (!promptLogged) {
    promptLogged = true;
    const note = truncated ? " (truncated from " + combined.length + ")" : "";
    console.error("[whisper-local] vocab prompt: " + prompt.length + " chars from " + source + " + custom dictionary" + note);
  }
  return prompt;
}

/**
 * Where the prompt text comes from. Env var wins (even if empty), then
 * vocab.txt, then nothing.
 *
 * @returns {Promise<{ raw: string, source: string }>}
 */
async function resolvePrompt() {
  if (typeof process.env.WHISPER_PROMPT === "string") {
    return { raw: process.env.WHISPER_PROMPT.trim(), source: "env WHISPER_PROMPT" };
  }
  try {
    const text = await readFile(VOCAB_FILE, "utf8");
    // Lines starting with '#' are comments; everything else collapses to one
    // whitespace-normalized blob that becomes whisper's initial prompt.
    const raw = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { raw, source: VOCAB_FILE };
  } catch {
    return { raw: "", source: "(none)" };
  }
}

/** @type {import("node:child_process").ChildProcess | null} */
let whisperServerProc = null;
/** @type {Promise<void> | null} */
let whisperServerReady = null;
let exitHandlerInstalled = false;

/**
 * Lazily spawn the whisper.cpp `whisper-server` binary on first attach.
 * Resolves once the server is responding on the configured port. On failure,
 * resets so the next attach() can retry.
 *
 * @param {string} [bin]
 * @returns {Promise<void>}
 */
export function stopWhisperServer() {
  if (whisperServerProc) {
    try { whisperServerProc.kill("SIGTERM"); } catch {}
    whisperServerProc = null;
  }
  whisperServerReady = null;
}

export function ensureWhisperServer(bin) {
  if (whisperServerReady) return whisperServerReady;

  // Replace the trailing "-cli" (with optional .exe suffix on Windows) with
  // "-server". Previous regex (/-cli$/) missed the .exe case and ended up
  // spawning whisper-cli.exe with server-style flags, which printed help and
  // exited.
  const serverBin = bin ? bin.replace(/-cli(\.exe)?$/i, "-server$1") : "whisper-server";
  const model = process.env.WHISPER_MODEL || "./models/ggml-small.en-q5_1.bin";
  const port = process.env.WHISPER_PORT || "8081";
  const baseUrl = `http://127.0.0.1:${port}`;

  whisperServerReady = (async () => {
    const args = [
      "-m", model,
      "--host", "127.0.0.1",
      "--port", port,
      "-t", "4",
      "--no-fallback",
      // GPU is on by default in the CUDA build (no -ng flag). -fa enables
      // flash-attention. Pass explicitly so future "why is this slow" debugs
      // don't have to guess.
      "-fa"
    ];
    let spawnError = null;
    whisperServerProc = spawn(serverBin, args);
    whisperServerProc.on("error", (err) => {
      spawnError = err;
      console.error("[whisper-server] spawn error:", err.message);
      whisperServerProc = null;
    });
    // Surface init lines so we can see whether CUDA actually initialized.
    // Once "server is listening" appears we stop being chatty.
    let serverReady = false;
    whisperServerProc.stderr?.on("data", (d) => {
      const s = d.toString();
      if (!serverReady) {
        if (/CUDA|GPU|cublas|listening|loaded|error|fail/i.test(s)) {
          console.error("[whisper-server]", s.trim());
        }
        if (/listening/i.test(s)) serverReady = true;
      } else if (/error|fail/i.test(s)) {
        console.error("[whisper-server]", s.trim());
      }
    });
    whisperServerProc.on("exit", (code) => {
      console.error("[whisper-server] exited with code " + code);
      whisperServerProc = null;
    });

    if (!exitHandlerInstalled) {
      exitHandlerInstalled = true;
      process.on("exit", () => {
        if (whisperServerProc) {
          try { whisperServerProc.kill("SIGTERM"); } catch {}
        }
      });
    }

    process.env.WHISPER_SERVER_URL = `${baseUrl}/inference`;

    await waitForServer(baseUrl, 10000, () => spawnError || (whisperServerProc === null ? new Error("whisper-server died before ready") : null));
    console.error("[whisper-server] ready at " + process.env.WHISPER_SERVER_URL);
  })();

  whisperServerReady.catch(() => {
    // Reset so a later attach() can retry instead of inheriting the failure.
    whisperServerReady = null;
  });

  return whisperServerReady;
}

/**
 * @param {string} baseUrl
 * @param {number} timeoutMs
 * @param {(() => Error | null) | null} [abortCheck]
 * @returns {Promise<void>}
 */
async function waitForServer(baseUrl, timeoutMs, abortCheck) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const fatal = abortCheck && abortCheck();
    if (fatal) throw fatal;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 500);
      try {
        const res = await fetch(baseUrl, { signal: ctrl.signal });
        if (res.status < 600) return;
      } finally {
        clearTimeout(timer);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("whisper-server did not start within " + timeoutMs + "ms");
}

/**
 * @param {import("ws").WebSocket} clientSocket
 * @param {{ bin: string, model: string }} opts
 */
export async function attach(clientSocket, { bin, model }) {
  const audioChunks = [];
  let chunkCount = 0;

  console.error("[relay] whisper-local session opened");

  // Register the audio listener BEFORE warming the server. The client flushes
  // a pre-roll burst the instant the socket opens; appended frames only land
  // in audioChunks (no server needed), so capturing them early costs nothing
  // and closes the warm-up race that would otherwise drop the opening words.
  clientSocket.on("message", async (message) => {
    let parsed;
    try { parsed = JSON.parse(message.toString()); } catch { return; }

    if (parsed.type === "input_audio_buffer.append" && typeof parsed.audio === "string") {
      audioChunks.push(Buffer.from(parsed.audio, "base64"));
      chunkCount++;
      return;
    }

    if (parsed.type === "input_audio_buffer.commit") {
      const pcm = Buffer.concat(audioChunks);
      console.error("[relay] whisper-local commit received: " + chunkCount + " chunks, " + pcm.length + " bytes PCM");
      audioChunks.length = 0;
      chunkCount = 0;
      if (pcm.length < MIN_PCM_BYTES) {
        console.error("[relay] whisper-local buffer too small, sending empty");
        sendToClient(clientSocket, {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: ""
        });
        return;
      }
      if (SILENCE_PEAK > 0) {
        const peak = peakAmplitude(pcm);
        if (peak < SILENCE_PEAK) {
          console.error("[relay] whisper-local silence gate: peak " + peak + " < " + SILENCE_PEAK + ", sending empty");
          sendToClient(clientSocket, {
            type: "conversation.item.input_audio_transcription.completed",
            transcript: ""
          });
          return;
        }
      }
      try {
        const prompt = await loadPrompt();
        const raw = await transcribePcm(pcm, SAMPLE_RATE, bin, model, prompt);
        const transcript = sanitizeTranscript(raw);
        if (raw && !transcript) {
          console.error("[relay] whisper-local sanitizer dropped: " + JSON.stringify(raw));
        }
        sendToClient(clientSocket, {
          type: "conversation.item.input_audio_transcription.completed",
          transcript
        });
      } catch (err) {
        console.error("[relay] whisper-local error:", err.message);
        sendToClient(clientSocket, { type: "local.error", message: "whisper-local: " + err.message });
      }
      return;
    }
  });

  clientSocket.on("close", () => {
    audioChunks.length = 0;
  });

  // Warm the server (cached after the first session) and announce readiness.
  // Frames that arrive during this await are already being buffered by the
  // listener above; commit only fires on key-release, long after this resolves.
  try {
    await ensureWhisperServer(bin);
  } catch (err) {
    console.error("[relay] whisper-server boot failed, will use CLI fallback:", err.message);
  }

  if (clientSocket.readyState !== clientSocket.OPEN) return;

  sendToClient(clientSocket, { type: "local.status", status: "connected", provider: "whisper-local", model });
}

/**
 * @param {Buffer} pcmBuffer
 * @param {number} sampleRate
 * @param {string} bin
 * @param {string} model
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function transcribePcm(pcmBuffer, sampleRate, bin, model, prompt) {
  const wav = wrapWav(pcmBuffer, sampleRate);
  const serverUrl = process.env.WHISPER_SERVER_URL;
  const t0 = Date.now();
  if (serverUrl) {
    try {
      const text = await runWhisperServer(serverUrl, wav, prompt);
      console.error("[relay] whisper-local (server) " + (Date.now() - t0) + "ms: " + JSON.stringify(text));
      return text;
    } catch (err) {
      console.error("[relay] whisper-server failed, falling back to CLI:", err.message);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "voice-stt-"));
  const wavPath = join(dir, "input.wav");
  await writeFile(wavPath, wav);
  try {
    const text = await runWhisper(bin, model, wavPath, prompt);
    console.error("[relay] whisper-local (cli) " + (Date.now() - t0) + "ms: " + JSON.stringify(text));
    return text;
  } finally {
    unlink(wavPath).catch(() => {});
  }
}

/**
 * @param {string} url
 * @param {Buffer} wavBuffer
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function runWhisperServer(url, wavBuffer, prompt) {
  const form = new FormData();
  // Node Buffer is structurally a BlobPart, but TS's lib narrows the buffer's
  // underlying type to ArrayBuffer (rejecting SharedArrayBuffer-backed views).
  // Cast through to silence the false positive — Buffer is always non-shared.
  form.append("file", new Blob([/** @type {ArrayBuffer} */ (wavBuffer.buffer)], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  if (prompt) form.append("prompt", prompt);
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("HTTP " + res.status + ": " + body.slice(0, 200));
  }
  const json = await res.json();
  const text = (json.text || "").replace(/\s+/g, " ").trim();
  return text;
}

/**
 * @param {string} bin
 * @param {string} model
 * @param {string} wavPath
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function runWhisper(bin, model, wavPath, prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-m", model,
      "-f", wavPath,
      "-nt",
      "-np",
      "-l", "auto",
      "--no-fallback",
      "-t", "4"
    ];
    if (prompt) args.push("--prompt", prompt);
    const proc = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error("whisper-cli exit " + code + ": " + stderr.slice(0, 300)));
      }
      resolve(stdout.replace(/\s+/g, " ").trim());
    });
  });
}
