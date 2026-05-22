# Voice Dictation - Setup

Wispr Flow-style push-to-talk dictation. Hold **Right Alt** anywhere on Windows, speak, release - the transcript types itself into the focused text field.

## One-time setup

1. Open `C:\dev\voice\.env` and paste your OpenAI API key after `OPENAI_API_KEY=`.
2. (Already done if you cloned fresh) Install dependencies:
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
| `OPENAI_API_KEY` | *(empty)* | Required. Your OpenAI key. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-whisper` | Speech-to-text model. |
| `CLEANUP_ENABLED` | `true` | LLM polish (punctuation, remove "um"/"uh"). |
| `CLEANUP_MODEL` | `gpt-4.1-nano` | Cleanup model. Cheap and fast. |
| `TYPE_VIA_CLIPBOARD` | `true` | Paste vs simulated keystrokes. Paste is faster and more reliable. |
| `PORT` | `3000` | Local relay port. |

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
- `public/setup.html` - main window UI
- `public/pill.html` - floating "Listening..." indicator
- `public/dictation.html` + `dictation.js` - hidden mic + WS client
- `docs/plan.md` - full delivery plan and progress notes
