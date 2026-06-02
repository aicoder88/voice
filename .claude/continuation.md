# Continuation — custom dictionary + polish pass

Status: COMPLETE. Unit tests (18/18) + parity (5/5) pass. Not committed
(awaiting user "ok"/"push").

## What this added
GVoice now learns the names/jargon it mishears. After a successful dictation it
looks for an unusual capitalized name in what it typed, and (macOS/Linux) watches
~12s for the user hand-fixing a word. Either triggers a small pop-up at the
cursor: *Add "X" to your dictionary?* Added words bias every engine. Asked once
per word; "No thanks" is remembered forever.

## Follow-up added this turn (the bootstrap fix)
User feedback: "it tends to guess at words I'm making up — there is no pop-up."
Root cause: the cursor pop-up can only confirm what was transcribed, but a
made-up word is transcribed as a *different* real word (usually lowercase, so it
isn't even flagged as a name candidate) — so the pop-up can never capture it.
The only fix is seeding the word BEFORE transcription so the engine biases
toward it. Added a **dictionary manager window** (tray → "Manage dictionary…")
to type words in directly + review/remove them. Replaced the raw-JSON
"Edit dictionary…" tray item (and removed now-dead vocab.ensureFile /
getStorePath). New files: public/dictionary.html, preload-dictionary.cjs. New in
main.js: openDictionaryWindow + ipcMain.handle vocab:list / vocab:add-many /
vocab:remove. New in vocab.js: removeTerm. package.json: preload-dictionary.cjs
in build.files.

## Files
- src/vocab.js (NEW) — the dictionary store + brains. init/addTerm/removeTerm/dismissTerm/
  isKnown/isDismissed, detectCandidates (mid-sentence capitalized, unknown,
  uncommon), isLikelyCorrection (Levenshtein ≤2 near-miss), wordsOf, and the
  three provider formatters (whisperPromptAddition / deepgramKeyterms /
  openaiPromptAddition). Store: userData/custom-vocab.json (repo-local default
  for non-Electron hosts). Seeds the "known" set from models/vocab.txt too.
- src/correction-watch.js (NEW) — uiohook keydown/mousedown listener, armed per
  dictation, reconstructs hand-typed words (US-letter layout + shift), no-op on
  Windows. Privacy: only acts while armed, only the in-progress word in memory.
- public/vocab-prompt.html (NEW) + preload-vocab.cjs (NEW) — the cursor pop-up.
- main.js — vocab.init at boot; createVocabWindow / positionVocabAtCursor /
  showVocabPrompt / hideVocab / maybeSuggestVocab; correctionWatcher wiring
  (arm on success, disarm on next press); IPC vocab:add/dismiss/hide; tray
  "Edit dictionary…"; GVOICE_DEBUG-gated debug() replacing chatty info logs.
- src/providers/deepgram.js — appends nova-3 `keyterm` (or `keywords`) per
  custom term, English-only (alongside smart_format guard).
- src/providers/whisper-local.js — folds whisperPromptAddition() into the
  initial prompt every commit.
- src/providers/openai.js — adds transcription `prompt` from the dictionary.
- src/hotkey.js — PRESS/RELEASE/TAP traces gated behind GVOICE_DEBUG.
- package.json — preload-vocab.cjs added to build.files.
- README.md — rewritten for GVoice. SETUP.md + .env.example — dictionary section
  + GVOICE_CORRECTION_WATCH_MS / GVOICE_DEBUG.
- debug.log — deleted (gitignored).

## Trigger model (per user's answers)
- "Only likely-misheard names": detectCandidates is conservative (mid-sentence
  capitalized, ≥3 chars, not common, not known/dismissed).
- All three engines biased.
- "Corrected" = BOTH the cleanup-diff cases (a known word stays known) AND
  watching manual edits via the keystroke watcher (user chose the fuller path).

## Config / env
- GVOICE_CORRECTION_WATCH_MS (default 12000; 0 disables manual-edit watch).
- GVOICE_DEBUG=1 echoes per-event traces to console (always in debug.log).

## Tests
- node /tmp/vocab-test.mjs — 18 assertions (candidate detection, correction
  match, add/dismiss roundtrip, provider formatting). Throwaway; re-derive from
  src/vocab.js exports if needed.
- node --test scripts/parity/dictation-flow.test.js — 5/5 pass.

## Known limitations (see notes.md)
- Manual-edit watcher is macOS/Linux only and US-letter-layout (names are ASCII
  in practice); Windows still gets transcript-based suggestions.
- Deepgram keyterm boosting is English-only (Deepgram limitation); Whisper
  biasing works in any language.
- Caret position isn't available cross-app on macOS, so the pop-up anchors to
  the mouse cursor, not the text caret.
