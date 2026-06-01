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

// --- Microphone auto-recovery -------------------------------------------------
// A getUserMedia stream binds to ONE device at the instant it's acquired. If
// that device is later unplugged, muted, switched, or grabbed by another app
// (a call, screen-share, etc.), the track goes mute/ended but the stream object
// stays "live" — so without watching for it we'd keep streaming pure silence
// and typing nothing, forever, until the app is restarted. We watch three
// signals and rebuild the pipeline (on the NEXT press, never mid-hold):
//   1. the track's onended/onmute events (clean OS drop / seizure),
//   2. mediaDevices 'devicechange' (default input switched/unplugged),
//   3. a run of silent holds (the macOS case where the track stays live but
//      pipes silence with no event at all).
let utterancePeak = 0;        // loudest worklet frame in the current hold (0..1)
let silentStreak = 0;         // consecutive long-enough holds that were silent
let captureStale = false;     // device changed → rebuild the pipeline next press
let deviceChangeWired = false;
let workletLoaded = false;    // audioWorklet module added (guards re-registration)
// Loudest frame below this, sustained across an entire long hold, means no real
// audio arrived. ~1% of full scale; a live mic in a real room clears it within
// the hold, a dead/seized device sits at ~0. Tunable for A/B testing.
const SILENCE_PEAK = Number(window.DICTATION_SILENCE_PEAK || 0.01);
// This many silent long-holds in a row ⇒ the mic is almost certainly dead, not
// the user choosing silence repeatedly. Warn + rebuild on the next press.
const SILENT_STREAK_LIMIT = 3;

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  // This hidden window runs for the whole session; cap the log so its DOM text
  // can't grow without bound. Keep roughly the last ~150 lines.
  if (logEl.textContent.length > 16000) {
    logEl.textContent = logEl.textContent.slice(-12000);
  }
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
  // Ship the captured audio with the transcript so main can save it to the
  // temporary recordings folder — the success pill's "Open recording" button
  // needs a file even when transcription succeeded.
  const chunks = recordedChunks.map((u8) => u8ToBase64(u8));
  window.dictationBridge.sendTranscript({ text, chunks, sampleRate: targetSampleRate });
  transcriptParts = [];
  // Drop the in-memory copy now that it's handed off, so memory doesn't grow
  // press over press.
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

  // Re-acquire onto the current default device whenever the audio device set
  // changes (unplug, switch, BT connect). We don't rebuild here — that could
  // land mid-hold — just mark the warm pipeline stale so the next press does.
  if (!deviceChangeWired && navigator.mediaDevices?.addEventListener) {
    deviceChangeWired = true;
    navigator.mediaDevices.addEventListener("devicechange", () => {
      captureStale = true;
      log("Audio devices changed — mic re-acquires on next press");
    });
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  // The stream is bound to this one device. If the OS drops it (ended) or
  // another app seizes it (mute), tear down so the next press rebuilds, and
  // surface a visible warning instead of silently typing nothing.
  const [track] = mediaStream.getAudioTracks();
  if (track) {
    track.onended = () => handleMicLost("The microphone was disconnected.");
    track.onmute = () => handleMicLost("The microphone went silent — another app may have taken it.");
  }

  // addModule re-runs the module script (and registerProcessor) every call;
  // registering the same processor name twice throws. Load it exactly once.
  if (!workletLoaded) {
    await audioContext.audioWorklet.addModule("/audio-capture-worklet.js");
    workletLoaded = true;
  }
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
    const { pcm16, peak } = event.data;
    // Maintain the rolling pre-roll window regardless of recording state.
    prerollChunks.push(pcm16);
    prerollBytes += pcm16.byteLength;
    while (prerollBytes > PREROLL_MAX_BYTES && prerollChunks.length > 1) {
      prerollBytes -= prerollChunks.shift().byteLength;
    }
    if (!isRecording) return;
    // Track the loudest frame of this hold so stopRecording can tell a dead mic
    // (sustained ~0) from real speech.
    if (typeof peak === "number" && peak > utterancePeak) utterancePeak = peak;
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

// Tear the capture graph down so the next initCapture() rebuilds onto the
// current default device. Keeps the AudioContext + loaded worklet module
// (both reusable); only the device-bound stream and nodes are dropped.
function teardownCapture() {
  try { if (processorNode) processorNode.port.onmessage = null; } catch {}
  try { sourceNode && sourceNode.disconnect(); } catch {}
  try { processorNode && processorNode.disconnect(); } catch {}
  try { muteNode && muteNode.disconnect(); } catch {}
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) { try { track.stop(); } catch {} }
  }
  sourceNode = null;
  processorNode = null;
  muteNode = null;
  mediaStream = null;
  prerollChunks = [];
  prerollBytes = 0;
  captureReady = false;
}

// The mic died or was taken (track ended/muted, or a run of silent holds).
// Drop the dead pipeline, surface a visible warning, and reset so the next
// press re-acquires. Safe to call mid-hold: we just abandon the current one.
function handleMicLost(reason) {
  log("Mic lost: " + reason);
  isRecording = false;
  teardownCapture();
  silentStreak = 0;
  clearFailureTimer();
  setStatus("Mic lost");
  // Don't leave the relay blocked on a commit that carries no audio.
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.close(); } catch {}
  }
  socket = null;
  window.dictationBridge.sendMicWarning(reason);
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

  // A device change since the last press means our warm stream is bound to the
  // wrong (old) device — drop it so initCapture re-acquires the new default.
  if (captureStale) {
    teardownCapture();
    captureStale = false;
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

  utterancePeak = 0;

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

  // Dead-mic backstop: only judge holds long enough to be a real attempt (a tap
  // is a misfire, not a silent mic). A live mic clears SILENCE_PEAK within the
  // hold; a sustained sub-threshold peak means no audio arrived. A single such
  // hold is legitimate (held the key, said nothing) — but a run of them is the
  // mic, not the user, so warn and rebuild on the next press.
  if (recordedBytes >= MIN_FAILURE_BYTES) {
    if (utterancePeak < SILENCE_PEAK) {
      silentStreak += 1;
      log("Silent hold " + silentStreak + "/" + SILENT_STREAK_LIMIT + " (peak=" + utterancePeak.toFixed(4) + ")");
      if (silentStreak >= SILENT_STREAK_LIMIT) {
        handleMicLost("No sound is reaching the app — your mic may be muted or in use by another app.");
        return;
      }
    } else {
      silentStreak = 0;
    }
  }

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
