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

import { spawn, execFileSync } from "node:child_process";
import { writeFile, unlink, mkdtemp, readFile } from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sendToClient, wrapWav } from "./_shared.js";
import { withRetry, httpError } from "../retry.js";

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

// Stock phrases Whisper emits on silence/noise — the YouTube-subtitle artifacts
// it "fills in" when handed audio it can't parse ("thanks for watching",
// "subscribe", "music", …). It produces them in MANY languages (the Turkish
// "Bu kanalıma abone olmayı unutmayın" = "don't forget to subscribe to my
// channel" being a notorious one), so this list is multilingual. Entries are
// stored in the SAME folded-ASCII form normalizeForMatch produces (lowercased,
// diacritics removed, punctuation stripped) so "Hvala!" and "hvala" — and
// "olmayı" and "olmayi" — collapse to one key. Whole-string match only: a real
// sentence that merely starts with one of these is left untouched.
const HALLUCINATION_PHRASES = new Set([
  // English
  "you", "thank you", "thank you very much", "thanks", "thanks for watching",
  "thank you for watching", "thanks for watching everyone", "please subscribe",
  "dont forget to subscribe", "like and subscribe", "subscribe", "bye", "bye bye",
  "goodbye", "okay", "ok", "so", "hello", "hi", "the", "yeah", "uh", "um", "mm",
  "mhm", "i", "co authored by", "subtitles by", "transcription by", "transcribed by",
  "amaraorg", "music", "applause", "silence", "blank audio",
  // Croatian
  "hvala", "hvala vam", "hvala na gledanju", "hvala vam na gledanju",
  "hvala na paznji", "hvala vam na paznji", "ne zaboravite se pretplatiti",
  "pretplatite se", "pretplatite se na moj kanal", "lajkajte i pretplatite se",
  "titlovi", "prijevod", "vidimo se", "bok", "pozdrav",
  // Turkish (the one this user actually hit)
  "bu kanalima abone olmayi unutmayin", "abone olmayi unutmayin",
  "kanalima abone olun", "abone ol", "izlediginiz icin tesekkurler",
  "tesekkurler", "tesekkur ederim",
  // German / Spanish / French / Italian / Portuguese
  "danke", "vielen dank", "danke furs zuschauen", "abonniert",
  "gracias", "gracias por ver", "suscribete",
  "merci", "merci davoir regarde", "abonnez vous",
  "grazie", "grazie per la visione",
  "obrigado", "inscreva se"
]);

// Fold a string to lowercase ASCII for hallucination matching: strip combining
// diacritics (č→c, ž→z, ü→u …) and map the special letters NFD doesn't
// decompose (Turkish dotless ı→i, Croatian đ→d, ł→l, ø→o), then drop anything
// that isn't a letter/digit/space. Cyrillic/CJK fold away entirely (→ empty),
// which is fine — they're caught as empty.
function normalizeForMatch(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/đ/g, "d")
    .replace(/ł/g, "l")
    .replace(/ø/g, "o")
    .replace(/['’']/g, "") // contractions collapse: don't → dont, d'avoir → davoir
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
export function sanitizeTranscript(text) {
  if (!text) return "";
  const stripped = text
    .replace(/\([^()]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  if (HALLUCINATION_PHRASES.has(normalizeForMatch(stripped))) return "";
  return stripped;
}

export { normalizeForMatch };

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
  // Only the hand-curated seed (models/vocab.txt / WHISPER_PROMPT) goes into the
  // initial prompt. The user's dynamic dictionary (words added via the cursor
  // pop-up) is deliberately NOT injected here: whisper's initial_prompt is a
  // bias, so a rare added proper noun ("Unsplash") gets hallucinated onto audio
  // that sounds nothing like it. Those terms are applied AFTER transcription
  // instead — see vocab.correctTranscript, a fuzzy fix that only fires on a
  // genuine near-miss. The seed file stays because it's curated prose written to
  // avoid that trap (see the cautions at the top of models/vocab.txt).
  const combined = raw;
  const truncated = combined.length > MAX_PROMPT_CHARS;
  const prompt = truncated ? combined.slice(0, MAX_PROMPT_CHARS) : combined;
  if (!promptLogged) {
    promptLogged = true;
    const note = truncated ? " (truncated from " + combined.length + ")" : "";
    console.error("[whisper-local] seed prompt: " + prompt.length + " chars from " + source + note);
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
/** Resolved model path the running server was started with (for cache-hit checks). */
let whisperServerModel = null;
// Bumped on every (re)spawn decision. An in-flight start captures this value and
// bails if a newer start supersedes it — otherwise two rapid different-model
// starts each spawn, orphaning the first server (its proc handle is overwritten,
// so nothing reaps it) and racing to publish WHISPER_SERVER_URL last-writer-wins.
let whisperServerGeneration = 0;
let exitHandlerInstalled = false;

// Records the PID of the whisper-server we spawned, so the NEXT app launch can
// clean up a server orphaned by a crash or force-quit (which would otherwise
// linger, hold the GPU/RAM, and — on a fixed port — wedge the next start).
const PID_FILE = join(tmpdir(), "gvoice-whisper-server.pid");

/** Does this PID exist? (signal 0 probes without killing.) */
function isAlive(/** @type {number} */ pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** True only if `pid` is genuinely a whisper-server — so we never kill an
 *  unrelated process that happens to have inherited a recycled PID. */
function isOurWhisperServer(/** @type {number} */ pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
      return /whisper-server/i.test(out);
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /whisper-server/i.test(out);
  } catch {
    return false;
  }
}

/** Kill a whisper-server left behind by a previous run (best-effort). Only ever
 *  touches a PID we wrote AND that still looks like our server. */
async function reapStaleServer() {
  let pid = 0;
  try {
    if (existsSync(PID_FILE)) pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {}
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
  if (!(pid > 0) || !isAlive(pid) || !isOurWhisperServer(pid)) return;
  console.error("[whisper-server] reaping stale server from a previous run, pid=" + pid);
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 20 && isAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
}

/** Ask the OS for a free TCP port on loopback. Using a fresh port each launch
 *  means a leftover server (or anything else) on the old port can never block
 *  startup. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Lazily spawn the whisper.cpp `whisper-server` binary on first attach.
 * Resolves once the server is responding on the configured port. On failure,
 * resets so the next attach() can retry.
 *
 * @param {string} [bin]
 * @returns {Promise<void>}
 */
// Tear the whisper-server down. SIGTERM first (clean), then SIGKILL shortly
// after if it ignores it, so closing the app never leaves the model resident.
// Synchronous-safe: callable from app 'before-quit' and process exit handlers.
export function stopWhisperServer() {
  const proc = whisperServerProc;
  whisperServerProc = null;
  whisperServerReady = null;
  whisperServerModel = null;
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
  if (!proc || proc.killed || proc.pid == null) return;
  const pid = proc.pid;
  try { proc.kill("SIGTERM"); } catch {}
  // Escalate if it's still around after a short grace period.
  setTimeout(() => { if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }, 1500).unref?.();
}

export function ensureWhisperServer(bin, modelPath) {
  // Replace the trailing "-cli" (with optional .exe suffix on Windows) with
  // "-server". Previous regex (/-cli$/) missed the .exe case and ended up
  // spawning whisper-cli.exe with server-style flags, which printed help and
  // exited.
  const serverBin = bin ? bin.replace(/-cli(\.exe)?$/i, "-server$1") : "whisper-server";
  // Same resolution order as the CLI fallback gets via attach(), so the server
  // and CLI can never run different models. The last-resort default is
  // resolved against this file, not cwd (which varies by launch method).
  const model = modelPath || process.env.WHISPER_MODEL || join(__dirname, "..", "..", "models", "ggml-small.en-q5_1.bin");
  // Normalize before comparing: "./models/x" and an absolute "<root>/models/x"
  // name the same file, so a naive string compare would respawn spuriously.
  const resolvedModel = resolve(model);

  // Reuse the warm server only if it's running the SAME model. A model switch
  // (Settings "Use on-device" with a different model, or a benchmark on another
  // model) must respawn — otherwise the cached promise would keep serving the
  // old model and dictation would silently transcribe with the wrong one.
  if (whisperServerReady) {
    if (whisperServerModel === resolvedModel) return whisperServerReady;
    stopWhisperServer();
  }
  whisperServerModel = resolvedModel;
  const myGeneration = ++whisperServerGeneration;

  whisperServerReady = (async () => {
    // Clean up a server orphaned by a previous crash/force-quit, then take a
    // fresh free port so nothing left on the old port can wedge this start.
    await reapStaleServer();
    // A newer start arrived while we awaited above (rapid model switch / an
    // overlapping benchmark): stop here. Spawning now would overwrite
    // whisperServerProc and leave that newer server's process unreaped.
    if (myGeneration !== whisperServerGeneration) {
      throw new Error("whisper-server start superseded before spawn");
    }
    const port = process.env.WHISPER_PORT || String(await getFreePort());
    const baseUrl = `http://127.0.0.1:${port}`;
    const args = [
      // Spawn on the resolved (absolute) path — the same value we keyed the
      // cache on — so the -m arg never depends on the child's cwd.
      "-m", resolvedModel,
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
    // Remember this server so the next launch can reap it if we die uncleanly.
    if (whisperServerProc.pid != null) {
      try { writeFileSync(PID_FILE, String(whisperServerProc.pid)); } catch {}
    }
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
    const thisProc = whisperServerProc;
    whisperServerProc.on("exit", (code) => {
      console.error("[whisper-server] exited with code " + code);
      // Only reset shared state if WE are still the current server — a late
      // exit from an already-replaced (or already-stopped) child must not
      // clobber its successor's state.
      if (whisperServerProc === thisProc) {
        whisperServerProc = null;
        // A crash must not leave the cached ready-promise pointing at a dead
        // port: ensureWhisperServer would return it forever and every later
        // dictation would limp through the slow CLI fallback until an app
        // restart. Reset so the next dictation respawns the server.
        whisperServerReady = null;
        delete process.env.WHISPER_SERVER_URL;
        // Our server is gone — drop the stale-PID marker so a future launch
        // never mistakes a recycled PID for it.
        try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
      }
    });

    if (!exitHandlerInstalled) {
      exitHandlerInstalled = true;
      // Last-ditch teardown if the app exits without calling stopWhisperServer
      // (e.g. an uncaught error). Best-effort and synchronous.
      process.on("exit", () => {
        if (whisperServerProc) {
          try { whisperServerProc.kill("SIGKILL"); } catch {}
        }
        try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
      });
    }

    await waitForServer(baseUrl, 10000, () => spawnError || (whisperServerProc === null ? new Error("whisper-server died before ready") : null));
    // Superseded while we were booting: don't publish our URL (it would clobber
    // the newer start's, last-writer-wins) and kill our own process so it can't
    // linger as an orphan on its port.
    if (myGeneration !== whisperServerGeneration) {
      try { thisProc.kill("SIGKILL"); } catch {}
      throw new Error("whisper-server start superseded after spawn");
    }
    // Publish the URL only once the server actually answers: a commit landing
    // during the boot window would otherwise POST at a dead port, burn the
    // retry, and drop to the slow CLI even though the server was seconds away.
    process.env.WHISPER_SERVER_URL = `${baseUrl}/inference`;
    console.error("[whisper-server] ready at " + process.env.WHISPER_SERVER_URL);
  })();

  const thisReady = whisperServerReady;
  thisReady.catch(() => {
    // Reset so a later attach() can retry instead of inheriting the failure,
    // and make sure no half-published URL points at a server that never came
    // up. Guarded: a slow failure must not clobber a successor's boot.
    if (whisperServerReady === thisReady) {
      whisperServerReady = null;
      delete process.env.WHISPER_SERVER_URL;
    }
  });

  return thisReady;
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
        // Dictation is English-only (main.js locks process.env.WHISPER_LANGUAGE
        // to "en" at load), so default to English here too rather than "auto" —
        // the provider defends the invariant itself instead of trusting a single
        // env assignment in main.js.
        const language = (process.env.WHISPER_LANGUAGE || "en").toLowerCase();
        const raw = await transcribePcm(pcm, SAMPLE_RATE, bin, model, prompt, language);
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
    await ensureWhisperServer(bin, model);
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
 * @param {string} [language] "auto" (detect), or an ISO code like "hr" / "en"
 * @returns {Promise<string>}
 */
async function transcribePcm(pcmBuffer, sampleRate, bin, model, prompt, language = "auto") {
  const wav = wrapWav(pcmBuffer, sampleRate);
  const serverUrl = process.env.WHISPER_SERVER_URL;
  const t0 = Date.now();
  // "auto"/"multi" means detect — but constrained to hr/en only, so a wrong-
  // language hallucination (the Turkish "subscribe" artifact) can't appear.
  const autoHrEn = language === "auto" || language === "multi";
  if (serverUrl) {
    try {
      const text = autoHrEn
        ? await transcribeHrEn(serverUrl, wav, prompt)
        : (await runWhisperServer(serverUrl, wav, prompt, language)).text;
      console.error("[relay] whisper-local (server) " + (Date.now() - t0) + "ms [" + language + "]: " + JSON.stringify(text));
      return text;
    } catch (err) {
      console.error("[relay] whisper-server failed, falling back to CLI:", err.message);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "voice-stt-"));
  const wavPath = join(dir, "input.wav");
  await writeFile(wavPath, wav);
  try {
    const text = await runWhisper(bin, model, wavPath, prompt, language);
    console.error("[relay] whisper-local (cli) " + (Date.now() - t0) + "ms [" + language + "]: " + JSON.stringify(text));
    return text;
  } finally {
    unlink(wavPath).catch(() => {});
  }
}

/**
 * @param {string} url
 * @param {Buffer} wavBuffer
 * @param {string} prompt
 * @param {string} [language] "auto" (whisper detects) or an ISO code like "hr"
 * @returns {Promise<{ text: string, confidence: number, language: string }>}
 */
async function runWhisperServer(url, wavBuffer, prompt, language = "auto") {
  const form = new FormData();
  // The Buffer itself (a Uint8Array view) — never its underlying ArrayBuffer,
  // which ignores byteOffset/byteLength and could ship pool garbage around
  // the WAV if the allocation ever lands in Buffer's shared pool.
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
  // verbose_json carries per-segment avg_logprob, which we average into a single
  // confidence so the hr/en picker can choose the more confident transcript.
  form.append("response_format", "verbose_json");
  form.append("temperature", "0.0");
  // Without this, whisper-server defaults to English and mis-decodes other
  // languages. "auto" enables its built-in language detection.
  form.append("language", language || "auto");
  if (prompt) form.append("prompt", prompt);
  // One retry on a transient failure (a dropped connection during the POST, or a
  // 5xx while the server is briefly busy) before the caller falls back to the
  // slower CLI path. A clean 4xx is not retried — it would just fail again.
  const json = await withRetry(
    async () => {
      // Cap the inference call: a wedged server (GPU hang) would otherwise pin
      // the dictation until the renderer's 20s watchdog. A TimeoutError is NOT
      // retried (see retry.js isRetryableError), so the caller falls to the
      // CLI path after at most one 15s wait.
      const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw httpError(res.status, body.slice(0, 200));
      }
      return res.json();
    },
    {
      retries: 1,
      onRetry: (err) => console.error("[relay] whisper-server transient failure, retrying once:", err && err.message)
    }
  );
  const text = (json.text || "").replace(/\s+/g, " ").trim();
  return { text, confidence: avgLogprob(json.segments), language: json.language || language };
}

/** Mean avg_logprob across whisper segments (closer to 0 = more confident).
 *  Empty/missing → a very low score so an empty leg never wins a tie. */
function avgLogprob(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return -10;
  let sum = 0;
  let count = 0;
  for (const seg of segments) {
    if (seg && typeof seg.avg_logprob === "number") { sum += seg.avg_logprob; count += 1; }
  }
  return count ? sum / count : -10;
}

/**
 * Pick the better of the two forced-language transcription legs. Pure logic,
 * exported for unit tests. Either leg may be null (that request failed).
 *
 * Order of preference:
 *  1. A leg that survives the hallucination sanitizer beats one that doesn't
 *     (a junk "thanks for watching" leg loses to a real sentence).
 *  2. Otherwise higher confidence (mean avg_logprob) wins. This is what picks
 *     the right LANGUAGE: forcing the wrong language onto real speech yields
 *     garbled-but-real-looking text that PASSES the sanitizer, so a
 *     first-leg-back-wins shortcut would type Croatian speech as English
 *     garble. Confidence is the only signal that separates them — both legs
 *     must be waited for. (Tried and reverted: whisper-server serializes
 *     inference, so the EN leg, posted first, nearly always finished first.)
 *
 * @param {{ text: string, confidence: number, language: string } | null} en
 * @param {{ text: string, confidence: number, language: string } | null} hr
 * @returns {{ text: string, confidence: number, language: string } | null}
 */
export function pickTranscript(en, hr) {
  if (!en && !hr) return null;
  if (!en) return hr;
  if (!hr) return en;
  const enClean = sanitizeTranscript(en.text);
  const hrClean = sanitizeTranscript(hr.text);
  if (enClean && !hrClean) return en;
  if (hrClean && !enClean) return hr;
  return en.confidence >= hr.confidence ? en : hr;
}

/**
 * Constrain whisper's language guess to ENGLISH or CROATIAN only: transcribe the
 * clip forced to each (in parallel), then keep the better one — see
 * pickTranscript. This makes a stray Turkish (or any other-language)
 * hallucination structurally impossible — neither leg can produce it — and
 * mirrors how the Deepgram provider runs parallel hr/en legs.
 *
 * One leg failing (a dropped connection that survives the retry) doesn't kill
 * the dictation: the surviving leg's transcript is used. Only when BOTH legs
 * fail does this throw, letting the caller fall back to the CLI path.
 *
 * @param {string} url @param {Buffer} wav @param {string} prompt
 * @returns {Promise<string>}
 */
async function transcribeHrEn(url, wav, prompt) {
  const [enResult, hrResult] = await Promise.allSettled([
    runWhisperServer(url, wav, prompt, "en"),
    runWhisperServer(url, wav, prompt, "hr")
  ]);
  const en = enResult.status === "fulfilled" ? enResult.value : null;
  const hr = hrResult.status === "fulfilled" ? hrResult.value : null;
  const pick = pickTranscript(en, hr);
  if (!pick) {
    throw enResult.status === "rejected" ? enResult.reason : new Error("both hr/en legs failed");
  }
  if (!en || !hr) {
    const dead = !en ? enResult : hrResult;
    const reason = dead.status === "rejected" && dead.reason ? dead.reason.message : "unknown";
    console.error(`[relay] whisper hr/en one leg failed (${!en ? "en" : "hr"}: ${reason}), using the other`);
  }
  console.error(`[relay] whisper hr/en pick=${pick.language} (en:${en ? "conf=" + en.confidence.toFixed(2) : "failed"} hr:${hr ? "conf=" + hr.confidence.toFixed(2) : "failed"})`);
  return pick.text;
}

/**
 * @param {string} bin
 * @param {string} model
 * @param {string} wavPath
 * @param {string} prompt
 * @param {string} [language] "auto" (detect) or an ISO code like "hr" / "en"
 * @returns {Promise<string>}
 */
function runWhisper(bin, model, wavPath, prompt, language = "auto") {
  return new Promise((resolve, reject) => {
    const args = [
      "-m", model,
      "-f", wavPath,
      "-nt",
      "-np",
      "-l", language || "auto",
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
