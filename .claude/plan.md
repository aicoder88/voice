# GVoice reliability plan — "it says error until I restart it"

Diagnosed 2026-06-09. Impact-ordered. Status: ☐ pending / ☑ done

## ✅ IMPLEMENTED + SHIPPED 2026-06-09 (all 6 steps)
Built, signed (team JZ4Z22F6BM, bundle com.purr.gvoice — TCC grants persist),
reinstalled to /Applications/GVoice.app, relaunched. Verified live:
- debug.log now writes to ~/Library/Application Support/GVoice/debug.log (Step 2).
- console.error mirrored into that log (whisper-server output is captured) (Step 2).
- legacy .env auto-migrated into userData on first packaged boot (Step 4).
- ES-module renderer loaded clean in the packaged app ("Dictation worker loaded"
  = the whole module incl. the /mic-health.js import executed) (Step 1).
- 61/61 unit tests (7 new mic-health). Parity 4/5 — the 1 fail is OpenAI live
  model access ("gpt-realtime-whisper-api-ev3 … no access"), env-only, unrelated.
Review gate run (adversarial+simplicity): ACCEPTED a re-entrancy guard on
rebuildCapture (resume+unlock double-fire) and a circular-safe stringify in the
console.error mirror. Rejected the rest (pre-existing or non-issues) — see notes.md.
Cannot verify the real sleep→wake→dictate path here (needs a physical sleep), but
the wake hook is wired and any recurrence is now diagnosable from debug.log.

## Root cause (confirmed with evidence)

Every failed dictation today (13:31, 23:26:54, 23:27:00, 23:27:05, 23:27:55) saved a
recording that is **pure digital silence — every sample exactly 0**. The 09:50 success
has normal audio (peak 16900). The app has been running since Mon 10AM.

The microphone capture stream inside the hidden dictation renderer went dead
(classic macOS/Electron failure after sleep/wake or an audio-device change: the
stream stays "live" but delivers zeros). With zero audio, the whisper-local
silence gate (and Deepgram alike) returns an empty transcript → error pill,
forever, until an app restart recreates the capture.

The existing auto-recovery (public/dictation.js) failed because:
1. It needs **3 consecutive silent holds** before acting (SILENT_STREAK_LIMIT=3).
2. Its rebuild keeps the old `AudioContext` (`teardownCapture()` only drops the
   stream/nodes) — tonight's last attempt, after recovery should have fired, was
   still all-zero, so reusing the context is not a sufficient rebuild.
3. Nothing rebuilds proactively on system wake.

## Step 1 — Fix dead-mic recovery for real (the bug)  ☐

File: public/dictation.js (+ main.js for powerMonitor IPC)
- Full rebuild: on recovery, also `audioContext.close()`, null it, reset
  `workletLoaded`, recreate everything. (Current rebuild reuses the wedged context.)
- Instant detection: a hold ≥ ~0.5s whose worklet peak is EXACTLY 0 is digital
  silence — a dead pipeline, never a quiet room (real mics have a noise floor).
  Rebuild immediately after ONE such hold (keep streak=3 for low-but-nonzero peaks).
- Proactive: main listens to `powerMonitor` resume/unlock → IPC the renderer to
  tear down + fully rebuild capture, so the FIRST post-sleep dictation works.
  Same full rebuild on `devicechange` (today it only marks stale → partial rebuild).
- Pill feedback when it happens: "Mic restarted — please try again" instead of bare error.

## Step 2 — Make the installed app actually log  ☐

File: main.js
- BUG: `DEBUG_LOG = join(__dirname, "debug.log")` is inside the read-only app
  package when installed → `appendFileSync` throws → swallowed → **the installed
  app logs nothing** (that's why tonight was a mystery). Move to
  `app.getPath("userData")/debug.log`.
- Mirror `console.error` (relay + provider logs, e.g. "deepgram ALL EMPTY",
  whisper silence gate) into the same rotated file when packaged — today all
  relay diagnostics are lost in the installed app.
- dlog the new mic lifecycle events: silent-hold, zero-peak rebuild, devicechange,
  power resume, render-process-gone.

## Step 3 — Error pill says WHY  ☐

Files: main.js, public/pill.html, preload-pill.cjs
- Thread a short reason string into showPillResult / pill renderer:
  "No audio reached the app — mic restarted, try again", "Couldn't reach the
  transcriber", etc. A bare red "Error" caused today's confusion.

## Step 4 — Remove the dev-folder dependency of the installed app  ☐

File: src/bootstrap-env.js (+ models/vocab resolution in whisper-local.js)
- BUG (potential): `PACKAGED_HOME = "/Users/macmini/dev/voice"` is hardcoded.
  The installed app reads .env, the Whisper model, and models/vocab.txt from the
  dev repo. Renaming/moving/cleaning the repo silently breaks the installed app.
- Default HOME to userData when packaged; on first packaged boot, migrate/copy
  .env + model path if present at the old location. Keep GVOICE_HOME override.
- Boot-time check: if the whisper-server binary (Homebrew) or model file is
  missing, surface it on the splash/settings ("Local engine missing: …") instead
  of the per-dictation ENOENT seen in the dev log (2026-06-02 10:05).

## Step 5 — Self-heal the other "until restart" failure modes  ☐

File: main.js
- Hidden dictation renderer crash: hotkey would IPC into a dead webContents and
  every press would silently do nothing. Handle `render-process-gone` /
  `unresponsive` on dictationWindow → reload + dlog.
- Route uncaughtException/unhandledRejection into dlog (currently console-only,
  invisible when packaged).

## Step 6 — Verify  ☐

- Unit test for the zero-peak instant-rebuild decision (extract as a pure
  function like hotkey-logic).
- Manual: dictate → sleep Mac ≥1 min → wake → dictate (must work first try).
- Simulate dead stream (feed zeros) → next press rebuilds, pill explains.
- `pnpm test:unit` + `pnpm test:parity`, then `pnpm build`, reinstall to
  /Applications, confirm debug.log appears in ~/Library/Application Support/GVoice/.
