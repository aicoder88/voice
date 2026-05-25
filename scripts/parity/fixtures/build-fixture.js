// Synthesize a deterministic 1.5 s PCM16 mono 24 kHz fixture: 0.3 s silence,
// 0.9 s 440 Hz sine at -12 dBFS, 0.3 s silence.
// Run: node scripts/parity/fixtures/build-fixture.js
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SAMPLE_RATE = 24000;
const DURATION_S = 1.5;
const TOTAL_SAMPLES = SAMPLE_RATE * DURATION_S;
const SILENT_HEAD = Math.floor(SAMPLE_RATE * 0.3);
const SILENT_TAIL = Math.floor(SAMPLE_RATE * 0.3);
const TONE_START = SILENT_HEAD;
const TONE_END = TOTAL_SAMPLES - SILENT_TAIL;
const TONE_HZ = 440;
const TONE_AMP = Math.round(32767 * 0.25); // ~-12 dBFS

const pcm = new Int16Array(TOTAL_SAMPLES);
for (let i = TONE_START; i < TONE_END; i++) {
  pcm[i] = Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * TONE_AMP);
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "tone-1500ms.pcm16");
writeFileSync(outPath, Buffer.from(pcm.buffer));
console.log(`wrote ${outPath} (${pcm.byteLength} bytes, ${DURATION_S}s @ ${SAMPLE_RATE}Hz)`);
