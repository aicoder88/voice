# CLAUDE.md

Project guidance for Claude Code working in this repo (`voice` / **GVoice**).

## What this is

GVoice is a macOS menu-bar / Windows tray **push-to-talk dictation app** built
on **Electron**. Hold a hotkey (right Option on macOS), speak, release, and the
transcribed text is pasted into whatever app is focused. Speech goes to a
speech-to-text engine (Deepgram, OpenAI realtime, or local whisper.cpp), an
optional cleanup pass tidies it, and API keys stay on a local relay.

- App name: **GVoice** (`appId` `com.purr.gvoice`). Entry point: `main.js`.
- Run in dev: `pnpm start` (launches `electron .`). `pnpm dev` runs the relay
  server (`server.js`) only.
- Build: `pnpm build` → electron-builder. The macOS target is `dir`, so the
  built app lands at `dist/mac-arm64/GVoice.app`.
- Menu-bar/tray icon: `main.js` `makeTrayIcon()` loads
  `public/trayTemplate.png`.
- Settings/persistence: `src/settings.js`. Microphone selection UI +
  device handling: `public/dictation.js`, `public/mic-health.js`,
  `public/realtime-voice-agent.js`.

## Hard rule: a fix is not done until you SEE it work on the running app

Bugs here have been re-reported after "fixes" that never actually stuck. Reading
the diff or typechecking is NOT enough. After ANY fix or UI change:

1. Rebuild the app (`pnpm build`) or launch it in dev (`pnpm start`).
2. Actually run/open the app.
3. Reproduce the exact reported scenario and confirm the specific behavior is
   fixed **on the running app** before reporting done.

A fix you have not observed working is not done — say "not verified", never
"done".

### Known regression-prone spots (verify these explicitly)

- **Microphone device selection persistence.** Selecting a specific input (e.g.
  the **Anker** mic) must survive an app restart and not silently revert to the
  system default. After changing anything near mic selection, restart the app
  and confirm the chosen device is still selected AND is the one actually
  capturing audio.
- **Menu-bar / tray icon presence.** The tray icon has gone missing before.
  After any change touching startup or the tray, launch the app and confirm the
  icon actually appears in the menu bar / tray and its menu opens.
