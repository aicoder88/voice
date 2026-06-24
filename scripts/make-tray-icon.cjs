#!/usr/bin/env node
// Generates the menu-bar tray icon: five equalizer-style soundwave bars.
// Output is a macOS *template* image (black shape + alpha) so macOS tints it to
// match the menu bar and it stays subtle in both light and dark modes. The
// `Template` filename suffix makes Electron flag it as a template automatically.
//
// Writes public/trayTemplate.png (@1x) and public/trayTemplate@2x.png (@2x).
// Pure Node — no image deps — so it's reproducible in any checkout.

const zlib = require("node:zlib");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

// Five bars, symmetric, tallest in the middle — a voice level / equalizer.
// Heights are fractions of the drawable height so the shape scales cleanly.
const BAR_HEIGHT_FRACTIONS = [0.42, 0.66, 1.0, 0.66, 0.42];

/** Render the soundwave bars into an RGBA buffer at `size`×`size`. */
function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4, 0); // transparent
  const set = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; // black (template tint ignores RGB)
    px[i + 3] = Math.max(px[i + 3], a);       // keep the strongest alpha
  };

  const n = BAR_HEIGHT_FRACTIONS.length;
  // Layout: bars + gaps fill ~78% of the width, centered, with vertical margin.
  const usableW = size * 0.78;
  const gap = usableW / (n * 2.0);          // gap ≈ half a bar
  const barW = (usableW - gap * (n - 1)) / n;
  const startX = (size - usableW) / 2;
  const maxBarH = size * 0.74;
  const cy = size / 2;
  const r = Math.max(1, barW / 2);          // rounded bar caps

  for (let b = 0; b < n; b++) {
    const bx = startX + b * (barW + gap);
    const bh = maxBarH * BAR_HEIGHT_FRACTIONS[b];
    const top = cy - bh / 2;
    const bottom = cy + bh / 2;
    for (let y = Math.floor(top); y <= Math.ceil(bottom); y++) {
      for (let x = Math.floor(bx); x <= Math.ceil(bx + barW); x++) {
        // Distance-based coverage for soft, anti-aliased rounded edges.
        const dxL = (bx + r) - (x + 0.5);
        const dxR = (x + 0.5) - (bx + barW - r);
        const dxEdge = Math.max(0, dxL, dxR);
        const dyT = (top + r) - (y + 0.5);
        const dyB = (y + 0.5) - (bottom - r);
        const dyEdge = Math.max(0, dyT, dyB);
        const dist = Math.sqrt(dxEdge * dxEdge + dyEdge * dyEdge);
        const cov = Math.max(0, Math.min(1, r - dist + 0.5)); // 1px AA band
        if (cov > 0) set(x, y, Math.round(255 * cov));
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const out = join(__dirname, "..", "public");
const targets = [["trayTemplate.png", 22], ["trayTemplate@2x.png", 44]];
for (const [name, size] of targets) {
  writeFileSync(join(out, name), encodePng(size, renderIcon(size)));
  console.log("wrote", join(out, name), `(${size}x${size})`);
}
