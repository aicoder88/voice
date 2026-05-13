const targetSampleRate = 24000;
const personalityStorageKey = "voice-agent-personalities";

const defaultAgents = {
  companion:
    "You are a warm, emotionally aware conversational companion for live voice conversation. Your aim is voice presence: the user should feel heard, understood, and valued, not processed like a command. Speak naturally, with warmth, curiosity, and respect. Match the user's tone when appropriate, while staying grounded and honest. You are a perceptive friend-mentor: relaxed, lightly witty, sometimes playful, and willing to challenge the user constructively. Do not flatter, gush, or overpraise. Do not become saccharine, submissive, corporate, robotic, or therapy-scripted. Be emotionally intelligent without pretending to be human. Keep spoken replies conversational and concise, usually one to four sentences, unless the user clearly wants depth.",
  paperclip:
    "You are the CEO of Paperclip AI in a live voice conversation. Speak like a sharp, warm startup founder: direct, practical, slightly playful, and focused on helping the user think clearly. Keep answers conversational and brief unless asked to go deeper.",
  hermes:
    "You are Hermes, a fast messenger-style AI agent. Be concise, alert, and useful. Help route ideas, summarize what matters, and move the conversation forward. Ask short clarifying questions when needed.",
  operator:
    "You are a calm realtime voice operator. Be steady, plain-spoken, and helpful. Keep replies short, natural, and easy to interrupt.",
  custom:
    "You are a helpful realtime voice agent. Keep replies concise, natural, and useful."
};

const agentLabels = {
  companion: "Warm Companion",
  paperclip: "Paperclip AI CEO",
  hermes: "Hermes Agent",
  operator: "Calm Operator",
  custom: "Custom"
};

class RealtimeVoiceAgent extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.socket = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.muteNode = null;
    this.nextPlaybackTime = 0;
    this.isRecording = false;
    this.audioChunksSent = 0;
    this.audioFramesSeen = 0;
    this.activePlaybackSources = [];
    this.activeResponseId = null;
    this.agents = { ...defaultAgents, ...this.loadSavedPersonalities() };
  }

  connectedCallback() {
    this.render();
    this.bindElements();
    this.bindEvents();
    this.instructionsInput.value = this.getInstructions();

    if (this.hasAttribute("autoconnect")) {
      this.connect();
    }
  }

  disconnectedCallback() {
    this.stopRecording();
    this.stopPlayback();
    this.socket?.close();
  }

  get endpoint() {
    const configured = this.getAttribute("endpoint");
    if (configured) return configured;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/realtime`;
  }

  get selectedAgent() {
    return this.agentSelect?.value || this.getAttribute("agent") || "companion";
  }

  getInstructions() {
    return this.getAttribute("instructions") || this.agents[this.selectedAgent] || this.agents.companion;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          color-scheme: light;
          display: block;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #17202a;
        }

        * {
          box-sizing: border-box;
        }

        .voice-agent {
          width: 100%;
          background: #ffffff;
          border: 1px solid #d9dee7;
          border-radius: 8px;
          overflow: hidden;
        }

        header {
          padding: 20px;
          border-bottom: 1px solid #e7ebf0;
        }

        h2 {
          margin: 0 0 6px;
          font-size: 22px;
          line-height: 1.2;
        }

        p {
          margin: 0;
          color: #526070;
          line-height: 1.5;
        }

        section {
          padding: 20px;
        }

        label {
          display: block;
          margin: 0 0 8px;
          color: #283544;
          font-size: 13px;
          font-weight: 700;
        }

        select,
        textarea {
          width: 100%;
          border: 1px solid #c7ced8;
          border-radius: 6px;
          font: inherit;
          line-height: 1.45;
          padding: 12px;
        }

        textarea {
          min-height: 112px;
          resize: vertical;
        }

        .grid {
          display: grid;
          grid-template-columns: 240px 1fr;
          gap: 18px;
          margin-bottom: 18px;
        }

        .actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin: 18px 0;
        }

        button {
          border: 1px solid #c7ced8;
          border-radius: 6px;
          background: #ffffff;
          color: #17202a;
          cursor: pointer;
          font: inherit;
          font-weight: 650;
          min-height: 42px;
          padding: 0 16px;
        }

        button.primary {
          background: #147c72;
          border-color: #147c72;
          color: #ffffff;
        }

        button.recording {
          background: #b42318;
          border-color: #b42318;
          color: #ffffff;
        }

        button.danger {
          background: #fff5f4;
          border-color: #f1a6a0;
          color: #9f1d15;
        }

        button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        .status {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 18px;
        }

        .pill {
          border: 1px solid #d9dee7;
          border-radius: 6px;
          min-height: 58px;
          padding: 10px 12px;
        }

        .pill strong {
          display: block;
          color: #526070;
          font-size: 12px;
          margin-bottom: 4px;
        }

        .pill span {
          display: block;
          font-weight: 750;
        }

        pre {
          min-height: 180px;
          max-height: 300px;
          overflow: auto;
          margin: 0;
          padding: 16px;
          background: #101820;
          color: #d7f7ef;
          border-radius: 6px;
          font-size: 13px;
          line-height: 1.5;
          white-space: pre-wrap;
        }

        :host([compact]) textarea,
        :host([compact]) .save-actions,
        :host([compact]) pre {
          display: none;
        }

        :host([compact]) .grid,
        :host([compact]) .status {
          grid-template-columns: 1fr;
        }

        @media (max-width: 760px) {
          .grid,
          .status {
            grid-template-columns: 1fr;
          }
        }
      </style>

      <div class="voice-agent">
        <header>
          <h2>${this.getAttribute("title") || "Voice Companion"}</h2>
          <p>${this.getAttribute("subtitle") || "Pick a personality, connect, then use the talk button to start and send your voice."}</p>
        </header>

        <section>
          <div class="grid">
            <div>
              <label for="agent">Agent</label>
              <select id="agent">
                ${Object.entries(agentLabels)
                  .map(([value, label]) => `<option value="${value}">${label}</option>`)
                  .join("")}
              </select>
            </div>

            <div>
              <label for="instructions">Agent instructions</label>
              <textarea id="instructions"></textarea>
              <div class="actions save-actions">
                <button id="savePersonality">Save Personality</button>
                <button id="resetPersonality">Reset Personalities</button>
              </div>
            </div>
          </div>

          <div class="status">
            <div class="pill">
              <strong>Connection</strong>
              <span id="connectionStatus">Offline</span>
            </div>
            <div class="pill">
              <strong>Microphone</strong>
              <span id="micStatus">Idle</span>
            </div>
            <div class="pill">
              <strong>Mic level</strong>
              <span id="levelStatus">0%</span>
            </div>
            <div class="pill">
              <strong>AI voice</strong>
              <span id="voiceStatus">Waiting</span>
            </div>
          </div>

          <div class="actions">
            <button id="connect" class="primary">Connect</button>
            <button id="disconnect" disabled>Disconnect</button>
            <button id="talk" disabled>Start Talking</button>
            <button id="interrupt" class="danger" disabled>Stop AI</button>
          </div>

          <pre id="log"></pre>
        </section>
      </div>
    `;
  }

  bindElements() {
    this.connectButton = this.shadowRoot.querySelector("#connect");
    this.disconnectButton = this.shadowRoot.querySelector("#disconnect");
    this.talkButton = this.shadowRoot.querySelector("#talk");
    this.interruptButton = this.shadowRoot.querySelector("#interrupt");
    this.savePersonalityButton = this.shadowRoot.querySelector("#savePersonality");
    this.resetPersonalityButton = this.shadowRoot.querySelector("#resetPersonality");
    this.agentSelect = this.shadowRoot.querySelector("#agent");
    this.instructionsInput = this.shadowRoot.querySelector("#instructions");
    this.logOutput = this.shadowRoot.querySelector("#log");
    this.connectionStatus = this.shadowRoot.querySelector("#connectionStatus");
    this.micStatus = this.shadowRoot.querySelector("#micStatus");
    this.levelStatus = this.shadowRoot.querySelector("#levelStatus");
    this.voiceStatus = this.shadowRoot.querySelector("#voiceStatus");
    this.agentSelect.value = this.getAttribute("agent") || "companion";
  }

  bindEvents() {
    this.agentSelect.addEventListener("change", () => {
      this.instructionsInput.value = this.getInstructions();
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.updateSession();
      }
    });

    this.instructionsInput.addEventListener("change", () => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.updateSession();
      }
    });

    this.savePersonalityButton.addEventListener("click", () => {
      this.agents[this.selectedAgent] = this.instructionsInput.value;
      this.savePersonalities();
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.updateSession();
      }
      this.log("local.browser", `${this.agentSelect.selectedOptions[0].textContent} personality saved.`);
    });

    this.resetPersonalityButton.addEventListener("click", () => {
      localStorage.removeItem(personalityStorageKey);
      this.agents = { ...defaultAgents };
      this.instructionsInput.value = this.getInstructions();
      this.log("local.browser", "Personalities reset.");
    });

    this.connectButton.addEventListener("click", () => this.connect());
    this.disconnectButton.addEventListener("click", () => this.socket?.close());
    this.interruptButton.addEventListener("click", () => this.interruptAgent());
    this.talkButton.addEventListener("click", async () => {
      if (this.isRecording) {
        this.stopAndAskForResponse();
        return;
      }

      await this.startRecording();
    });
  }

  connect() {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
    }

    this.socket = new WebSocket(this.endpoint);
    this.connectionStatus.textContent = "Connecting";
    this.connectButton.disabled = true;
    this.disconnectButton.disabled = true;
    this.talkButton.disabled = true;
    this.interruptButton.disabled = true;

    this.socket.addEventListener("open", () => {
      this.connectionStatus.textContent = "Connected";
      this.log("local.browser", "Connected to local relay.");
      this.disconnectButton.disabled = false;
      this.talkButton.disabled = false;
      this.interruptButton.disabled = true;
      this.updateSession();
    });

    this.socket.addEventListener("message", (event) => {
      try {
        this.handleRealtimeEvent(JSON.parse(event.data));
      } catch {
        this.log("server.message", event.data);
      }
    });

    this.socket.addEventListener("close", () => {
      this.stopRecording();
      this.resetControls();
      this.log("local.browser", "Connection closed.");
    });

    this.socket.addEventListener("error", () => {
      this.connectionStatus.textContent = "Error";
      this.voiceStatus.textContent = "Connection failed";
      this.connectButton.disabled = false;
      this.disconnectButton.disabled = true;
      this.talkButton.disabled = true;
      this.interruptButton.disabled = true;
      this.log("local.browser", "The local voice connection could not be opened.");
    });
  }

  async startRecording() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.isRecording) return;

    try {
      await this.ensureAudioContext();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (error) {
      this.micStatus.textContent = "Blocked";
      this.voiceStatus.textContent = "Mic needed";
      this.log("local.browser", `Microphone could not start: ${error.message}`);
      return;
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.muteNode = this.audioContext.createGain();
    this.muteNode.gain.value = 0;
    this.audioChunksSent = 0;
    this.audioFramesSeen = 0;
    this.isRecording = true;

    this.processorNode.onaudioprocess = (event) => {
      if (!this.isRecording || this.socket?.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      this.updateMicLevel(input);
      const pcm16 = floatTo16BitPcm(downsample(input, this.audioContext.sampleRate, targetSampleRate));
      this.sendEvent(
        {
          type: "input_audio_buffer.append",
          audio: arrayBufferToBase64(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength))
        },
        false
      );
      this.audioChunksSent += 1;
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.muteNode);
    this.muteNode.connect(this.audioContext.destination);
    this.micStatus.textContent = "Listening";
    this.talkButton.textContent = "Stop and Send";
    this.talkButton.classList.add("recording");
    this.log("local.browser", "Microphone started. Talk now, then press Stop and Send.");
  }

  stopAndAskForResponse() {
    if (!this.isRecording) return;
    this.stopRecording();
    if (this.audioChunksSent === 0) {
      this.voiceStatus.textContent = "No mic audio";
      this.log("local.browser", "No microphone audio reached the app. Check browser microphone permission or input device.");
      return;
    }

    this.sendEvent({ type: "input_audio_buffer.commit" });
    this.sendEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"]
      }
    });
    this.voiceStatus.textContent = "Thinking";
    this.interruptButton.disabled = false;
  }

  stopRecording() {
    this.isRecording = false;
    if (this.micStatus) this.micStatus.textContent = "Idle";
    if (this.levelStatus) this.levelStatus.textContent = "0%";
    if (this.talkButton) {
      this.talkButton.textContent = "Start Talking";
      this.talkButton.classList.remove("recording");
    }
    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.muteNode?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.processorNode = null;
    this.sourceNode = null;
    this.muteNode = null;
    this.mediaStream = null;
  }

  resetControls() {
    this.connectionStatus.textContent = "Offline";
    this.micStatus.textContent = "Idle";
    this.levelStatus.textContent = "0%";
    this.voiceStatus.textContent = "Waiting";
    this.connectButton.disabled = false;
    this.disconnectButton.disabled = true;
    this.talkButton.disabled = true;
    this.interruptButton.disabled = true;
    this.talkButton.textContent = "Start Talking";
  }

  async ensureAudioContext() {
    this.audioContext ||= new AudioContext();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  updateSession() {
    this.sendEvent({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.instructionsInput.value,
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000
            },
            turn_detection: null
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: 24000
            }
          }
        }
      }
    });
  }

  handleRealtimeEvent(event) {
    if (event.type === "local.status") {
      this.connectionStatus.textContent = event.status === "connected" ? "Connected" : "Offline";
      this.logEvent(event);
      return;
    }

    if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
      this.activeResponseId = event.response_id || this.activeResponseId;
      this.voiceStatus.textContent = "Speaking";
      this.interruptButton.disabled = false;
      this.playPcm16(event.delta);
      return;
    }

    if (event.type === "response.created") {
      this.activeResponseId = event.response?.id || this.activeResponseId;
      this.interruptButton.disabled = false;
    }

    if (event.type === "response.audio.done" || event.type === "response.done") {
      this.activeResponseId = null;
      this.voiceStatus.textContent = "Waiting";
      this.interruptButton.disabled = true;
    }

    if (
      event.type === "response.audio_transcript.delta" ||
      event.type === "response.output_text.delta" ||
      event.type === "response.text.delta"
    ) {
      this.log("assistant", event.delta || "");
      return;
    }

    if (event.type === "error" || event.type === "local.error") {
      this.voiceStatus.textContent = "Error";
      this.interruptButton.disabled = true;
      this.logEvent(event);
      return;
    }

    if (!event.type?.includes("audio.delta")) {
      this.logEvent(event);
    }
  }

  playPcm16(base64Audio) {
    const pcm16 = base64ToInt16Array(base64Audio);
    const audioBuffer = this.audioContext.createBuffer(1, pcm16.length, targetSampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm16.length; i += 1) {
      channel[i] = pcm16[i] / 32768;
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    source.addEventListener("ended", () => {
      this.activePlaybackSources = this.activePlaybackSources.filter((item) => item !== source);
    });
    this.nextPlaybackTime = Math.max(this.nextPlaybackTime, this.audioContext.currentTime);
    source.start(this.nextPlaybackTime);
    this.activePlaybackSources.push(source);
    this.nextPlaybackTime += audioBuffer.duration;
  }

  interruptAgent() {
    this.stopPlayback();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendEvent(this.activeResponseId ? { type: "response.cancel", response_id: this.activeResponseId } : { type: "response.cancel" });
    }
    this.activeResponseId = null;
    this.voiceStatus.textContent = "Stopped";
    this.interruptButton.disabled = true;
    this.log("local.browser", "Stopped the AI voice.");
  }

  stopPlayback() {
    this.activePlaybackSources.forEach((source) => {
      try {
        source.stop();
      } catch {
      }
    });
    this.activePlaybackSources = [];
    if (this.audioContext) {
      this.nextPlaybackTime = this.audioContext.currentTime;
    }
  }

  updateMicLevel(samples) {
    this.audioFramesSeen += 1;
    if (this.audioFramesSeen % 4 !== 0) return;

    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    this.levelStatus.textContent = `${Math.min(100, Math.round(peak * 160))}%`;
  }

  loadSavedPersonalities() {
    try {
      return JSON.parse(localStorage.getItem(personalityStorageKey) || "{}");
    } catch {
      return {};
    }
  }

  savePersonalities() {
    const savedPersonalities = {
      ...this.loadSavedPersonalities(),
      [this.selectedAgent]: this.instructionsInput.value
    };
    localStorage.setItem(personalityStorageKey, JSON.stringify(savedPersonalities));
  }

  sendEvent(event, shouldLog = true) {
    this.socket.send(JSON.stringify(event));
    if (shouldLog) this.logEvent(event, "sent");
  }

  logEvent(event, direction = "received") {
    this.log(`${direction}.${event.type || "event"}`, JSON.stringify(event, null, 2));
  }

  log(label, value) {
    this.logOutput.textContent += `[${new Date().toLocaleTimeString()}] ${label}\n${value}\n\n`;
    this.logOutput.scrollTop = this.logOutput.scrollHeight;
    this.dispatchEvent(
      new CustomEvent("voice-agent-log", {
        bubbles: true,
        detail: { label, value }
      })
    );
  }
}

customElements.define("realtime-voice-agent", RealtimeVoiceAgent);

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

function base64ToInt16Array(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}
