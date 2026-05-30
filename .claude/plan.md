# Plan — audio backup + retry/play safety net

Goal: a long dictation must never be silently lost. When transcription fails,
save the captured audio to disk and show a pop-up with two actions: **Retry**
(re-transcribe the same audio) and **Play** (listen to the recording).

Ordered by impact:

1. **Persist audio on failure** — renderer accumulates the full utterance PCM
   (pre-roll + everything streamed), and on a genuine processing failure ships
   it to the main process, which writes a timestamped WAV under
   `userData/recordings/`. (src/backup.js, public/dictation.js, preload.cjs,
   main.js)

2. **Detect the three failure shapes** in the renderer:
   - explicit `local.error`/`error` frame
   - socket not open at commit (lost connection mid-dictation)
   - no terminal frame within a failure timeout (transcriber hung)
   A silence-gate empty (`completed` with empty transcript) is NOT a failure.

3. **Error pop-up window** with Retry + Play. (public/backup-error.html,
   preload-backup.cjs, main.js)

4. **Retry path in main** — replay the saved WAV through the relay over a Node
   WebSocket (same protocol the parity test uses). On success, run the normal
   cleanup + type pipeline and delete the backup. (src/backup.js, main.js)

5. **Serve recordings over the local HTTP server** so the pop-up's `<audio>`
   element can play the WAV. (server.js)

Notes / decisions: see notes.md.
