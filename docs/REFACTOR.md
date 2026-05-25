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
- Baseline: `tests 5 / pass 5 / ~10.5s` against OpenAI + Deepgram + whisper-local + OpenAI-bad-key contract (added in Pass 4).

## Status

| # | Pass | Status | SHA | Size |
|---|------|--------|-----|------|
| 0 | Scaffolding (docs + parity harness + dead-file purge) | ✅ done | `48754b2` | medium |
| 1 | Fix platform-wrong error string + remove dead `preload.cjs` reference | ✅ done | `32507f3` | small |
| 2 | De-duplicate transcription-only model set | ✅ done | `c505926` | small |
| 3 | Encapsulate dictation session state | ✅ done | `125e98b` | small |
| 4 | Split `realtime-relay.js` into providers | ✅ done | _next-pass fills in_ | **large** |
| 5 | Move `whisper-server` boot into whisper-local provider | ⏭ next | — | medium |
| 6 | Split `public/realtime-voice-agent.js` | pending | — | **large** |

Recommendation heuristic for `ok` vs new window:

- Small / medium passes → **`ok`** (cache stays warm, low context cost).
- Large file-split passes (4, 6) → **new window** after they land (diff bloats context; fresh read of post-pass code is cheaper than carrying pre-pass state).

## Next pass — details

### Pass 5 — move `whisper-server` child-process boot into the whisper-local provider

**Files:**

- `main.js` — delete `bootWhisperServer`, `waitForServer`, and the call site in `app.whenReady`. Also delete the `whisperServerProc` global and its `before-quit` cleanup.
- `src/providers/whisper-local.js` — own the child-process boot. Lazy-start on first connection. Set `process.env.WHISPER_SERVER_URL` once ready (matching today's handoff). Cleanup on process exit.

**Why this is medium not small:**

The whisper-server lifetime currently spans the entire Electron app (boot at `whenReady`, kill at `before-quit`). Moving it into the provider means the first browser→relay connection triggers the boot — and that connection must wait for the server to be reachable before the relay starts feeding it audio. The provider's `attach()` becomes async-aware: it can't return immediately if the server is still starting.

Two reasonable shapes:

1. **Lazy + per-process singleton:** the provider boots the server once and caches the promise; subsequent attach calls await the same promise. Tracks the child process at module scope so a single SIGTERM handler in the module cleans it up at exit. _Cleanest. Recommended._
2. **Eager from realtime-relay.js:** the relay boots the server during `attachRealtimeRelay()` if `STT_PROVIDER=whisper-local`. Closer to today's behavior but couples the relay to provider internals.

Go with option 1.

**Changes:**

1. New module-scope state in `src/providers/whisper-local.js`:
   - `let whisperServerProc = null;`
   - `let whisperServerReady = null;` (Promise; cached on first call)
   - `function ensureWhisperServer()` — spawns `whisper-server`, polls until `http://127.0.0.1:<port>` answers, sets `process.env.WHISPER_SERVER_URL`. Returns the cached promise on subsequent calls.
2. `attach()` becomes async: awaits `ensureWhisperServer()` before wiring `clientSocket.on("message")`. Frames the browser sends during the boot wait are buffered (same logic that's already there for audio chunks; no change needed since the message handler isn't attached until after the await).
3. Process-exit cleanup: register a `process.on("exit")` handler in the module that SIGTERMs the child if it's still alive. Don't rely on Electron's `before-quit`.
4. `main.js`: delete `bootWhisperServer` + `waitForServer` + the `app.whenReady` call site + the `before-quit` whisperServerProc.kill block + the `whisperServerProc` global. Net deletion ~45 LoC.

**Validation:**

- `npm run test:parity` → 5/5 green. The whisper-local test must specifically prove that the provider's lazy server boot works: today the test relies on `whisper-cli` CLI fallback (no WHISPER_SERVER_URL set in the test env), so after this pass the test will trigger the lazy server boot and use the server path. Bump the whisper-local sub-test timeout to 60s to cover the first-boot cold start.
- Manual: `STT_PROVIDER=whisper-local npm start`, hold the hotkey, dictate. Server boots on first press. Quit cleanly with ⌘Q, confirm `whisper-server` is no longer in `ps`.

**Expected commit shape:** two files, ~+90 / ~−60 LoC. No public API change.

**Note for the assistant executing this pass:** also backfill Pass 4's SHA into the Status table when committing (lazy SHA-fill pattern).

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
