# Continuation — GVoice "error until restart" fix

## State (2026-06-09) — DONE + SHIPPED
All 6 plan steps implemented, reviewed, built, reinstalled to /Applications,
relaunched, and verified (see plan.md "IMPLEMENTED + SHIPPED"). Nothing pending
except watching for a real-world sleep→wake recurrence (now diagnosable via the
userData debug.log).

## What changed (files)
- public/mic-health.js — NEW pure module classifyHold(): zero-peak ⇒ instant
  dead-mic, low-but-nonzero ⇒ streak. Shared by renderer + unit test.
- scripts/unit/mic-health.test.js — NEW, 7 tests.
- public/dictation.js — now an ES module (`import` from /mic-health.js);
  teardownCapture(full) closes the AudioContext for a true rebuild; stopRecording
  uses classifyHold; rebuildCapture() proactive on wake (re-entrancy guarded);
  onRebuildCapture wired.
- public/dictation.html — script tag now type="module".
- preload.cjs — onRebuildCapture bridge.
- main.js — DEBUG_LOG → userData (+mkdir); console.error mirrored to dlog when
  packaged (circular-safe); powerMonitor resume/unlock → dictation:rebuild-capture;
  render-process-gone/unresponsive on dictationWindow → reload+dlog;
  uncaught/unhandled → dlog; pill reason threaded through
  showPillResult/setPillState; PILL error/success width 440→480.
- public/pill.html — shows the reason string on result pills; label ellipsis.
- src/bootstrap-env.js — packaged HOME defaults to userData (not the hardcoded
  dev repo); migrates legacy .env once; resolves whisper model from HOME then
  legacy. app.setName moved earlier so userData resolves to GVoice.

## Known/deferred
- Whisper MODEL file still lives in /Users/macmini/dev/voice/models and is found
  via the legacy fallback (config .env is now decoupled into userData; the model
  file is not copied — too heavy). If the repo is deleted, onboarding surfaces
  "point GVoice at a model" instead of a silent failure.
- Parity test 5 needs live OpenAI gpt-realtime-whisper access (account-gated),
  unrelated to this work.

## Next step
None required. If a sleep→wake silent-mic error ever recurs, read
~/Library/Application Support/GVoice/debug.log — look for "power resume",
"Dead mic", "render-process-gone".
