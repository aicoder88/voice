# GVoice - Setup

Push-to-talk dictation. Hold **Ctrl+Shift** (either side) anywhere on Windows — or **right Option** on macOS — speak, release: the transcript types itself into the focused text field.

## One-time setup

### Option A — Local Whisper on Windows (no per-clip API cost)

Runs the whole pipeline on your PC: a small Whisper model transcribes the clip, optional cleanup model polishes it.

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Download whisper.cpp binaries + GGML model. From the repo root:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup-whisper-windows.ps1
   ```
   Pulls ~400 MB of CUDA binaries into `bin\` and a ~190 MB multilingual quantized model into `models\`. Re-runnable — skips files that already exist. CPU-only machines: add `-Variant cpu`. Different model: `-Model ggml-small.en-q5_1.bin` etc.
3. Confirm `.env` has these lines (the setup script prints the right values at the end):
   ```
   STT_PROVIDER=whisper-local
   WHISPER_BIN=C:\dev\voice\bin\whisper-cli.exe
   WHISPER_MODEL=C:\dev\voice\models\ggml-small-q5_1.bin
   ```
4. (Optional) For LLM cleanup, paste an Anthropic or OpenAI key in `.env`. Without one, raw Whisper text is typed as-is.

> Prefer not to touch the terminal? The Settings window (tray → **Settings…**) has an "On-device engine" panel that downloads the binaries and a model for you, runs a speed test on your machine, and switches the engine over — no script needed.

### Option B — OpenAI Realtime (Mac or Windows, pay per clip)

1. Open `.env` and paste your OpenAI API key after `OPENAI_API_KEY=`.
2. Set `STT_PROVIDER=openai` (or leave unset — openai is the default).
3. Install dependencies if you haven't:
   ```
   npm install
   ```

### Option C — Deepgram (Mac or Windows, pay per clip)

Fast cloud streaming transcription. Good language coverage and very low latency.

1. Get an API key at [console.deepgram.com](https://console.deepgram.com) (free credit on signup, no card needed).
2. In `.env`:
   ```
   STT_PROVIDER=deepgram
   DEEPGRAM_API_KEY=your-key-here
   ```
3. (Optional) `DEEPGRAM_MODEL` picks the model — default `nova-3`.

## Run

```
cd C:\dev\voice
npm start
```

An Electron window opens with status info. A tray icon shows up in the system tray (bottom-right of the Windows taskbar - click the small `^` to find it if hidden).

## Use

1. Click into any text field anywhere on your computer (Word, Slack, Chrome address bar, terminal, code editor - anything).
2. **Hold Ctrl+Shift** (Windows) or **right Option** (macOS). A floating "Listening..." pill appears.
3. Speak. The mic is open.
4. **Release the keys.** Pill disappears, transcript is cleaned up by a small LLM, then typed into the focused field via clipboard paste.

## Settings (edit `.env`)

| Variable | Default | What it does |
|---|---|---|
| `STT_PROVIDER` | `openai` | `openai`, `whisper-local`, or `deepgram`. Picks which speech-to-text backend the dictation window opens. |
| `OPENAI_API_KEY` | *(empty)* | Required for `openai` provider and (by default if no Groq key) for cleanup. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2` | Realtime session model when `STT_PROVIDER=openai`. |
| `DEEPGRAM_API_KEY` | *(empty)* | Required for the `deepgram` provider. Get one at console.deepgram.com. |
| `DEEPGRAM_MODEL` | `nova-3` | Deepgram model. |
| `WHISPER_BIN` | `whisper-cli` | Full path to whisper.cpp's `whisper-cli.exe`. Set by the Windows setup script. (`WHISPER_CLI` is accepted as a legacy alias.) |
| `WHISPER_MODEL` | `./models/ggml-small.en-q5_1.bin` | Full path to a GGML model file. Set by the Windows setup script. |
| `WHISPER_PORT` | *(free port each launch)* | Port the whisper-server child process listens on. Picked automatically; set this only to pin a fixed port. |
| `CLEANUP_ENABLED` | `true` | LLM polish (punctuation, remove "um"/"uh"). |
| `CLEANUP_PROVIDER` | `groq` if `GROQ_API_KEY` is set, else `openai` | Which API runs the cleanup pass: `groq`, `openai`, `anthropic`, or `google`. |
| `CLEANUP_MODEL` | *(per provider)* | Cleanup model. Defaults: `llama-3.3-70b-versatile` (groq), `gpt-4.1-mini` (openai), `claude-haiku-4-5` (anthropic), `gemini-2.5-flash-lite` (google). |
| `TYPE_VIA_CLIPBOARD` | `true` | Paste vs simulated keystrokes. Paste is faster and more reliable. |
| `PORT` | `3000` | Local relay port. |
| `GVOICE_CORRECTION_WATCH_MS` | `12000` | How long after a dictation GVoice watches for a hand-typed correction (macOS/Linux). Set to `0` to turn manual-edit suggestions off. |
| `GVOICE_DEBUG` | *(off)* | Set to `1` to echo per-event traces (presses, paste timing, cleanup) to the console. They're always written to the app-data `debug.log` regardless (macOS: `~/Library/Application Support/GVoice/debug.log`). |

## Custom dictionary

GVoice keeps a list of names and made-up words it should spell exactly, and feeds it to whichever engine you use (Whisper's initial prompt, Deepgram's keyterm boosting, OpenAI's transcription prompt). This is what makes the engine *produce* an unusual word instead of guessing a real one in its place.

- **Add your own words.** Tray menu → **Manage dictionary…** opens a window where you type in brands, people, and coined terms (one at a time, or several comma-separated). This is the dependable fix for words the engine mishears: a made-up word is transcribed as something else, so you seed the correct spelling and the engine biases toward it on the next dictation.
- **Or let it suggest.** After a dictation, if GVoice sees an unusual capitalized name it typed — or notices you immediately retyping a word it got wrong — a small pop-up appears at your cursor: *Add "Estefania" to your dictionary?* Click **Add** or **No thanks**.
- **It asks once.** A "No thanks" is remembered forever; a word is never suggested twice.
- **Deepgram boosting is English-only** (a Deepgram limitation). Whisper biasing works in every language. The dictionary is stored per-user in the app's data folder, not in the repo.

A hand-curated starter list lives in `models/vocab.txt` (used by the local Whisper engine); the manager and the pop-up write to the separate per-user store.

## Languages

Whisper supports 57+ languages including English, French, Croatian, Bosnian, Serbian, Spanish, Italian, German, and more. It auto-detects per chunk - you can switch mid-sentence.

## Troubleshooting

**Window opens but says "Missing OPENAI_API_KEY"** - paste your key in `C:\dev\voice\.env` and relaunch.

**Hotkey doesn't fire** - check the Electron console for `Failed to start global hotkey`. On macOS/Linux, if `uiohook-napi` failed to load, run `npx electron-rebuild`. On macOS, also make sure the app has Accessibility permission (System Settings → Privacy & Security → Accessibility).

**Typing doesn't insert text** - some apps block synthetic clipboard paste. Set `TYPE_VIA_CLIPBOARD=false` to fall back to direct keystrokes.

**Pill doesn't appear** - the pill is a frameless always-on-top window. Some fullscreen apps (games, video players) suppress it. The transcript still types.

## How it works

```
Hotkey held (Ctrl+Shift / right Option)
   |
   v
main.js (Electron)  ----IPC---->  dictation.js (hidden window)
   |                                      |
   | shows pill                           | opens mic, streams PCM
   |                                      v
   |                          ws://localhost:<port>/realtime
   |                            ?model=gpt-realtime-whisper        (openai)
   |                            ?provider=deepgram&language=...    (deepgram)
   |                            ?provider=whisper-local            (whisper-local)
   |                                      |
   |                                      v
   |                          realtime-relay.js <--> OpenAI / Deepgram / whisper.cpp
   |                                      |
   |                                      | transcript events
   |                                      v
   |                          dictation.js accumulates
   |
Hotkey released
   |
   v
dictation.js commits buffer, IPC sends final transcript
   |
   v
main.js -> cleanup.js (LLM polish) -> typing.js (clipboard paste) -> focused app
```

The relay listens on `PORT` (default 3000); if that port is busy it falls back to a free one, so the actual port can vary per launch.

## Files

- `main.js` - Electron main process, hotkey, tray, IPC, typing
- `server.js` - HTTP + WebSocket relay server
- `realtime-relay.js` - reusable WS relay; dispatches each connection to a provider
- `src/providers/` - one transport per speech engine (`openai`, `deepgram`, `whisper-local`)
- `src/hotkey.js` - global hotkey listener (Ctrl+Shift polling on Windows, uiohook on macOS/Linux)
- `src/typing.js` - keystroke / clipboard-paste output (nut-js)
- `src/cleanup.js` - LLM polish pass
- `public/pill.html` - floating "Listening..." indicator
- `public/dictation.html` + `dictation.js` - hidden mic + WS client
