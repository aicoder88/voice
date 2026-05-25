# Refactor — multi-pass execution log

Durable plan + state for the modernization refactor. Source of truth between sessions.

## How to use this file

After each pass commits, the assistant will:

1. Update the **Status** table below to mark the pass complete + record its SHA.
2. Rewrite **Next pass — details** for the upcoming pass.
3. End the reply with **one** of:
   - **`ok` to continue** — keep going in the current context (small pass, context still cheap).
   - **Start a new window** — and print the `Continuation prompt` block below verbatim, so a fresh Claude can resume from cold.

You then either type `ok`, or open a new Claude Code session in this repo and paste the printed continuation prompt.

## Goal & constraints

- Modernize without behavior change. Public APIs frozen.
- Public surfaces preserved:
  - `attachRealtimeRelay(server, options)` signature + option keys (see `README.md`).
  - `<realtime-voice-agent>` custom element: name, attributes (`endpoint`, `agent`, `compact`, `instructions`, `autoconnect`), shadow-DOM contract.
  - `startServer({ port, model }) → Promise<{ server, port }>`.
  - `/realtime` WebSocket protocol per `docs/RELAY_PROTOCOL.md` (4 invariants).
- Validation gate per pass: **`npm run test:parity` must stay green**.
- Baseline before Pass 1: `tests 4 / pass 4 / ~6.6s` against OpenAI + Deepgram + whisper-local.

## Status

| # | Pass | Status | SHA | Size |
|---|------|--------|-----|------|
| 0 | Scaffolding (docs + parity harness + dead-file purge) | ✅ done | `48754b2` | medium |
| 1 | Fix platform-wrong error string + remove dead `preload.cjs` reference | ✅ done | `32507f3` | small |
| 2 | De-duplicate transcription-only model set | ✅ done | _next-pass fills in_ | small |
| 3 | Encapsulate dictation session state | ⏭ next | — | small |
| 4 | Split `realtime-relay.js` into providers | pending | — | **large** |
| 5 | Move `whisper-server` boot into whisper-local provider | pending | — | medium |
| 6 | Split `public/realtime-voice-agent.js` | pending | — | **large** |

Recommendation heuristic for `ok` vs new window:

- Small / medium passes → **`ok`** (cache stays warm, low context cost).
- Large file-split passes (4, 6) → **new window** after they land (diff bloats context; fresh read of post-pass code is cheaper than carrying pre-pass state).

## Next pass — details

### Pass 3 — encapsulate dictation session state

**Files:** `main.js`, new `src/dictation-session.js`

**Changes:**

1. Create `src/dictation-session.js` exporting a `DictationSession` class with these fields/methods:
   - `busy: boolean`
   - `pressAt: number | null`
   - `releaseAt: number | null`
   - `start()` — sets `busy = true`, `pressAt = Date.now()`, returns `true` if accepted, `false` if already busy.
   - `release()` — sets `releaseAt = Date.now()`, arms a safety timer (default 1500 ms) that clears `busy` if a transcript never lands. Returns the millisecond delta since press for logging.
   - `finalize()` — clears the safety timer and resets `busy = false`. Returns `{ sinceRelease }`.
   - `cancel(reason)` — clears timer + state on error.
2. `main.js` — replace every `global.__dictationBusy / __dictationPressAt / __dictationReleaseAt / __dictationBusyTimer` use with an instance of `DictationSession`. The hotkey `onPress` / `onRelease` and the `ipcMain.on("dictation:transcript", ...)` / `ipcMain.on("dictation:error", ...)` handlers all become 3–5 line wrappers over the session object.

**Validation:**

- `npm run test:parity` → 4/4 green. (Parity gate tests the relay, not main.js, so this is mostly proving the relay wasn't accidentally touched.)
- Manual: `npm start`, hold/release the hotkey three times in quick succession, confirm the "previous dictation still processing" guard still fires for the second press, and the safety-timeout still clears `busy` if no transcript arrives within 1.5 s.

**Expected commit shape:** two files, ~80 lines added (new session module), ~25 lines removed (globals + ad-hoc timer mgmt in `main.js`). Pure refactor — no behavior change.

**Note for the assistant executing this pass:** also backfill Pass 2's SHA into the Status table when committing (lazy SHA-fill pattern).

## Continuation prompt (paste into a fresh window)

```
Resume the modernization refactor for this repo.

1. Read docs/REFACTOR.md — it is the durable plan + state. The Status table
   shows which pass is next.
2. If you have not read them already, read docs/ARCHITECTURE.md (current-state
   map) and docs/RELAY_PROTOCOL.md (the wire contract the parity harness asserts).
3. Run `npm run test:parity` to confirm baseline green (expect tests 4 / pass 4).
4. Execute the "Next pass — details" section. Match the existing commit style
   (lowercase prefix, "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>").
5. After committing, update docs/REFACTOR.md: mark the pass complete with its
   SHA in the Status table, rewrite "Next pass — details" for the following
   pass, and reply with either "type ok" or a fresh continuation prompt per
   the file's recommendation heuristic.

Do not push. Do not start passes beyond the one named in "Next pass — details"
without explicit approval.
```

## Out of scope (separate PRs after this refactor lands)

- **M1.** Electron `preload.cjs` + `contextIsolation: true` for the dictation window (security migration; replaces today's `nodeIntegration: true` pattern).
- **M2.** `AudioWorklet` replaces deprecated `ScriptProcessorNode` in `public/dictation.js` and `public/realtime-voice-agent.js`.
- **M3.** Dependency refresh: `electron@33`, `uiohook-napi`, `@nut-tree-fork/nut-js`, `ws`.
- **M4.** Optional: `// @ts-check` + JSDoc types across `src/*` and `realtime-relay.js`.
