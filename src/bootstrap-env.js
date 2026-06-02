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
import { existsSync } from "node:fs";
import { join } from "node:path";

// Where the app's config (.env) and the Whisper model live. Kept OUTSIDE the
// app bundle so real API keys never ship inside a distributable .app. Unpackaged
// this is just the repo (cwd); packaged it's the install location, overridable
// with GVOICE_HOME.
const PACKAGED_HOME = "/Users/macmini/dev/voice";
const HOME = process.env.GVOICE_HOME || (app.isPackaged ? PACKAGED_HOME : process.cwd());

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

// Default the Whisper model to an absolute path under HOME if the user hasn't
// pinned one — a cwd-relative "./models/…" would miss in a packaged launch.
if (!process.env.WHISPER_MODEL) {
  const model = join(HOME, "models", "ggml-small.en-q5_1.bin");
  if (existsSync(model)) process.env.WHISPER_MODEL = model;
}
