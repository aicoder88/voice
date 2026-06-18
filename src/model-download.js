// @ts-check
// On-demand fetch of the Whisper engine assets (the GGML model + the Windows
// whisper.cpp binaries). Nothing here ships in the installer — it's pulled the
// moment the user picks the on-device engine, with progress surfaced to the
// guided setup UI. URLs lifted from scripts/setup-whisper-windows.ps1.
//
// Split like the rest of the codebase: PURE helpers (URL/size/path builders,
// progress math — unit-tested with no network) plus the IO machinery
// (downloadFile / ensureModel / ensureWindowsBinaries) that streams to disk.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { withRetry, httpError } from "./retry.js";

// Pin the whisper.cpp release the Windows binaries come from. Bump deliberately
// (and re-test) rather than tracking "latest", so a fresh upstream build can't
// silently change the flags/behavior the app spawns.
export const WHISPER_VERSION = "v1.8.4";

// GGML models on HuggingFace. Sizes are approximate, shown to the user up front
// so a metered/slow connection isn't surprised by the download.
export const MODELS = {
  "ggml-base-q5_1.bin": { sizeMB: 57, multilingual: true },
  "ggml-small-q5_1.bin": { sizeMB: 182, multilingual: true }
};

// Windows whisper.cpp release archives, by hardware variant.
export const WINDOWS_BINARY_ZIPS = {
  cpu: { asset: "whisper-bin-x64.zip", sizeMB: 12 },
  cuda: { asset: "whisper-cublas-12.4.0-bin-x64.zip", sizeMB: 700 }
};

/**
 * HuggingFace download URL for a GGML model file.
 * @param {string} name e.g. "ggml-base-q5_1.bin"
 */
export function modelUrl(name) {
  if (!MODELS[name]) throw new Error(`Unknown model: ${name}`);
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}`;
}

/**
 * whisper.cpp GitHub release URL for the Windows binary zip of a variant.
 * @param {"cpu"|"cuda"} variant
 */
export function windowsBinaryUrl(variant) {
  const entry = WINDOWS_BINARY_ZIPS[variant];
  if (!entry) throw new Error(`Unknown variant: ${variant}`);
  return `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${entry.asset}`;
}

/**
 * Fraction complete (0..1) for a download. Returns null when the total size is
 * unknown (no Content-Length) so the UI can show an indeterminate state instead
 * of a fake percentage.
 * @param {number} received @param {number} total
 */
export function progressFraction(received, total) {
  if (!total || total <= 0) return null;
  return Math.min(1, received / total);
}

/**
 * Stream a URL to `dest`, reporting progress. Downloads to a sibling `.part`
 * file and atomically renames on success, so an interrupted download never
 * leaves a truncated file that later reads as "already downloaded". A transient
 * network failure is retried once (via the shared retry helper).
 *
 * @param {string} url
 * @param {string} dest absolute path the finished file should land at
 * @param {{ onProgress?: (p: { received: number, total: number, fraction: number|null }) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>} the dest path
 */
export async function downloadFile(url, dest, opts = {}) {
  const { onProgress, signal } = opts;
  mkdirSync(join(dest, ".."), { recursive: true });
  const part = dest + ".part";

  await withRetry(
    async () => {
      const res = await fetch(url, { redirect: "follow", signal });
      if (!res.ok || !res.body) {
        const body = res.ok ? "no response body" : await res.text().catch(() => "");
        throw httpError(res.ok ? 502 : res.status, body.slice(0, 200));
      }
      const total = Number(res.headers.get("content-length")) || 0;
      let received = 0;
      const out = createWriteStream(part);
      // Node's fetch body is a web ReadableStream; Readable.fromWeb bridges it to
      // a Node stream we can pipe and watch byte-by-byte for progress.
      const nodeStream = Readable.fromWeb(/** @type {any} */ (res.body));
      nodeStream.on("data", (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total, fraction: progressFraction(received, total) });
      });
      await new Promise((resolve, reject) => {
        nodeStream.pipe(out);
        nodeStream.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
      });
    },
    { retries: 1, onRetry: () => { try { if (existsSync(part)) unlinkSync(part); } catch {} } }
  );

  renameSync(part, dest);
  return dest;
}

/**
 * Ensure a GGML model exists under `modelsDir`, downloading it if missing.
 * Returns the absolute model path (ready to set as WHISPER_MODEL). A file
 * already present at the expected size is treated as done (idempotent).
 *
 * @param {string} name
 * @param {string} modelsDir
 * @param {{ onProgress?: (p: { received: number, total: number, fraction: number|null }) => void, signal?: AbortSignal }} [opts]
 */
export async function ensureModel(name, modelsDir, opts = {}) {
  const dest = join(modelsDir, name);
  if (existsSync(dest) && statSync(dest).size > 1024 * 1024) return dest;
  await downloadFile(modelUrl(name), dest, opts);
  return dest;
}

/**
 * Ensure the Windows whisper.cpp binaries exist under `binDir`, downloading and
 * extracting the variant's release zip if `whisper-cli.exe` is missing. Returns
 * the absolute path to whisper-cli.exe (ready to set as WHISPER_BIN).
 *
 * Windows-only: Node has no built-in unzip, so extraction shells out to
 * PowerShell's Expand-Archive (always present on Win10+). The CUDA archive nests
 * everything under Release\ — flatten it so the binary resolves directly, the
 * same fix-up the PowerShell setup script does.
 *
 * @param {"cpu"|"cuda"} variant
 * @param {string} binDir
 * @param {{ onProgress?: (p: { received: number, total: number, fraction: number|null }) => void, signal?: AbortSignal }} [opts]
 */
// Escape a path for safe interpolation into a single-quoted PowerShell literal:
// inside '...' the only special char is the single quote, escaped by doubling it.
// A no-op for ordinary paths; fixes accounts whose username contains an apostrophe.
const psq = (p) => String(p).replace(/'/g, "''");

export async function ensureWindowsBinaries(variant, binDir, opts = {}) {
  const cli = join(binDir, "whisper-cli.exe");
  if (existsSync(cli)) return cli;
  const url = windowsBinaryUrl(variant);
  const zip = join(binDir, basename(url));
  await downloadFile(url, zip, opts);
  await extractZipWindows(zip, binDir);
  // Flatten a nested Release\ dir if the archive had one.
  const nested = join(binDir, "Release");
  if (existsSync(nested)) {
    await runPowerShell(
      `Move-Item -Force (Join-Path '${psq(nested)}' '*') '${psq(binDir)}'; Remove-Item -Recurse -Force '${psq(nested)}'`
    );
  }
  try { unlinkSync(zip); } catch {}
  if (!existsSync(cli)) throw new Error("whisper-cli.exe not found after extracting " + basename(url));
  return cli;
}

/** Expand a .zip into a directory via PowerShell (Windows). */
function extractZipWindows(zipPath, destDir) {
  return runPowerShell(`Expand-Archive -Path '${psq(zipPath)}' -DestinationPath '${psq(destDir)}' -Force`);
}

/** Run a PowerShell one-liner, rejecting on a non-zero exit. */
function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout: 120000 },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(undefined))
    );
  });
}
