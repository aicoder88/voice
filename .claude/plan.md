# FluidVoice feature port — 2026-06-27 (CURRENT)

Cross-language (FluidVoice = Swift, GVoice = Electron/JS) → reimplement features,
not copy code. Parakeet engine out of scope (needs a Swift build; separate project).

Impact-ordered:
1. [DONE] Self-correction in cleanup — drop spoken retractions ("buy milk no wait
   buy water" → "Buy water."). Prompt-only change in src/cleanup.js, scoped as the
   single exception to "preserve every word". Verify with `node scripts/cleanup-test.js`.
2. [IN PROGRESS] Settings UI redesign (sidebar + consolidate) — user approved
   full scope. Sections: Speech engine, AI cleanup, Dictionary (moved in),
   Activity (stats), History & privacy, Shortcuts. Files:
   - src/settings.js: add selfCorrection (SELF_CORRECTION) + cleanupProvider
     (CLEANUP_PROVIDER) to settingsView/patchFromView.
   - src/stats.js: NEW pure module — computeStats(history) → words/timeSaved/
     streak/recent. Unit-tested.
   - src/cleanup.js: SELF_CORRECTION off → trailing prompt override (read at
     call time so it's live).
   - main.js: gate respects SELF_CORRECTION; new stats:get handler; bump
     settings window to ~760x580.
   - preload-settings.cjs: add statsGet + dict list/add/remove passthrough.
   - public/settings.html: full sidebar rewrite, wired to the bridge.
   Prototype approved (scratchpad/settings-proto.html). Contained to the
   settings window — dictation core untouched.
3. [DONE-ish via #2] Usage stats — Activity tab from history.json.
- Per-app prompt styles: deferred (user said not now).

Out of scope (scope creep on a working app): Command Mode, Rewrite Mode, light theming.

---

# Polish pass — 2026-06-17 (HISTORICAL)

Goal: find mistakes, omissions, polish; fix high-value confirmed ones. App is stable
and running in /Applications — precision over volume; surface risky internal refactors
instead of silently changing them.

Baseline (clean tree @ 95b87ef): Unit 110/110, Parity 4 pass + 1 known skip, Cleanup 9/9.
Tests cover only PURE modules — nothing in main.js/IPC/FFI/paste; treat fixes there conservatively.

Method: 9-dimension review workflow (dictation-core, relay-providers, resource-lifecycle,
security-ipc, crossplatform-ffi, ux-copy, simplification-deadcode, docs-accuracy,
vocab-cleanup-data) → adversarial verify each finding → triage by value×confidence÷blast-radius.

STATUS (2026-06-17): DONE. 35 confirmed findings fixed across 5 tested batches + review gate
applied (2 should-fix + 2 nits). 4 surfaced for the user (#2 relay auth, #3 full-async, #8/#11/#15).
Tests: unit 110/110, parity 4 + 1 known skip, cleanup 9/9. NOT committed, NOT shipped (awaiting user).
Full state in .claude/continuation.md; decisions in .claude/notes.md; findings in .claude/review-findings-2026-06-17.md.

## Cross-reference: prior-pass PENDING items I confirmed still OPEN (2026-06-17)
- package.json: no `"test"` alias (trivial). [4f]
- scripts/unit/dictation-session.test.js: file does not exist. [4d]
- benchmark-run.js:103 postWav() fetch has NO timeout → wedged whisper-server pins
  the Settings "Testing speed…" UI forever. [1b]
- hardware.js probeCapability(): NOT memoized — runs execFileSync wmic (4s) + PowerShell
  fallback synchronously on the MAIN process at every Settings-open/benchmark. [2]
- benchmark-run.js finally (90-94): restores WHISPER_MODEL but never stops the benchmark
  whisper-server nor clears WHISPER_SERVER_URL → if dictating on whisper-local while
  benchmarking a different model, next dictation can use the benchmark server/model; also a
  process leak until restart. [1a — verify scope w/ workflow]
DONE since June 10 (verified): settings.html error surfacing (showEngineError, !res.ok guard).

---

# GVoice full-review fix pass — 2026-06-10 (pt.2) — HISTORICAL (prior pass)

Source: 63-agent review (41 confirmed findings, 4 refuted, 36 lows).
Full results JSON: /private/tmp/claude-501/-Users-macmini-dev-voice/45579cbf-db29-42e4-bc8b-12c7ceed7f02/tasks/wvcj36kgr.output
(NOTE: /tmp may be wiped on reboot — the confirmed-findings details for the
REMAINING items are restated under "Pending" below, self-contained.)

Status: ☑ done (committed) / ☐ pending / ✗ deferred

## DONE — committed, 105/105 unit + 4/5 parity green
- ☑ main.js+hotkey.js: hotkey startup failure now surfaces (splash error,
  tray warning tooltip, notification); hotkey.js throws instead of returning
  a dead stub. [high]
- ☑ dictation.js: quick-tap race — stop during async startRecording is now
  deferred and committed instead of dropped (mic no longer records forever). [high]
- ☑ dictation.js: 1200ms partial-transcript fallback timer now tracked +
  cleared per utterance. [high→med]
- ☑ whisper-local.js: server crash now respawns on next dictation (exit
  handler resets whisperServerReady + clears WHISPER_SERVER_URL, guarded
  against late exits from replaced children). [high]
- ☑ whisper-local.js: WHISPER_SERVER_URL published only after the server
  answers; cleared on boot failure; inference POST capped at 15s
  (TimeoutError is not retried → falls to CLI); Blob([wavBuffer]) instead of
  .buffer; ensureWhisperServer takes the model param (server/CLI can't
  diverge). [med+lows]
- ☑ deepgram.js: close handler gated on finalizeSent (no more premature
  completed mid-hold → partial paste); CONNECTING legs get their Finalize on
  open; commit with no live legs completes immediately. [high+med]
- ☑ mic-health.js+dictation.js: no-frames wedge (long hold, ~0 bytes) now
  classified dead → rebuild; holdMs passed from renderer. [med]
- ☑ dictation.js: initCapture cleans up after itself on throw; all failure
  paths teardownCapture(true) (no leaked live mic / double graph). [med]
- ☑ dictation.js: handleMicLost cancels the pending tail-drain commit. [low]
- ☑ main.js: transcribing-pill backstop 25s (outlives renderer 20s watchdog). [med]
- ☑ main.js: DictationSession safetyTimeoutMs 25s (busy guard real now);
  dictation-session.js drops dead pressAt, resets releaseAt per session. [med+low]
- ☑ foreground.js: transient AX errors (CannotComplete/APIDisabled) return
  null, not false → no more false "Couldn't paste". [med]
- ☑ typing.js: clipboard image captured + restored (screenshot no longer
  destroyed by dictating). [med]
- ☑ settings.js: env quoting rewritten (single quotes, dotenv-literal);
  Windows path with spaces round-trips; tests updated + 3 new. [low]
- ☑ history.js: atomic write (tmp+rename). [low]
- ☑ cleanup.js: anthropic max_tokens truncation → falls back to raw. [low]
- ☑ correction-watch.js: mousedown also detaches after lapse. [low]
- ☑ server.js: bad %-encoding in /recordings/ → 404, not crash. [low]
- ☑ realtime-relay.js: wrong-path upgrade destroys the socket. [low]
- ☑ openai.js: "OpenAI: " error prefix. [low]
- ☑ hotkey.js: self-heal now releases the hold tracker (swallowed keyup
  can't leave the mic recording). [low]
- ☑ main.js engine handlers: benchmark single-flight guard; engine:apply
  refuses a model path not on disk (returns { error }); CUDA 700 MB
  disclosed in progress text. [high+med]
- ☑ UX copy: Windows hotkey is "Ctrl+Shift" in tray tooltip/splash/balloon;
  pill reasons action-first + conditioned "recording saved"; pill wraps to
  2 lines on results; Copy/Open re-arm 1.4s not 30s; pill margins no longer
  eat clicks (forward-mouse-events pattern, new pill:set-interactive IPC);
  tray ⚠ rows get "Wasn't pasted" legend; Relay row dev-only; splash boot
  errors in plain words. [many]
- ☑ docs: README/SETUP/ARCHITECTURE/REFACTOR/RELAY_PROTOCOL synced to code
  (agent pass, 8 fixes; ARCHITECTURE safety-timer line re-fixed to 25s).

## PENDING — next session (self-contained details)
1. src/benchmark-run.js (Windows engine flow):
   a) The finally block restores WHISPER_MODEL but never stops the benchmark
      whisper-server → live dictation silently keeps using the BENCHMARK
      model until restart (ensureWhisperServer caches; transcribePcm reads
      WHISPER_SERVER_URL fresh). FIX: in finally, call stopWhisperServer()
      and delete process.env.WHISPER_SERVER_URL after restoring the env.
      [high, 2 verifiers confirmed]
   b) postWav's fetch (~line 103) has no timeout → wedged server pins the
      Settings UI on "Testing speed…" forever. FIX: signal:
      AbortSignal.timeout(120000) + plain-English error. [med]
2. src/hardware.js: probeCapability runs execFileSync wmic (4s timeout) +
   PowerShell fallback (~1-3s) ON THE MAIN PROCESS at every Settings open and
   every benchmark. FIX: memoize (module-level cache; hardware doesn't change
   mid-session). [med]
3. public/settings.html:
   a) benchBtn handler shows #engineResult (which CONTAINS the Use on-device
      button) BEFORE the `if (!res.ok)` early-return → a failed download
      still offers "Use on-device" (engine:apply now refuses, returning
      { error } — surface that error string in the panel, and wrap the two
      choice buttons in a div hidden when !res.ok). [high]
   b) Engine dropdown says "(offline, on this Mac)" while the panel below
      says local isn't available on this platform; cleanup hint mentions a
      "cleanup API key" field that doesn't exist (env-only concept); save
      failure says "check the app". FIX: copy changes (use "this computer",
      reconcile panel text, OpenAI-key wording, drop "check the app"). [med]
   c) engine:apply response can now be { error } — renderer must show it
      (currently assumes a settings view comes back). [REQUIRED to match the
      committed main.js change]
4. Tests:
   a) scripts/parity/dictation-flow.test.js test 5: the finally block
      restores the real OPENAI_API_KEY BEFORE the client connects, but the
      relay reads the key per-connection → test can never fail; burns 10s
      then skips. FIX: keep the bad key until after the failure assertion
      (t.after restore). Also fix the stale comment (~line 174) claiming the
      relay swallows 401s (forwardUnexpectedResponse exists). [high+low]
   b) scripts/cleanup-test.js: set process.exitCode = passed===total?0:1. [med]
   c) scripts/unit/recordings.test.js:98: path.split("/") breaks on Windows
      → use basename(). [med]
   d) NEW scripts/unit/dictation-session.test.js (~6 tests: busy guard,
      safety timer, releaseAt reset — module is pure, injectable timeout). [med]
   e) scripts/unit/mic-health.test.js: add cases for the new holdMs /
      no-frames dead classification (long hold + 0 bytes → dead; short tap →
      ignore; holdMs absent → old behavior). [med]
   f) package.json: add "test": "npm run test:unit". [low]
5. REVIEW GATE for this whole fix pass (adversarial + simplicity subagents
   over `git diff HEAD~1`), then full test run.
6. SHIP: pnpm build → replace /Applications/GVoice.app → relaunch (same
   bundle id/team, TCC persists). Manual smoke: dictate; check pill buttons
   clickable + margins click-through; sleep→wake→dictate.

## DEFERRED (decided, do not re-litigate without need)
- CUDA-broken-install in-app CPU fallback (design work, Windows-only).
- typing.js leading-space-into-empty-field (behavior taste; needs
  focusedFieldValue pre-read).
- history.js electron decouple + unit tests (initHistory(dir) refactor).
- pill/vocab renderer crash recovery; press-during-reload swallow;
  settings:save write-failure surfacing in UI; model checksum validation;
  setup-whisper-windows.ps1 partial-download check; savedForegroundHwnd
  nulling before pill positioning (multi-monitor pill jump); .part orphan
  cleanup (single-flight guard covers the corruption case).
- REFUTED by verifiers (don't redo): model change without restart claim;
  WS-close-after-commit watchdog claim; re-press drop (alreadyFinalized)
  claim; cleanup enumeration flakiness rewrite.
