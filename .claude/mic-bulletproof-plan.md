# Plan — make GVoice mic + tray bulletproof (2026-06-16)

Root cause: app captures the macOS *default* input (never pins a device) and only
rebuilds on the next key-press. This Mac has several virtual mics (Immersed VR,
Virtual Desktop Mic, Teams). On sleep/wake/USB churn the default becomes a silent
device (peak=0), or Chromium's audio helper process wedges → app stays deaf until a
full restart. Tray icon also drops from the menu bar on wake, leaving no way in.

## Steps (impact order)
1. [done] Restart the stuck instance (immediate cure).
2. Renderer: liveness-probe device selection — enumerate inputs, bind to one that
   actually produces signal, prefer last-known-good. (`public/dictation.js`)
3. Renderer: active background recovery loop (no key-press needed) with backoff; on
   exhaustion, escalate to main. (`public/dictation.js`)
4. Renderer: device-label log line on every capture build (diagnostic).
5. Main: escalation ladder — reload renderer first, then guarded full-app relaunch
   (rate-limited, last resort). (`main.js` + `preload.cjs`)
6. [done] Main: recreate tray on resume/unlock if missing; add "Restart
   microphone" tray item (manual lever, no editor needed). (`main.js`)
7. [done] Review gate (adversarial + simplicity). Adversarial found: (a) press
   vs recovery concurrency race → fixed with captureBusy lock + startInFlight
   guards; (b) OS-muted mic misread as dead → guarded with track.muted check;
   (c) startup race → routed through recoverMic; (d) unbounded relaunch →
   gated on everHadLiveMic + argv-persisted cooldown. Simplicity: removed a
   redundant resume(). 110 unit + 4 parity tests pass.
8. [done] Built (same Apple Development cert → permissions preserved), replaced
   /Applications/GVoice.app, relaunched. Verified live: startup probe bound to
   real Anker mic, rejected virtual mics, "Mic recovered (round 1)".

## Notes
- Auto-relaunch demoted from centerpiece to guarded backstop (advisor): device
  selection is robust under both "default→virtual" and "audio-helper wedged".
