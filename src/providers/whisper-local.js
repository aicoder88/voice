// Local whisper.cpp transport. Selected via ?provider=whisper-local (alias:
// local). No upstream WebSocket — instead, accumulates PCM in memory until
// the browser commits, then either POSTs a WAV to a long-running
// whisper-server (if WHISPER_SERVER_URL is set; ~10–100x faster) or shells
// out to whisper-cli on a tempfile (fallback).

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendToClient } from "./_shared.js";

const SAMPLE_RATE = 24000;
// Anything shorter than this is almost certainly a misfire (the user tapped
// the hotkey rather than holding it). Skip the transcription round-trip and
// return an empty string immediately.
const MIN_PCM_BYTES = 4800; // 0.1s @ 24 kHz mono int16

export function attach(clientSocket, { bin, model }) {
  const audioChunks = [];
  let chunkCount = 0;

  console.error("[relay] whisper-local session opened");
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
        const transcript = await transcribePcm(pcm, SAMPLE_RATE, bin, model);
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

async function transcribePcm(pcmBuffer, sampleRate, bin, model) {
  const wav = wrapWav(pcmBuffer, sampleRate);
  const serverUrl = process.env.WHISPER_SERVER_URL;
  const t0 = Date.now();
  if (serverUrl) {
    try {
      const text = await runWhisperServer(serverUrl, wav);
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
    const text = await runWhisper(bin, model, wavPath);
    console.error("[relay] whisper-local (cli) " + (Date.now() - t0) + "ms: " + JSON.stringify(text));
    return text;
  } finally {
    unlink(wavPath).catch(() => {});
  }
}

async function runWhisperServer(url, wavBuffer) {
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("HTTP " + res.status + ": " + body.slice(0, 200));
  }
  const json = await res.json();
  const text = (json.text || "").replace(/\s+/g, " ").trim();
  return text;
}

// 44-byte canonical PCM16 WAV header. Mono, 16-bit, caller-supplied rate.
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

function runWhisper(bin, model, wavPath) {
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
