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
| 10 | `// @ts-check` + JSDoc types across `src/*` and `realtime-relay.js` (was M4) | ⏭ next | — | medium |

Phase 1 (passes 0–6, structural refactor) landed. Phase 2 (passes 7–10, modernization) is planned but not started — each needs explicit go-ahead before kicking off.

Recommendation heuristic for `ok` vs new window:

- **Small/medium passes** that touch the same files as the previous pass → **`ok`** (cache stays warm, low context cost).
- **Large passes** (file splits, deps refresh) → **new window** after they land — the diff bloats context, and a fresh read of post-pass code is cheaper than carrying pre-pass state.
- **Topic switch** (next pass touches entirely different files than the just-finished one) → **new window** even if both passes are small — the prior context isn't useful.
- When in doubt, prefer `ok`. The user can always start a new window manually.

## Next pass — details

### Pass 10 — `// @ts-check` + JSDoc types across `src/*` and `realtime-relay.js`

**Status quo.** This is a JavaScript codebase (`"type": "module"`, no TypeScript build). The Node-side files have no type annotations. VS Code and editor language servers infer types but miss a lot — function signatures, callback shapes, event payload shapes, and the wire-protocol event types that flow through the realtime relay.

**Goal.** Add `// @ts-check` to every Node-side source file plus inline JSDoc annotations on every exported function and major data shape. No `tsconfig.json`, no build step — just per-file directives that turn on TypeScript checking in any editor. Runtime is unaffected.

**Files in scope.**

- `realtime-relay.js` (entry point — re-exports from `src/providers/*`).
- `src/cleanup.js`
- `src/dictation-session.js`
- `src/hotkey.js`
- `src/typing.js`
- `src/providers/_shared.js`
- `src/providers/openai.js`
- `src/providers/deepgram.js`
- `src/providers/whisper-local.js`
- `server.js`
- `main.js`
- `preload.cjs` (CommonJS — JSDoc still works)

**Files NOT in scope.**

- `public/**` — browser code, separate language server context, not what JSDoc-on-Node is targeting. Skip for this pass.
- `scripts/parity/*` — test files. Type-checking tests adds noise without much value. Skip.

**Steps.**

1. Add `// @ts-check` as the first line of every in-scope file. Run `npx tsc --noEmit --allowJs --checkJs --target esnext --module nodenext --moduleResolution nodenext --strict false realtime-relay.js` (or equivalent per-file) to see what errors surface. Fix each by adding JSDoc, never by silencing.
2. For each exported function, add a JSDoc block above the declaration with `@param` and `@returns`. Example:
   ```js
   /**
    * @param {import("ws").WebSocketServer} server
    * @param {{ model?: string, openaiApiKey?: string }} [options]
    */
   export function attachRealtimeRelay(server, options) { ... }
   ```
3. For shared data shapes (the relay's `local.status` event, the `dictationBridge` API in `preload.cjs`, the `DictationSession` class), define `@typedef` blocks once and reference them with `@type {Foo}`.
4. For callbacks, type the function shape inline: `@param {(text: string) => Promise<void>} onResult`.
5. Where third-party types are imported, use `import("ws").WebSocket` etc. Avoid `any` — if a type is genuinely unknowable, use `unknown` and narrow.
6. After every file, run `npx tsc --noEmit --allowJs --checkJs <file>` and confirm zero errors before moving on.
7. Run `npm run test:parity` — must remain 5/5 green. Type annotations are erased at runtime, so any runtime regression means a bad code change snuck in alongside the typing work. Keep this pass purely additive.

**Validation.**

- `npm run test:parity` → 5/5 green.
- `npx tsc --noEmit --allowJs --checkJs --target esnext --module nodenext --moduleResolution nodenext` (no `tsconfig.json` needed) on every in-scope file → zero errors.
- Open `realtime-relay.js` in VS Code → hover over `attachRealtimeRelay` shows the typed signature.

**Why medium.** The work is mechanical but spans ~10 files and surfaces real type bugs (mismatched callback signatures, optional vs required props, accidentally-untyped event payloads). The slowest part is writing the `@typedef`s for the relay protocol — read `docs/RELAY_PROTOCOL.md` first and mirror the event shape definitions there.

**Risk notes.**

1. **Strict mode is too aggressive for an unannotated codebase.** Start with `--strict false`. After this pass settles, a follow-up could tighten to strict.
2. **`@typedef` ordering matters.** Define shared types in the file they originate from, reference them via `import("./file.js").TypeName` from consumers. Don't centralize in a `types.d.ts` — that requires a tsconfig.
3. **`preload.cjs` is CommonJS.** `@ts-check` still works. Use `module.exports` typing if needed, but the file currently just registers contextBridge — no exports to type.
4. **Pure additive change.** No runtime behavior should differ. If parity goes red after this pass, the typing work isn't the problem — find the accidental code change.

**Expected commit shape:** ~10 files modified, +200 / −0 LoC (JSDoc blocks and `@ts-check` directives, no code deletions).

**Heuristic call after this pass:** medium pass touching only Node-side source files — no overlap with the renderer work (Passes 7+8) or the lockfile (Pass 9). After this lands, the refactor is fully complete; the next reply should announce completion, not queue a Pass 11.

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
