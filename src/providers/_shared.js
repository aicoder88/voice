// @ts-check
// Shared helpers for the relay providers.
// Underscore prefix marks this as an internal module — not part of the public
// API of realtime-relay.js. See docs/RELAY_PROTOCOL.md for the wire contract
// these helpers enforce.

import WebSocket from "ws";

// Realtime models that switch the OpenAI session into transcription-only
// shape (no output audio, no turn detection). Source of truth — do not
// duplicate. Re-exported by realtime-relay.js so the public import path
// stays `import { TRANSCRIPTION_ONLY_MODELS } from "<repo>/realtime-relay.js"`.
export const TRANSCRIPTION_ONLY_MODELS = new Set([
  "gpt-realtime-whisper",
  "gpt-realtime-translate"
]);

/**
 * 44-byte canonical PCM16 WAV header + payload. Mono, 16-bit, caller-supplied
 * rate. Shared by the whisper-local provider (which feeds whisper.cpp) and the
 * backup module (which persists failed dictations) — one WAV encoder for the
 * whole repo.
 *
 * @param {Buffer} pcm
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function wrapWav(pcm, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
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
 * JSON-serialize `event` and send it to a browser client if the socket is
 * still open. No-op on a closed socket. All relay providers funnel their
 * outbound frames through this so the protocol contract has one chokepoint.
 *
 * @param {WebSocket} socket
 * @param {Record<string, unknown>} event
 */
export function sendToClient(socket, event) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

/**
 * Wire an `unexpected-response` event on an upstream WebSocket. The upstream
 * returned HTTP non-2xx during the WS upgrade (typical for invalid API keys:
 * 401, 429, etc.). Forwards the status + first 200 chars of the body as a
 * local.error frame so the client (and the parity tests) can observe the
 * failure.
 *
 * @param {WebSocket} upstreamSocket
 * @param {WebSocket} clientSocket
 * @param {string} label
 */
export function forwardUnexpectedResponse(upstreamSocket, clientSocket, label) {
  upstreamSocket.on("unexpected-response", (_req, res) => {
    console.error(`[relay] ${label} unexpected-response status=${res.statusCode}`);
    let body = "";
    res.on("data", (chunk) => { body += chunk.toString(); });
    res.on("end", () => {
      const snippet = body.slice(0, 200);
      console.error(`[relay] ${label} response body: ${body.slice(0, 500)}`);
      sendToClient(clientSocket, {
        type: "local.error",
        message: `${label} HTTP ${res.statusCode}: ${snippet}`
      });
    });
  });
}
