# Notes — backup safety net

Decisions:
- **Back up on failure only**, not every dictation. The stated problem is lost
  transcripts when processing fails; backing up every successful dictation adds
  a privacy + disk-growth concern for no stated benefit. Failed recordings are
  kept until a retry succeeds (then deleted) or the user dismisses the pop-up.
- **Retry runs in the main process** by replaying the saved WAV through the
  relay over a Node WebSocket — identical to how scripts/parity replays a
  fixture. This works even after an app restart and reuses every provider's
  existing pipeline, instead of poking the (hidden) renderer.
- **Failure timeout is separate from the existing 1200ms delta-flush fallback.**
  Declaring "the transcriber hung" at 1200ms would false-positive on slow but
  working transcriptions of long clips, so there is a longer DICTATION_FAILURE_MS
  (default 20s) timer that only fires the pop-up when NO terminal frame arrives.
- **Silence is not failure.** The relay returns a `completed` frame with an
  empty transcript for silence / hallucination. That sets gotTerminalEvent and
  never triggers the pop-up.

Rejected: keeping the PCM in the renderer for retry — loses durability across a
crash/restart and couples retry to a hidden window. WS replay from main is the
smaller, more robust path.

## Review gate (adversarial + simplicity)

Merged:
- Hardened the /recordings/ route with a resolved-path containment check
  (resolve + startsWith base+sep), replacing string heuristics.
- Boot-time prune of recordings older than 7 days (BACKUP_RETENTION_DAYS), so
  dismissed/played-back backups don't accumulate forever.
- Socket-identity guard in dictation.js so a late frame from a replaced socket
  can't flip the new utterance's state.
- Deduped wrapWav into providers/_shared.js (the old "worklets can't share"
  comment was wrong — both call sites are plain Node modules).

Rejected (one line each):
- Partial-delta-then-hang typing a partial as success: pre-existing behavior,
  and a partial typed is better than nothing; Play still recovers full audio.
- Provider mismatch on retry (uses env STT_PROVIDER): provider is fixed per
  session via env (changing it needs a restart), and Play recovers the audio
  regardless — not worth encoding provider per-file.
- Base64 IPC stall: already chunked per ~4KB frame, runs in the hidden
  dictation renderer, so any stall is invisible to the user.
- Utterance-ID tagging for timers: the stale failure timer is already cleared
  on the next startRecording(), so the real path is covered.

## Merge with origin/main (parallel work from another machine)

origin/main had diverged 6 commits (single-instance lock, foreground-window
capture/restore, GetAsyncKeyState Windows hotkey + right-Ctrl hr/en toggle,
Croatian/Deepgram, input-gain worklet, log rotation, Mac restore, hi-DPI tray
icons). User chose "combine everything, this computer's recording pipeline wins
on conflicts." Resolution:
- hotkey.js: took origin/main's platform-split detector (superset; carries the
  Croatian toggle). Not part of the recording pipeline.
- dictation.js: took THIS computer's pipeline (pre-roll, AGC off, warm capture,
  backup hooks), then grafted the Deepgram language profile so the Croatian
  toggle still works. Dropped the server's per-press worklet setup + 30s cap.
- whisper-local.js: auto-merged cleanly — kept this computer's silence gate +
  sanitizer + the wrapWav move, plus the server's ensureWhisperServer
  improvements (.exe handling, -fa GPU flag, stderr filtering).
- main.js: combined both — server's single-instance/foreground/log-rotation/
  language wiring + my backup IPC. processTranscript now also strips Whisper
  noise tokens and restores foreground focus before pasting (live path passes
  the saved hwnd; retry passes none).

JUDGMENT CALL to flag: the merged worklet applies a 2.5x soft-clipped input
gain (server's audio tuning). initCapture now passes it explicitly
(window.DICTATION_INPUT_GAIN overrides). This rides inside this computer's
pipeline because it helps the kept Deepgram/Croatian path and is runtime-
tunable; flip the default to 1 (≈linear) if raw-signal Whisper accuracy
regresses.

Verified post-merge: all JS syntax OK, parity 5/5, backup e2e (round-trip,
prune, traversal guard, live retranscribe) pass.

## Mic auto-recovery (silent-capture fix)

Symptom: dictation returned empty (`transcript len:0`) after working all
morning; the local whisper-server was healthy (verified by POSTing a synthesized
WAV to :8081 — transcribed perfectly). Root cause: the renderer acquired the mic
ONCE at boot and reused that stream forever; when the external mic was
unplugged/muted/seized (Teams/call apps present in the audio stack), the stream
went silent with no recovery and no visible warning — it just typed nothing.

Fix (public/dictation.js + preload.cjs + main.js): three detectors, rebuild on
NEXT press (never mid-hold):
- track onended/onmute → teardown + warn (instant recovery on clean drops).
- mediaDevices 'devicechange' → mark captureStale, rebuild next press.
- silent-streak backstop: SILENT_STREAK_LIMIT (3) consecutive long holds with
  worklet peak < SILENCE_PEAK (0.01) ⇒ warn + rebuild. Catches the macOS
  live-but-silent track (no event) — the exact observed symptom. Single silent
  hold is legitimate (held key, said nothing) so it never nags on one.
- New visible channel: dictation:mic-warning → native Notification (throttled
  10s) so failures are no longer silent.

Reused the worklet's already-emitted `peak` (was discarded) — zero added cost.
Guarded audioWorklet.addModule with workletLoaded (re-adding re-runs
registerProcessor → throws on duplicate name) so rebuilds don't crash.

TRADEOFF flagged: on 'devicechange' we rebuild on the next press. If a browser
fires devicechange as a side effect of getUserMedia (can happen the first time
labels populate), one extra rebuild occurs — harmless (~100-300ms re-acquire,
self-limiting since the app already holds standing mic permission, so steady
state doesn't loop). Did NOT add device-list diffing to suppress it — not worth
the complexity for a one-off extra rebuild.

Takes effect only after restarting GVoice (hidden dictation window must reload
the new preload + dictation.js). Parity 5/5 still pass.
