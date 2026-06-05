// @ts-check
// Deepgram streaming transcription transport. Selected via ?provider=deepgram.
//
// Translates the OpenAI-shaped browser frames (input_audio_buffer.append /
// .commit) into Deepgram's binary-audio + Finalize protocol, and synthesizes
// the OpenAI-shaped transcription frames back to the browser so the client
// code is provider-agnostic.

import WebSocket from "ws";
import { sendToClient, forwardUnexpectedResponse } from "./_shared.js";
import * as vocab from "../vocab.js";

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
  // smart_format and keyterm prompting used to be English-only; Deepgram now
  // accepts both for nova-3 monolingual languages including hr (handshake
  // verified 2026-06-05 — no HTTP 400).
  params.set("smart_format", "true");
  // Bias toward the user's custom dictionary. nova-3 uses keyterm prompting;
  // older Deepgram models use the keywords param. Each term is appended as a
  // repeated query param. Re-read per connection so freshly-added words apply
  // to the very next dictation.
  try {
    const terms = vocab.deepgramKeyterms();
    const param = /nova-3/i.test(model) ? "keyterm" : "keywords";
    for (const term of terms) params.append(param, term);
  } catch {}
  const dgUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${apiKey}` }
  });

  const finalParts = [];
  let lastInterim = "";
  const queuedBinaries = [];
  let completedSent = false;
  // Set when the browser commits (key released) and we ask Deepgram to flush.
  // Deepgram never sends a message of type "Finalize" back — it marks the
  // flushed result with from_finalize: true on a normal Results frame.
  let finalizeSent = false;
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
      if (text) {
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
      }
      // The flush triggered by our Finalize arrives as a Results frame with
      // from_finalize: true (possibly with an empty transcript). That is the
      // real "everything is transcribed" signal — complete immediately instead
      // of letting the blind timeout fire, which was both slow (~1.5s) and
      // raced the renderer's own fallback, dropping the last words.
      if (finalizeSent && (msg.from_finalize === true || msg.speech_final === true)) {
        emitCompleted();
      }
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
      finalizeSent = true;
      if (dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(JSON.stringify({ type: "Finalize" }));
      }
      // Safety net only — the from_finalize Results frame above is the normal
      // completion path. Long enough that it can't beat a healthy flush.
      setTimeout(emitCompleted, 3000);
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
