import {
  agentLabels,
  clearSavedPersonalities,
  defaultAgents,
  loadSavedPersonalities,
  savePersonality
} from "./realtime-voice-agent/agents.js";
import {
  arrayBufferToBase64,
  base64ToInt16Array,
  downsample,
  floatTo16BitPcm
} from "./realtime-voice-agent/audio-utils.js";
import { renderTemplate } from "./realtime-voice-agent/template.js";

const targetSampleRate = 24000;

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
    this.agents = { ...defaultAgents, ...loadSavedPersonalities() };
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
    this.shadowRoot.innerHTML = renderTemplate({
      title: this.getAttribute("title"),
      subtitle: this.getAttribute("subtitle")
    });
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
      savePersonality(this.selectedAgent, this.instructionsInput.value);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.updateSession();
      }
      this.log("local.browser", `${this.agentSelect.selectedOptions[0].textContent} personality saved.`);
    });

    this.resetPersonalityButton.addEventListener("click", () => {
      clearSavedPersonalities();
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
