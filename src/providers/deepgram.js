// @ts-check
// Deepgram streaming transcription transport. Selected via ?provider=deepgram.
//
// Translates the OpenAI-shaped browser frames (input_audio_buffer.append /
// .commit) into Deepgram's binary-audio + Finalize protocol, and synthesizes
// the OpenAI-shaped transcription frames back to the browser so the client
// code is provider-agnostic.

import WebSocket from "ws";
import { sendToClient, forwardUnexpectedResponse } from "./_shared.js";

/**
 * @param {WebSocket} clientSocket
 * @param {{ apiKey: string, model: string, language?: string }} opts
 */
export function attach(clientSocket, { apiKey, model, language }) {
  // Re-read env on every connection so a runtime toggle (Right-Ctrl tap in
  // main.js) takes effect on the next dictation without a server restart.
  const lang = (language || process.env.WHISPER_LANGUAGE || "hr").toLowerCase();
  const params = new URLSearchParams({
    model,
    language: lang,
    encoding: "linear16",
    sample_rate: "24000",
    channels: "1",
    punctuate: "true",
    interim_results: "true",
    endpointing: "false",
    vad_events: "false"
  });
  // smart_format is English-only on Deepgram. Adding it with language=hr (or
  // any other non-English) returns HTTP 400 at the WS handshake.
  if (lang === "en" || lang === "en-us" || lang === "en-gb") {
    params.set("smart_format", "true");
  }
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

  forwardUnexpectedResponse(dgSocket, clientSocket, "deepgram");

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
