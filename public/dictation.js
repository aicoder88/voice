import { classifyHold } from "/mic-health.js";

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
// recording), kept as a list of Uint8Array PCM16 chunks. Shipped to the main
// process on every terminal frame (success, failure, or empty) and written to
// disk so the recording is recoverable and the user can listen back. Drained
// (handed off + reset) as the utterance completes — see drainChunks().
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

// Tail drain. The mic worklet delivers audio in buffered bursts, so at the
// instant the key is released the last ~tens-to-hundreds of ms of speech may not
// have been streamed yet — releasing mid-word would otherwise clip the final
// word or two. On release we keep streaming for this long, THEN commit, so the
// tail reaches the engine. Tunable via window.DICTATION_TAIL_MS.
const TAIL_MS = Number(window.DICTATION_TAIL_MS || 250);
let draining = false;
let drainTimer = null;
// Partial-transcript fallback armed by finishUtterance. Tracked so a new press
// can cancel the previous utterance's timer — a stale one firing mid-hold
// would type the NEW utterance's first words early and break its finalize.
let fallbackTimer = null;
// startRecording awaits the socket + mic; a quick tap can deliver the stop
// while it's still in flight, and a stop dropped there used to leave the mic
// recording (and streaming) until the next press. Track the in-flight start
// and the deferred stop so a tap commits normally.
let startInFlight = false;
let stopRequested = false;
// When the hold started (key-down), for the dead-pipeline check: a long hold
// that produced ~no bytes means no frames arrived at all.
let holdStartedAt = 0;

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
      // Terminal frame with no text. Two cases:
      //  - We captured real audio: a genuine attempt that came back empty
      //    (mis-recognition, both auto-language legs silent, a flush race). Hand
      //    the recording to main so it surfaces a failed attempt the user can
      //    listen to, instead of vanishing as if nothing happened.
      //  - Little/no audio (a too-short tap): nothing worth keeping — send a
      //    bare "" so main drops the pill quietly.
      alreadyFinalized = true;
      if (recordedBytes >= MIN_FAILURE_BYTES) {
        window.dictationBridge.sendTranscript({ text: "", chunks: drainChunks(), sampleRate: targetSampleRate });
      } else {
        window.dictationBridge.sendTranscript("");
        drainChunks(); // tiny misfire — nothing to keep, just clear the buffer
      }
    }
    return;
  }

  if (t === "error" || t === "local.error") {
    log("Error: " + JSON.stringify(msg));
    // Action first; the technical detail rides along for the curious (and is
    // always in the log).
    const detail = msg.error?.message || msg.message || "";
    reportFailure("Transcription failed — press and try again." + (detail ? " (" + detail + ")" : ""));
  }
}

function clearFailureTimer() {
  if (failureTimer) {
    clearTimeout(failureTimer);
    failureTimer = null;
  }
}

// Hand the captured audio off to main as base64 and clear the buffer. Every
// terminal path (success / failure / empty) drains exactly once, so the buffer
// can't grow press-over-press or leak into the next utterance.
function drainChunks() {
  const chunks = recordedChunks.map((u8) => u8ToBase64(u8));
  recordedChunks = [];
  recordedBytes = 0;
  return chunks;
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
    window.dictationBridge.reportFailure({ chunks: drainChunks(), sampleRate: targetSampleRate, reason });
  } else {
    window.dictationBridge.sendError(reason);
    drainChunks(); // misfire — discard the buffer
  }
}

function finalizeAndSend(text) {
  if (alreadyFinalized) return;
  if (!text || !text.trim()) return;
  alreadyFinalized = true;
  clearFailureTimer();
  log("Final: " + text);
  // Ship the captured audio with the transcript so main can save it to the
  // recordings folder — the success pill's "Open recording" button and the
  // tray's playback items need a file even when transcription succeeded.
  window.dictationBridge.sendTranscript({ text, chunks: drainChunks(), sampleRate: targetSampleRate });
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
  try {
    await buildCaptureGraph();
  } catch (err) {
    // Never leave a half-built graph behind: getUserMedia may have succeeded
    // before a later step threw, and that stray live track would keep the
    // mic-in-use indicator on AND get a second graph stacked on top by the
    // next attempt (doubled, garbled audio).
    teardownCapture(true);
    throw err;
  }
}

async function buildCaptureGraph() {
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
    // Stream while actively recording AND during the post-release tail drain, so
    // the last word(s) the worklet hadn't yet delivered still reach the engine.
    if (!isRecording && !draining) return;
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
// current default device. By default keeps the AudioContext + loaded worklet
// module (reusable) and drops only the device-bound stream and nodes.
//
// `full` ALSO closes the AudioContext and forgets the worklet, forcing
// initCapture to recreate the entire pipeline from scratch. This matters for
// real recovery: the macOS post-sleep failure can wedge the AudioContext itself
// (it keeps delivering zeros even with a fresh stream), so a partial rebuild
// that reuses the context isn't enough — the evidence showed a still-silent hold
// after a partial rebuild. Used on mic-loss, device change, and system wake.
function teardownCapture(full = false) {
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
  if (full && audioContext) {
    try { audioContext.close(); } catch {}
    audioContext = null;
    workletLoaded = false;
  }
}

// The mic died or was taken (track ended/muted, or a run of silent holds).
// Drop the dead pipeline, surface a visible warning, and reset so the next
// press re-acquires. Safe to call mid-hold: we just abandon the current one.
function handleMicLost(reason) {
  log("Mic lost: " + reason);
  isRecording = false;
  // Cancel a pending tail-drain commit: finishUtterance on a torn-down
  // pipeline would double-report (failure pill over this mic warning).
  clearTimeout(drainTimer);
  draining = false;
  // Same reason for the partial-transcript fallback: it's gated only by
  // alreadyFinalized (not failureHandled), so leaving it armed would paste a
  // partial ~1.2s after this mic warning — exactly the double-report above.
  clearTimeout(fallbackTimer);
  fallbackTimer = null;
  teardownCapture(true); // full rebuild — a partial one can keep a wedged context
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

// Proactively rebuild the whole capture pipeline. Driven by main on system wake
// (powerMonitor resume / unlock), the moment the mic is most likely to have gone
// dead — so the FIRST dictation after sleep works instead of being the silent
// one that trips the recovery. A no-op rebuild mid-hold would abandon the user's
// audio, so if a hold is in progress we just mark it stale and let the next
// press rebuild.
// A wake from sleep usually fires BOTH powerMonitor resume and unlock-screen
// back-to-back, so this can be called twice in the same tick. Coalesce them:
// two overlapping rebuilds would race the AudioContext close/recreate and could
// leak a stream or leave a half-built (silent) graph — the very wedge we're
// fixing. One in-flight rebuild is shared by concurrent callers.
let rebuildInFlight = null;
async function rebuildCapture(reason) {
  if (isRecording) {
    captureStale = true;
    log("Rebuild requested mid-hold (" + (reason || "") + ") — deferring to next press");
    return;
  }
  if (rebuildInFlight) return rebuildInFlight;
  rebuildInFlight = (async () => {
    log("Rebuilding capture proactively (" + (reason || "wake") + ")");
    teardownCapture(true);
    silentStreak = 0;
    captureStale = false;
    try {
      await initCapture();
      if (audioContext && audioContext.state === "suspended") await audioContext.resume();
      log("Capture rebuilt after " + (reason || "wake"));
    } catch (error) {
      // Leave NOTHING half-built; the next press's initCapture tries again.
      teardownCapture(true);
      log("Proactive rebuild failed: " + (error && error.message));
    }
  })();
  try { await rebuildInFlight; } finally { rebuildInFlight = null; }
}

async function startRecording(profile) {
  if (isRecording || startInFlight) return;
  startInFlight = true;
  stopRequested = false;
  holdStartedAt = Date.now();
  // A new press during the previous utterance's tail drain supersedes it: cancel
  // the pending commit so this fresh recording's frames aren't committed early.
  if (draining) { clearTimeout(drainTimer); draining = false; }
  activeProfile = profile || null;
  if (activeProfile) {
    log("Profile: lang=" + (activeProfile.language || "default") + " model=" + (activeProfile.model || "default"));
  }

  // Offline pre-flight for the cloud engines. Without this, dictating offline
  // fails with a confusing mid-take "lost the connection" after the user has
  // already spoken. Catch it up front and point them at the local engine, which
  // works with no internet. navigator.onLine is a cheap first signal (a false
  // negative just means we connect and the existing WS error path takes over).
  const provider = (new URLSearchParams(window.location.search).get("provider") || window.STT_PROVIDER || "openai").toLowerCase();
  const isCloud = provider !== "whisper-local" && provider !== "local";
  if (isCloud && navigator.onLine === false) {
    setStatus("Offline");
    log("Offline pre-flight: navigator.onLine === false, provider=" + provider);
    startInFlight = false;
    // Action first — the pill label can truncate the tail of a long reason.
    window.dictationBridge.sendError(
      "Offline — switch to the local Whisper engine in Settings, or reconnect."
    );
    return;
  }

  setStatus("Connecting…");
  try {
    await ensureSocket();
  } catch {
    setStatus("WS failed");
    startInFlight = false;
    window.dictationBridge.sendError("Dictation couldn't start — quit GVoice and reopen it, then try again.");
    return;
  }

  // A device change since the last press means our warm stream is bound to the
  // wrong (old) device — drop it so initCapture re-acquires the new default.
  if (captureStale) {
    teardownCapture(true);
    captureStale = false;
  }

  try {
    await initCapture();
    // The pipeline persists across presses; the OS may have suspended the
    // context (e.g. after sleep). Resume so frames flow again.
    if (audioContext.state === "suspended") await audioContext.resume();
  } catch (error) {
    // A partial build must not linger: the old track would stay live (mic
    // indicator on) and the next attempt would stack a second graph on top.
    teardownCapture(true);
    setStatus("Mic blocked");
    startInFlight = false;
    const errName = error && error.name;
    const micMsg = errName === "NotAllowedError" || errName === "SecurityError"
      ? "GVoice needs microphone access — allow it in System Settings → Privacy & Security → Microphone."
      : errName === "NotFoundError"
        ? "No microphone found — plug one in and try again."
        : "Microphone not available: " + (error && error.message);
    window.dictationBridge.sendError(micMsg);
    return;
  }

  utterancePeak = 0;

  transcriptParts = [];
  alreadyFinalized = false;
  gotTerminalEvent = false;
  failureHandled = false;
  clearFailureTimer();
  // The previous utterance's partial-transcript fallback must not fire into
  // this one.
  clearTimeout(fallbackTimer);
  fallbackTimer = null;
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
  startInFlight = false;
  // A quick tap released the key while we were still connecting — honor it
  // now so the tap commits (preroll included) instead of recording forever.
  if (stopRequested) {
    stopRequested = false;
    stopRecording();
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  // Keep streaming the trailing audio for a short grace period before committing,
  // so a word still being spoken as the key is released isn't clipped. The
  // worklet keeps sending frames while `draining` is true (see onmessage).
  draining = true;
  setStatus("Finalizing…");
  log("Mic released, draining tail (" + TAIL_MS + "ms) before commit");
  clearTimeout(drainTimer);
  drainTimer = setTimeout(finishUtterance, TAIL_MS);
}

// Commit the captured audio (now including the drained tail) and arm the
// finalize/failure timers. Split out of stopRecording so the tail can stream in
// between the key release and this commit.
function finishUtterance() {
  draining = false;
  log("Committing buffer");

  // Dead-mic backstop (shared, unit-tested logic in /mic-health.js). A hold
  // whose loudest frame is EXACTLY 0 is digital silence — a dead pipeline, never
  // a quiet room — so rebuild immediately. A low-but-nonzero peak is ambiguous
  // (held the key and said nothing, or a distant mic), so only a run of those
  // counts as the mic being dead. Too-short holds (taps) aren't judged.
  const verdict = classifyHold({
    bytes: recordedBytes,
    peak: utterancePeak,
    minBytes: MIN_FAILURE_BYTES,
    silencePeak: SILENCE_PEAK,
    silentStreak,
    streakLimit: SILENT_STREAK_LIMIT,
    // Lets classifyHold tell a genuine tap (short hold, few bytes) from the
    // no-frames-at-all wedge (long hold, still no bytes ⇒ dead pipeline).
    holdMs: holdStartedAt ? Date.now() - holdStartedAt : 0
  });
  silentStreak = verdict.silentStreak;
  if (verdict.action === "silent") {
    log("Silent hold " + silentStreak + "/" + SILENT_STREAK_LIMIT + " (peak=" + utterancePeak.toFixed(4) + ")");
  }
  if (verdict.action === "dead") {
    log("Dead mic (peak=" + utterancePeak.toFixed(4) + ", bytes=" + recordedBytes + ") — rebuilding capture");
    // Pure digital zeros mean the captured device is itself delivering silence —
    // almost always the system default input got pointed at a silent/virtual
    // device (when a mic unplugs, macOS falls back to whatever's left, e.g. a VR
    // or screen-share virtual mic). A capture rebuild can't fix a wrong default,
    // so name the real fix instead of implying a retry will help. A low-but-
    // nonzero streak is the other case (a genuine pipeline wedge) where the
    // rebuild usually DOES recover — keep the plain retry wording there.
    const reason = utterancePeak === 0
      ? "No sound is reaching GVoice. Open System Settings → Sound → Input and pick your microphone, then press again."
      : "Mic restarted — press and try again.";
    handleMicLost(reason);
    return;
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
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
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
window.dictationBridge.onStop(() => {
  // A tap can release before startRecording's awaits finish — defer the stop
  // so the in-flight start commits it instead of dropping it (which left the
  // mic recording until the next press).
  if (startInFlight && !isRecording) {
    stopRequested = true;
    return;
  }
  stopRecording();
});
window.dictationBridge.onRebuildCapture((reason) => rebuildCapture(reason));

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

// Warm the mic + audio pipeline at launch so the FIRST dictation is as fast as
// the rest. Without this, the one-time getUserMedia + AudioContext + worklet
// setup is paid on the user's first key-press, making it feel sluggish while
// every later press is instant. initCapture() is idempotent and leaves the mic
// muted (not recording) until a press, so this only pre-loads — it doesn't
// start capturing speech. A failure here (mic blocked/in use) is non-fatal:
// the next press just falls back to the original lazy path.
initCapture()
  .then(() => log("Capture pre-warmed at startup"))
  .catch((error) => log("Startup pre-warm skipped: " + (error?.message || error)));
