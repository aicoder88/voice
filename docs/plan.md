# Wispr Flow-style Push-to-Talk Dictation

Goal: hold a global hotkey anywhere on Windows, speak, release — the transcript types itself into whatever text field has focus. Works in Word, Slack, browsers, terminals, code editors, anywhere.

## Stack

- **Electron** — desktop shell, gives us global hotkeys and a hidden background process
- **`gpt-realtime-whisper`** (OpenAI, released 2026-05-07) — streaming speech-to-text, ~57 languages including Croatian, English, French
- **`@nut-tree/nut-js`** — native keyboard automation, types into the focused field of any app
- Existing `realtime-relay.js` from this repo — already proxies WebSocket to OpenAI and keeps the API key on the server side. We reuse it as-is, just swap the model.

## How it works (the loop)

1. User holds hotkey (default: right-Alt). Anywhere on the OS.
2. Electron's `globalShortcut` fires the press event.
3. A small floating "🎙️ Listening…" pill appears near the cursor (frameless always-on-top window).
4. Hidden mic window opens the user's microphone, streams 24kHz PCM to the local relay.
5. Relay forwards to `gpt-realtime-whisper`. Partial transcripts stream back.
6. User releases hotkey.
7. Mic stops. We wait for the final transcript.
8. Optional cleanup pass through a small chat model for punctuation and filler-word removal (the "Wispr polish").
9. `nut-js` types the cleaned transcript into the currently focused text field via simulated keystrokes.
10. Pill disappears.

## Languages

`gpt-realtime-whisper` supports Croatian, English, French, German, Italian, Spanish, Portuguese, Russian, Polish, Ukrainian, Bosnian, Serbian, Slovenian, plus ~45 others. Auto-detects per chunk, so mixed-language dictation works.

## Phased delivery

## Progress (updated 2026-05-21)

**Phase 1 — DONE**
- `main.js` Electron main process
- System tray with Show Window / Relay URL / Quit
- `server.js` refactored to export `startServer()`
- Graceful boot when `OPENAI_API_KEY` missing (shows `setup.html`)

**Phase 2 — DONE**
- Relay swapped: accepts `?model=gpt-realtime-whisper` query param, switches session config to STT-only
- `public/dictation.html` + `public/dictation.js` hidden mic worker, streams to whisper, IPC-emits final transcript
- `public/pill.html` "Listening…" floating UI (frameless, transparent, click-through, always-on-top)
- `src/hotkey.js` global right-Alt via `uiohook-napi` (hold = press, release = stop)

**Phase 3 — DONE**
- `src/typing.js` types transcript via clipboard-paste (default) or direct keystrokes
- Restores previous clipboard 250ms after paste

**Phase 4 — DONE**
- `src/cleanup.js` LLM polish via `gpt-4.1-nano`, language-preserving, falls back to raw text on error
- Toggled by `CLEANUP_ENABLED` env var, on by default

**Outstanding / known risks**
- Native modules `uiohook-napi` + `@nut-tree-fork/nut-js` use N-API so prebuilt binaries should load in Electron without rebuild. If they fail at runtime, install Visual Studio Build Tools and run `npx electron-rebuild`.
- gpt-realtime-whisper session config shape is best-guess from existing realtime API; may need adjustment after first real session response.

### Phase 0 — sanity check the cloned repo (15 min)
- `npm install`
- Add `.env` with `OPENAI_API_KEY`
- `npm run dev`, open browser, confirm voice agent works
- This validates the OpenAI key + relay + the realtime API path before we change anything

### Phase 1 — wrap in Electron (1-2 hrs)
- Add `electron` and `electron-builder` to package.json
- New `main.js` (Electron main process) that:
  - Boots the existing `server.js` (relay) on a local port
  - Opens a single hidden `BrowserWindow` for the mic + WS client
  - Adds a system tray icon (quit, settings, view history)
- Keep `realtime-voice-agent.js` widget as the mic/WS handler but strip the conversational UI

### Phase 2 — global hotkey + dictation mode (1-2 hrs)
- Register global hotkey via `globalShortcut.register('Alt+RightArrow', ...)` (or whatever default we settle on — needs to be a key Windows doesn't already own)
- On press: open mic, start streaming to `gpt-realtime-whisper`
- On release: stop mic, finalize transcript
- Build the floating pill: frameless, transparent, always-on-top `BrowserWindow`, positioned near `screen.getCursorScreenPoint()`
- Swap relay model from `gpt-realtime-2` to `gpt-realtime-whisper` and trim the audio.output config (whisper is STT only)

### Phase 3 — type into the focused field (1 hr)
- `npm install @nut-tree/nut-js`
- After final transcript: `await keyboard.type(text)`
- Critical: wait ~50ms after hotkey release before typing, so the user's modifier-key state is clean
- Edge case: if hotkey is still down when transcript arrives (slow network), buffer the text until release

### Phase 4 — Wispr-style polish (2-3 hrs)
- Cleanup LLM pass: send raw transcript to `gpt-4.1-nano` with prompt "punctuate, remove filler words (um, uh), fix obvious mistakes, keep meaning and language." Toggleable.
- Custom vocab: settings UI for names/jargon, fed to Whisper as `prompt:` hint
- History panel: last 20 dictations, click to re-copy
- Per-app behavior: detect foreground app via Windows API; in code editors, skip auto-punctuation
- Optional: second hotkey for "dictate-and-translate" using `gpt-realtime-translate` (e.g., speak Croatian → types English)

### Phase 5 — nice-to-haves (later)
- Command mode: "new line", "delete that", "select all" → keystroke actions instead of text
- Auto-launch on Windows startup
- Hotkey customization in settings UI
- Cost meter (minutes used today)

## File layout after Phase 2

```
C:/dev/voice/
  main.js                    # Electron main process
  server.js                  # existing — relay HTTP server
  realtime-relay.js          # existing — WebSocket relay (model swapped to whisper)
  public/
    pill.html                # floating "listening" UI
    pill.js
    dictation-engine.js      # new — mic + WS client (replaces realtime-voice-agent.js for dictation mode)
  src/
    hotkey.js                # globalShortcut wiring
    typing.js                # nut-js keystroke synthesis
    cleanup.js               # optional LLM polish pass
  docs/
    plan.md                  # this file
```

## Decisions locked

- **Hotkey**: right-Alt (hold to talk, release to type). Configurable later in settings.
- **Cleanup pass**: ON by default. Raw transcript → `gpt-4.1-nano` for punctuation + filler removal → typed out.
- **Pill UI**: simple "🎙️ Listening…" — no live partial transcript. Cleaner, less code, less distracting.
- **Environment**: Node 24.14.1, npm 11, pnpm 10 confirmed on this machine.
