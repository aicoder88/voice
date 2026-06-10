# GVoice polish pass — 2026-06-10

Solo review (the 8-agent workflow hit the session limit; reviewed inline).
Baseline: 97/97 unit, 4/5 parity (1 clean network skip). Impact-ordered.

## 1. Fix the uncommitted transcribeHrEn race (auto-language correctness)  ☑ done
File: src/providers/whisper-local.js (uncommitted diff in working tree)
- BUG in the WIP change: "first clean leg wins" defeats the function's purpose.
  whisper-server serializes inference (one model context), and the EN leg is
  POSTed first → EN nearly always finishes first. A forced-EN decode of
  Croatian speech is garbled-but-real-looking text that PASSES the sanitizer,
  so in auto mode Croatian would get typed as English garble almost every time.
  The old confidence comparison was the only thing picking the right language.
- Also: one leg erroring rejects the whole promise even when the other leg
  has a good result (both old and new code) → falls back to slow CLI re-run.
- Fix: Promise.allSettled both legs; pick via a NEW exported pure function
  pickTranscript(en, hr) (sanitizer-survivor first, then confidence; a failed
  leg loses to a successful one; both failed → throw so CLI fallback runs).
- Unit tests for pickTranscript in scripts/unit (no server needed).

## 2. Bind the local relay to loopback only (privacy)  ☑ done
File: server.js
- BUG: server.listen(port) / listen(0) bind 0.0.0.0 — anyone on the same
  Wi-Fi can reach the static server, /recordings/<name>.wav voice clips, and
  the WS relay that spends the API keys. whisper-server already binds
  127.0.0.1; the relay should too.
- Fix: listen(port, "127.0.0.1") in both call sites.

## 3. Settings window's cleanup default disagrees with the app (silent flip)  ☑ done
Files: src/settings.js, scripts/unit/settings.test.js
- BUG: main.js runs cleanup unless CLEANUP_ENABLED==="false" (default ON);
  settingsView reports OFF when unset. On a fresh install, opening Settings
  and pressing Save writes CLEANUP_ENABLED=false — silently disabling the
  AI tidy-up that was running. (Current machine sets it explicitly, so it
  doesn't bite here — it bites fresh installs.)
- Fix: settingsView default true; update the test that pinned the wrong value.

## 4. Dead file + stale docs  ☑ done
- Delete public/setup.html — the "main window" of the app's first iteration;
  nothing loads it (verified: no references in any js/html).
- SETUP.md + docs/ARCHITECTURE.md: remove/replace the setup.html rows.
- README.md Troubleshooting: debug.log lives in the app-data folder when the
  installed app runs (moved 2026-06-09); README still says repo-root only.
- realtime-relay.js JSDoc: deepgramModel default says "nova-2" (code: nova-3);
  deepgramLanguage default says "hr" (code: null = read env per connection).
- pill.html comment: "Backstopped by main's safety timer (12s/45s)" — actual
  is holdMs+15s (21s/45s).

## 5. Verify  ☑ done
- node --check on touched files; pnpm test:unit; pnpm test:parity.
- Review gate (adversarial + simplicity) — subagents if the session limit
  allows, otherwise honest self-review noted in notes.md.
- Commit to main (NO push). Rebuild + reinstall /Applications/GVoice.app,
  relaunch (established ship step for this app).
