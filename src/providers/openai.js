// @ts-check
// OpenAI Realtime API transport. The relay routes here for any /realtime
// connection that does not request a different provider via ?provider=.
//
// Two modes, picked by the ?model= query param:
// - transcription-only (gpt-realtime-whisper, gpt-realtime-translate): runs
//   the underlying session on gpt-realtime-2 but with input audio only and
//   transcription.model set to the requested model.
// - conversational (default): both input and output audio, server VAD,
//   default instructions.
//
// Every other client→relay frame is passed through to OpenAI as-is. Every
// OpenAI→client frame is passed through to the browser as-is. Frames the
// browser sends before the upstream is open are queued and flushed on open.

import WebSocket from "ws";
import { sendToClient, TRANSCRIPTION_ONLY_MODELS, forwardUnexpectedResponse } from "./_shared.js";
import * as vocab from "../vocab.js";

/**
 * @param {WebSocket} clientSocket
 * @param {URL} requestUrl
 * @param {{ apiKey: string, model: string, instructions: string }} opts
 */
export function attach(clientSocket, requestUrl, { apiKey, model, instructions }) {
  const requestedModel = requestUrl.searchParams.get("model");
  const isTranscribeOnly = TRANSCRIPTION_ONLY_MODELS.has(requestedModel);
  const transcriptionModel = isTranscribeOnly ? requestedModel : null;
  const sessionModel = isTranscribeOnly ? "gpt-realtime-2" : (requestedModel || model);
  const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(sessionModel)}`;
  const openaiSocket = new WebSocket(realtimeUrl, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  const queuedMessages = [];

  openaiSocket.on("open", () => {
    sendToClient(clientSocket, { type: "local.status", status: "connected", model: sessionModel, provider: "openai" });
    // Bias the transcription model toward the user's custom dictionary, if any.
    let vocabPrompt = "";
    try { vocabPrompt = vocab.openaiPromptAddition(); } catch {}
    const transcription = vocabPrompt
      ? { model: transcriptionModel, prompt: vocabPrompt }
      : { model: transcriptionModel };
    const sessionPayload = isTranscribeOnly
      ? {
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                turn_detection: null,
                transcription
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

  forwardUnexpectedResponse(openaiSocket, clientSocket, "openai");

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
