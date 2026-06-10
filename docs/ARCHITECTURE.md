# Architecture

Snapshot of the current code, not a delivery plan. Update when files move.

This repo has two product surfaces sharing one relay:

1. **Reusable realtime relay + `<realtime-voice-agent>` web component** — drop-in voice agent for any web app. The wire contract is in [`RELAY_PROTOCOL.md`](./RELAY_PROTOCOL.md); the component itself lives in `public/realtime-voice-agent.js`.
2. **Electron push-to-talk dictation app** — hold a global key anywhere on the OS, speak, release, the transcript types itself into the focused field. Documented in `SETUP.md`.

Both surfaces use the same relay (`realtime-relay.js`) and the same `/realtime` WebSocket protocol. The wire contract is specified in `RELAY_PROTOCOL.md`.

## Diagram (dictation flow)

```
   Hotkey held (right Option / Ctrl+Shift)
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
            │         (transcription mode)          (local CLI / server)
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

- **`main.js`** — Electron main process. Boots the relay, creates the windows (boot splash, floating pill, hidden dictation worker, dictionary pop-up, dictionary manager, Settings), registers the global hotkey, owns dictation session state, routes the final transcript through cleanup + typing.
- **`server.js`** — Tiny HTTP server: serves `public/` statically and attaches the relay. Exports `startServer({ port?, model? }) → Promise<{ server, port }>`. Falls back to a free port if the configured one is busy. Runs standalone when invoked directly (`npm run dev`).
- **`realtime-relay.js`** — The relay. Exports `attachRealtimeRelay(server, options)`. Upgrades WebSocket connections at the configured path and dispatches to one of three transports (in `src/providers/`) based on the `?provider=` query param: `openai` (default), `deepgram`, `whisper-local`. Each transport translates the browser's wire frames into provider-specific calls and translates results back into the OpenAI-style transcription frames the browser expects.
- **`package.json`** — `npm run dev` runs the relay-only server; `npm start` runs Electron; `npm run build` packages with electron-builder.

### `src/` (Electron-side helpers)

- **`hotkey.js`** — Platform-split hotkey detector. Windows: polls physical key state via Win32 `GetAsyncKeyState` (~30 Hz) and fires on Ctrl+Shift (either side). macOS/Linux: `uiohook-napi` event stream; right Option, left Ctrl+Cmd chord, or the mouse back button all hold-to-talk. Right-Ctrl tap toggles language on both platforms.
- **`hotkey-logic.js`** — Pure press/release/tap state machines shared by both hotkey backends, unit-tested with an injectable clock.
- **`foreground.js`** — Win32 FFI helpers: capture/restore the focused window around a dictation, anchor the pill to it, and read raw key state for the Windows hotkey poll.
- **`typing.js`** — Injects the final transcript into the focused field. Default path: write to clipboard, fire Cmd/Ctrl+V via `@nut-tree-fork/nut-js`, restore the previous clipboard after 250 ms. Fallback path (`TYPE_VIA_CLIPBOARD=false`): direct synthetic keystrokes.
- **`cleanup.js`** — Optional LLM polish pass. Provider-agnostic (OpenAI / Groq / Anthropic / Google). Long system prompt enforces paragraph + list rules; preserves language and every dictated sentence. Returns raw text on any error.
- **`dictation-session.js`** — Push-to-talk session state (busy flag, press/release timestamps, safety timer). One instance per main process.
- **`bootstrap-env.js`** — Boot-time `.env` loading. Imported first from `main.js` so a packaged app launched from Finder still finds its environment.
- **`settings.js`** — Settings store backing the Settings window. The one module that edits the `.env` file, surgically (existing keys updated in place, comments preserved).
- **`history.js`** — The last 50 transcripts, persisted to a JSON file in userData. Feeds the tray's "Recent dictations" menu.
- **`recordings.js`** — Saved dictation audio: writes clips, prunes by count cap (50) and age cap (`RECORDING_RETENTION_DAYS`).
- **`retry.js`** — One-retry helper for the HTTP calls (cleanup pass, whisper-server POST) so a single 429/5xx doesn't fail a dictation.
- **`vocab.js`** — Custom dictionary store, shared by the main process and the relay providers (same Node process).
- **`correction-watch.js`** — Watches the keystroke stream for a hand-typed fix right after a dictation (macOS/Linux) to suggest dictionary entries.
- **`hardware.js`** / **`benchmark.js`** / **`benchmark-run.js`** — The on-device engine decision chain: a cheap capability probe, the pure "fast enough vs cloud?" verdict, and the live timed transcription that feeds it.
- **`model-download.js`** — On-demand download of whisper.cpp binaries + GGML models for the guided on-device setup in Settings.

### `src/providers/` (relay transports)

- **`_shared.js`** — Frame send helpers shared by the transports.
- **`openai.js`** — OpenAI Realtime passthrough; switches the session into transcription-only mode for the dictation models.
- **`deepgram.js`** — Deepgram streaming; runs parallel per-language legs for `auto` language (see `RELAY_PROTOCOL.md`).
- **`whisper-local.js`** — Local whisper.cpp: owns the `whisper-server` child process, silence gate, hallucination sanitizer.

### `public/` (browser-side)

- **`index.html`** — Demo page that mounts the reusable web component.
- **`realtime-voice-agent.js`** — `<realtime-voice-agent>` custom element. Self-contained shadow-DOM UI: agent personality selector, instructions textarea, mic capture, WebSocket lifecycle, PCM playback queue. Public attributes: `endpoint`, `agent`, `compact`, `instructions`, `autoconnect`.
- **`pill.html`** — Frameless transparent always-on-top "Listening…" indicator shown near the cursor while the hotkey is held.
- **`dictation.html` + `dictation.js`** — Hidden Electron renderer that captures the microphone, downsamples to 24 kHz PCM16, streams it to the relay over `/realtime?provider=...`, and forwards the final transcript to `main.js` over IPC.
- **`audio-capture-worklet.js`** — The `AudioWorklet` processor that does the capture/downsample work for the dictation renderer.
- **`mic-health.js`** — Pure decision logic for spotting a dead mic pipeline (the post-sleep "all zeros" failure); the renderer rebuilds capture on the next press when it trips.
- **`splash.html`** — Boot splash card; reports startup progress, then tucks itself into the tray icon.
- **`settings.html`** — The Settings window (engine choice, keys, cleanup, recordings privacy, on-device engine setup/benchmark).
- **`dictionary.html`** — The "Manage dictionary…" window.
- **`vocab-prompt.html`** — The small "Add to dictionary?" pop-up shown near the cursor.

### `scripts/`

- **`cleanup-test.js`** — Ad-hoc test harness for `src/cleanup.js`. Runs eight named cases through `polishTranscript` and prints pass/fail.
- **`parity/`** — Parity test harness for refactor passes. `dictation-flow.test.js` boots `startServer()`, opens a WS client, feeds a recorded PCM fixture, and asserts the emitted frame sequence per provider. Fixtures in `parity/fixtures/`.
- **`unit/`** — Node-runner unit tests for the pure modules (hotkey logic, mic health, benchmark verdicts, …).
- **`setup-whisper-windows.ps1`** — Downloads whisper.cpp binaries + a model on Windows (the manual alternative to the guided setup in Settings).

## Process model (Electron app)

| Process            | Code                                              | Lifetime                       |
| ------------------ | ------------------------------------------------- | ------------------------------ |
| Main (Node)        | `main.js`, `server.js`, `realtime-relay.js`, `src/*` | App lifetime                   |
| Dictation renderer | `public/dictation.html` + `dictation.js`          | App lifetime (hidden)          |
| Pill window        | `public/pill.html`                                | App lifetime (shown on press)  |
| Splash window      | `public/splash.html`                              | Boot only                      |
| Settings / dictionary / vocab pop-up | `public/settings.html`, `dictionary.html`, `vocab-prompt.html` | Opened on demand |
| whisper.cpp server | `whisper-server` child process                    | Only when `STT_PROVIDER=whisper-local` |

## Dictation lifecycle

1. `src/hotkey.js` fires `onPress`.
2. `main.js` shows the pill near the cursor and sends IPC `dictation:start` to the hidden renderer.
3. `public/dictation.js` opens the mic, opens a WS to `/realtime?provider=...`, streams PCM frames.
4. User releases the key. `main.js` sends IPC `dictation:stop`, flips the pill to "Transcribing…", and the session arms a safety timer (25 s, outliving the renderer’s 20 s watchdog; `src/dictation-session.js`) so a renderer that never reports back can't jam the next press.
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
| `WHISPER_BIN`             | `whisper-cli` (`WHISPER_CLI` accepted as legacy alias) | relay, main |
| `WHISPER_MODEL`           | `./models/ggml-small.en-q5_1.bin` | relay, main           |
| `WHISPER_PORT`            | free port picked each launch (set to pin one) | whisper-local provider |
| `WHISPER_SERVER_URL`      | (set by the provider once whisper-server is up) | relay   |
| `WHISPER_SILENCE_PEAK`    | `500` (int16 peak; `0` disables the silence gate) | whisper-local provider |
| `CLEANUP_ENABLED`         | `true`                           | main                   |
| `CLEANUP_PROVIDER`        | implicit (groq if key, else openai) | cleanup             |
| `CLEANUP_MODEL`           | provider-specific                | cleanup                |
| `CLEANUP_TIMEOUT_MS`      | `6000`                           | cleanup                |
| `GROQ_API_KEY`            | —                                | cleanup                |
| `ANTHROPIC_API_KEY`       | —                                | cleanup                |
| `GOOGLE_AI_KEY`           | —                                | cleanup                |
| `TYPE_VIA_CLIPBOARD`      | `true`                           | typing                 |
| `TYPE_RELEASE_DELAY_MS`   | `80`                             | typing                 |
