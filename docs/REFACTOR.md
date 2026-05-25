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
| 1 | Fix platform-wrong error string + remove dead `preload.cjs` reference | ⏭ next | — | small |
| 2 | De-duplicate transcription-only model set | pending | — | small |
| 3 | Encapsulate dictation session state | pending | — | small |
| 4 | Split `realtime-relay.js` into providers | pending | — | **large** |
| 5 | Move `whisper-server` boot into whisper-local provider | pending | — | medium |
| 6 | Split `public/realtime-voice-agent.js` | pending | — | **large** |

Recommendation heuristic for `ok` vs new window:

- Small / medium passes → **`ok`** (cache stays warm, low context cost).
- Large file-split passes (4, 6) → **new window** after they land (diff bloats context; fresh read of post-pass code is cheaper than carrying pre-pass state).

## Next pass — details

### Pass 1 — fix platform-wrong error string + remove dead `preload.cjs` reference

**Files:** `main.js`

**Changes:**

1. `main.js:94` — `serverError = "Missing OPENAI_API_KEY in C:\\dev\\voice\\.env"` hardcodes a Windows path. Replace with a platform-neutral message that names the actual `.env` location (`<repo>/.env`).
2. `main.js:17` — `const preloadPath = join(__dirname, "preload.cjs")` followed by `existsSync(preloadPath) ? preloadPath : undefined` at line 117. `preload.cjs` does not exist; reference is dead. Remove both lines.

**Validation:**

- `npm run test:parity` → still 4/4 green.
- Manual: temporarily unset `OPENAI_API_KEY`, `npm start`, confirm setup window shows a platform-neutral path (no `C:\\`).

**Expected commit shape:** one file, ~6 lines changed.

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
