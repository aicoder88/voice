# Architecture

Snapshot of the current code, not a delivery plan. Update when files move.

> Currently mid-refactor — see [`REFACTOR.md`](./REFACTOR.md) for which passes have landed and what's next.

This repo has two product surfaces sharing one relay:

1. **Reusable realtime relay + `<realtime-voice-agent>` web component** — drop-in voice agent for any web app. Documented in the top-level `README.md`.
2. **Electron push-to-talk dictation app** — hold a global key anywhere on the OS, speak, release, the transcript types itself into the focused field. Documented in `SETUP.md`.

Both surfaces use the same relay (`realtime-relay.js`) and the same `/realtime` WebSocket protocol. The wire contract is specified in `RELAY_PROTOCOL.md`.

## Diagram (dictation flow)

```
   Right Alt held
         |
         v
 ┌─────────────────────┐         ┌──────────────────────┐
 │ main.js (Electron)  │── IPC ─▶│ public/dictation.js  │
 │  - hotkey listener  │         │  (hidden renderer)   │
 │  - pill window      │         │  - mic capture       │
 │  - tray + menus     │         │  - PCM downsample    │
 │  - session state    │         │  - WS to relay       │
 └─────────────────────┘         └──────────┬───────────┘
            ▲                                │  ws://localhost:PORT/realtime
            │ ipc: dictation:transcript      ▼
            │                       ┌──────────────────────┐
            │                       │ realtime-relay.js    │
            │                       │  routes by provider  │
            │                       └─────┬────────┬───────┘
            │                             │        │
            │                  ┌──────────┘        └──────────┐
            │                  ▼                              ▼
            │         OpenAI Realtime API           Deepgram or whisper.cpp
            │         (gpt-realtime-whisper)        (local CLI / server)
            │
            ▼
   ┌────────────────┐         ┌──────────────────┐
   │ src/cleanup.js │────────▶│ src/typing.js    │
   │  LLM polish    │         │  clipboard paste │
   └────────────────┘         └──────────────────┘
                                       │
                                       ▼
                              Focused app receives text
```

## File map

### Top-level

- **`main.js`** — Electron main process. Boots the relay, creates the three windows (setup UI, hidden dictation worker, floating pill), registers the global hotkey, owns dictation session state, routes the final transcript through cleanup + typing.
- **`server.js`** — Tiny HTTP server: serves `public/` statically and attaches the relay. Exports `startServer({ port?, model? }) → Promise<{ server, port }>`. Falls back to a free port if the configured one is busy. Runs standalone when invoked directly (`npm run dev`).
- **`realtime-relay.js`** — The relay. Exports `attachRealtimeRelay(server, options)`. Upgrades WebSocket connections at the configured path and dispatches to one of three transports based on the `?provider=` query param: `openai` (default), `deepgram`, `whisper-local`. Each transport translates the browser's wire frames into provider-specific calls and translates results back into the OpenAI-style transcription frames the browser expects.
- **`package.json`** — `npm run dev` runs the relay-only server; `npm start` runs Electron; `npm run build` packages with electron-builder.

### `src/` (Electron-side helpers)

- **`hotkey.js`** — Wraps `uiohook-napi`. Watches for press/release of right-Alt (or platform-equivalent Option) and fires the callbacks supplied by `main.js`.
- **`typing.js`** — Injects the final transcript into the focused field. Default path: write to clipboard, fire Cmd/Ctrl+V via `@nut-tree-fork/nut-js`, restore the previous clipboard after 250 ms. Fallback path (`TYPE_VIA_CLIPBOARD=false`): direct synthetic keystrokes.
- **`cleanup.js`** — Optional LLM polish pass. Provider-agnostic (OpenAI / Groq / Anthropic / Google). Long system prompt enforces paragraph + list rules; preserves language and every dictated sentence. Returns raw text on any error.

### `public/` (browser-side)

- **`index.html`** — Demo page that mounts the reusable web component.
- **`realtime-voice-agent.js`** — `<realtime-voice-agent>` custom element. Self-contained shadow-DOM UI: agent personality selector, instructions textarea, mic capture, WebSocket lifecycle, PCM playback queue. Public attributes: `endpoint`, `agent`, `compact`, `instructions`, `autoconnect`.
- **`pill.html`** — Frameless transparent always-on-top "Listening…" indicator shown near the cursor while the hotkey is held.
- **`dictation.html` + `dictation.js`** — Hidden Electron renderer that captures the microphone, downsamples to 24 kHz PCM16, streams it to the relay over `/realtime?provider=...`, and forwards the final transcript to `main.js` over IPC.

### `scripts/`

- **`cleanup-test.js`** — Ad-hoc test harness for `src/cleanup.js`. Runs eight named cases through `polishTranscript` and prints pass/fail.
- **`parity/`** — Parity test harness for refactor passes. `dictation-flow.test.js` boots `startServer()`, opens a WS client, feeds a recorded PCM fixture, and asserts the emitted frame sequence per provider. Fixtures in `parity/fixtures/`.

## Process model (Electron app)

| Process            | Code                                              | Lifetime                       |
| ------------------ | ------------------------------------------------- | ------------------------------ |
| Main (Node)        | `main.js`, `server.js`, `realtime-relay.js`, `src/*` | App lifetime                   |
| Dictation renderer | `public/dictation.html` + `dictation.js`          | App lifetime (hidden)          |
| Pill window        | `public/pill.html`                                | App lifetime (shown on press)  |
| whisper.cpp server | `whisper-server` child process                    | Only when `STT_PROVIDER=whisper-local` |

## Dictation lifecycle

1. `src/hotkey.js` fires `onPress`.
2. `main.js` shows the pill near the cursor and sends IPC `dictation:start` to the hidden renderer.
3. `public/dictation.js` opens the mic, opens a WS to `/realtime?provider=...`, streams PCM frames.
4. User releases the key. `main.js` sends IPC `dictation:stop`, hides the pill, arms a 1.5 s safety timer.
5. `public/dictation.js` sends `input_audio_buffer.commit`, waits for `conversation.item.input_audio_transcription.completed`, IPC-sends `dictation:transcript`.
6. `main.js` optionally runs cleanup, then types the result via `src/typing.js`.

## Environment variables

| Variable                  | Default                          | Used by                |
| ------------------------- | -------------------------------- | ---------------------- |
| `OPENAI_API_KEY`          | *(required)*                     | relay, cleanup         |
| `OPENAI_REALTIME_MODEL`   | `gpt-realtime-2`                 | relay                  |
| `PORT`                    | `3000`                           | server                 |
| `STT_PROVIDER`            | `openai`                         | relay, dictation       |
| `DEEPGRAM_API_KEY`        | —                                | relay (Deepgram)       |
| `DEEPGRAM_MODEL`          | `nova-3`                         | relay (Deepgram)       |
| `WHISPER_CLI`             | `whisper-cli`                    | relay, main            |
| `WHISPER_MODEL`           | `./models/ggml-base.en.bin`      | relay, main            |
| `WHISPER_PORT`            | `8081`                           | main                   |
| `WHISPER_SERVER_URL`      | (derived from `WHISPER_PORT`)    | relay                  |
| `CLEANUP_ENABLED`         | `true`                           | main                   |
| `CLEANUP_PROVIDER`        | implicit (groq if key, else openai) | cleanup             |
| `CLEANUP_MODEL`           | provider-specific                | cleanup                |
| `CLEANUP_TIMEOUT_MS`      | `6000`                           | cleanup                |
| `GROQ_API_KEY`            | —                                | cleanup                |
| `ANTHROPIC_API_KEY`       | —                                | cleanup                |
| `GOOGLE_AI_KEY`           | —                                | cleanup                |
| `TYPE_VIA_CLIPBOARD`      | `true`                           | typing                 |
| `TYPE_RELEASE_DELAY_MS`   | `80`                             | typing                 |
