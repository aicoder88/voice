# Session notes — 2026-06-09 (pt.2): "error until restart" — IMPLEMENTED + SHIPPED

Implemented all 6 plan steps, reviewed, built, reinstalled, verified live.

## Core fix (Step 1)
- The dead-mic decision is one pure, unit-tested function: public/mic-health.js
  classifyHold(). KEY insight: a loudest-frame of EXACTLY 0 is digital silence =
  a dead pipeline (the recorded evidence was all-zero samples), never a real
  room (which always has a noise floor > 0). So ONE zero-peak hold rebuilds
  immediately; a low-but-nonzero peak still needs the 3-hold streak.
- teardownCapture(full=true) now CLOSES the AudioContext (+ forgets the worklet),
  so recovery rebuilds the WHOLE pipeline — the old partial rebuild reused a
  wedged context and stayed silent (the evening's evidence).
- Proactive rebuild on powerMonitor resume/unlock (system wake is when the macOS
  stream dies). Renderer rebuildCapture() guarded against the resume+unlock
  double-fire (re-entrancy promise) so two overlapping rebuilds can't race the
  context close/recreate.
- Renderer is now an ES module so it can import the shared mic-health module over
  HTTP (server already serves public/*.js as text/javascript). Verified the
  packaged renderer loads clean.

## Review-gate decisions (adversarial + simplicity)
ACCEPTED:
- rebuildCapture re-entrancy guard — resume AND unlock-screen fire together on
  wake; two concurrent async rebuilds could leak a stream / leave a half-built
  silent graph. One in-flight rebuild shared by callers.
- circular-safe stringify in the packaged console.error→dlog mirror — a rich
  error object with a circular ref would throw in JSON.stringify and (caught)
  silently drop the MOST useful log line. Falls back to String().
REJECTED:
- "wake message dropped during a provider/crash reload" — a freshly-loaded
  renderer has NO warm AudioContext (capture is built lazily on first press), so
  it's never in the dead state; the next press builds clean regardless.
- worklet frame arriving between teardown and init — reviewer agreed harmless.
- window.dictationBridge missing guard — pre-existing (old classic script threw
  the same way); not worsened by the module conversion; out of scope.
- four window.DICTATION_* tuning knobs / arrayBufferToBase64 wrapper /
  HIDE_BY_STATE fallback — all pre-existing, not introduced here.

## Verified
- 61/61 unit tests (7 new). node --check clean on all touched files.
- Built + signed (team JZ4Z22F6BM, same bundle id → mic/AX/input grants persist),
  reinstalled /Applications/GVoice.app, relaunched.
- LIVE: debug.log present in userData; console.error mirrored (whisper output in
  it); legacy .env migrated to userData on first packaged boot; whisper warmed;
  ES-module renderer loaded clean.
- NOT verifiable here: a real sleep→wake→dictate cycle (needs physical sleep).
  The wake hook is wired and any recurrence is now diagnosable from debug.log.
- Parity 4/5 — the 1 fail is OpenAI live-model access, env-only, unrelated.

---

# Session notes — 2026-06-09: "always says error until restart" — diagnosed, plan written

- ROOT CAUSE (evidence-confirmed): the hidden dictation renderer's mic capture
  stream died mid-session and delivered pure digital silence — every failed
  attempt's saved WAV (13:31, 23:26–23:27) has peak=0/rms=0, while the 09:50
  success has peak=16900. With zero audio the whisper-local silence gate returns
  an empty transcript → error pill on every attempt until app restart. App had
  been running since Mon 10AM.
- Existing auto-recovery didn't save it: needs 3 silent holds before acting, its
  rebuild keeps the old AudioContext (insufficient — the post-recovery attempt
  was still all-zero), and nothing rebuilds on system wake.
- Found while investigating (also in plan): packaged app's debug.log path is
  inside the read-only bundle → installed app logs NOTHING; bare "Error" pill
  carries no reason; PACKAGED_HOME hardcodes /Users/macmini/dev/voice.
- Action taken this session: restarted /Applications/GVoice.app (new PID) so
  dictation works tonight. NO code changes yet — plan in .claude/plan.md awaits "ok".

---

# Session notes — 2026-06-08 (pt.3): eight improvements (settings UI, retry, privacy, tests, etc.)

Implemented the 8-item improvement list. All additive; new logic pulled into pure,
unit-tested modules instead of growing main.js.

## New modules (all pure, no Electron import → unit-tested)
- src/settings.js — surgical .env read/write (update-in-place, preserve comments +
  unmanaged keys), settingsView/patchFromView. Backs the Settings window.
- src/recordings.js — saveRecording / pruneRecordings (count + age caps, oldest
  first) / clearRecordings. main.js saveTempRecording now delegates here.
- src/retry.js — withRetry + httpError (RetryableHttpError for 429/5xx, plain
  HttpError for 4xx so a clean 4xx is NOT retried). Wired into cleanup.js (per-
  attempt timeout; abort/timeout deliberately not retried) and whisper-local
  runWhisperServer (one retry before CLI fallback).
- src/hotkey-logic.js — createTapDetector / createHoldTracker (injectable clock).
  hotkey.js Windows + uiohook paths now share ONE implementation. Behavior
  preserved (verified by adversarial review + 11 unit tests).

## Features
1. Settings window: public/settings.html + preload-settings.cjs + IPC
   settings:get/save/clear-recordings. Live-apply: relay reads keys fresh per
   connection (realtime-relay.js), provider switch reloads the dictation window,
   first-run save boots the relay + bringUpDictation().
2. Windows paste verify: foreground.isForegroundWindow(); processTranscript
   downgrades pasted→false if focus left the restored window mid-paste.
3. Retry (above). Streaming WS providers intentionally NOT retried (dup-transcript
   risk) — documented in retry.js header.
4. Recordings privacy: RECORDINGS_ENABLED + RECORDING_RETENTION_DAYS, boot prune,
   tray "Clear recordings", Settings controls.
5. Tests: scripts/unit/ (hotkey-logic, vocab, settings, recordings, retry) — 54
   assertions, all pass. `pnpm test:unit`.
6. Offline pre-flight in dictation.js: cloud provider + navigator.onLine===false →
   helpful "switch to local Whisper" error before connecting.
7. Deepgram observability: emitCompleted(reason) always logs per-leg
   words/conf/len + an explicit ALL-EMPTY warning.
8. First-run onboarding: needsOnboarding() opens Settings when the active engine's
   key/model is missing, instead of a dead-end splash.

## Review-gate decisions
ACCEPTED (from adversarial + simplicity subagents):
- Clear serverError at the top of bootRelayServer so a successful first-run retry
  doesn't keep a stale "Missing KEY" string.
- recordings NAME_RE made the random suffix OPTIONAL so older `dictation-<ts>.wav`
  clips are still pruned/cleared (else "Clear recordings" silently leaks them).
- Tray "Clear recordings" enabled on recordingsDir (not history's lastRecording),
  matching the Settings button — clips can outlive the capped history.
- Removed unused exports EDITABLE_KEYS (settings.js) and GVOICE_HOME (bootstrap-env.js).
REJECTED:
- Mutex around reloadDictationWindow for a rapid first-run double-save — too
  speculative (reviewer agreed).
- whisper PID-file shared across instances / process.on('exit') SIGKILL — real but
  PRE-EXISTING, not introduced here. Left for a future pass.
- Dropping tap.isOpen()/hold.size() — they're the clean state-machine surface the
  unit tests assert against.

## Verification
- node --check on all touched files: clean.
- pnpm test:unit → 54/54. pnpm test:parity → 4 pass, 1 skip (bad-key network skip,
  pre-existing). pnpm test:cleanup → 8/9; the 1 "fail" is the documented honest
  rate-limit failure (groq 429 → retry → still 429 → raw fallback), not a regression.
- NOT yet rebuilt into /Applications/GVoice.app and NOT committed.

---

# Session notes — 2026-06-08 (pt.2): whisper-server lifecycle (stuck-on-Transcribing root cause)

- ROOT CAUSE of "stuck on Transcribing…, no output": the local whisper-server bound
  a FIXED port (8081). A crash / force-quit / app-update left the child orphaned
  holding 8081; the next launch couldn't bind → every dictation waited forever.
  (Confirmed the engine itself was fine: fed the user's real clips through the live
  relay → correct transcript in ~450-560 ms.)
- Provider was whisper-local all along (.env STT_PROVIDER=whisper-local) — NOT a
  silent switch to Deepgram.

## Fixes (src/providers/whisper-local.js + main.js)
- DYNAMIC PORT: each launch takes a fresh free port via net.createServer(0); a
  leftover server on the old port can no longer wedge startup. WHISPER_PORT still
  overrides. Consumers read WHISPER_SERVER_URL (set by ensureWhisperServer) per
  request, so the dynamic port is transparent.
- STALE REAP: PID written to tmpdir/gvoice-whisper-server.pid on spawn; next boot
  reaps it — but ONLY if the PID is alive AND `ps`/`tasklist` confirms it's really
  a whisper-server (guards against PID reuse). SIGTERM → 2s grace → SIGKILL.
- CLEAN SHUTDOWN: stopWhisperServer() = SIGTERM + 1.5s SIGKILL fallback + remove
  pidfile. Called from a shared shutdownAll() on before-quit AND new SIGINT/SIGTERM
  handlers (covers terminal/dev launches). process.on('exit') SIGKILLs as last ditch.
- ROBUST START: boot warm retries once; reaps any orphan before the first dictation.

## Verified on the installed app (rebuilt + reinstalled /Applications/GVoice.app)
- Fresh launch: 1 whisper-server on a dynamic port, relay on :3000, end-to-end
  transcription 563 ms.
- Simulated crash (SIGKILL main) → orphan survived → relaunch REAPED it; exactly
  one fresh server, pidfile updated.
- Normal quit → whisper-server gone, pidfile removed.
- 5/5 parity tests pass.

## Review-gate (lifecycle)
- ACCEPTED: dynamic port over "kill whatever holds 8081" — never touches an
  unrelated process, and removes the collision entirely rather than racing it.
- ACCEPTED: cmdline-verified kill (ps/tasklist) so a recycled PID is never killed.
- REJECTED: tracking/reaping ALL historical whisper-servers — out of scope; one
  pidfile for the server we own is enough, dynamic port makes leftovers harmless.

---

# Session notes — 2026-06-08: three regressions (empty paste / pill timing / listen to recordings)

- Reconciled diverged branches first: rebased local paste-timeout fix (cc7b273)
  onto remote Deepgram parallel-legs work (4acf6fa, 69204c7). No file overlap,
  clean rebase. New tip 4313349.
- ROOT CAUSE (likely behind #1 + #2): on macOS, a paste into a browser / Slack /
  editor often can't be read back (`focusedFieldValue()` → null), so a paste that
  silently went nowhere was still classed `pasted=true` → green "Success" pill at
  the short 3s/6s timer. Looks exactly like "not pasted anywhere, popup vanished
  before I could click."
- Empty Deepgram result (both auto-language legs silent, or a flush race) fell
  into a quiet hidePill() with the audio discarded — no pill, no recording.
- Tray menu had no way to play recordings; history stored text only; recordings
  were one-at-a-time and wiped at boot.

## Fixes
1. Renderer ships the audio on an empty terminal frame (>= MIN_FAILURE_BYTES);
   main saves it, shows an Error pill, records a history entry → failed attempts
   are now visible + listenable instead of silently dropped.
2. Pill lingers: confirmed success 6s; error OR unverified success 30s (main
   passes holdMs; renderer honours it; safety backstop = holdMs+15s).
3. Recordings persist (last 50, pruned; no boot wipe); each history entry carries
   its recordingPath; tray gives every recent dictation a Copy text / Play
   recording submenu, plus a top-level "Play last recording".

## Review-gate decisions (this pass)
- ACCEPTED (adversarial): unverified-success now lingers like an error — the
  highest-value fix; a silent browser miss stays recoverable from the pill.
- ACCEPTED (adversarial): random suffix on recording filename — airtight against
  two same-millisecond saves clobbering one file.
- ACCEPTED (adversarial): fixed stale "Cleared on success" comment in dictation.js.
- ACCEPTED (simplicity): drainChunks() helper collapses 3 encode+reset blocks so
  no terminal path can forget to clear the buffer.
- ACCEPTED (simplicity): trimmed the triplicated 3s/8s timing comment in pill.html.
- REJECTED: coupling MAX_RECORDINGS to MAX_ENTRIES via import — different modules,
  not worth the coupling for one int; comment notes the intent.
- REJECTED: age-based recording prune — count cap (50) already bounds the folder;
  persistence is exactly what the user asked for. PRIVACY NOTE surfaced to user:
  last 50 recordings now sit unencrypted in userData/temp-recordings (no boot wipe).
- Verified: 5/5 parity tests pass; all edited files pass `node --check`.

---

# Session notes — 2026-06-06: dictation stuck on "Transcribing…"

- Root cause: macOS-level wedge starting 11:08 (system process `com.apple.appkit` stuck in kernel exit state E). From then on every `osascript` invocation either took ~5.4 min to error ("System Events … isn't running (-600)") or got stuck in exit state permanently.
- The app's paste step (`src/typing.js` → `osascript … keystroke "v"`) awaited the child's exit with no timeout → pill frozen on "Transcribing…" forever. Two zombie osascript children (11:21, 11:26) had PPID = GVoice.
- Transcription pipeline verified healthy end-to-end: whisper-server ~0.3s; full WS relay round-trip on the running app returned the user's words in 351 ms.
- Fix shipped (cc7b273): 4s timeout race on the paste helper → on timeout the paste is treated as failed, error pill shows the text, text lands on the clipboard. Rebuilt + reinstalled /Applications/GVoice.app.
- Machine still needs a REBOOT to clear kernel-stuck (state E) processes — kill -9 cannot touch them.

## Review-gate decisions (paste timeout)
- ACCEPTED: `Number(env) || 4000` guard so a malformed TYPE_PASTE_TIMEOUT_MS can't make every paste fail instantly.
- REJECTED: distinguishing "keystroke landed but process stuck" from "never sent" on timeout — no reliable signal exists; a false error pill with recoverable text beats an infinite hang or false success.
- REJECTED: clipboard-clobber concern — pre-existing intentional recovery behavior.
- REJECTED: trimming the new constant's comment — documents a real incident; cosmetic.

## Recovered dictations (from temp recordings, via whisper)
- 11:26 attempt: "Good. I'll check if they were applied and if not apply them."
- 11:21 attempt: "yet label." (short clip)

---

# Notes — custom dictionary + polish pass

## Key architecture decision
main.js and the relay/providers run in the SAME node process (server is booted
in-process), so the dictionary is ONE module — `src/vocab.js` — with an
in-memory cache backed by one JSON file. main.js writes (on "Add"); the
providers read (on every connection). No IPC between them. This collapsed what
looked like a multi-process problem into a single shared module.

## Product decisions (from the user's answers)
- **Trigger = "only likely-misheard names."** detectCandidates is conservative:
  mid-sentence capitalized, ≥3 chars, real uppercase initial, not common, not
  already known/dismissed. Each unknown name is asked at most ONCE (session set
  + persistent dismissed list), so it converges to silence.
- **All three engines biased.** Whisper initial-prompt, Deepgram nova-3 keyterm
  (English-only — Deepgram limitation), OpenAI transcription prompt.
- **"Corrected" = watch manual edits** (the fuller option the user picked) PLUS
  it naturally covers cleanup-diff cases (a word the cleanup changed stays
  known). The manual-edit watcher (src/correction-watch.js) reconstructs
  hand-typed words from the uiohook keystream during a short post-dictation
  window and offers ones that are a near-miss (Levenshtein ≤2) of what GVoice
  typed.

## Anchoring the pop-up
The text caret's screen position isn't reliably available across apps on macOS,
so the pop-up anchors to the MOUSE cursor (where attention already is), not the
caret. Documented; acceptable for v1.

## Rabbit-hole avoided
A fully robust cross-layout, cross-app keylogger-style correction detector is a
large, fragile subsystem. Kept it pragmatic: US-letter layout + shift, bounded
to the armed window, in-memory only, listeners attached ONLY while armed. Names
are ASCII in practice; on other layouts it degrades to "no suggestion," never
wrong data. Flagged as the main scope cut.

## Review gate (adversarial + simplicity) — outcome
Merged (behavior/shape change, smaller or clearer, right regardless of source):
- **CRITICAL** detectCandidates used `[A-ZÀ-ſ]`, which matches LOWERCASE accented
  letters (ž/č/đ) → every lowercase Croatian word (the default language!) was a
  false candidate. Now `/^\p{Lu}/u`. Verified by test.
- **HIGH** First pop-up could be sent before the renderer registered its handler
  → lost. Now gated on the window's did-finish-load.
- **HIGH/MED** The 25s self-comparing correction window would nag during normal
  post-dictation typing. Now: corrections must be capitalized (name-like) AND
  the window dropped to 12s.
- **HIGH** WORD_RE's shared global lastIndex was correct only by luck.
  detectCandidates now uses a fresh regex instance.
- **MED** Deepgram keyterms were unbounded → handshake URL could grow past
  server limits as the dictionary fills. Capped at the 100 most recent.
- **MED/privacy** The keystroke listener was attached for the whole app
  lifetime (gated only in JS). Now attached only while armed, and self-detaches
  when the window lapses — not a standing global key listener.
- **Simplicity** Removed dead `getStorePath()` export, removed the never-called
  `vocab:hide` wire (preload + IPC), hoisted the duplicated 300×104 size const.

Rejected:
- US-layout / Caps-Lock limitations of the watcher — documented, out of v1 scope.
- dismiss-key normalization divergence — can't occur for clean word tokens
  (candidates come from a letters/'/- regex).
- Mouse-vs-caret anchoring — by design (caret position unavailable cross-app).

## Tests
- src/vocab.js logic: 18 + 7 assertions (throwaway scripts) — all pass, incl.
  the Croatian fix and the cap.
- Parity 5/5 pass (providers still wire-compatible).

## Takes effect after restarting GVoice
The hidden dictation window and the new pop-up window must reload the new
preloads + HTML, so changes only apply after the app restarts.

## Boot splash (2026-06-02)
- Replaced the bare/terminal-style startup with a branded splash:
  public/splash.html + preload-splash.cjs, driven from main.js
  (createSplashWindow / setSplashStatus / dismissSplashToTray).
- Shows boot stages (relay → engine → ready), then shrink+slide animates into
  the tray icon and closes. Frameless, transparent, focusable:false,
  showInactive — never steals the caret.
- public/icon.png copied from build/icon.png (ships at runtime). package.json:
  preload-splash.cjs added to build.files; mac/win icon config added.

Review-gate decisions (merged):
- Single readiness flag + held latest status (mirrors vocabWindowReady) instead
  of the per-call did-finish-load listener — earlier version stacked listeners
  and could collapse/drop boot-stage messages.
- Added a 9s dismiss backstop on the success path: if the dictation window's
  load ever hangs, the splash still tucks away instead of pinning on screen.
- One-shot `splashDismissed` guard so the backstop + ready path can't both run
  the animation.
- Dropped a no-op `icon:` option (frameless/transparent/dock-hidden window) and
  its unused APP_ICON const.
Rejected: nothing material outstanding.

## Packaged app (2026-06-02, follow-up)
Problem: launching via a .command (always opens Terminal) or a thin .app wrapper
made dictation "always error" — macOS grants Mic/Accessibility/Input-Monitoring
per executable PATH, and the wrapper ran Electron under a different path/identity
than the terminal launch (which borrowed Terminal's grants). Also stale copies
piled up (kill patterns missed the symlink path) -> no clean tray, "can't quit".

Fix: real packaged app via electron-builder.
- package.json build.mac: target "dir", LSUIElement true, NSMicrophoneUsageDescription.
- New src/bootstrap-env.js (imported FIRST in main.js, replaces dotenv/config):
  prepends Homebrew to PATH, loads .env + resolves WHISPER_MODEL from an absolute
  app home (GVOICE_HOME, default /Users/macmini/dev/voice) so a Finder launch with
  bare PATH and cwd=/ still finds the whisper-server binary, .env, and model.
- Built + signed (Apple Development cert on machine, team JZ4Z22F6BM) ->
  /Applications/GVoice.app. Removed the Desktop wrapper.
- .env stays OUT of the bundle (real API keys); the app reads it by absolute path,
  so the dev folder must remain in place.

Known/parity:
- koffi native binary was never downloaded (pnpm ignored its install script), so
  the macOS AX focus-detection ("[foreground] AX init failed") is disabled — SAME
  as the current dev/terminal launch. Paste still works via nut-js + clipboard.
  Not a regression; left for later (would need pnpm approve-builds koffi + asarUnpack).
- bootstrap-env.js hardcodes the dev-folder path as packaged default (behind
  GVOICE_HOME + app.isPackaged). Machine-specific; fine for personal build.

Still requires the user to grant Microphone + Accessibility + Input Monitoring to
"GVoice" once (Input Monitoring won't auto-prompt; the hotkey is silent without it).

## Mic entitlement fix (2026-06-02)
Root cause of "not asking for microphone": packaged app was signed with hardened
runtime ON but WITHOUT com.apple.security.device.audio-input, so the renderer was
blocked from the mic before macOS could prompt (TCC had no Microphone row, while
Accessibility + ListenEvent for com.purr.gvoice were granted=2).
Fix: build/entitlements.mac.plist (+ .inherit.plist) with audio-input + cs.* keys;
package.json mac: hardenedRuntime true + entitlements/entitlementsInherit. Rebuilt,
reinstalled. Accessibility/Input-Monitoring grants persisted (same bundle id+cert).
Mic now prompts on first dictation.

## Typing fix — packaged paste (2026-06-02)
After mic worked, dictation transcribed fine but paste threw:
"Cannot find module '@jimp/custom'". Cause: importing @nut-tree-fork/nut-js
eagerly loads jimp; electron-builder + pnpm bundled jimp but not its @jimp/*
sub-deps (pnpm-nesting collection gap). Rather than fight the bundler / reinstall,
src/typing.js now: (1) sends ⌘V on macOS via /usr/bin/osascript (System Events
keystroke) — no native dep; (2) imports nut-js lazily, only for the non-clipboard
type-each-char path and non-macOS paste. Verified: full dictation types text in
the packaged app. New one-time prompt on macOS: "GVoice wants to control System
Events" (Automation) — must be allowed once.
Note: on a packaged WINDOWS build the lazy nut-js path would still hit the jimp
gap; revisit if/when Windows is packaged (hoist node_modules or osascript-equiv).

## Polish pass reworded speech — passive-voice fix (2026-06-03)
Symptom: spoken commands occasionally came out reworded, e.g. "write a prompt to
fix this..." → "A prompt should be written to fix this...". STT was faithful; the
LLM polish pass (src/cleanup.js, polishTranscript, groq llama-3.3-70b) was doing
it. Intermittent (could not reproduce on the exact phrase in 5+ runs).
Root cause: SYSTEM_PROMPT framed the job as "polished written text" + "be
assertive about structure" with NO rule preserving the speaker's exact words,
grammatical voice, or sentence mood — so the model occasionally paraphrased.
Fix: added a top-priority "PRESERVE THE SPEAKER'S WORDS" section (forbids
paraphrase / active→passive / mood changes) + one reinforcing bullet in
PRESERVATION (strict). Recast the opener as "transcriptionist, NOT an editor"
and scoped "be assertive about structure" to layout only. Regression case added
to scripts/cleanup-test.js.

Review-gate decisions (merged):
- Test was fake-green: polishTranscript falls back to RAW text on any API error
  (429/timeout), and raw == verbatim, so the regression case passed even when the
  model never ran. Now it also asserts output != raw input (a real run adds a
  cap + period) so a rate-limited run FAILS honestly instead of green.
- Prompt self-contradiction: a "never reorder/drop words" supreme rule fought the
  list-formatting the same prompt still requires (and 2 existing tests assert).
  Added an explicit layout carve-out for the enumeration→list transform.
- Trimmed 3 overlapping bullets down to the load-bearing voice/mood/verbatim ones.

Rejected (surfaced, not done):
- Deterministic word-preservation guard (compare content words, fall back to raw
  on divergence). No SIMPLE version is both safe and effective: list/filler edits
  legitimately drop/reorder words, and this specific passive flip was a net +1
  word (17→18) — indistinguishable from a one-word transcription fix. A guard
  strict enough to catch it would discard real cleanups. Left as opt-in follow-up.
- Tightening the needsCleanup gate so short single-clause commands skip the LLM
  (just add a period locally). Reduces risk + latency, but changes capitalization
  behavior — a product/taste call for the user, not a unilateral change.

Verification: regression case PASS with modelRan=true on a clean window; 6/6
imperative phrases kept verbatim live; list/filler/prose/injection cases still
pass; parity 5/5. Note: the inline-numbered-enumeration test is brittle (exact
blank-line match on a stochastic model) and flakes ~occasionally — pre-existing,
not caused by this change (passed 3/3 on isolated re-run).
