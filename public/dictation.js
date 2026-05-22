const { ipcRenderer } = require("electron");

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
let transcriptParts = [];
let lastFinalAt = 0;

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function ensureSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;
  if (socket && socket.readyState === WebSocket.CONNECTING) return socket;

  return new Promise((resolve, reject) => {
    const url = `ws://${window.location.host}/realtime?model=gpt-realtime-whisper`;
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      log("WS open (whisper)");
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                turn_detection: null,
                transcription: { model: "gpt-realtime-whisper" }
              }
            }
          }
        })
      );
      resolve(socket);
    });
    socket.addEventListener("error", (e) => {
      log("WS error");
      reject(e);
    });
    socket.addEventListener("close", () => {
      log("WS closed");
      socket = null;
    });
    socket.addEventListener("message", (event) => {
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
    ipcRenderer.send("dictation:error", msg.error?.message || msg.message || "unknown error");
  }
}

function finalizeAndSend(text) {
  log("Final: " + text);
  ipcRenderer.send("dictation:transcript", text);
  transcriptParts = [];
}

async function startRecording() {
  if (isRecording) return;
  setStatus("Connecting…");
  try {
    await ensureSocket();
  } catch {
    setStatus("WS failed");
    ipcRenderer.send("dictation:error", "Could not connect to relay");
    return;
  }

  try {
    audioContext = audioContext || new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (error) {
    setStatus("Mic blocked");
    ipcRenderer.send("dictation:error", "Microphone not available: " + error.message);
    return;
  }

  transcriptParts = [];
  isRecording = true;
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  muteNode = audioContext.createGain();
  muteNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    if (!isRecording || !socket || socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPcm(downsample(input, audioContext.sampleRate, targetSampleRate));
    socket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: arrayBufferToBase64(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength))
      })
    );
  };

  sourceNode.connect(processorNode);
  processorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);
  setStatus("Listening");
  log("Mic started");
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  setStatus("Finalizing…");
  log("Mic stopped, committing buffer");

  try {
    processorNode?.disconnect();
    sourceNode?.disconnect();
    muteNode?.disconnect();
    mediaStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  processorNode = null;
  sourceNode = null;
  muteNode = null;
  mediaStream = null;

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  const startedAt = Date.now();
  setTimeout(() => {
    if (lastFinalAt < startedAt && transcriptParts.length > 0) {
      finalizeAndSend(transcriptParts.join("").trim());
    }
    setStatus("Idle");
  }, 2500);
}

ipcRenderer.on("dictation:start", () => startRecording());
ipcRenderer.on("dictation:stop", () => stopRecording());

function downsample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    output[i] = input[Math.floor(i * ratio)];
  }
  return output;
}

function floatTo16BitPcm(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return pcm16;
}

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
