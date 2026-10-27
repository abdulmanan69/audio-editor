// Renders the Kerf app icons (PNG) with no dependencies: a tiny signed-distance rasteriser
// plus a zlib PNG encoder. Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [6, 16, 19], RIM = [46, 64, 74], AMBER = [255, 181, 71], CYAN = [92, 242, 214];
// Waveform polyline from the SVG brand mark (32-unit grid).
const WAVE = [[7, 16], [10, 16], [12, 10], [15, 23], [18, 6], [21, 20], [23, 16], [25, 16]];

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * t, pay - bay * t);
}

function render(size, { maskable = false } = {}) {
  const S = 4; // supersampling per axis
  const px = new Uint8Array(size * size * 4);
  // Maskable icons keep content inside the central 80% safe zone and fill the full square.
  const scale = maskable ? (size * 0.62) / 32 : size / 32;
  const off = maskable ? (size - 32 * scale) / 2 : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const ux = (x + (sx + 0.5) / S - off) / scale, uy = (y + (sy + 0.5) / S - off) / scale;
        let c = null, alpha = 0;
        const inBox = maskable ? true : sdRoundRect(ux, uy, 16, 16, 15, 15, 8) <= 0;
        if (inBox) {
          c = BG; alpha = 1;
          const glow = Math.max(0, 1 - Math.hypot(ux - 16, uy - 6) / 18) * 0.12;
          c = [c[0] + CYAN[0] * glow, c[1] + CYAN[1] * glow, c[2] + CYAN[2] * glow];
          if (!maskable && sdRoundRect(ux, uy, 16, 16, 15, 15, 8) > -0.6) c = RIM;
          // Dashed cyan "kerf" line.
          if (Math.abs(ux - 22.5) < 0.8 && uy > 5 && uy < 27 && ((uy - 5) % 4.2) < 2.1) c = CYAN;
          let d = Infinity;
          for (let i = 0; i < WAVE.length - 1; i++) d = Math.min(d, sdSegment(ux, uy, ...WAVE[i], ...WAVE[i + 1]));
          if (d < 1.15) c = AMBER;
        }
        if (alpha) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
      const n = S * S, o = (y * size + x) * 4;
      px[o] = a ? r / a : 0; px[o + 1] = a ? g / a : 0; px[o + 2] = a ? b / a : 0; px[o + 3] = (a / n) * 255;
    }
  }
  return px;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const v of buf) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
  ['favicon-32.png', 32, {}],
];
for (const [name, size, opts] of jobs) {
  writeFileSync(join(outDir, name), png(size, render(size, opts)));
  console.log('wrote', name);
}
