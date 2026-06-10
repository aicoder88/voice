# GVoice cross-platform installer + smart engine setup

## Context
Today GVoice is a dev-folder app: you clone the repo, run a PowerShell script that
downloads ~700 MB of CUDA binaries + a model, hand-edit `.env`, and `pnpm start`.
The packaged build doesn't even include the whisper binaries/model (`build.files`
omits `bin/` and `models/`), and `src/bootstrap-env.js` hardcodes one Mac dev path.

Goal: a downloadable installer (Windows + Mac) that anyone can run. On first launch
the app probes the hardware and:
- **Capable machine** → use the free on-device engine (local Whisper).
- **Slow machine** → default to the cloud engine (Deepgram/OpenAI).
- Never download the Whisper model unless local is actually chosen; when it is,
  download it automatically with a guided, plain-English progress UI.

## Decisions (locked with user)
- **Cloud keys = bring-your-own.** User pastes their Deepgram/OpenAI key in Settings
  (already supported). No backend. ~80% of the cloud path already exists.
- **Mac = cloud-only for v1.** Upstream whisper.cpp ships Windows binaries only
  (verified: v1.8.6 release assets are Win + an xcframework + a jar — no Mac CLI).
  Mac on-device engine is a later phase (needs us to build/bundle Mac binaries).
- **Ship unsigned for v1.** One-time OS warning + clear "run anyway" instructions.
- **Cloud-first; local must PROVE it's faster (a real benchmark decides).**
  A hardware guess (cores/RAM/GPU-name) is unreliable — verified on the dev
  machine: a GTX 1660 Ti Max-Q (4 GB laptop GPU) reads as "capable" by GPU
  presence yet isn't actually faster than the cloud. So:
  - Default provider is always the **cloud** engine (instant, with the user's key).
  - The hardware probe (`src/hardware.js`) is now only a cheap *pre-filter* for
    whether to **offer** local — NOT the final verdict.
  - Local is **opt-in**: choosing it downloads the model, runs a timed transcription
    of a short bundled clip on the real hardware, and keeps local ONLY if it beats
    the cloud baseline; otherwise it reverts to cloud and explains why.

## Foundational fix (do first — everything sits on it)
`src/bootstrap-env.js`: replace the hardcoded `PACKAGED_HOME = "/Users/macmini/dev/voice"`.
- `.env` and downloaded files must live in `app.getPath('userData')` (writable on
  both OSes; the Mac app bundle is read-only/signed and must never be written into).
- Resolve `HOME`/`ENV_FILE` to userData when packaged, `process.cwd()` in dev.
- Default model path → `<userData>/models/<file>.bin`; whisper binaries →
  `<userData>/bin/`. Set `WHISPER_MODEL`/`WHISPER_BIN` from there if present.

## New pure modules (no Electron import → unit-tested, mirrors existing pattern)
1. `src/hardware.js` — `probeCapability()` returns a binary tier `{ tier: "capable"|"limited", gpu, cores, ramGB, reason }`.
   - Signals: `os.cpus().length`, `os.totalmem()`, `os.platform/arch`, GPU detect
     (Windows: NVIDIA presence; Mac: `arch === "arm64"` = Apple Silicon).
   - Heuristic (conservative, binary): Apple Silicon OR (NVIDIA GPU) OR
     (≥8 logical cores AND ≥8 GB RAM) ⇒ `capable`; else `limited`.
   - Pure: takes an injected `{ cpus, totalmem, platform, arch, gpu }` so tests
     pass fixtures. A thin `detectGpu()` wrapper does the OS probe.
2. `src/model-download.js` — `downloadFile(url, dest, { onProgress })` +
   `MODELS`/`WHISPER_BINARIES` URL tables (lifted from `setup-whisper-windows.ps1`).
   - HuggingFace model: `ggml-base-q5_1.bin` (57 MB) default for CPU-capable,
     `ggml-small-q5_1.bin` (182 MB) for GPU machines.
   - Windows binaries: `whisper-bin-x64.zip` (CPU) or `whisper-cublas-12.4.0-bin-x64.zip`
     (NVIDIA), from `github.com/ggml-org/whisper.cpp/releases`.
   - Streams to a `.part` temp file, atomic rename on success, resumable-safe,
     SHA/size sanity check, progress callback (bytes/total). Unzip via a small
     helper (Windows zips only; Node has no built-in unzip — use a tiny dep or
     `Expand-Archive` via child_process on Windows).

## Wiring (reuse existing windows/IPC, don't build new scaffolding)
3. First-run onboarding (extend `needsOnboarding()` + `openSettingsWindow` in `main.js`):
   - On a fresh `.env`, run `probeCapability()` once and write the recommended
     `STT_PROVIDER` (capable→`whisper-local`, limited→`deepgram`).
   - `limited` → open Settings as today, prompting for a cloud key (existing path).
   - `capable` → show the guided download (below) before first dictation.
4. Guided model download UI — reuse the **splash** window + IPC pattern
   (`public/splash.html`, `setSplashStatus`, `preload-splash.cjs`) to show stages:
   "Checking your computer…" → "Downloading the speech model (57 MB)… 40%" →
   "Setting up the on-device engine…" → "Ready". Driven by `onProgress` from
   `model-download.js`. Cancel/retry. Falls back to offering cloud if download fails.
5. Settings additions (`src/settings.js`, `public/settings.html`): a "Speech engine"
   section that shows the detected tier, a "Download on-device engine" button (for
   limited users who want to opt in later), and download status.

## Packaging (`package.json` build config)
- Keep `bin/` and `models/` OUT of `build.files` (download on demand → small installer).
- Mac target → `dmg` (was `dir`); Windows stays `nsis`. Both unsigned for v1.
- Add `electron-builder` mac/win artifact naming; verify `extraResources` not needed
  since downloads go to userData.
- Native deps (`uiohook-napi`, `@nut-tree-fork/nut-js`, `koffi`) already work on
  Win dev; confirm they're rebuilt for the packaged Electron (`@electron/rebuild`).

## Files to touch
- `src/bootstrap-env.js` (foundational path fix)
- `src/hardware.js` (new), `scripts/unit/hardware.test.js` (new)
- `src/model-download.js` (new), `scripts/unit/model-download.test.js` (new)
- `main.js` (onboarding + guided download wiring)
- `public/splash.html`, `preload-splash.cjs` (progress stages — extend, not rebuild)
- `src/settings.js`, `public/settings.html` (engine section)
- `package.json` (build targets), `README.md`/`SETUP.md` (new install instructions)

## Verification
- `pnpm test:unit` — new hardware + downloader tests green; existing 53 still pass.
- Manual: fresh `userData` (rename the real one), launch → onboarding picks the
  right engine; on a capable machine the model downloads with visible progress and
  a dictation works; on a forced-limited probe it opens Settings for a cloud key.
- `pnpm build` produces a Windows `.exe` installer and a Mac `.dmg`; install on a
  clean machine/VM, confirm first-run flow end-to-end and that nothing writes into
  the app bundle.

## Phasing (ship incrementally to `testing`)
- **P1 (foundation):** bootstrap-env userData fix + `hardware.js` + tests.
- **P2 (downloader):** `model-download.js` + tests, wired to a manual "download" button.
- **P3 (onboarding):** auto-probe + guided splash download on first run.
- **P4 (packaging):** build targets, unsigned installers, updated docs.
</content>
</invoke>
