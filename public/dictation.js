const targetSampleRate = 24000;
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

let socket = null;
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let muteNode = null;
let isRecording = false;
let captureReady = false;
let transcriptParts = [];
let lastFinalAt = 0;
let alreadyFinalized = false;

// Rolling pre-roll buffer of the most recent mic audio. The capture pipeline
// runs continuously once warmed, so on key-press we can flush the last ~600ms
// into the buffer — this recovers words the speaker began saying right as (or
// just before) they pressed the key, the audio a cold-start mic would drop.
const PREROLL_MS = 600;
const PREROLL_MAX_BYTES = Math.round((targetSampleRate * 2 * PREROLL_MS) / 1000);
let prerollChunks = [];
let prerollBytes = 0;

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  console.log(line);
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function ensureSocket() {
  if (socket) {
    try { socket.close(); } catch {}
    socket = null;
  }

  return new Promise((resolve, reject) => {
    const provider = (new URLSearchParams(window.location.search).get("provider") || window.STT_PROVIDER || "openai").toLowerCase();
    // For the OpenAI path we request the dictation-flavored transcription-only
    // model. The relay reads ?model=, switches the upstream session into
    // STT-only shape, and sends its own session.update on open — we do not
    // need to send one from here. See docs/RELAY_PROTOCOL.md.
    const url =
      provider === "deepgram"
        ? `ws://${window.location.host}/realtime?provider=deepgram`
        : provider === "whisper-local" || provider === "local"
          ? `ws://${window.location.host}/realtime?provider=whisper-local`
          : `ws://${window.location.host}/realtime?model=gpt-realtime-whisper`;
    const thisSocket = new WebSocket(url);
    socket = thisSocket;
    thisSocket.addEventListener("open", () => {
      log("WS open (" + provider + ")");
      resolve(socket);
    });
    thisSocket.addEventListener("error", (e) => {
      log("WS error");
      reject(e);
    });
    thisSocket.addEventListener("close", () => {
      log("WS closed");
      if (socket === thisSocket) socket = null;
    });
    thisSocket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeEvent(msg);
      } catch {}
    });
  });
}

function handleRealtimeEvent(msg) {
  const t = msg.type || "";

  if (
    t === "conversation.item.input_audio_transcription.delta" ||
    t === "response.audio_transcript.delta" ||
    t === "response.output_text.delta" ||
    t === "response.text.delta"
  ) {
    if (typeof msg.delta === "string") transcriptParts.push(msg.delta);
    return;
  }

  if (
    t === "conversation.item.input_audio_transcription.completed" ||
    t === "response.audio_transcript.done" ||
    t === "response.output_text.done" ||
    t === "response.text.done" ||
    t === "response.done"
  ) {
    const finalText =
      msg.transcript ||
      msg.text ||
      (msg.response && (msg.response.output_text || msg.response.transcript)) ||
      transcriptParts.join("");
    if (finalText && finalText.trim()) {
      lastFinalAt = Date.now();
      finalizeAndSend(finalText.trim());
    }
    return;
  }

  if (t === "error" || t === "local.error") {
    log("Error: " + JSON.stringify(msg));
    window.dictationBridge.sendError(msg.error?.message || msg.message || "unknown error");
  }
}

function finalizeAndSend(text) {
  if (alreadyFinalized) return;
  if (!text || !text.trim()) return;
  alreadyFinalized = true;
  log("Final: " + text);
  window.dictationBridge.sendTranscript(text);
  transcriptParts = [];
}

// Bring the mic + worklet pipeline up once and leave it running. Idempotent:
// later calls return immediately. Captured frames feed the rolling pre-roll
// buffer always, and stream to the socket only while isRecording is true.
//
// AGC / noise-suppression / echo-cancellation are all OFF on purpose: they
// degrade Whisper accuracy. AGC ramps gain down during silence and lags on the
// first word; noise suppression can clip speech onsets. Whisper wants the raw
// signal.
async function initCapture() {
  if (captureReady) return;
  audioContext = audioContext || new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  await audioContext.audioWorklet.addModule("/audio-capture-worklet.js");
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = new AudioWorkletNode(audioContext, "audio-capture-processor", {
    processorOptions: { outputRate: targetSampleRate }
  });
  muteNode = audioContext.createGain();
  muteNode.gain.value = 0;

  processorNode.port.onmessage = (event) => {
    const { pcm16 } = event.data;
    // Maintain the rolling pre-roll window regardless of recording state.
    prerollChunks.push(pcm16);
    prerollBytes += pcm16.byteLength;
    while (prerollBytes > PREROLL_MAX_BYTES && prerollChunks.length > 1) {
      prerollBytes -= prerollChunks.shift().byteLength;
    }
    if (!isRecording || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: arrayBufferToBase64(pcm16)
      })
    );
  };

  sourceNode.connect(processorNode);
  processorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);
  captureReady = true;
}

async function startRecording() {
  if (isRecording) return;
  setStatus("Connecting…");
  try {
    await ensureSocket();
  } catch {
    setStatus("WS failed");
    window.dictationBridge.sendError("Could not connect to relay");
    return;
  }

  try {
    await initCapture();
    // The pipeline persists across presses; the OS may have suspended the
    // context (e.g. after sleep). Resume so frames flow again.
    if (audioContext.state === "suspended") await audioContext.resume();
  } catch (error) {
    captureReady = false;
    setStatus("Mic blocked");
    window.dictationBridge.sendError("Microphone not available: " + error.message);
    return;
  }

  transcriptParts = [];
  alreadyFinalized = false;
  isRecording = true;

  // Flush the pre-roll so the opening words aren't lost to the press itself.
  if (socket && socket.readyState === WebSocket.OPEN) {
    for (const buf of prerollChunks) {
      socket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: arrayBufferToBase64(buf)
        })
      );
    }
  }

  setStatus("Listening");
  log("Mic started (preroll " + prerollBytes + "B)");
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  setStatus("Finalizing…");
  log("Mic stopped, committing buffer");

  // Leave the capture pipeline warm for the next press — only stop streaming.

  if (socket && socket.readyState === WebSocket.OPEN) {
    log("Sending commit (socket readyState=" + socket.readyState + ")");
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  } else {
    log("CANNOT send commit, socket=" + !!socket + " readyState=" + (socket ? socket.readyState : "no-socket"));
  }

  const FALLBACK_MS = Number(window.DICTATION_FALLBACK_MS || 1200);
  const startedAt = Date.now();
  setTimeout(() => {
    if (alreadyFinalized) return;
    if (lastFinalAt < startedAt && transcriptParts.length > 0) {
      finalizeAndSend(transcriptParts.join("").trim());
    }
    setStatus("Idle");
  }, FALLBACK_MS);
}

window.dictationBridge.onStart(() => startRecording());
window.dictationBridge.onStop(() => stopRecording());

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

setStatus("Ready - waiting for hotkey");
log("Dictation worker loaded");
