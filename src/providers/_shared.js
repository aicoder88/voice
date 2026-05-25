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

// JSON-serializes `event` and sends it to a browser client if the socket is
// still open. No-op on a closed socket. All relay providers funnel their
// outbound frames through this so the protocol contract has one chokepoint.
export function sendToClient(socket, event) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

// Wires an `unexpected-response` event on an upstream WebSocket. The upstream
// returned HTTP non-2xx during the WS upgrade (typical for invalid API keys:
// 401, 429, etc.). Today the relay used to log the body to stderr and leave
// the browser blind — the parity harness had to time out to detect this.
// Now we forward the status + first 200 chars of the body as a local.error
// frame so the client (and the parity tests) can observe the failure.
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
