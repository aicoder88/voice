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
| 7 | Electron security: preload bridge + `contextIsolation: true` for dictation window (was M1) | ⏭ next | — | medium |
| 8 | `AudioWorklet` replaces `ScriptProcessorNode` in dictation + realtime-voice-agent (was M2) | ⏭ planned | — | medium |
| 9 | Dependency refresh: latest Electron, `ws`, `uiohook-napi`, `@nut-tree-fork/nut-js` (was M3) | ⏭ planned | — | small-risky |
| 10 | `// @ts-check` + JSDoc types across `src/*` and `realtime-relay.js` (was M4) | ⏭ planned | — | medium |

Phase 1 (passes 0–6, structural refactor) landed. Phase 2 (passes 7–10, modernization) is planned but not started — each needs explicit go-ahead before kicking off.

Recommendation heuristic for `ok` vs new window:

- **Small/medium passes** that touch the same files as the previous pass → **`ok`** (cache stays warm, low context cost).
- **Large passes** (file splits, deps refresh) → **new window** after they land — the diff bloats context, and a fresh read of post-pass code is cheaper than carrying pre-pass state.
- **Topic switch** (next pass touches entirely different files than the just-finished one) → **new window** even if both passes are small — the prior context isn't useful.
- When in doubt, prefer `ok`. The user can always start a new window manually.

## Next pass — details

### Pass 7 — Electron security: preload bridge + `contextIsolation: true` for the dictation window

**Status quo.** `main.js:114–121` creates the dictation `BrowserWindow` with `contextIsolation: false, nodeIntegration: true`. That gives the renderer (`public/dictation.js`) direct access to Node — it currently does `import { ipcRenderer } from "electron"` at the top of the file. The other two windows (`mainWindow` at main.js:55–62 and `pillWindow` at main.js:84–97) already use the safe pattern (`contextIsolation: true, nodeIntegration: false`).

**Goal.** Flip the dictation window to the safe pattern, route all renderer↔main IPC through a narrow `contextBridge` API exposed by a new `preload.cjs`.

**Steps.**

1. Audit every `ipcRenderer.*` and `import ... from "electron"` site in `public/dictation.js`. Build the exhaustive channel list (likely small: `dictation:error`, `dictation:result`, lifecycle pings — confirm by grep before writing the bridge).
2. Create `preload.cjs` (CommonJS, alongside `main.js`). Use `contextBridge.exposeInMainWorld("dictationBridge", { ... })`. Expose:
   - `sendError(message)` → wraps `ipcRenderer.send("dictation:error", message)`.
   - `sendResult(text)` (or whatever channels the audit reveals).
   - `onWindowEvent(callback)` if the renderer subscribes to anything from main.
   - **No raw `ipcRenderer`**, no `require`, no `process`.
3. Update `main.js:114–121` to `contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs")`. Add `path` import if not present.
4. Update `public/dictation.js`:
   - Remove `import { ipcRenderer } from "electron"` (and any other Node imports).
   - Replace every `ipcRenderer.send(...)` call with the corresponding `window.dictationBridge.*` call.
   - Confirm the file is now pure browser code (loadable in a regular browser tab too, modulo the bridge being absent).
5. Add `preload.cjs` to the `build.files` list in `package.json` so `electron-builder` includes it in packaged builds.

**Validation.**

- `npm run test:parity` → still 5/5 green. (Parity tests run the server + WebSocket relay; they do not exercise Electron, so this is a smoke test for "we didn't break the import graph," not a real verification of the migration.)
- Manual: `npm start`. The tray opens, the pill window shows, holding the right Option key triggers dictation, the dictation window receives transcribed text, and errors surface in the title bar.
- DevTools console for the dictation window must be clean — no "ipcRenderer is undefined", no CSP warnings, no "contextBridge already exposed" errors.

**Why medium, not small.** The change spans `main.js` + a new `preload.cjs` + `public/dictation.js` + `package.json`, and the renderer-side rewrite has to touch every IPC site without regressions. The "find every channel" audit is the part that can hide bugs — miss one channel and dictation silently drops error messages.

**Risk notes.**

1. **Preload is CommonJS.** The project is `"type": "module"`, so `preload.cjs` (not `.js`) is required, and it must use `require("electron")`, not `import`. Don't try to make it ESM; Electron's preload loader is still CJS-only as of Electron 33.
2. **`contextBridge` only serializes structured-cloneable values.** If any IPC payload contains functions or class instances, they have to be wrapped/unwrapped. The audit step catches this.
3. **`__dirname` works in `main.js` here.** Confirm by reading the top of `main.js` — if it's already importing `fileURLToPath` to derive `__dirname`, use the existing constant.
4. **No behavior change visible to the user.** This is hardening, not a feature.

**Expected commit shape:** 4 files (1 new `preload.cjs`, 3 modified). ~+60 / ~−15 LoC.

**Heuristic call after this pass:** medium pass that mostly touches Electron-side files (`main.js`, `preload.cjs`, `dictation.js`) — the next pass (8, AudioWorklet) touches `dictation.js` again *and* `realtime-voice-agent.js`. Some shared context. Recommend **`ok`** to continue.

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
