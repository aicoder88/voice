# Continuation — audio backup + retry/play safety net

Status: COMPLETE and tested (parity suite + backup e2e all pass). Not committed
(awaiting user "ok"/"push").

## What this added
When a dictation fails to transcribe, the captured audio is saved as a WAV and
a pop-up appears with **Retry** (re-transcribe the same audio) and **Play**
(listen back). A long dictation is never silently lost.

## Files
- src/backup.js (new) — saveBackup / readBackupPcm / deleteBackup /
  pruneBackups / buildRelayUrl / retranscribe (WS replay through the relay).
- src/providers/_shared.js — now owns wrapWav (deduped from whisper-local.js).
- src/providers/whisper-local.js — imports wrapWav from _shared.
- public/dictation.js — accumulates recordedChunks (pre-roll + streamed),
  reportFailure(), 20s failure watchdog, gotTerminalEvent, socket-identity guard.
- public/backup-error.html (new) — the pop-up UI.
- preload.cjs — added reportFailure bridge method.
- preload-backup.cjs (new) — backupBridge: retry() + close().
- main.js — processTranscript() refactor; IPC dictation:failure /
  backup:retry / backup:close; openBackupWindow(); boot-time prune; recordingsDir.
- server.js — serves /recordings/*.wav from recordingsDir with traversal guard.
- package.json — added preload-backup.cjs to build.files.

## Failure detection (three shapes; silence is NOT a failure)
1. error/local.error frame → reportFailure immediately.
2. socket not OPEN at commit → reportFailure (lost connection).
3. no terminal frame within DICTATION_FAILURE_MS (20s) → reportFailure (hung).
A `completed` frame with empty transcript = silence gate, sets gotTerminalEvent,
no pop-up.

## Config / env
- DICTATION_FAILURE_MS (default 20000) — hang watchdog.
- BACKUP_RETENTION_DAYS (default 7) — prune age.
- Recordings dir: userData/recordings/.

## Tests
- npm run test:parity — all 5 pass.
- Backup e2e (WAV round-trip, prune, traversal guard, live retranscribe via
  whisper-local) verified during the build; script was throwaway.

## Known limitations (see notes.md)
- Retry uses the env STT provider; Play always recovers audio regardless.
- Retry-after-restart works (reads WAV from disk).
