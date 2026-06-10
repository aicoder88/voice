// @ts-check
// Boot-time environment setup. Imported FIRST from main.js (before anything
// that reads process.env), so it must have no side effects beyond preparing the
// environment.
//
// Why this exists: a packaged GVoice.app launched from Finder starts with a
// bare PATH and "/" as its working directory — so the Homebrew whisper-server
// binary isn't found, and a cwd-relative ".env" / model path resolves to
// nothing. A dev launch (`electron .` from the repo) already has the right cwd
// and PATH, so for that case everything here is a harmless no-op.
import dotenv from "dotenv";
import { app } from "electron";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

// This module is imported before main.js calls app.setName, so set the name here
// too (idempotent). Without it, app.getPath("userData") below would resolve to
// Electron's default ".../Application Support/Electron" folder, and the packaged
// app would read its config from the wrong place.
app.setName("GVoice");

// The dev repo this build was historically pinned to. Kept ONLY to migrate an
// existing install's config (and find a model the user already downloaded) the
// first time this self-contained build runs — never as the live home.
const LEGACY_HOME = "/Users/macmini/dev/voice";

// Where the app's config (.env) and the Whisper model live. Kept OUTSIDE the
// app bundle so real API keys never ship inside a distributable .app. Unpackaged
// this is the repo (cwd). Packaged it now defaults to userData — a writable,
// install-independent location — so renaming, moving, or cleaning up the dev
// repo no longer silently breaks the installed app. GVOICE_HOME still overrides.
const USERDATA_HOME = app.getPath("userData");
const HOME = process.env.GVOICE_HOME || (app.isPackaged ? USERDATA_HOME : process.cwd());

// First packaged boot into the new home with no .env yet: migrate the one from
// the old dev-repo location if it's there, so an existing install keeps working
// without the user re-entering their keys. One-time copy — afterwards HOME/.env
// is the single source of truth and the dev repo can be moved or deleted.
if (app.isPackaged && HOME === USERDATA_HOME) {
  const homeEnv = join(HOME, ".env");
  const legacyEnv = join(LEGACY_HOME, ".env");
  if (!existsSync(homeEnv) && existsSync(legacyEnv)) {
    try {
      mkdirSync(HOME, { recursive: true });
      copyFileSync(legacyEnv, homeEnv);
    } catch {}
  }
}

// Finder launches with a minimal PATH. Prepend the dirs the app shells out to
// (Homebrew for whisper-server / whisper-cli) so local Whisper works.
if (process.platform === "darwin") {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  const missing = extra.filter((dir) => !current.includes(dir));
  if (missing.length) process.env.PATH = [...missing, ...current].join(":");
}

// Load .env from the app home (not cwd), so config is found wherever launched.
const envFile = join(HOME, ".env");
if (existsSync(envFile)) dotenv.config({ path: envFile });
else dotenv.config();

// Exported so the rest of the app (main.js, the settings writer) edits the SAME
// .env this loaded — never a cwd-relative guess that misses in a packaged launch.
export const ENV_FILE = envFile;

// Default the Whisper model to an absolute path if the user hasn't pinned one.
// Look in the new home first, then the legacy repo — so an existing install that
// kept the model in the dev repo still finds it, while a fresh install can drop
// the model into userData/models. If neither exists, WHISPER_MODEL stays unset
// and main.js's onboarding surfaces "point GVoice at a model" instead of failing
// per-dictation. A cwd-relative "./models/…" would miss in a packaged launch.
if (!process.env.WHISPER_MODEL) {
  const MODEL_NAME = "ggml-small.en-q5_1.bin";
  for (const base of [HOME, LEGACY_HOME]) {
    const model = join(base, "models", MODEL_NAME);
    if (existsSync(model)) {
      process.env.WHISPER_MODEL = model;
      break;
    }
  }
}
