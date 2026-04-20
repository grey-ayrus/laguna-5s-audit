#!/usr/bin/env node
/**
 * Generates the PNG icons the PWA manifest needs.
 *
 * Re-creates the Laguna logo pattern (dark slate background + white rectangles
 * from laguna-logo.svg) directly as pixel buffers so we don't need a native
 * image dependency (`sharp`, `canvas`, ImageMagick, ...). The result is a flat
 * brand-consistent icon that is plenty for home-screen installs.
 *
 * Run it once after `npm install` (or re-run if you tweak the pattern).
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, '..', 'client', 'public', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

const BG_EDGE = [255, 255, 255, 255];
const BG_PLATE = [47, 62, 70, 255];
const FG = [255, 255, 255, 255];
const ACCENT = [30, 60, 114, 255];

// Rectangles come from client/public/laguna-logo.svg, mapped to the 0..1 space
// of the inner plate so we can re-rasterise at any size. The plate itself
// occupies roughly the top 70% of the 337x400 original; we map it to the
// inner square of the icon so the logo reads well even at 192px.
const PATTERN = [
  { x: 0.00, y: 0.00, w: 1.00, h: 1.00, color: BG_PLATE },
  { x: 0.10, y: 0.10, w: 0.19, h: 0.15, color: FG },
  { x: 0.36, y: 0.10, w: 0.54, h: 0.15, color: FG },
  { x: 0.10, y: 0.34, w: 0.19, h: 0.30, color: FG },
  { x: 0.36, y: 0.34, w: 0.27, h: 0.30, color: FG },
  { x: 0.10, y: 0.72, w: 0.54, h: 0.18, color: FG },
  { x: 0.73, y: 0.72, w: 0.19, h: 0.18, color: FG },
];

function encodePNG(width, height, pixels) {
  const rowLen = width * 4;
  const stride = rowLen + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * rowLen, y * rowLen + rowLen);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const chunks = [];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  chunks.push(signature);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', compressed));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function putPixel(buf, idx, rgba) {
  buf[idx] = rgba[0];
  buf[idx + 1] = rgba[1];
  buf[idx + 2] = rgba[2];
  buf[idx + 3] = rgba[3];
}

function fillRect(buf, width, height, x, y, w, h, color) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.floor(x + w));
  const y1 = Math.min(height, Math.floor(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      putPixel(buf, (py * width + px) * 4, color);
    }
  }
}

function render(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  // Outer background (white for non-maskable so it looks clean on light
  // launchers; brand blue + full bleed for maskable so the safe zone still
  // reads as Laguna).
  fillRect(pixels, size, size, 0, 0, size, size, maskable ? ACCENT : BG_EDGE);

  // Inner plate: on non-maskable icons we inset 12% to keep breathing room.
  // On maskable icons we keep a 10% safe zone and push the plate further in
  // so the launcher's circle crop shows the logo.
  const pad = Math.round(size * (maskable ? 0.18 : 0.12));
  const plateSize = size - pad * 2;
  const px = pad;
  const py = pad;

  for (const r of PATTERN) {
    fillRect(
      pixels,
      size,
      size,
      px + r.x * plateSize,
      py + r.y * plateSize,
      r.w * plateSize,
      r.h * plateSize,
      r.color,
    );
  }

  return encodePNG(size, size, pixels);
}

const targets = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-512-maskable.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180, maskable: false },
];

for (const t of targets) {
  const outPath = path.join(OUT_DIR, t.name);
  fs.writeFileSync(outPath, render(t.size, { maskable: t.maskable }));
  console.log(`wrote ${path.relative(process.cwd(), outPath)} (${t.size}x${t.size})`);
}
