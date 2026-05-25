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
| 4 | Split `realtime-relay.js` into providers | ✅ done | `1a61d04` | **large** |
| 5 | Move `whisper-server` boot into whisper-local provider | ✅ done | `9546233` | medium |
| 6 | Split `public/realtime-voice-agent.js` | ⏭ next | — | **large** |

Recommendation heuristic for `ok` vs new window:

- Small / medium passes → **`ok`** (cache stays warm, low context cost).
- Large file-split passes (4, 6) → **new window** after they land (diff bloats context; fresh read of post-pass code is cheaper than carrying pre-pass state).

## Next pass — details

### Pass 6 — split `public/realtime-voice-agent.js`

`public/realtime-voice-agent.js` is 726 lines: defaults + huge HTML/CSS template + WebSocket lifecycle + audio capture/playback + DOM event wiring + pure helpers all in one file. The public surface is the `<realtime-voice-agent>` custom element and its attributes (`endpoint`, `agent`, `compact`, `instructions`, `autoconnect`) — none of that changes.

**Public-API constraint:**

The file is loaded by callers as `<script type="module" src="realtime-voice-agent.js"></script>` (check `public/index.html` and `public/setup.html` to confirm). The path `public/realtime-voice-agent.js` MUST remain — it is the entry point and the file that registers the custom element via `customElements.define(...)`. The split is internal: extracted modules live under `public/realtime-voice-agent/` and are imported relatively.

Before extracting anything, **read `public/index.html` and `public/setup.html`** to confirm both pages load this file as a module. If either uses a classic `<script>` tag, the file has to remain self-contained (no `import`) — in that case, fall back to a single-file refactor that just collapses the giant `render()` template into a top-level template-literal constant.

**Recommended split (assuming module loading):**

- `public/realtime-voice-agent/audio-utils.js` — `downsample`, `floatTo16BitPcm`, `arrayBufferToBase64`, `base64ToInt16Array`. Pure functions, no DOM. ~40 LoC.
- `public/realtime-voice-agent/agents.js` — `defaultAgents`, `agentLabels`, `personalityStorageKey`, plus a `loadPersonalities()` / `savePersonalities()` pair that wraps `localStorage`. ~50 LoC.
- `public/realtime-voice-agent/template.js` — exports a single `templateHTML` string (or a `renderTemplate(root)` function that sets `root.innerHTML` and returns a `$` helper to query the shadow tree). Hosts the long HTML + `<style>` block currently embedded in `render()`. ~250 LoC.
- `public/realtime-voice-agent.js` — keeps the `RealtimeVoiceAgent` class, the `customElements.define` call, the `targetSampleRate` constant, and `connectedCallback`/`disconnectedCallback`/`connect()`/`updateSession()`/playback/mic-level methods. Imports from the three new modules. ~350 LoC after extraction.

**Why this is large:**

The HTML/CSS template alone is hundreds of lines of strings interleaved with classnames the JS reaches into via `querySelector` — extracting it means every selector used elsewhere in the file has to keep matching. The audio helpers are easy; the template is the risky part. Do them in that order so a regression caught by manual smoke can be bisected easily.

**Validation:**

- `npm run test:parity` → 5/5 green. (The component is exercised only indirectly through parity; the harness uses a raw `ws://.../realtime` client, not the custom element.)
- Manual smoke (no automation): `npm run dev`, open `http://localhost:3000/index.html`, click into the agent UI, change personality, type instructions, press Connect, speak. Confirm: shadow DOM matches the original (visual diff), WebSocket connects, transcription frames render, voice playback plays back. Then load `setup.html` from the Electron app (`npm start`) and confirm the embedded scratchpad still works.
- Console must be clean (no 404s for new module paths, no "customElements.define already called" if HMR-style reloads happen).

**Expected commit shape:** four files in `public/` (one modified, three new), ~+730 / ~−400 LoC net (template gets copy-pasted, so most "additions" are moves).

**Risk notes for the executing assistant:**

1. **The file is loaded by the browser, not Node.** Check the actual `<script>` tag in both HTML pages before splitting. ES modules need `type="module"` AND relative imports starting with `./`.
2. **Don't rename or re-order DOM classnames.** Anything the existing JS does via `shadowRoot.querySelector(".foo")` must still find the same element after extraction.
3. **`customElements.define()` must run exactly once.** Keep it at the bottom of the entry file. If the browser hot-reloads, a second `define` throws — but that's pre-existing behavior, don't try to fix it in this pass.
4. **No behavior change.** This is a pure code-organization refactor. Do not "improve" anything along the way.

## Continuation prompt (paste into a fresh window)

```
Resume the modernization refactor for this repo.

1. Read docs/REFACTOR.md — it is the durable plan + state. The Status table
   shows which pass is next.
2. If you have not read them already, read docs/ARCHITECTURE.md (current-state
   map) and docs/RELAY_PROTOCOL.md (the wire contract the parity harness asserts).
3. Run `npm run test:parity` to confirm baseline green (expect tests 5 / pass 5).
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
