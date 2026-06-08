# Continuation — eight improvements (2026-06-08 pt.3)

Status: COMPLETE in source. `node --check` clean on all touched files;
`pnpm test:unit` 54/54; `pnpm test:parity` 4 pass + 1 pre-existing network skip;
`pnpm test:cleanup` 8/9 (the 1 "fail" is the documented honest groq-429 rate-limit
fallback, not a regression). NOT committed and NOT rebuilt into
/Applications/GVoice.app — the user runs the packaged app, so a `pnpm build` is
needed to test live (or run via `pnpm start`).

## What shipped (the 8-item list, all uncommitted)
1. Settings window — src/settings.js (pure .env writer), public/settings.html,
   preload-settings.cjs, IPC settings:get/save/clear-recordings in main.js.
   Live-apply: realtime-relay.js reads keys fresh per connection;
   reloadDictationWindow() on provider switch; first-run save boots relay +
   bringUpDictation().
2. Windows paste verify — foreground.isForegroundWindow(); processTranscript
   downgrades pasted→false if focus left the restored window mid-paste (win32).
3. Retry — src/retry.js, wired into cleanup.js + whisper-local runWhisperServer.
   Streaming WS providers intentionally not retried (dup-transcript risk).
4. Recordings privacy — src/recordings.js (count + age prune), RECORDINGS_ENABLED
   + RECORDING_RETENTION_DAYS, boot prune, tray "Clear recordings", Settings UI.
5. Tests — scripts/unit/{hotkey-logic,vocab,settings,recordings,retry}.test.js.
   `pnpm test:unit`. Pure reducers extracted to src/hotkey-logic.js (shared by
   both hotkey backends).
6. Offline pre-flight — public/dictation.js: cloud provider + offline → helpful
   error before connecting.
7. Deepgram observability — emitCompleted(reason) logs per-leg detail + ALL-EMPTY.
8. First-run onboarding — needsOnboarding() opens Settings when key/model missing.

## Files touched
New: src/settings.js, src/recordings.js, src/retry.js, src/hotkey-logic.js,
preload-settings.cjs, public/settings.html, scripts/unit/*.test.js.
Modified: main.js, src/hotkey.js, src/foreground.js, src/cleanup.js,
src/providers/whisper-local.js, src/providers/deepgram.js, realtime-relay.js,
src/bootstrap-env.js (exports ENV_FILE), public/dictation.js, package.json,
.env.example, README.md.

## To verify in the real app (after pnpm build)
- Rename/clear .env key → relaunch → Settings opens on first run; paste a key,
  Save → dictation works WITHOUT restart.
- Tray → Settings… → switch engine → next dictation uses it.
- Settings → "Delete all recordings now" and the retention-days field; tray
  "Clear recordings".
- (Windows) paste while another app steals focus → Error pill, text on clipboard.

## Known follow-ups (surfaced by review, deliberately deferred)
- whisper PID file is a single fixed tmp path → two GVoice instances could kill
  each other's whisper-server. PRE-EXISTING (not from this pass). Fix = per-PID or
  per-userData pidfile if it ever bites.
- reloadDictationWindow vs a rapid first-run double-save: theoretical double
  loadURL race. Not worth a mutex unless seen in practice.

## Next step options
- "ok" → rebuild (`pnpm build`, mac dir target) + reinstall /Applications/GVoice.app.
- "commit" / "push" → stage + commit the working tree.
