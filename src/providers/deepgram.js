// @ts-check
// Deepgram streaming transcription transport. Selected via ?provider=deepgram.
//
// Translates the OpenAI-shaped browser frames (input_audio_buffer.append /
// .commit) into Deepgram's binary-audio + Finalize protocol, and synthesizes
// the OpenAI-shaped transcription frames back to the browser so the client
// code is provider-agnostic.
//
// Language auto-detect: Deepgram streaming has no language detection for
// Croatian (nova-3 "multi" covers ~10 languages, hr not among them; the
// detect_language feature is batch-only). So language "auto" runs one
// streaming connection ("leg") per candidate language in parallel on the same
// audio and keeps the transcript Deepgram was more confident about. Legs run
// simultaneously, so latency is unchanged; per-clip cost doubles (pennies).

import WebSocket from "ws";
import { sendToClient, forwardUnexpectedResponse } from "./_shared.js";
import * as vocab from "../vocab.js";

const AUTO_LANGUAGES = ["hr", "en"];

/**
 * @param {WebSocket} clientSocket
 * @param {{ apiKey: string, model: string, language?: string }} opts
 */
export function attach(clientSocket, { apiKey, model, language }) {
  // Re-read env on every connection so a runtime toggle (Right-Ctrl tap in
  // main.js) takes effect on the next dictation without a server restart.
  const lang = (language || process.env.WHISPER_LANGUAGE || "auto").toLowerCase();
  const langs = lang === "auto" || lang === "multi" ? AUTO_LANGUAGES : [lang];
  const multiLeg = langs.length > 1;

  let completedSent = false;
  // Set when the browser commits (key released) and we ask Deepgram to flush.
  // Deepgram never sends a message of type "Finalize" back — it marks the
  // flushed result with from_finalize: true on a normal Results frame.
  let finalizeSent = false;

  function legUrl(/** @type {string} */ legLang) {
    const params = new URLSearchParams({
      model,
      language: legLang,
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
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  // One leg = one Deepgram connection transcribing in one language.
  function makeLeg(/** @type {string} */ legLang) {
    const dgSocket = new WebSocket(legUrl(legLang), {
      headers: { Authorization: `Token ${apiKey}` }
    });
    const leg = {
      lang: legLang,
      dgSocket,
      finalParts: /** @type {string[]} */ ([]),
      lastInterim: "",
      queuedBinaries: /** @type {(Buffer | string)[]} */ ([]),
      // Confidence-weighted word counts for the winner pick: Σ(conf·words)/Σwords.
      confWeighted: 0,
      confWords: 0,
      flushed: false
    };

    dgSocket.on("open", () => {
      console.error("[relay] deepgram connected model=" + model + " lang=" + legLang);
      sendToClient(clientSocket, { type: "local.status", status: "connected", provider: "deepgram", model });
      while (leg.queuedBinaries.length > 0) dgSocket.send(leg.queuedBinaries.shift());
    });

    dgSocket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "Results") {
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript || "";
        if (text) {
          if (msg.is_final) {
            leg.finalParts.push(text);
            leg.lastInterim = "";
            const words = text.split(/\s+/).length;
            const conf = typeof alt.confidence === "number" ? alt.confidence : 0;
            leg.confWeighted += conf * words;
            leg.confWords += words;
            // Deltas exist only as the renderer's last-resort fallback text.
            // With parallel legs they'd interleave two languages, so only the
            // single-leg mode streams them.
            if (!multiLeg) {
              sendToClient(clientSocket, {
                type: "conversation.item.input_audio_transcription.delta",
                delta: text + " "
              });
            }
          } else {
            leg.lastInterim = text;
          }
        }
        // The flush triggered by our Finalize arrives as a Results frame with
        // from_finalize: true (possibly with an empty transcript). That is the
        // real "everything is transcribed" signal — complete as soon as every
        // leg has flushed instead of letting a blind timeout fire.
        if (finalizeSent && (msg.from_finalize === true || msg.speech_final === true)) {
          leg.flushed = true;
          if (legs.every((l) => l.flushed)) emitCompleted("from_finalize");
        }
        return;
      }
      if (msg.type === "UtteranceEnd") return;
      if (msg.type === "Metadata") return;
      if (msg.type === "SpeechStarted") return;
    });

    dgSocket.on("error", (error) => {
      console.error("[relay] deepgram error (" + legLang + "):", error.message);
      // A dead leg must not block completion forever; mark it flushed so the
      // surviving leg's flush can complete the utterance.
      leg.flushed = true;
      if (multiLeg && legs.some((l) => !l.flushed || l.transcriptText())) {
        if (finalizeSent && legs.every((l) => l.flushed)) emitCompleted("leg_error");
        return;
      }
      sendToClient(clientSocket, { type: "local.error", message: "Deepgram: " + error.message });
    });

    dgSocket.on("close", (code, reason) => {
      console.error("[relay] deepgram closed lang=" + legLang + " code=" + code + " reason=" + reason.toString());
      leg.flushed = true;
      if (legs.every((l) => l.flushed)) emitCompleted("socket_close");
      if (legs.every((l) => l.dgSocket.readyState === WebSocket.CLOSED || l.dgSocket.readyState === WebSocket.CLOSING)) {
        sendToClient(clientSocket, { type: "local.status", status: "closed", code });
        clientSocket.close();
      }
    });

    forwardUnexpectedResponse(dgSocket, clientSocket, "deepgram");

    leg.transcriptText = function () {
      const finalsText = this.finalParts.join(" ").replace(/\s+/g, " ").trim();
      return finalsText || this.lastInterim.trim();
    };
    leg.confidence = function () {
      return this.confWords > 0 ? this.confWeighted / this.confWords : 0;
    };

    return leg;
  }

  const legs = langs.map(makeLeg);

  function emitCompleted(/** @type {string} */ reason = "unknown") {
    if (completedSent) return;
    completedSent = true;
    // Winner: the leg with the highest confidence that actually heard words.
    let best = legs[0];
    for (const leg of legs) {
      const a = leg.transcriptText() ? leg.confidence() : -1;
      const b = best.transcriptText() ? best.confidence() : -1;
      if (a > b) best = leg;
    }
    // Always log the per-leg outcome (not just in multi-leg auto mode) so a
    // dictation that completed with nothing is diagnosable instead of a mystery
    // blank. Each leg reports how many words it heard and at what confidence.
    const legSummary = legs
      .map((l) => `${l.lang}:words=${l.confWords},conf=${l.confidence().toFixed(3)},len=${l.transcriptText().length}`)
      .join(" ");
    const winnerText = best.transcriptText();
    if (!winnerText) {
      // Every leg came back empty — the single most useful thing to surface when
      // chasing "I dictated and nothing happened" (silence, mic gain, or both
      // auto-language legs genuinely hearing nothing).
      console.error(`[relay] deepgram ALL EMPTY (reason=${reason}, multiLeg=${multiLeg}) ${legSummary}`);
    } else {
      console.error(`[relay] deepgram complete pick=${best.lang} (reason=${reason}) ${legSummary}`);
    }
    sendToClient(clientSocket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: winnerText,
      language: best.lang
    });
  }

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
      for (const leg of legs) {
        if (leg.dgSocket.readyState === WebSocket.OPEN) {
          leg.dgSocket.send(JSON.stringify({ type: "Finalize" }));
        } else {
          leg.flushed = true; // never connected — don't wait on it
        }
      }
      // Safety net only — the from_finalize Results frames above are the
      // normal completion path. Long enough that it can't beat a healthy flush.
      // If THIS is what completes the utterance, the flush never came back —
      // worth seeing in the log (reason=safety_timeout).
      setTimeout(() => emitCompleted("safety_timeout"), 3000);
      return;
    }
  });

  function forwardBinary(/** @type {Buffer | string} */ buf) {
    for (const leg of legs) {
      if (leg.dgSocket.readyState === WebSocket.OPEN) {
        leg.dgSocket.send(buf);
      } else {
        leg.queuedBinaries.push(buf);
      }
    }
  }

  clientSocket.on("close", () => {
    for (const leg of legs) {
      try {
        if (leg.dgSocket.readyState === WebSocket.OPEN) leg.dgSocket.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      setTimeout(() => { try { leg.dgSocket.close(); } catch {} }, 200);
    }
  });
}
