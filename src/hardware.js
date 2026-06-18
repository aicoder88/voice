// @ts-check
// Hardware capability probe — a cheap PRE-FILTER, not the final verdict.
//
// It answers only "is it worth OFFERING this machine the on-device engine?" The
// real "is local actually faster than the cloud here?" decision is made by a
// timed benchmark on the real hardware (src/benchmark.js), because a hardware
// guess is unreliable: a 2019 laptop GPU (e.g. GTX 1660 Ti Max-Q) reads as
// "capable" here yet loses to the cloud in practice. The app therefore DEFAULTS
// TO THE CLOUD; "capable" only means local is surfaced as an opt-in worth
// benchmarking — never auto-selected on the strength of this probe alone.
//
// Kept free of any Electron import and split into a PURE classifier
// (classifyCapability, fed injected facts → unit-tested with fixtures) and a
// thin OS-probing wrapper (probeCapability / detectGpu) that gathers those
// facts at runtime. Mirrors the settings.js / hotkey-logic.js pattern.

import { cpus, totalmem, platform, arch } from "node:os";
import { execFileSync } from "node:child_process";

// Conservative thresholds for the CPU-only path. A machine with no discrete/
// integrated acceleration still runs whisper.cpp acceptably IF it has enough
// cores and RAM; below this, transcription of a normal clip is slow enough that
// the cloud engine is the better default. Tuned for the small/base GGML models.
const MIN_CORES = 8;
const MIN_RAM_GB = 8;

/**
 * Pure capability classifier. Takes already-gathered facts so it can be unit
 * tested with fixtures (no real hardware needed).
 *
 * Rule (binary, conservative):
 *   Apple Silicon  → capable (Metal is fast even on the base chips)
 *   NVIDIA GPU     → capable (CUDA build is ~10–100x the CPU path)
 *   ≥8 cores AND ≥8 GB RAM → capable (CPU build is usable)
 *   otherwise      → limited (default to cloud)
 *
 * @param {{ cores: number, ramGB: number, platform: string, arch: string, gpu: ("nvidia"|"apple"|"none") }} facts
 * @returns {{ tier: "capable"|"limited", gpu: string, cores: number, ramGB: number, reason: string }}
 */
export function classifyCapability(facts) {
  const { cores, ramGB, platform: plat, arch: cpuArch, gpu } = facts;
  const base = { gpu, cores, ramGB };

  if (plat === "darwin" && cpuArch === "arm64") {
    return { ...base, tier: "capable", reason: "Apple Silicon (Metal-accelerated)" };
  }
  if (gpu === "nvidia") {
    return { ...base, tier: "capable", reason: "NVIDIA GPU (CUDA-accelerated)" };
  }
  if (cores >= MIN_CORES && ramGB >= MIN_RAM_GB) {
    return { ...base, tier: "capable", reason: `${cores}-core CPU, ${ramGB} GB RAM` };
  }
  return {
    ...base,
    tier: "limited",
    reason: `only ${cores} cores / ${ramGB} GB RAM and no GPU — cloud will be faster`
  };
}

/**
 * Which whisper.cpp build + model the capable machine should fetch. NVIDIA gets
 * the CUDA build and the larger (more accurate) small model; everyone else gets
 * the CPU build and the lighter base model so the download + per-clip latency
 * stay reasonable. Apple Silicon is moot for v1 (Mac is cloud-only) but kept
 * honest for when Mac-local lands.
 *
 * @param {{ gpu: string, platform?: string }} facts
 * @returns {{ variant: "cuda"|"cpu", model: "ggml-small-q5_1.bin"|"ggml-base-q5_1.bin" }}
 */
export function recommendedAssets(facts) {
  if (facts.gpu === "nvidia") return { variant: "cuda", model: "ggml-small-q5_1.bin" };
  return { variant: "cpu", model: "ggml-base-q5_1.bin" };
}

/**
 * Best-effort GPU class detection. Never throws — an undetectable GPU just
 * reads as "none", which only costs the machine the (correct) CPU/cloud default.
 *
 * @returns {"nvidia"|"apple"|"none"}
 */
export function detectGpu() {
  try {
    if (platform() === "darwin") {
      return arch() === "arm64" ? "apple" : "none";
    }
    if (platform() === "win32") {
      // Query the GPU name(s) from WMI. `wmic` is deprecated but still present;
      // fall back to PowerShell's CIM cmdlet if it's been removed.
      let out = "";
      try {
        out = execFileSync("wmic", ["path", "win32_VideoController", "get", "name"], {
          encoding: "utf8",
          timeout: 4000
        });
      } catch {
        out = execFileSync(
          "powershell",
          ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"],
          { encoding: "utf8", timeout: 6000 }
        );
      }
      return /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(out) ? "nvidia" : "none";
    }
    // Linux / other: probe nvidia-smi presence.
    execFileSync("nvidia-smi", ["-L"], { encoding: "utf8", timeout: 4000 });
    return "nvidia";
  } catch {
    return "none";
  }
}

/** @type {ReturnType<typeof classifyCapability> | null} */
let capabilityCache = null;

/**
 * Gather real hardware facts and classify them. The single entry point main.js
 * calls when the Settings engine panel opens and before a benchmark.
 *
 * Memoized for the process lifetime: cores/RAM/GPU/arch don't change while the
 * app runs, and on Windows the GPU probe shells out to wmic/PowerShell, which
 * blocks the main event loop. Caching means that cost is paid at most once
 * instead of on every Settings-open and every benchmark. (The first call still
 * blocks; a fully async GPU probe would remove even that.)
 *
 * @returns {{ tier: "capable"|"limited", gpu: string, cores: number, ramGB: number, reason: string }}
 */
export function probeCapability() {
  if (capabilityCache) return capabilityCache;
  const facts = {
    cores: cpus().length,
    ramGB: Math.round(totalmem() / 1024 ** 3),
    platform: platform(),
    arch: arch(),
    gpu: detectGpu()
  };
  // Frozen: every caller gets this same shared instance, so freezing stops a
  // stray `probe.tier = ...` from silently poisoning the cache process-wide.
  capabilityCache = Object.freeze(classifyCapability(facts));
  return capabilityCache;
}
