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
