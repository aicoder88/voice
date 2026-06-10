# Continuation — polish pass 2026-06-10

## State: DONE (pending packaged rebuild verification — see below)
Polish pass implemented, review-gated, tested, committed to main (not pushed).
See .claude/plan.md (all items) and .claude/notes.md (decisions + honest limits).

## What changed (files)
- src/providers/whisper-local.js — transcribeHrEn reworked (allSettled +
  exported pickTranscript; one-leg failure tolerated). The risky uncommitted
  "first clean leg wins" race was rejected (EN always won → Croatian garbled).
- scripts/unit/pick-transcript.test.js — NEW, 6 tests (103 total now).
- server.js — relay binds 127.0.0.1 (was all interfaces).
- src/settings.js + scripts/unit/settings.test.js — cleanupEnabled view
  default now true, matching main.js runtime.
- public/setup.html — DELETED (dead). SETUP.md, docs/ARCHITECTURE.md,
  README.md, realtime-relay.js JSDoc, public/pill.html comment — corrected.

## Next step
Rebuild + reinstall the packaged app so the fixes reach /Applications:
  cd /Users/macmini/dev/voice && pnpm build
  then replace /Applications/GVoice.app with dist/mac-arm64/GVoice.app
  (same bundle id com.purr.gvoice + cert team JZ4Z22F6BM → TCC grants persist),
  quit the running GVoice first, relaunch after copying.
If dictating in auto language mode, confirm a Croatian sentence still comes
out Croatian (the pick now waits for both hr/en legs again).
