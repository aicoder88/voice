# Relay protocol

The wire contract between any browser client and `realtime-relay.js`. This is the surface the refactor must preserve byte-for-byte; the parity harness (`scripts/parity/dictation-flow.test.js`) asserts against it.

The protocol is deliberately shaped to look like a subset of the OpenAI Realtime API, so the OpenAI transport is mostly a passthrough and the other transports (Deepgram, whisper-local) synthesize the same frames.

## Connection

- **Origin gating.** The relay spends the user's API keys, so by default it accepts an upgrade only from an app-local (loopback) `Origin` — or from a client that sends no `Origin` at all (native tools; a browser always sends one and cannot forge it). This blocks a random web page the user visits from opening a session on their key. A cross-origin deployment of the reusable relay passes `attachRealtimeRelay({ allowedOrigins: [...] })` (exact origin strings, or `["*"]`).
- URL: `ws://<host>/realtime` (path configurable via `attachRealtimeRelay({ path })`)
- Query parameters:
  - `provider` — `openai` | `deepgram` | `whisper-local` (alias: `local`). Default: `STT_PROVIDER` env or `openai`.
  - `model` — honored by the OpenAI and Deepgram transports. OpenAI: two values switch the relay into transcription-only mode (`gpt-realtime-whisper`, `gpt-realtime-translate`); any other value is passed through as the session model. Deepgram: overrides `DEEPGRAM_MODEL`.
  - `language` — Deepgram only. A BCP-47 code (`hr`, `en`, …) pins one language; `auto` (the default, also via `WHISPER_LANGUAGE` env) runs parallel per-language legs — see below.

## Client → relay

| Frame                                  | Shape                                                                                   | Behavior                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `session.update`                       | `{ type: "session.update", session: { ... } }`                                          | OpenAI: forwarded. Others: ignored.                   |
| `input_audio_buffer.append`            | `{ type: "input_audio_buffer.append", audio: "<base64 PCM16 mono 24 kHz>" }`            | All providers: append audio to the in-flight buffer. |
| `input_audio_buffer.commit`            | `{ type: "input_audio_buffer.commit" }`                                                 | All providers: close the utterance, request final transcript. |
| any other JSON                         | passthrough                                                                              | OpenAI only.                                          |
| raw binary frame                       | binary                                                                                   | Deepgram only — forwarded as-is.                     |

## Relay → client

The relay emits two families of frames: **status frames** synthesized by the relay (`local.*`) and **transcription frames** that mirror the OpenAI Realtime API shape regardless of which transport produced them.

### Status frames (synthesized)

| Frame                                                                                          | When                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| `{ type: "local.status", status: "connected", provider, model }`                               | Upstream socket / process is ready. |
| `{ type: "local.status", status: "closed", code, reason? }`                                    | Upstream closed.                    |
| `{ type: "local.error", message }`                                                             | Any upstream failure.               |

### Transcription frames (OpenAI-shaped)

| Frame                                                                                                 | Emitted by                          |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `{ type: "conversation.item.input_audio_transcription.delta", delta }`                                | Deepgram (per is_final segment, single-leg mode only). OpenAI passthrough. |
| `{ type: "conversation.item.input_audio_transcription.completed", transcript }`                       | Every provider — exactly once per commit. Deepgram also includes a `language` field (the winning leg). |

The OpenAI transport also passes through all native Realtime API frames it receives (`response.output_text.delta`, `response.done`, `error`, etc.). The browser tolerates any of them.

## Per-provider behavior

### `openai`

- Opens `wss://api.openai.com/v1/realtime?model=<sessionModel>` with `Authorization: Bearer $OPENAI_API_KEY`.
- On open, sends a relay-synthesized `session.update`:
  - **Conversation mode** (default): both input and output audio, server VAD, agent instructions.
  - **Transcription-only mode** (when `?model=gpt-realtime-whisper` or `=gpt-realtime-translate`): input audio only, no turn detection, `transcription.model` set to the requested model. The underlying session still runs on `gpt-realtime-2`.
- Every message in either direction is then forwarded as-is.
- Client messages received before the upstream open are queued and flushed on open.

### `deepgram`

- Opens one or more "legs" — one streaming connection per candidate language — to `wss://api.deepgram.com/v1/listen` with `Authorization: Token $DEEPGRAM_API_KEY`, model from `DEEPGRAM_MODEL` (default `nova-3`, overridable via `?model=`), `encoding=linear16`, `sample_rate=24000`, `punctuate=true`, `smart_format=true`, `interim_results=true`, `endpointing=false`. Custom-dictionary terms are appended as `keyterm` params (nova-3) or `keywords` (older models).
- **Language legs.** A pinned `?language=` opens a single leg in that language. Language `auto` (the default) runs one leg per candidate (`hr` + `en`) **in parallel on the same audio** — Deepgram streaming has no language detection covering Croatian — and the winner is the leg with the highest confidence-weighted word score that actually heard words. Latency is unchanged; per-clip cost doubles.
- `input_audio_buffer.append` → base64-decoded and sent as a binary frame to every leg.
- `input_audio_buffer.commit` → sends `{ type: "Finalize" }` to every leg; the synthesized `completed` frame is emitted once every leg has flushed (a `Results` frame with `from_finalize`/`speech_final`), or after a 3 s safety timeout if a flush never comes back.
- Final `Results` segments are streamed as `...transcription.delta` frames **only in single-leg mode** (with parallel legs they would interleave two languages). The winning leg's accumulated text becomes the `transcript` field of the `...completed` frame, alongside a `language` field naming the winner.

### `whisper-local`

- Accumulates `input_audio_buffer.append` PCM in memory until `input_audio_buffer.commit`.
- Wraps the PCM in a WAV header and either POSTs it to `WHISPER_SERVER_URL` (if set) or invokes the `whisper-cli` binary on a tempfile.
- Buffers smaller than 4800 bytes (0.1 s) return an empty transcript without invoking whisper.
- **Silence gate.** If the loudest sample in the buffer never crosses `WHISPER_SILENCE_PEAK` (default `500` on the int16 scale, ~1.5% of full scale), the buffer is treated as silence and an empty transcript is returned without invoking whisper — Whisper hallucinates plausible text on near-silent audio. Set `WHISPER_SILENCE_PEAK=0` to disable.
- **Hallucination sanitizer.** Whisper's output is scrubbed before it reaches the client: bracketed/parenthesized sound tags (`[BLANK_AUDIO]`, `(music)`, `*laughs*`) are stripped, and if what remains is empty or one of Whisper's stock silence hallucinations ("Thank you.", "Thanks for watching", and their multilingual variants), the transcript comes back empty. Whole-string match only — a real sentence that merely starts with one of these phrases is untouched.
- Emits exactly one `...completed` frame per commit.

## Invariants the refactor preserves

1. For any sequence of client frames, the **type and order** of relay-emitted frames is unchanged.
2. The `...completed` frame fires exactly once per `commit`, for every provider.
3. The `local.status` "connected" frame always fires before any transcription frame.
4. The relay never emits frames after the client socket has closed.
5. `attachRealtimeRelay(server, options)` keeps the documented signature and option keys.
