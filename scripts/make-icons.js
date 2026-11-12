#!/usr/bin/env node
'use strict';

/**
 * Generates the tray / window icons (a robot head) as PNG files, with no
 * dependencies: shapes are signed-distance functions, rasterised with 4x4
 * supersampling and encoded with node:zlib.
 *
 *   npm run make-icons
 *
 * Output: app/assets/tray.png (16 px), tray@2x.png (32 px), icon.png (256 px).
 * The generated files are committed, so you only need this after changing the
 * design below.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'app', 'assets');
const UNITS = 32; // the design below is drawn on a 32 x 32 grid

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const NAVY = hex('#22344A');

// Signed distance functions (negative inside).
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const segment = (ax, ay, bx, by, halfWidth) => (x, y) => {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t) - halfWidth;
};

// Painter's order: later layers draw on top.
const LAYERS = [
  { sdf: segment(16, 3.5, 16, 9, 1), fill: NAVY },
  { sdf: circle(16, 3.5, 2.6), fill: hex('#FFC857'), stroke: NAVY, width: 1.1 },
  { sdf: circle(4.6, 17.5, 2.6), fill: hex('#2E9E90'), stroke: NAVY, width: 1.1 },
  { sdf: circle(27.4, 17.5, 2.6), fill: hex('#2E9E90'), stroke: NAVY, width: 1.1 },
  { sdf: roundRect(5, 8.5, 27, 28.5, 6), fill: hex('#3DBFAE'), stroke: NAVY, width: 1.6 },
  { sdf: roundRect(8.2, 12, 23.8, 24.5, 4), fill: hex('#1C2838') },
  { sdf: roundRect(11, 15, 14, 20.5, 1.5), fill: hex('#8AF3FF') },
  { sdf: roundRect(18, 15, 21, 20.5, 1.5), fill: hex('#8AF3FF') },
];

function colorAt(x, y) {
  let color = null;
  for (const layer of LAYERS) {
    const d = layer.sdf(x, y);
    if (layer.stroke && Math.abs(d) <= layer.width / 2) color = layer.stroke;
    else if (d <= 0) color = layer.fill;
  }
  return color;
}

function render(size) {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  const scale = UNITS / size;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const c = colorAt((px + (sx + 0.5) / samples) * scale, (py + (sy + 0.5) / samples) * scale);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(g / a);
        pixels[i + 2] = Math.round(b / a);
        pixels[i + 3] = Math.round((a / (samples * samples)) * 255);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of [
  ['tray.png', 16],
  ['tray@2x.png', 32],
  ['icon.png', 256],
]) {
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(size, render(size)));
  console.log(`wrote app/assets/${name} (${size}x${size})`);
}
