# GVoice - Setup

Push-to-talk dictation. Hold **Right Alt** anywhere on Windows, speak, release - the transcript types itself into the focused text field.

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

### Option B — OpenAI Realtime (Mac or Windows, pay per clip)

1. Open `.env` and paste your OpenAI API key after `OPENAI_API_KEY=`.
2. Set `STT_PROVIDER=openai` (or leave unset — openai is the default).
3. Install dependencies if you haven't:
   ```
   npm install
   ```

## Run

```
cd C:\dev\voice
npm start
```

An Electron window opens with status info. A tray icon shows up in the system tray (bottom-right of the Windows taskbar - click the small `^` to find it if hidden).

## Use

1. Click into any text field anywhere on your computer (Word, Slack, Chrome address bar, terminal, code editor - anything).
2. **Hold Right Alt.** A floating "Listening..." pill appears.
3. Speak. The mic is open.
4. **Release Right Alt.** Pill disappears, transcript is cleaned up by a small LLM, then typed into the focused field via clipboard paste.

## Settings (edit `.env`)

| Variable | Default | What it does |
|---|---|---|
| `STT_PROVIDER` | `openai` | `openai`, `whisper-local`, or `deepgram`. Picks which speech-to-text backend the dictation window opens. |
| `OPENAI_API_KEY` | *(empty)* | Required for `openai` provider and (by default) for cleanup. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-whisper` | Speech-to-text model when `STT_PROVIDER=openai`. |
| `WHISPER_BIN` | `whisper-cli` | Full path to whisper.cpp's `whisper-cli.exe`. Set by the Windows setup script. |
| `WHISPER_MODEL` | `./models/ggml-small.en-q5_1.bin` | Full path to a GGML model file. Set by the Windows setup script. |
| `WHISPER_PORT` | `8081` | Port the whisper-server child process listens on. |
| `CLEANUP_ENABLED` | `true` | LLM polish (punctuation, remove "um"/"uh"). |
| `CLEANUP_MODEL` | `gpt-4.1-nano` | Cleanup model. Cheap and fast. |
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

**Hotkey doesn't fire** - check the Electron console for `Failed to start global hotkey`. If `uiohook-napi` failed to load, install Visual Studio Build Tools (C++ workload) and run `npx electron-rebuild`.

**Typing doesn't insert text** - some apps block synthetic clipboard paste. Set `TYPE_VIA_CLIPBOARD=false` to fall back to direct keystrokes.

**Pill doesn't appear** - the pill is a frameless always-on-top window. Some fullscreen apps (games, video players) suppress it. The transcript still types.

## How it works

```
Right Alt held
   |
   v
main.js (Electron)  ----IPC---->  dictation.js (hidden window)
   |                                      |
   | shows pill                           | opens mic, streams PCM
   |                                      v
   |                          ws://localhost:3000/realtime?model=gpt-realtime-whisper
   |                                      |
   |                                      v
   |                          realtime-relay.js (server) <----> OpenAI Realtime API
   |                                      |
   |                                      | transcript events
   |                                      v
   |                          dictation.js accumulates
   |
Right Alt released
   |
   v
dictation.js commits buffer, IPC sends final transcript
   |
   v
main.js -> cleanup.js (LLM polish) -> typing.js (clipboard paste) -> focused app
```

## Files

- `main.js` - Electron main process, hotkey, tray, IPC, typing
- `server.js` - HTTP + WebSocket relay server
- `realtime-relay.js` - reusable WS relay (proxies to OpenAI Realtime API)
- `src/hotkey.js` - global right-Alt listener (uiohook-napi)
- `src/typing.js` - keystroke / clipboard-paste output (nut-js)
- `src/cleanup.js` - LLM polish pass (OpenAI chat completions)
- `public/pill.html` - floating "Listening..." indicator
- `public/dictation.html` + `dictation.js` - hidden mic + WS client
- `docs/plan.md` - full delivery plan and progress notes
