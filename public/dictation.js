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
// Per-press profile from main: { language, model } for Deepgram (right-Ctrl
// toggles hr/en). null = use the URL-default behavior. Read by ensureSocket.
let activeProfile = null;

// Full audio of the current utterance (pre-roll + everything streamed while
// recording), kept as a list of Uint8Array PCM16 chunks. This is the backup:
// if processing fails, it gets shipped to the main process and written to disk
// so a long dictation is never silently lost. Cleared on success.
let recordedChunks = [];
let recordedBytes = 0;
// True once a terminal frame (transcript OR a server-decided empty) arrives.
// Distinguishes a real failure (nothing ever came back) from legitimate
// silence (the relay returns an empty `completed` frame on purpose).
let gotTerminalEvent = false;
// One-shot guard so a single failed utterance produces at most one pop-up.
let failureHandled = false;
let failureTimer = null;

// Below this the buffer is a misfire (a tap, not a held dictation) — not worth
// a backup pop-up. 4800 bytes = 0.1s @ 24 kHz mono int16.
const MIN_FAILURE_BYTES = 4800;
// How long to wait for ANY terminal frame before declaring the transcriber
// hung. Deliberately long so slow-but-working transcription of a long clip
// isn't mistaken for a failure. Separate from the delta-flush fallback below.
const FAILURE_MS = Number(window.DICTATION_FAILURE_MS || 20000);

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
    let url;
    if (provider === "deepgram") {
      // Carry the per-press language/model profile (right-Ctrl toggles hr/en)
      // through to the relay so Deepgram transcribes in the chosen language.
      const params = new URLSearchParams({ provider: "deepgram" });
      if (activeProfile?.language) params.set("language", activeProfile.language);
      if (activeProfile?.model) params.set("model", activeProfile.model);
      url = `ws://${window.location.host}/realtime?${params.toString()}`;
    } else if (provider === "whisper-local" || provider === "local") {
      url = `ws://${window.location.host}/realtime?provider=whisper-local`;
    } else {
      url = `ws://${window.location.host}/realtime?model=gpt-realtime-whisper`;
    }
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
      // Ignore late frames from a socket we've already replaced — they belong
      // to a previous utterance and must not flip the current one's state.
      if (socket !== thisSocket) return;
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
    // A terminal frame arrived — even an empty one (silence gate). This is the
    // signal that the transcriber did NOT hang, so cancel the failure path.
    gotTerminalEvent = true;
    clearFailureTimer();
    const finalText =
      msg.transcript ||
      msg.text ||
      (msg.response && (msg.response.output_text || msg.response.transcript)) ||
      transcriptParts.join("");
    if (finalText && finalText.trim()) {
      lastFinalAt = Date.now();
      finalizeAndSend(finalText.trim());
    } else if (!alreadyFinalized) {
      // Terminal frame with no text (silence gate or hallucination filter).
      // Tell main anyway so it drops the pill instead of leaving the spinner up.
      alreadyFinalized = true;
      window.dictationBridge.sendTranscript("");
    }
    return;
  }

  if (t === "error" || t === "local.error") {
    log("Error: " + JSON.stringify(msg));
    reportFailure("The transcriber reported an error: " + (msg.error?.message || msg.message || "unknown error"));
  }
}

function clearFailureTimer() {
  if (failureTimer) {
    clearTimeout(failureTimer);
    failureTimer = null;
  }
}

// A dictation couldn't be turned into text. If we captured enough audio, hand
// the whole recording to the main process so it can be saved and offered back
// for retry / playback. Otherwise there's nothing worth keeping — just report
// a plain error. Runs at most once per utterance.
function reportFailure(reason) {
  if (failureHandled) return;
  failureHandled = true;
  isRecording = false;
  clearFailureTimer();
  setStatus("Saved for retry");
  log("Failure: " + reason + " (" + recordedBytes + "B captured)");

  if (recordedBytes >= MIN_FAILURE_BYTES) {
    const chunks = recordedChunks.map((u8) => u8ToBase64(u8));
    window.dictationBridge.reportFailure({ chunks, sampleRate: targetSampleRate, reason });
  } else {
    window.dictationBridge.sendError(reason);
  }
  recordedChunks = [];
  recordedBytes = 0;
}

function finalizeAndSend(text) {
  if (alreadyFinalized) return;
  if (!text || !text.trim()) return;
  alreadyFinalized = true;
  clearFailureTimer();
  log("Final: " + text);
  window.dictationBridge.sendTranscript(text);
  transcriptParts = [];
  // Success — drop the backup audio so memory doesn't grow press over press.
  recordedChunks = [];
  recordedBytes = 0;
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
  // Input gain is applied (soft-clipped) in the worklet so quiet/distant
  // speech crosses Deepgram's energy threshold. Override at runtime via
  // `window.DICTATION_INPUT_GAIN = <positive finite number>` for A/B testing.
  const gainOverride = Number(window.DICTATION_INPUT_GAIN);
  const inputGain = Number.isFinite(gainOverride) && gainOverride > 0 ? gainOverride : 2.5;
  processorNode = new AudioWorkletNode(audioContext, "audio-capture-processor", {
    processorOptions: { outputRate: targetSampleRate, inputGain }
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
    if (!isRecording) return;
    // Keep a copy of every recorded frame for the backup. slice(0) detaches it
    // from the transferred buffer so it survives independently.
    const copy = new Uint8Array(pcm16.slice(0));
    recordedChunks.push(copy);
    recordedBytes += copy.byteLength;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
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

async function startRecording(profile) {
  if (isRecording) return;
  activeProfile = profile || null;
  if (activeProfile) {
    log("Profile: lang=" + (activeProfile.language || "default") + " model=" + (activeProfile.model || "default"));
  }
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
  gotTerminalEvent = false;
  failureHandled = false;
  clearFailureTimer();
  recordedChunks = [];
  recordedBytes = 0;
  isRecording = true;

  // Flush the pre-roll so the opening words aren't lost to the press itself.
  // The same frames seed the backup buffer so a saved recording matches what
  // the transcriber actually heard.
  for (const buf of prerollChunks) {
    const copy = new Uint8Array(buf.slice(0));
    recordedChunks.push(copy);
    recordedBytes += copy.byteLength;
    if (socket && socket.readyState === WebSocket.OPEN) {
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
    // The connection dropped before we could ask for a transcript, but the
    // audio is in the backup buffer — save it rather than lose it.
    reportFailure("Lost the connection to the transcriber before your audio could be sent.");
    return;
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

  // Separate, longer watchdog: if NO terminal frame (transcript or a
  // server-decided empty) ever arrives, the transcriber hung — save the audio
  // and offer a retry instead of swallowing the dictation.
  clearFailureTimer();
  failureTimer = setTimeout(() => {
    if (alreadyFinalized || gotTerminalEvent || failureHandled) return;
    reportFailure("The transcriber didn't respond in time.");
  }, FAILURE_MS);
}

window.dictationBridge.onStart((profile) => startRecording(profile));
window.dictationBridge.onStop(() => stopRecording());

function arrayBufferToBase64(buffer) {
  return u8ToBase64(new Uint8Array(buffer));
}

function u8ToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

setStatus("Ready - waiting for hotkey");
log("Dictation worker loaded");
