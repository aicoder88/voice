import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultInstructions =
  "You are a warm, emotionally aware realtime voice companion. Be natural, friendly, honest, lightly witty, and easy to interrupt. Listen for tone and context, avoid empty praise, and keep spoken replies conversational unless the user wants depth.";

export function attachRealtimeRelay(server, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
    path = "/realtime",
    instructions = defaultInstructions,
    deepgramApiKey = process.env.DEEPGRAM_API_KEY,
    deepgramModel = process.env.DEEPGRAM_MODEL || "nova-3",
    whisperBin = process.env.WHISPER_CLI || "whisper-cli",
    whisperModel = process.env.WHISPER_MODEL || "./models/ggml-base.en.bin",
    defaultProvider = process.env.STT_PROVIDER || "openai"
  } = options;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Create a .env file from .env.example first.");
  }

  const browserSockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname !== path) return;
    browserSockets.handleUpgrade(request, socket, head, (clientSocket) => {
      browserSockets.emit("connection", clientSocket, request);
    });
  });

  browserSockets.on("connection", (clientSocket, request) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const provider = (requestUrl.searchParams.get("provider") || defaultProvider).toLowerCase();

    if (provider === "deepgram") {
      if (!deepgramApiKey) {
        sendToClient(clientSocket, { type: "local.error", message: "Missing DEEPGRAM_API_KEY in .env" });
        clientSocket.close();
        return;
      }
      attachDeepgram(clientSocket, { apiKey: deepgramApiKey, model: deepgramModel });
      return;
    }

    if (provider === "whisper-local" || provider === "local") {
      attachWhisperLocal(clientSocket, { bin: whisperBin, model: whisperModel });
      return;
    }

    attachOpenAI(clientSocket, requestUrl, { apiKey, model, instructions });
  });

  return {
    path,
    close: () => browserSockets.close()
  };
}

function attachOpenAI(clientSocket, requestUrl, { apiKey, model, instructions }) {
  const requestedModel = requestUrl.searchParams.get("model");
  const transcriptionOnlyModels = new Set(["gpt-realtime-whisper", "gpt-realtime-translate"]);
  const isTranscribeOnly = transcriptionOnlyModels.has(requestedModel);
  const transcriptionModel = isTranscribeOnly ? requestedModel : null;
  const sessionModel = isTranscribeOnly ? "gpt-realtime-2" : (requestedModel || model);
  const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(sessionModel)}`;
  const openaiSocket = new WebSocket(realtimeUrl, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  const queuedMessages = [];

  openaiSocket.on("open", () => {
    sendToClient(clientSocket, { type: "local.status", status: "connected", model: sessionModel, provider: "openai" });
    const sessionPayload = isTranscribeOnly
      ? {
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                turn_detection: null,
                transcription: { model: transcriptionModel }
              }
            }
          }
        }
      : {
          type: "session.update",
          session: {
            type: "realtime",
            instructions,
            audio: {
              input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "server_vad" } },
              output: { format: { type: "audio/pcm", rate: 24000 } }
            }
          }
        };
    openaiSocket.send(JSON.stringify(sessionPayload));
    while (queuedMessages.length > 0) openaiSocket.send(queuedMessages.shift());
  });

  openaiSocket.on("message", (message) => {
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(message.toString());
  });

  openaiSocket.on("error", (error) => {
    console.error("[relay] openai socket error:", error.message);
    sendToClient(clientSocket, { type: "local.error", message: error.message });
  });

  openaiSocket.on("close", (code, reason) => {
    console.error("[relay] openai socket closed code=" + code + " reason=" + reason.toString());
    sendToClient(clientSocket, { type: "local.status", status: "closed", code, reason: reason.toString() });
    clientSocket.close();
  });

  openaiSocket.on("unexpected-response", (_req, res) => {
    console.error("[relay] openai unexpected-response status=" + res.statusCode);
    let body = "";
    res.on("data", (chunk) => { body += chunk.toString(); });
    res.on("end", () => console.error("[relay] openai response body:", body.slice(0, 500)));
  });

  clientSocket.on("message", (message) => {
    const payload = message.toString();
    if (openaiSocket.readyState === WebSocket.OPEN) {
      openaiSocket.send(payload);
      return;
    }
    queuedMessages.push(payload);
  });

  clientSocket.on("close", () => openaiSocket.close());
}

function attachDeepgram(clientSocket, { apiKey, model }) {
  const params = new URLSearchParams({
    model,
    language: "multi",
    encoding: "linear16",
    sample_rate: "24000",
    channels: "1",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "false",
    vad_events: "false"
  });
  const dgUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${apiKey}` }
  });

  const finalParts = [];
  let lastInterim = "";
  const queuedBinaries = [];
  let completedSent = false;
  function emitCompleted() {
    if (completedSent) return;
    completedSent = true;
    const finalsText = finalParts.join(" ").replace(/\s+/g, " ").trim();
    const transcript = finalsText || lastInterim.trim();
    sendToClient(clientSocket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript
    });
  }

  dgSocket.on("open", () => {
    console.error("[relay] deepgram connected model=" + model);
    sendToClient(clientSocket, { type: "local.status", status: "connected", provider: "deepgram", model });
    while (queuedBinaries.length > 0) dgSocket.send(queuedBinaries.shift());
  });

  dgSocket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "Results") {
      const alt = msg.channel?.alternatives?.[0];
      const text = alt?.transcript || "";
      if (!text) return;
      if (msg.is_final) {
        finalParts.push(text);
        lastInterim = "";
        sendToClient(clientSocket, {
          type: "conversation.item.input_audio_transcription.delta",
          delta: text + " "
        });
      } else {
        lastInterim = text;
      }
      return;
    }

    if (msg.type === "Finalize") {
      emitCompleted();
      return;
    }
    if (msg.type === "UtteranceEnd") {
      return;
    }

    if (msg.type === "Metadata") return;
    if (msg.type === "SpeechStarted") return;
  });

  dgSocket.on("error", (error) => {
    console.error("[relay] deepgram error:", error.message);
    sendToClient(clientSocket, { type: "local.error", message: "Deepgram: " + error.message });
  });

  dgSocket.on("close", (code, reason) => {
    console.error("[relay] deepgram closed code=" + code + " reason=" + reason.toString());
    emitCompleted();
    sendToClient(clientSocket, { type: "local.status", status: "closed", code });
    clientSocket.close();
  });

  dgSocket.on("unexpected-response", (_req, res) => {
    console.error("[relay] deepgram unexpected-response status=" + res.statusCode);
    let body = "";
    res.on("data", (chunk) => { body += chunk.toString(); });
    res.on("end", () => console.error("[relay] deepgram response body:", body.slice(0, 500)));
  });

  clientSocket.on("message", (message) => {
    const payload = message.toString();
    let parsed;
    try { parsed = JSON.parse(payload); } catch {
      forwardBinary(payload);
      return;
    }

    if (parsed.type === "input_audio_buffer.append" && typeof parsed.audio === "string") {
      const buf = Buffer.from(parsed.audio, "base64");
      forwardBinary(buf);
      return;
    }

    if (parsed.type === "input_audio_buffer.commit") {
      if (dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(JSON.stringify({ type: "Finalize" }));
      }
      setTimeout(emitCompleted, 1500);
      return;
    }
  });

  function forwardBinary(buf) {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(buf);
    } else {
      queuedBinaries.push(buf);
    }
  }

  clientSocket.on("close", () => {
    try {
      if (dgSocket.readyState === WebSocket.OPEN) dgSocket.send(JSON.stringify({ type: "CloseStream" }));
    } catch {}
    setTimeout(() => { try { dgSocket.close(); } catch {} }, 200);
  });
}

function attachWhisperLocal(clientSocket, { bin, model }) {
  const SAMPLE_RATE = 24000;
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
      if (pcm.length < 4800) {
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

function sendToClient(socket, event) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}
