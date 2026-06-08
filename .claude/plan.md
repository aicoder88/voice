# Plan — three regressions (2026-06-08)

Reconciled diverged branches first (rebased local paste-timeout fix onto remote
Deepgram parallel-legs work). All three failures share one root: a failed/empty
dictation gives the user nothing to see, click, or listen to.

## 1. Failed/empty transcript is now recoverable (fixes "not heard, not pasted")
- public/dictation.js: on an empty terminal frame, if we captured real audio
  (>= MIN_FAILURE_BYTES) send the chunks (text:"") instead of a bare "" — so main
  can save the recording and surface a failed attempt instead of a silent hide.
- main.js transcript handler: empty text + audio → save recording, show Error
  pill (Open recording), record a history entry. Tiny taps (no audio) still hide
  quietly.
- main.js dictation:failure handler: also record a history entry so the attempt
  shows in the tray and is listenable.

## 2. Failure pill stays long enough to click (fixes "disappeared too fast")
- public/pill.html: success 3s->6s, error 8s->30s; hover still pauses. Main-side
  safety backstops (12s/45s) already exceed these.

## 3. Listen to recordings from the tray (fixes "can't hear last attempt")
- saveTempRecording: keep the last 50 clips (prune) instead of deleting all but
  one; stop wiping the folder at boot so the last attempt survives a restart.
- src/history.js: HistoryEntry gains optional recordingPath; recordTranscript
  accepts it and allows an entry with no text but a recording.
- main.js tray: each recent dictation becomes a submenu (Copy text / Play
  recording); add a top-level "Play last recording".

## Review-gate decisions
- (recorded in notes.md as work completes)
