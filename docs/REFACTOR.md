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
| 8 | `AudioWorklet` replaces `ScriptProcessorNode` in dictation + realtime-voice-agent (was M2) | ⏭ next | — | medium |
| 9 | Dependency refresh: latest Electron, `ws`, `uiohook-napi`, `@nut-tree-fork/nut-js` (was M3) | ⏭ planned | — | small-risky |
| 10 | `// @ts-check` + JSDoc types across `src/*` and `realtime-relay.js` (was M4) | ⏭ planned | — | medium |

Phase 1 (passes 0–6, structural refactor) landed. Phase 2 (passes 7–10, modernization) is planned but not started — each needs explicit go-ahead before kicking off.

Recommendation heuristic for `ok` vs new window:

- **Small/medium passes** that touch the same files as the previous pass → **`ok`** (cache stays warm, low context cost).
- **Large passes** (file splits, deps refresh) → **new window** after they land — the diff bloats context, and a fresh read of post-pass code is cheaper than carrying pre-pass state.
- **Topic switch** (next pass touches entirely different files than the just-finished one) → **new window** even if both passes are small — the prior context isn't useful.
- When in doubt, prefer `ok`. The user can always start a new window manually.

## Next pass — details

### Pass 8 — `AudioWorklet` replaces `ScriptProcessorNode` in dictation + realtime-voice-agent

**Status quo.** Two renderer files use the deprecated `ScriptProcessorNode`:

- `public/dictation.js:147` — `audioContext.createScriptProcessor(4096, 1, 1)`, downsamples mic → 24kHz PCM16, sends via WebSocket.
- `public/realtime-voice-agent.js:203` — same shape, plus a side-effect to update a UI mic-level pill.

`ScriptProcessorNode` runs the audio callback on the main thread, which Chrome has been warning about for years (`(deprecated)` in DevTools, glitchy under load). `AudioWorklet` is the modern replacement: the per-buffer code runs in a dedicated `AudioWorkletGlobalScope` thread and communicates with the main thread via `MessagePort`.

**Goal.** Move the per-buffer audio capture to a shared `AudioWorklet` module, used by both renderers, with zero observable behavior change.

**Recommended split.**

- `public/audio-capture-worklet.js` (new) — a single `AudioWorkletProcessor` subclass. Receives mono Float32 input frames in `process()`, posts them back to the main thread via `this.port.postMessage(...)`. Keeps zero state besides what's needed for the buffer hop. The downsampling + Int16 conversion can either happen inside the worklet (cleaner; one message = one ready-to-send PCM16 chunk) or in the main thread after `port.onmessage` (simpler; the worklet just relays). **Recommend in-worklet conversion** — it keeps the per-message payload small and the main thread idle.
- `public/realtime-voice-agent/audio-utils.js` (existing) — keep the pure helpers (`downsample`, `floatTo16BitPcm`, `arrayBufferToBase64`, `base64ToInt16Array`) where they are. The worklet duplicates `downsample` + `floatTo16BitPcm` inline because worklets cannot use ES imports the way main-thread modules can — they're registered via `audioContext.audioWorklet.addModule(url)` and loaded in their own scope. Duplicating those ~15 LoC is the documented pattern; do not try to share via `import`.
- `public/dictation.js` — replace the `createScriptProcessor` block (lines 147–162) with:
  1. `await audioContext.audioWorklet.addModule("/audio-capture-worklet.js")` (once per AudioContext).
  2. Create an `AudioWorkletNode(audioContext, "audio-capture-processor", { processorOptions: { inputRate: audioContext.sampleRate, outputRate: targetSampleRate } })`.
  3. Wire `source → workletNode → muteNode → destination` (same graph topology).
  4. `workletNode.port.onmessage = (e) => socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: arrayBufferToBase64(e.data) }))`.
- `public/realtime-voice-agent.js` — same swap. The mic-level pill update (`this.updateMicLevel(input)`) currently runs in the audio callback. Move it to the `port.onmessage` handler — it only needs the peak of the chunk, which the worklet can compute and include in the message (or send the raw Float32 alongside the PCM16 if the size is fine). **Recommend** the worklet includes a `peak` float in each message so the main thread does no audio math.

**Validation.**

- `npm run test:parity` → still 5/5 green. (Again, parity boots the HTTP relay, not the renderer; this is a "no import graph regression" smoke test only.)
- Manual: `npm start`. Hold right-Option, speak, release — transcript types into the focused field as before. DevTools console for the dictation window must show **no** "ScriptProcessorNode deprecated" warning anymore. Open `http://localhost:3000/index.html`, connect, talk — voice playback works, mic level pill animates, transcript renders.
- Audio quality should be identical or slightly better (the worklet thread is isolated from main-thread jank).

**Why medium, not small.** Two files swap their audio pipeline. Worklets have a real cognitive overhead (separate global scope, no closures over outer variables, `port.postMessage` instead of direct returns). The risk is silent — if the worklet's `process()` returns the wrong value or posts the wrong shape, mic audio dies but nothing throws.

**Risk notes.**

1. **`addModule` returns a Promise — await it.** Calling `new AudioWorkletNode(...)` before the module is registered throws synchronously.
2. **Worklet code cannot use `import`.** It's a standalone script loaded into the `AudioWorkletGlobalScope`. Helpers must be inlined or accessed via `processorOptions`.
3. **`process()` must return `true`** for the worklet to keep running. Returning `false` (or nothing) kills it permanently.
4. **Frame size differs from `ScriptProcessorNode`.** Worklets always get 128-sample frames (~2.7ms at 48kHz). The old code got 4096-sample frames (~85ms). The downsampler + WebSocket-send rate will change accordingly — batching inside the worklet (accumulate frames until N samples, then post) is recommended to keep WebSocket message volume sane. Aim for ~50–100ms chunks post-downsample.
5. **AudioWorklet requires the AudioContext to be running.** The existing code already calls `audioContext.resume()` — leave that intact.

**Expected commit shape:** 3 files (1 new `audio-capture-worklet.js`, 2 modified). ~+90 / ~−40 LoC.

**Heuristic call after this pass:** medium pass touching two renderer files plus a new worklet. The next pass (9, deps refresh) shares no code context — it's a `package.json` job. Recommend **new window** after Pass 8 lands; print the Continuation prompt block.

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
