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
import { sendToClient } from "./_shared.js";

const SAMPLE_RATE = 24000;
// Anything shorter than this is almost certainly a misfire (the user tapped
// the hotkey rather than holding it). Skip the transcription round-trip and
// return an empty string immediately.
const MIN_PCM_BYTES = 4800; // 0.1s @ 24 kHz mono int16

// Whisper's initial-prompt accepts ~224 tokens (~1000 chars of typical English).
// Anything longer gets silently truncated by the model, so cap it here with a
// console warning rather than blowing the budget on a runaway file.
const MAX_PROMPT_CHARS = 1000;
// Resolve vocab.txt relative to this source file (= projectRoot/models/vocab.txt)
// rather than process.cwd(). Cwd varies by launch method (npm start vs Finder
// double-click vs packaged app), and a relative path would silently miss the
// file from some launchers while working from others — exactly the kind of
// "works on my machine" bug that masquerades as "the dictionary isn't helping."
const __dirname = dirname(fileURLToPath(import.meta.url));
const VOCAB_FILE = join(__dirname, "..", "..", "models", "vocab.txt");

let promptLogged = false;

/**
 * Initial-prompt text used to bias whisper toward custom vocabulary
 * (product names, jargon, people). Resolution order:
 *   1. WHISPER_PROMPT env var (wins if set, even if empty)
 *   2. models/vocab.txt file contents
 *   3. empty string (no bias)
 *
 * Re-read on every commit so editing vocab.txt takes effect without a restart.
 * Logs once per process so operators can confirm vocab is actually loading.
 *
 * @returns {Promise<string>}
 */
async function loadPrompt() {
  let prompt = "";
  let source = "";
  if (typeof process.env.WHISPER_PROMPT === "string") {
    prompt = truncatePrompt(process.env.WHISPER_PROMPT.trim());
    source = "env WHISPER_PROMPT";
  } else {
    try {
      const raw = await readFile(VOCAB_FILE, "utf8");
      // Strip lines that start with '#' so vocab.txt can carry comments.
      const cleaned = raw
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      prompt = truncatePrompt(cleaned);
      source = VOCAB_FILE;
    } catch {
      source = "(none — no env var, no vocab.txt)";
    }
  }
  if (!promptLogged) {
    promptLogged = true;
    console.error("[whisper-local] vocab prompt: " + prompt.length + " chars from " + source);
  }
  return prompt;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncatePrompt(text) {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  console.error("[whisper-local] prompt truncated from " + text.length + " to " + MAX_PROMPT_CHARS + " chars");
  return text.slice(0, MAX_PROMPT_CHARS);
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
function ensureWhisperServer(bin) {
  if (whisperServerReady) return whisperServerReady;

  const serverBin = bin ? bin.replace(/-cli$/, "-server") : "whisper-server";
  const model = process.env.WHISPER_MODEL || "./models/ggml-small.en-q5_1.bin";
  const port = process.env.WHISPER_PORT || "8081";
  const baseUrl = `http://127.0.0.1:${port}`;

  whisperServerReady = (async () => {
    const args = [
      "-m", model,
      "--host", "127.0.0.1",
      "--port", port,
      "-t", "4",
      "--no-fallback"
    ];
    let spawnError = null;
    whisperServerProc = spawn(serverBin, args);
    whisperServerProc.on("error", (err) => {
      spawnError = err;
      console.error("[whisper-server] spawn error:", err.message);
      whisperServerProc = null;
    });
    whisperServerProc.stderr?.on("data", (d) => {
      const s = d.toString();
      if (/error|fail/i.test(s)) console.error("[whisper-server]", s.trim());
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

  try {
    await ensureWhisperServer(bin);
  } catch (err) {
    console.error("[relay] whisper-server boot failed, will use CLI fallback:", err.message);
  }

  if (clientSocket.readyState !== clientSocket.OPEN) return;

  sendToClient(clientSocket, { type: "local.status", status: "connected", provider: "whisper-local", model });

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
      try {
        const prompt = await loadPrompt();
        const transcript = await transcribePcm(pcm, SAMPLE_RATE, bin, model, prompt);
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
 * 44-byte canonical PCM16 WAV header. Mono, 16-bit, caller-supplied rate.
 *
 * @param {Buffer} pcm
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function wrapWav(pcm, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
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
