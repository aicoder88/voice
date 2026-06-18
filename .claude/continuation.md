# Continuation — GVoice polish pass (2026-06-17)

## Where things stand
Ran a 9-dimension find→adversarially-verify review workflow (60 agents): 39 confirmed
findings (0 critical, 0 high, 7 medium, 32 low), 12 refuted. Then applied the high-value
confirmed fixes in 5 batches, each tested. NOT committed, NOT shipped (waiting on user).

Tests after all batches: unit 110/110, parity 4 pass + 1 known network skip, cleanup 9/9.

## Fixed this pass (by finding #)
- Batch A (zero-risk docs/config/dead-code/copy): #4 #5 #6 #12 #20 #21 #22 #23 #26 #27 #28 #29 #30 #31 #32 #33 #34 #35 #36 #37
- Batch B (contained robustness/hardening): #7 #9 #10 #16 #17 #18 #19 #24 #25 #38
- Batch C (whisper-server lifecycle): #1 #14
- Batch D (bad-OpenAI-key surfacing): #0
- Batch E (GPU probe): #3 (memoize; async full-fix surfaced, not done — Windows-only/untestable here)

## #2 relay auth — DONE (user chose Origin check over token)
- realtime-relay.js: default-deny cross-origin WS upgrades; allow loopback origins + missing-Origin
  (native clients). New `allowedOrigins` option (["*"] or exact list) for cross-origin reuse.
  Browsers can't forge Origin, so this blocks the "malicious website spends your key" threat with
  ZERO change to the dictation path. Tested: new parity case (cross-origin rejected, loopback+none
  accepted) + verified on the LIVE dev app. RELAY_PROTOCOL.md documents it.

## LIVE SMOKE TEST — passed (2026-06-17/18)
Quit installed app → launched dev build → verified, then restored installed app:
- Boots clean (all main.js edits, web-contents guard, dialog import, engine guards — no crash).
- Relay up + serves dictation.html (HTTP 200); global hotkeys active (uiohook loaded); mic live.
- whisper-server warmed at boot → exercised #1/#14 ensureWhisperServer restructure LIVE, succeeded.
- #2 Origin gate on live relay: loopback ACCEPTED, cross-origin REJECTED, no-origin ACCEPTED.
- End-to-end transcription through live relay: connected+completed frames (empty transcript = correct
  for the tone fixture; silence gate refused to hallucinate).
- Clean quit reaped the whisper-server child (before-quit→stopWhisperServer worked). Installed app restored.
- NOT exercised live (needs a held key + speech + focused field): the physical hold→speak→paste loop
  and the dictation.js renderer frame-handling (#0 bad-key msg, #7 guards) — verified by reasoning + the adversarial gate.

## Surfaced, NOT changed (verifier said leave)
- #8  worklet tail-flush — verifier: proposed fix doesn't work, would reorder load-bearing commit lifecycle. Leave.
- #11 losing Deepgram leg not closed — low payoff, lifecycle risk. Leave.
- #15 relay/WS not closed on quit — OS reaps socket on exit; no real leak. Leave.
- #3-async the full async GPU-probe fix (removes even the first-call block) — Windows-only, can't test here.

## Known follow-ups (prior-plan items still open, NOT done this pass)
- parity test "openai bad-key" (item 4a): restores the key before connect, so it can never fail → always skips.
  Fixing it (keep bad key until after the assertion) would actually exercise the #0 relay path. Network-dependent.
- NEW scripts/unit/dictation-session.test.js (4d); package.json "test" alias (4f); mic-health holdMs cases (4e).

## Key files touched
main.js, public/dictation.js, src/providers/{whisper-local,deepgram}.js, src/{vocab,cleanup,hardware,model-download,settings,foreground,bootstrap-env}.js,
public/{settings,dictionary,pill}.html, public/realtime-voice-agent{.js,/template.js}, scripts/cleanup-test.js,
README.md, SETUP.md, docs/ARCHITECTURE.md, .env.example, pnpm-workspace.yaml.

## Review docs
- .claude/review-findings-2026-06-17.md — all 39 confirmed + 12 refuted, full detail.
- .claude/triage-2026-06-17.md — fix-vs-surface decisions.
