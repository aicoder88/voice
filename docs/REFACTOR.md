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
| 9 | Dependency refresh: latest Electron, `ws`, `uiohook-napi`, `@nut-tree-fork/nut-js` (was M3) | ⏭ next | — | small-risky |
| 10 | `// @ts-check` + JSDoc types across `src/*` and `realtime-relay.js` (was M4) | ⏭ planned | — | medium |

Phase 1 (passes 0–6, structural refactor) landed. Phase 2 (passes 7–10, modernization) is planned but not started — each needs explicit go-ahead before kicking off.

Recommendation heuristic for `ok` vs new window:

- **Small/medium passes** that touch the same files as the previous pass → **`ok`** (cache stays warm, low context cost).
- **Large passes** (file splits, deps refresh) → **new window** after they land — the diff bloats context, and a fresh read of post-pass code is cheaper than carrying pre-pass state.
- **Topic switch** (next pass touches entirely different files than the just-finished one) → **new window** even if both passes are small — the prior context isn't useful.
- When in doubt, prefer `ok`. The user can always start a new window manually.

## Next pass — details

### Pass 9 — Dependency refresh

**Status quo.** `package.json` pins:

- Runtime: `@nut-tree-fork/nut-js ^4.2.6`, `dotenv ^16.4.7`, `uiohook-napi ^1.5.5`, `ws ^8.18.0`.
- Dev: `@electron/rebuild ^4.0.4`, `electron ^33.4.11`, `electron-builder ^25.1.8`.

The original M3 description said "bump Electron to v33" — that already happened. The actual task now is "check what's current in 2026 and bump cautiously."

**Goal.** Pull each dependency to a current, stable version. Two of them (`uiohook-napi`, `@nut-tree-fork/nut-js`) contain native bindings that link against Electron's V8 ABI — a major Electron bump can require `electron-rebuild`.

**Steps.**

1. Run `npm outdated` to see the current vs latest matrix for every dep.
2. For each dep, decide:
   - **Patch/minor bump** (semver-safe) → bump in `package.json`, run `npm install`, run `npm run test:parity`.
   - **Major bump** → check the changelog/release notes (use Context7 or fetch the package's CHANGELOG.md). Note any breaking changes. Only proceed if breakage is unrelated to how this repo uses the package.
3. After all bumps, run `npx electron-rebuild` (the dep `@electron/rebuild` is already there). This relinks native modules against the new Electron ABI. If `uiohook-napi` or `nut-js` fail to rebuild, that's the first place to bisect.
4. Run `npm run test:parity` — must stay 5/5 green.
5. Manual smoke: `npm start`. Tray opens, hotkey works, dictation cycle types text into the focused field, both windows load.
6. If `package-lock.json` shows huge churn (deep transitive bumps), commit it in the same commit as `package.json` — never split lockfile changes from manifest changes.

**Validation.**

- `npm run test:parity` → 5/5 green.
- `npm start` → tray + hotkey + dictation all work end-to-end.
- Electron DevTools shows no module-resolution errors on either window.

**Why "small-risky".** The code diff is tiny (just `package.json` + `package-lock.json`), but Electron major bumps can break native modules silently. Run `electron-rebuild`. If something breaks, prefer reverting to the previous version of *that one dep* rather than holding up the whole pass.

**Risk notes.**

1. **Native modules are the failure mode.** `uiohook-napi` (global keyboard listener) and `@nut-tree-fork/nut-js` (keyboard typing) are NAPI-based. They typically tolerate Electron bumps better than pure native modules, but still need a rebuild step.
2. **Electron 33 → newer:** the dictation window's preload pattern (Pass 7) is forward-compatible with Electron 35+ and the eventual switch to V3 sandboxing. No anticipated regressions.
3. **`ws` major bumps** rarely break consumer code, but parity tests will catch any wire-protocol-affecting change.
4. **Lock file commit policy:** if `npm install` updates `package-lock.json` deeply (it usually does on a bump), commit it. Do not gitignore it.
5. **Don't bump `dotenv`** unless there's a security advisory — it's stable and risk-free to leave.

**Expected commit shape:** 2 files (`package.json` + `package-lock.json`). The lockfile diff will dominate — that's normal.

**Heuristic call after this pass:** small-risky pass touching only `package.json` and the lockfile — no source code context shared with what came before, AND no source code context needed for the next pass (10, JSDoc types, which is `src/*` + `realtime-relay.js`). The pass-9 work is self-contained. Recommend **`ok`** to continue (cache is cheap when the diff is just a lockfile).

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
