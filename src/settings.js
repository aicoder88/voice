// @ts-check
// Settings store. Backs the preferences window (tray → "Settings…").
//
// The whole app is configured through environment variables loaded from a .env
// file at the app home (see src/bootstrap-env.js). This module is the ONE place
// that edits that file, and it does so surgically: an existing key is updated in
// place, a new key is appended, and every comment / blank line / unmanaged key
// the user put there by hand is preserved untouched. That keeps the .env readable
// instead of being rewritten into a machine blob on every save.
//
// Kept free of any Electron import so it can be unit-tested with plain Node and
// reused by non-Electron hosts. main.js passes in the resolved .env path.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// The settings window reads and writes only the keys handled by settingsView /
// patchFromView below. Everything else in the .env (other tuning knobs,
// comments) is left exactly as the user wrote it.

export const VALID_PROVIDERS = new Set(["openai", "deepgram", "whisper-local"]);
const VALID_LANGUAGES = new Set(["auto", "hr", "en"]);

/**
 * Parse .env text into the ordered raw lines plus a name→{ value, lineIndex }
 * index of the simple `KEY=value` assignments. Quotes around a value are
 * stripped for the returned value but preserved on disk by applyEnv (which only
 * ever rewrites the value portion of a matched line).
 *
 * @param {string} text
 * @returns {{ lines: string[], index: Map<string, { value: string, lineIndex: number }> }}
 */
export function parseEnv(text) {
  const lines = (text || "").split("\n");
  /** @type {Map<string, { value: string, lineIndex: number }>} */
  const index = new Map();
  lines.forEach((line, lineIndex) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) return; // comment, blank, or export-style — leave alone
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    index.set(m[1], { value, lineIndex });
  });
  return { lines, index };
}

/**
 * Return new .env text with `patch` applied: existing keys updated in place,
 * missing keys appended. Comments and unmanaged keys are preserved. A value
 * containing whitespace or `#` is double-quoted so dotenv reads it back whole;
 * newlines are rejected (a single .env line can't hold one).
 *
 * @param {string} text
 * @param {Record<string, string>} patch
 * @returns {string}
 */
export function applyEnv(text, patch) {
  const { lines, index } = parseEnv(text);
  for (const [key, rawValue] of Object.entries(patch)) {
    const value = String(rawValue ?? "");
    if (/[\r\n]/.test(value)) throw new Error(`Setting ${key} cannot contain a newline`);
    // Quoting rules are dictated by how dotenv READS the value back:
    //  - double quotes expand \n and \r, so a Windows path like "C:\new models"
    //    would come back with a real newline in it after the next restart
    //    (JSON.stringify escaping made this worse — dotenv never unescapes);
    //  - single quotes are read literally, so they're safe for backslashes.
    const needsQuote = /\s|#/.test(value);
    let rendered;
    if (!needsQuote) {
      rendered = `${key}=${value}`;
    } else if (!value.includes("'")) {
      rendered = `${key}='${value}'`;
    } else if (!value.includes('"') && !value.includes("\\")) {
      rendered = `${key}="${value}"`;
    } else {
      throw new Error(`Setting ${key} mixes quotes/backslashes with spaces and can't be stored safely`);
    }
    const existing = index.get(key);
    if (existing) {
      lines[existing.lineIndex] = rendered;
    } else {
      // Drop a trailing blank line before appending so we don't grow a run of
      // them on every save.
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(rendered);
    }
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/** Read the .env text (empty string if it doesn't exist yet). */
export function readEnvFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * Apply `patch` to the .env file on disk, creating it (and its directory) if
 * missing. Returns the new file text.
 * @param {string} path
 * @param {Record<string, string>} patch
 */
export function writeEnvFile(path, patch) {
  const next = applyEnv(readEnvFile(path), patch);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf8");
  return next;
}

/** dotenv-style truthiness: "false"/"0"/""/"no"/"off" are false, else default. */
function asBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

/**
 * Build the view the settings window renders, from a plain env-like object
 * (pass process.env in the app, or a literal in tests). API keys are returned
 * verbatim so the field is editable — the window is local and owned by the user.
 *
 * @param {Record<string, string | undefined>} env
 */
export function settingsView(env = {}) {
  const provider = (env.STT_PROVIDER || "openai").toLowerCase();
  const language = (env.WHISPER_LANGUAGE || "auto").toLowerCase();
  return {
    provider: VALID_PROVIDERS.has(provider) ? provider : "openai",
    language: VALID_LANGUAGES.has(language) ? language : "auto",
    // Default must mirror the runtime check in main.js (cleanup runs unless
    // CLEANUP_ENABLED === "false"), or a fresh install's first Save would
    // silently write =false and turn off the tidy-up that had been running.
    cleanupEnabled: asBool(env.CLEANUP_ENABLED, true),
    openaiKey: env.OPENAI_API_KEY || "",
    deepgramKey: env.DEEPGRAM_API_KEY || "",
    recordingsEnabled: asBool(env.RECORDINGS_ENABLED, true),
    retentionDays: clampDays(env.RECORDING_RETENTION_DAYS, 7)
  };
}

function clampDays(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(365, Math.round(n));
}

/**
 * Turn a settings-window payload into a clean { ENV_KEY: stringValue } patch,
 * dropping unknown fields and normalizing types. Invalid enum values fall back
 * to the current/default rather than corrupting the file.
 *
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, string>}
 */
export function patchFromView(payload = {}) {
  /** @type {Record<string, string>} */
  const patch = {};
  if (typeof payload.provider === "string" && VALID_PROVIDERS.has(payload.provider)) {
    patch.STT_PROVIDER = payload.provider;
  }
  if (typeof payload.language === "string" && VALID_LANGUAGES.has(payload.language)) {
    patch.WHISPER_LANGUAGE = payload.language;
  }
  if (typeof payload.cleanupEnabled === "boolean") {
    patch.CLEANUP_ENABLED = payload.cleanupEnabled ? "true" : "false";
  }
  if (typeof payload.openaiKey === "string") patch.OPENAI_API_KEY = payload.openaiKey.trim();
  if (typeof payload.deepgramKey === "string") patch.DEEPGRAM_API_KEY = payload.deepgramKey.trim();
  if (typeof payload.recordingsEnabled === "boolean") {
    patch.RECORDINGS_ENABLED = payload.recordingsEnabled ? "true" : "false";
  }
  if (payload.retentionDays != null && Number.isFinite(Number(payload.retentionDays))) {
    patch.RECORDING_RETENTION_DAYS = String(clampDays(payload.retentionDays, 7));
  }
  return patch;
}
