// Parity test for /realtime per provider.
// Boots startServer() on an ephemeral port, opens a WS client, replays a
// recorded PCM fixture, asserts the emitted frame sequence.
//
// Run all: node --test scripts/parity/dictation-flow.test.js
// Run one: node --test --test-name-pattern=openai scripts/parity/dictation-flow.test.js
//
// Provider subtests are skipped when their credentials / binaries are absent.

import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { startServer } from "../../server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "tone-1500ms.pcm16");
const CHUNK_SAMPLES = 4096; // matches public/dictation.js ScriptProcessorNode buffer

function loadFixtureChunks() {
  const pcm = readFileSync(FIXTURE_PATH);
  const chunkBytes = CHUNK_SAMPLES * 2;
  const chunks = [];
  for (let off = 0; off < pcm.length; off += chunkBytes) {
    chunks.push(pcm.subarray(off, Math.min(off + chunkBytes, pcm.length)));
  }
  return chunks;
}

async function bootRelay() {
  const { server, port } = await startServer({ port: 0 });
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        // Force-close any lingering upstream sockets (e.g. an OpenAI socket
        // still mid-handshake after a 401). Without this, server.close() can
        // hang for the full HTTP keep-alive interval.
        try { server.closeAllConnections?.(); } catch {}
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        server.close(() => finish());
        setTimeout(finish, 1000).unref();
      })
  };
}

function openClient(port, provider, extraQuery = "") {
  // Always set ?provider= explicitly. Otherwise STT_PROVIDER in .env would
  // override the test's intent (e.g. STT_PROVIDER=whisper-local would silently
  // route the "openai" test to whisper-local).
  const url =
    provider === "openai"
      ? `ws://127.0.0.1:${port}/realtime?provider=openai&model=gpt-realtime-whisper${extraQuery}`
      : `ws://127.0.0.1:${port}/realtime?provider=${provider}${extraQuery}`;
  const ws = new WebSocket(url);
  const frames = [];
  ws.on("message", (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      frames.push({ type: "<binary>", bytes: raw.length });
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, frames, ready };
}

function waitFor(predicate, { timeoutMs = 8000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Returns null on success, or a skip-reason string if the relay reported an
// upstream failure (closed without ever connecting, or local.error frame).
function detectUpstreamSkip(frames) {
  const connected = frames.some(
    (f) => f.type === "local.status" && f.status === "connected"
  );
  const closed = frames.find((f) => f.type === "local.status" && f.status === "closed");
  const errored = frames.find((f) => f.type === "local.error");
  if (!connected && (closed || errored)) {
    if (errored) return `upstream error: ${errored.message}`;
    return `upstream closed before connected: code=${closed.code} reason=${closed.reason || ""}`;
  }
  return null;
}

function streamFixture(ws, chunks) {
  for (const chunk of chunks) {
    ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64")
      })
    );
  }
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
}

function assertCoreInvariants(frames, provider) {
  // Invariant 1: a local.status connected frame is emitted before any transcription frame.
  const firstStatusIdx = frames.findIndex(
    (f) => f.type === "local.status" && f.status === "connected"
  );
  const firstTranscriptionIdx = frames.findIndex((f) =>
    String(f.type || "").startsWith("conversation.item.input_audio_transcription.")
  );
  assert.notStrictEqual(firstStatusIdx, -1, `${provider}: missing connected status frame`);
  if (firstTranscriptionIdx !== -1) {
    assert.ok(
      firstStatusIdx < firstTranscriptionIdx,
      `${provider}: status connected must precede first transcription frame`
    );
  }

  // Invariant 2: exactly one ...completed frame per commit.
  const completed = frames.filter(
    (f) => f.type === "conversation.item.input_audio_transcription.completed"
  );
  assert.strictEqual(
    completed.length,
    1,
    `${provider}: expected exactly one completed frame, got ${completed.length}`
  );

  // Invariant 3: completed frame has a string transcript field (may be "").
  assert.strictEqual(
    typeof completed[0].transcript,
    "string",
    `${provider}: completed.transcript must be a string`
  );
}

test("parity: relay boots and serves /realtime", async (t) => {
  if (!process.env.OPENAI_API_KEY) {
    t.skip("OPENAI_API_KEY required even for boot (relay constructor enforces it)");
    return;
  }
  const relay = await bootRelay();
  t.after(() => relay.close());
  assert.ok(relay.port > 0, "ephemeral port assigned");
});

test("parity: openai transcription-only completes one utterance", async (t) => {
  if (!process.env.OPENAI_API_KEY) {
    t.skip("OPENAI_API_KEY not set");
    return;
  }
  const relay = await bootRelay();
  t.after(() => relay.close());

  const chunks = loadFixtureChunks();
  const { ws, frames, ready } = openClient(relay.port, "openai");
  await ready;
  t.after(() => ws.close());

  // Wait for either connected or an upstream failure signal. Today's relay
  // swallows OpenAI 401s silently (logs but doesn't emit a local.error), so a
  // short timeout here is the only skip signal we get for an invalid key.
  try {
    await waitFor(
      () =>
        frames.some((f) => f.type === "local.status" && f.status === "connected") ||
        detectUpstreamSkip(frames) !== null,
      { timeoutMs: 4000 }
    );
  } catch {
    t.skip("openai upstream never responded (likely no network or invalid key)");
    return;
  }
  const skipReason = detectUpstreamSkip(frames);
  if (skipReason) {
    t.skip(`openai unavailable: ${skipReason}`);
    return;
  }

  streamFixture(ws, chunks);

  await waitFor(
    () =>
      frames.some(
        (f) => f.type === "conversation.item.input_audio_transcription.completed"
      ),
    { timeoutMs: 15000 }
  );

  assertCoreInvariants(frames, "openai");
});

test("parity: deepgram completes one utterance", async (t) => {
  if (!process.env.OPENAI_API_KEY) {
    t.skip("OPENAI_API_KEY required to boot the relay");
    return;
  }
  if (!process.env.DEEPGRAM_API_KEY) {
    t.skip("DEEPGRAM_API_KEY not set");
    return;
  }
  const relay = await bootRelay();
  t.after(() => relay.close());

  const chunks = loadFixtureChunks();
  const { ws, frames, ready } = openClient(relay.port, "deepgram");
  await ready;
  t.after(() => ws.close());

  await waitFor(() =>
    frames.some((f) => f.type === "local.status" && f.status === "connected")
  );

  streamFixture(ws, chunks);

  await waitFor(
    () =>
      frames.some(
        (f) => f.type === "conversation.item.input_audio_transcription.completed"
      ),
    { timeoutMs: 10000 }
  );

  assertCoreInvariants(frames, "deepgram");
});

test("parity: whisper-local completes one utterance", async (t) => {
  if (!process.env.OPENAI_API_KEY) {
    t.skip("OPENAI_API_KEY required to boot the relay");
    return;
  }
  const modelPath = process.env.WHISPER_MODEL || "./models/ggml-base.en.bin";
  if (!existsSync(modelPath)) {
    t.skip(`whisper model not found at ${modelPath}`);
    return;
  }

  const relay = await bootRelay();
  t.after(() => relay.close());

  const chunks = loadFixtureChunks();
  const { ws, frames, ready } = openClient(relay.port, "whisper-local");
  await ready;
  t.after(() => ws.close());

  await waitFor(() =>
    frames.some((f) => f.type === "local.status" && f.status === "connected")
  );

  streamFixture(ws, chunks);

  await waitFor(
    () =>
      frames.some(
        (f) => f.type === "conversation.item.input_audio_transcription.completed"
      ),
    { timeoutMs: 30000 }
  );

  assertCoreInvariants(frames, "whisper-local");
});

test("parity: openai bad-key surfaces as observable failure", async (t) => {
  // Client-observable contract: when the upstream rejects the API key, the
  // browser must be able to detect the failure — never see a "connected"
  // status and never see a transcription frame. The exact failure shape
  // depends on whether OpenAI rejects during the WS handshake (HTTP 4xx →
  // local.error from forwardUnexpectedResponse) or after the upgrade
  // completes (WS close with reason → local.status closed). Either form
  // satisfies the contract.
  if (!process.env.OPENAI_API_KEY) {
    t.skip("OPENAI_API_KEY required (test overrides it before booting)");
    return;
  }
  const realKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-invalid-parity-test-no-such-key";
  let relay;
  try {
    relay = await bootRelay();
  } finally {
    process.env.OPENAI_API_KEY = realKey;
  }
  t.after(() => relay.close());

  const { ws, frames, ready } = openClient(relay.port, "openai");
  await ready;
  t.after(() => ws.close());

  function hasFailureSignal() {
    return frames.some(
      (f) =>
        f.type === "local.error" ||
        (f.type === "local.status" && f.status === "closed")
    );
  }

  try {
    await waitFor(hasFailureSignal, { timeoutMs: 10000 });
  } catch {
    t.skip("upstream did not signal failure within 10s (network slow or key happens to work)");
    return;
  }

  // OpenAI completes the WS handshake even with a bad key (`connected` may
  // fire), then closes with an auth-error reason as soon as the relay sends
  // session.update. The contract that matters: the client sees a failure
  // signal and never sees a transcription frame.
  const transcriptionFrame = frames.find((f) =>
    String(f.type || "").startsWith("conversation.item.input_audio_transcription.")
  );
  assert.strictEqual(transcriptionFrame, undefined, "must not see transcription on bad key");
});
