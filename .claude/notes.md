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
