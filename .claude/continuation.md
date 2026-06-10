# Continuation — GVoice full-review fix pass (paused 2026-06-10 night)

## Where things stand
Two passes happened today on top of commit fc5e3a5:

1. **Morning polish pass — SHIPPED.** Commit 3cb9cb9 (auto-language pick fix,
   loopback-only relay, settings cleanup default, dead setup.html). Built and
   installed to /Applications/GVoice.app — **that build is what's running now;
   it's stable.**

2. **Full-review fix pass — CODE DONE & COMMITTED, NOT SHIPPED.** A 63-agent
   review produced 41 confirmed findings (+36 lows). Roughly 80% are fixed and
   committed (see "DONE" in .claude/plan.md). Tests: 105/105 unit, 4/5 parity
   (the 1 skip is the pre-existing OpenAI network skip).
   The /Applications build does NOT include these fixes yet — shipping is the
   last step, after the pending items below.

## What's left (impact order — full details in .claude/plan.md "PENDING")
1. settings.html: REQUIRED follow-up to a committed change — engine:apply can
   now return { error } and the renderer doesn't display it; also the failed-
   benchmark panel still offers "Use on-device", plus 3 copy fixes.
2. benchmark-run.js: stop the benchmark whisper-server in finally (else live
   dictation silently switches to the benchmark model); add a fetch timeout.
3. hardware.js: memoize probeCapability (sync PowerShell blocks main process).
4. Tests: parity bad-key restore-order fix; cleanup-test exit code;
   recordings.test basename; NEW dictation-session.test.js; mic-health holdMs
   cases; package.json "test" alias.
5. Review gate (adversarial + simplicity) over the whole uncommitted-pass diff
   (`git diff 3cb9cb9..HEAD`), then full tests.
6. Ship: pnpm build → swap /Applications/GVoice.app → relaunch → smoke test
   (dictate; pill buttons clickable, margins click-through; sleep→wake).

## Sharp edges to know before resuming
- main.js engine:apply now returns { error: string } when the model file is
  missing — settings.html MUST be taught to show it (pending item 1) or a
  failed apply looks like a silent success in the UI. This is the only
  committed change with a loose end.
- The pill click-through rework (pill:set-interactive IPC, forward:true) is
  committed but has NOT been manually tested in a live app — verify the
  Copy/Open buttons still click during the smoke test.
- whisper-local exit-handler reset is guarded by `whisperServerProc ===
  thisProc` — don't "simplify" the guard away; late exits from replaced
  children would clobber the successor's state.
- settings.js now single-quotes spaced values (dotenv reads them literally);
  double quotes would expand \n in Windows paths. Tests pin this.
- The full review-findings JSON lives in /private/tmp/... (may not survive a
  reboot) — but plan.md restates every pending item self-contained.

## Key files touched in the unshipped pass
main.js, src/hotkey.js, src/dictation-session.js, src/foreground.js,
src/typing.js, src/settings.js, src/cleanup.js, src/history.js,
src/correction-watch.js, src/providers/{whisper-local,deepgram,openai}.js,
realtime-relay.js, server.js, public/{dictation.js,mic-health.js,pill.html},
preload-pill.cjs, scripts/unit/settings.test.js, all 5 docs (agent pass).
