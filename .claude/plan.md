# Plan — custom dictionary + polish pass

Goal: GVoice learns the names/jargon it mishears. After a dictation, a pop-up at
the cursor offers to add an unusual name — or a word the user just hand-fixed —
to a custom dictionary that biases every speech engine. Plus four polish fixes.

Status: COMPLETE (not committed — awaiting user go-ahead).

Impact-ordered:

1. **Custom dictionary store** — `src/vocab.js`. One JSON store
   (`userData/custom-vocab.json`) shared in-process by main.js (writes) and the
   relay providers (read). Candidate detection (likely-misheard names),
   correction matching (Levenshtein near-miss), add/dismiss, per-provider
   formatting. DONE + 18 unit assertions pass.

2. **Feed all three engines** — whisper-local (initial prompt), deepgram (nova-3
   `keyterm`, English-only), openai (transcription `prompt`). DONE. Parity 5/5.

3. **Cursor pop-up** — `public/vocab-prompt.html` + `preload-vocab.cjs` +
   `createVocabWindow`/`showVocabPrompt` in main.js. Frameless, non-focusable,
   appears at the mouse cursor. Add / No-thanks. Asks once per word per session;
   "No thanks" persists forever. DONE.

4. **Manual-correction watcher** — `src/correction-watch.js`. Adds its own
   keydown/mousedown listener to the existing uiohook singleton, armed for
   ~25s after each dictation, reconstructs hand-typed words, offers the ones
   that look like a fix of what GVoice typed. macOS/Linux only. DONE.

5. **Polish fixes**:
   - README rewritten for GVoice (was the old "Realtime Voice Agents" demo). DONE.
   - Stale `.claude/` docs refreshed (this pass). DONE.
   - Per-event console logs gated behind `GVOICE_DEBUG` in main.js + hotkey.js. DONE.
   - `debug.log` deleted (gitignored). DONE.
   - (#4 from the audit — Windows-only build target — intentionally skipped:
     the app runs on macOS via `electron .`, no Mac packaging target needed.)

See notes.md for decisions and the review-gate outcome.
