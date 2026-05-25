# Refactor — multi-pass execution log

Durable plan + state for the modernization refactor. Source of truth between sessions.

## How to use this file

This file is the durable plan + state between sessions. After each pass lands the assistant always does these four steps, in order:

1. **Commit** the code change with the existing style (`<type>: pass <N> — <one-line summary>` + the Claude Opus 4.7 co-author trailer).
2. **Update the Status table** — flip the row to `✅ done`, record the SHA, keep the size column accurate.
3. **Rewrite "Next pass — details"** — replace the section with the upcoming pass's details (goal, files, risks, validation, expected commit shape). If there is no next pass, replace it with `Refactor complete.`
4. **End the reply with exactly one of:**
   - **`Reply "ok" to continue.`** — small/medium pass, prior context still useful, prompt cache stays warm. Pick this by default.
   - **A fenced `Continuation prompt` block ready to paste into a fresh window.** — pick this when the pass was large (file split, deps refresh, anything that bloats the diff), OR when the next pass shares no code context with the just-finished one. Print the block verbatim — title it `Start a new window — copy-paste this:` so the user knows what to do.

The recommendation heuristic is documented next to the Status table. Honor it unless the next pass's risk profile says otherwise (e.g. the next pass touches files the previous pass just rewrote → keep the cache warm, type "ok").

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
| 4 | Split `realtime-relay.js` into providers | ✅ done | `1a61d04` | **large** |
| 5 | Move `whisper-server` boot into whisper-local provider | ✅ done | `9546233` | medium |
| 6 | Split `public/realtime-voice-agent.js` | ✅ done | `500d6c6` | **large** |
| 7 | Electron security: preload bridge + `contextIsolation: true` for dictation window (was M1) | ✅ done | `7218b9f` | medium |
| 8 | `AudioWorklet` replaces `ScriptProcessorNode` in dictation + realtime-voice-agent (was M2) | ✅ done | `c63b323` | medium |
| 9 | Dependency refresh: latest Electron, `ws`, `uiohook-napi`, `@nut-tree-fork/nut-js` (was M3) | ✅ done | `ee59bec` | small-risky |
| 10 | `// @ts-check` + JSDoc types across `src/*` and `realtime-relay.js` (was M4) | ✅ done | `c593ece` | medium |

**Refactor complete.** All 11 passes (0–10) have landed. Parity stayed 5/5 throughout. Phase 1 (passes 0–6) restructured the codebase without behavior change; Phase 2 (passes 7–10) modernized Electron security, audio capture, dependencies, and added type checking.

Recommendation heuristic for `ok` vs new window:

- **Small/medium passes** that touch the same files as the previous pass → **`ok`** (cache stays warm, low context cost).
- **Large passes** (file splits, deps refresh) → **new window** after they land — the diff bloats context, and a fresh read of post-pass code is cheaper than carrying pre-pass state.
- **Topic switch** (next pass touches entirely different files than the just-finished one) → **new window** even if both passes are small — the prior context isn't useful.
- When in doubt, prefer `ok`. The user can always start a new window manually.

## Next pass — details

**Refactor complete.** No further passes planned. Future modernization work goes into the Status table with a sizing call before it starts, per "How to use this file" — never executed ad-hoc.

### Pass 10 — `// @ts-check` + JSDoc types (landed `c593ece`)

Added `// @ts-check` directive and inline JSDoc annotations to all 12 Node-side source files:

- `realtime-relay.js`, `server.js`, `main.js`, `preload.cjs`
- `src/cleanup.js`, `src/dictation-session.js`, `src/hotkey.js`, `src/typing.js`
- `src/providers/_shared.js`, `src/providers/openai.js`, `src/providers/deepgram.js`, `src/providers/whisper-local.js`

No `tsconfig.json`, no build step — editors that read `// @ts-check` (VS Code default, JetBrains optional) now type-check the codebase live. Runtime unaffected.

Type check command (re-runnable for future verification):

```
npx --package=typescript -- tsc --noEmit --allowJs --checkJs \
  --target esnext --module nodenext --moduleResolution nodenext --strict false \
  realtime-relay.js server.js main.js preload.cjs \
  src/cleanup.js src/dictation-session.js src/hotkey.js src/typing.js \
  src/providers/_shared.js src/providers/openai.js \
  src/providers/deepgram.js src/providers/whisper-local.js
```

The pass surfaced 5 real findings, each fixed without silencing:

1. `main.js` used `app.isQuitting` — a community-tutorial monkey-patch onto Electron's App singleton. Replaced with a module-local `let isQuitting = false` (4 call sites).
2. `main.js`'s `unhandledRejection` handler treated `reason` as if it had `.stack`. `reason` is `unknown` per Node types — narrowed via `"stack" in reason`.
3. `main.js`'s `Menu.buildFromTemplate` argument lost its narrow `role: "about"` literal types through the array spread — annotated as `MenuItemConstructorOptions[]` to preserve them.
4. `server.js`'s HTTP "error" listener typed `error` as `Error`, but the `EADDRINUSE` check uses `.code`. Retyped as `NodeJS.ErrnoException`.
5. `whisper-local.js`'s `new Blob([buffer], ...)` failed TS 6.x's tightened `BlobPart` (SharedArrayBuffer vs ArrayBuffer). Passed `buffer.buffer` with explicit `ArrayBuffer` cast.

Parity 5/5 green throughout.

## Continuation prompt (paste into a fresh window)

When a pass calls for a fresh window, print this block verbatim — the user pastes it into a new Claude Code session in this repo.

```
Resume the modernization refactor for this repo.

1. Read docs/REFACTOR.md — it is the durable plan + state. The Status table
   shows which pass is next; "Next pass — details" has the full brief.
2. If you have not read them already, read docs/ARCHITECTURE.md (current-state
   map) and docs/RELAY_PROTOCOL.md (the wire contract the parity harness asserts).
3. Run `npm run test:parity` to confirm baseline green (expect tests 5 / pass 5).
4. Execute the "Next pass — details" section. Match the existing commit style
   (lowercase prefix like "refactor:" or "feat:" or "chore:", one-line summary,
   "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" trailer).
5. After committing, follow the four-step workflow in "How to use this file":
   commit → update Status table → rewrite "Next pass — details" → end the reply
   with either `Reply "ok" to continue.` or a fresh Continuation prompt block
   per the recommendation heuristic.

Do not push unless explicitly asked. Do not start passes beyond the one named
in "Next pass — details" without explicit approval.
```

## Backlog beyond the planned passes

Nothing currently. Once Passes 7–10 land the refactor is fully complete. Any new modernization work added later goes into the Status table with a sizing call before it starts — never executed ad-hoc.
