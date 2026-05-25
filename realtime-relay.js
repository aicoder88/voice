// /realtime WebSocket relay. Routes incoming browser connections to one of
// the per-provider modules under src/providers/. See docs/RELAY_PROTOCOL.md
// for the wire contract every provider must honor.

import { WebSocketServer } from "ws";
import { sendToClient } from "./src/providers/_shared.js";
import { attach as attachOpenAI } from "./src/providers/openai.js";
import { attach as attachDeepgram } from "./src/providers/deepgram.js";
import { attach as attachWhisperLocal } from "./src/providers/whisper-local.js";

// Re-exported so the public import path stays
//   import { TRANSCRIPTION_ONLY_MODELS } from "./realtime-relay.js"
// even though the data definition now lives in providers/_shared.js.
export { TRANSCRIPTION_ONLY_MODELS } from "./src/providers/_shared.js";

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
