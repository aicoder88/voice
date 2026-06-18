# GVoice

Push-to-talk dictation for your whole computer. Hold a key, speak, release — the words type themselves into whatever text field you're in: Slack, your editor, a browser box, anything.

GVoice is a small menu-bar/tray app built on Electron. Your speech goes to a speech-to-text engine of your choice, an optional cleanup pass tidies up the punctuation and filler, and the result is pasted into the focused app. Your API keys stay on a local relay, never in a browser.

## Quick start

```bash
pnpm install
cp .env.example .env   # then add your API key(s)
pnpm start
```

The app lives in the menu bar (macOS) or system tray (Windows). Hold **right Option** (macOS) or **Ctrl+Shift** (Windows, either side), speak, and release. On macOS, holding **left Ctrl+Cmd** or the **mouse back button** works too. Tap **right Ctrl** to cycle the dictation language (Auto → Croatian → English). Full setup — including the local, no-API-cost Whisper option — is in [SETUP.md](SETUP.md).

First launch with no API key set? GVoice opens its **Settings** window so you can pick an engine and paste a key — no hand-editing files. You can reopen it any time from the tray (**Settings…**).

## Speech engines

Pick one with `STT_PROVIDER` in `.env`:

- **`deepgram`** — fast cloud transcription (needs `DEEPGRAM_API_KEY`).
- **`whisper-local`** — runs entirely on your machine, no per-clip cost (needs whisper.cpp binaries + a model; see SETUP.md). On Windows, the Settings window can set this up for you: it downloads the engine and a model, runs a speed test on your actual hardware, and only suggests keeping local if it's fast enough.
- **`openai`** — OpenAI's realtime transcription (needs `OPENAI_API_KEY`).

## Custom dictionary

GVoice keeps a list of names and made-up words it should spell exactly. How it applies them depends on the engine: for the local Whisper engine the terms are fixed up *after* transcription (a near-miss like "Cloud" is corrected to your saved "Claud"); for the cloud engines (Deepgram keyterm boosting, OpenAI's prompt) they bias recognition up front. Whisper used to be biased up front too, but that made it hallucinate rare words onto unrelated audio (e.g. "a US price" → "a Unsplash price"), so the local path now corrects after the fact instead.

Two ways to fill it:

- **Add them yourself.** Tray menu → **Manage dictionary…** opens a window where you type in your brands, people, and coined terms. This is the reliable way to fix words the engine mishears. Keep entries to genuinely unusual proper nouns — a term that's one letter from an everyday word (e.g. "Stripe" vs "strip") can get over-applied.
- **Let it suggest.** After a dictation, if GVoice spots an unusual name it typed — or notices you hand-fixing a word it got wrong — a small pop-up appears next to your cursor offering to remember it. You're asked once per word; "No thanks" is remembered for good.

## How it works

```
Hotkey held (right Option / Ctrl+Shift)
        │
        ▼
   main.js (Electron)  ──IPC──▶  dictation window (hidden)
        │ shows pill                    │ opens mic, streams audio
        │                               ▼
        │            ws://localhost:<port>/realtime  ──▶  relay  ──▶  speech engine
        │                               │
        │                       transcript comes back
        ▼                               │
Hotkey released ────────────────────────┘
        │
        ▼
   cleanup pass (optional LLM polish)  ──▶  paste into the focused app
        │
        ▼
   "Add to dictionary?" pop-up if a new name showed up
```

## Layout

- `main.js` — Electron main process: hotkey, tray, the floating pill, typing, and the dictionary pop-up.
- `server.js` + `realtime-relay.js` — local HTTP server and the WebSocket relay that keeps your API keys out of the browser window.
- `src/providers/` — one transport per speech engine (`deepgram`, `whisper-local`, `openai`).
- `src/vocab.js` — the custom dictionary: one store, read by every engine, written by the pop-up.
- `src/correction-watch.js` — watches for a hand-typed fix right after a dictation (macOS/Linux).
- `src/hotkey.js`, `src/typing.js`, `src/cleanup.js` — the hotkey listener, clipboard/keystroke output, and the LLM cleanup pass.
- `public/` — the hidden mic window, the status pill, and the dictionary pop-up.

## Settings

The common options — speech engine, default language, AI cleanup, API keys, and recording privacy — are in the **Settings…** window (tray menu). It writes the same `.env` the app reads, leaving your comments and other keys untouched, and changes apply to your next dictation without a restart.

Everything (including the knobs not in the window — models, ports, the dictionary watch window) is still plain environment variables in `.env`; the full table lives in [SETUP.md](SETUP.md).

**Recordings & privacy.** GVoice keeps recent dictation audio on disk so a missed paste stays recoverable. These clips are unencrypted. They're capped at the last 50 *and* auto-deleted after `RECORDING_RETENTION_DAYS` (default 7). Turn saving off entirely, change the window, or wipe them now from Settings (or the tray's **Clear recordings**).

**Dictation history.** The tray's **Recent dictations** menu keeps your last 50 transcripts (they survive restarts), so a paste that missed its target can be copied again — and each entry's audio clip can be played back while recordings are enabled.

## Troubleshooting & logs

Per-event tracing (key presses, paste timing, cleanup) is written to `debug.log` in the app's data folder — on macOS that's `~/Library/Application Support/GVoice/debug.log` (rotated at ~1 MB). Set `GVOICE_DEBUG=1` to also echo those traces to the console while developing.

**Mic goes quiet after sleep?** GVoice watches for it. If the system wakes from sleep (or the audio device changes) and the mic starts delivering pure silence, the capture pipeline is rebuilt automatically on the next press — no restart needed.
