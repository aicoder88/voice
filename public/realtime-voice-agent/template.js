import { agentLabels } from "./agents.js";

export function renderTemplate({ title, subtitle }) {
  return `
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
          <h2>${title || "Voice Companion"}</h2>
          <p>${subtitle || "Pick a personality, connect, then use the talk button to start and send your voice."}</p>
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
