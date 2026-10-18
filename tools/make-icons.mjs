// Writes the app's PNG icons with no dependencies (hand-rolled PNG encoder).
// Usage: node tools/make-icons.mjs
// The design matches icons/icon.svg: a pale notebook page with mid-blue lines on a deep-blue tile.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../icons/', import.meta.url));

const TILE = [0x0e, 0x4a, 0x72]; // Deep blue tile
const PAGE = [0xee, 0xf5, 0xfb]; // Mist page
const LINE = [0x34, 0x82, 0xbc]; // Mid blue lines

// Signed distance-free "inside rounded rect" test in unit coordinates.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Returns [r, g, b, a] for a point in the unit square.
function shade(x, y, maskable) {
  // Maskable icons must fill the whole square; platforms crop them.
  const tile = maskable || inRoundRect(x, y, 0, 0, 1, 1, 0.22);
  if (!tile) return [0, 0, 0, 0];

  // Maskable keeps content inside the central safe zone.
  const p = maskable ? { x0: 0.31, y0: 0.25, x1: 0.69, y1: 0.75, r: 0.04 } : { x0: 0.27, y0: 0.19, x1: 0.73, y1: 0.81, r: 0.05 };
  if (inRoundRect(x, y, p.x0, p.y0, p.x1, p.y1, p.r)) {
    const w = p.x1 - p.x0;
    const h = p.y1 - p.y0;
    const lines = [0.36, 0.52, 0.68];
    for (let i = 0; i < lines.length; i++) {
      const ly = p.y0 + h * lines[i];
      const lx1 = p.x0 + w * (i === lines.length - 1 ? 0.62 : 0.82);
      if (inRoundRect(x, y, p.x0 + w * 0.18, ly - h * 0.035, lx1, ly + h * 0.035, h * 0.035)) return [...LINE, 255];
    }
    return [...PAGE, 255];
  }
  return [...TILE, 255];
}

function render(size, maskable) {
  const SS = 4; // 4x4 supersampling for smooth edges
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // first byte: PNG filter type 0
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, maskable);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = 1 + px * 4;
      row[o] = a ? Math.round(r / a) : 0;
      row[o + 1] = a ? Math.round(g / a) : 0;
      row[o + 2] = a ? Math.round(b / a) : 0;
      row[o + 3] = Math.round(a / (SS * SS));
    }
    rows.push(row);
  }
  return encodePng(size, size, Buffer.concat(rows));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const outputs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true], // iOS adds its own rounded corners
];
for (const [name, size, maskable] of outputs) {
  writeFileSync(OUT + name, render(size, maskable));
  console.log(`wrote icons/${name}`);
}
