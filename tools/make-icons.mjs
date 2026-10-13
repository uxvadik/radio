// Генератор PWA-иконок без внешних зависимостей (PNG через zlib).
// Запуск: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'icons');
mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

// Signed-ish coverage helpers for supersampling.
function inRoundedRect(x, y, w, h, r) {
  const cx = clamp(x, r, w - r);
  const cy = clamp(y, r, h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function drawIcon(size, { maskable }) {
  const SS = 4; // supersampling
  const out = Buffer.alloc(size * size * 4);
  const pad = maskable ? 0 : size * 0.06;
  const boxR = maskable ? 0 : size * 0.22;
  const boxW = size - pad * 2;

  // geometry (in size units); for maskable keep glyph inside the 80% safe zone
  const k = maskable ? 0.66 : 1;
  const map = (v) => (0.5 + (v - 0.5) * k) * size;
  const dotX = map(0.34);
  const dotY = map(0.68);
  const dotR = size * 0.075 * k;
  const arcs = [0.30, 0.46, 0.62, 0.78].map((v) => v * size * k);
  const arcT = size * 0.052 * k;

  // palette
  const bgTop = [13, 17, 26];
  const bgBot = [20, 28, 42];
  const accent = [61, 220, 132];
  const accent2 = [34, 211, 238];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;

          // background
          let cr = 0, cg = 0, cb = 0, ca = 0;
          const insideBox = pad === 0 && boxR === 0 ? true : inRoundedRect(x - pad, y - pad, boxW, boxW, boxR);
          if (insideBox) {
            const t = clamp(y / size, 0, 1);
            cr = mix(bgTop[0], bgBot[0], t);
            cg = mix(bgTop[1], bgBot[1], t);
            cb = mix(bgTop[2], bgBot[2], t);
            ca = 255;
          }

          // broadcast glyph
          const ddx = x - dotX;
          const ddy = y - dotY;
          const dist = Math.hypot(ddx, ddy);
          const ang = ((Math.atan2(dotY - y, x - dotX) * 180) / Math.PI + 360) % 360;

          let glyph = 0;
          let gcol = accent;
          if (dist <= dotR) {
            glyph = 1;
          } else if (ang >= 6 && ang <= 84) {
            for (let i = 0; i < arcs.length; i++) {
              if (Math.abs(dist - arcs[i]) <= arcT / 2) {
                glyph = 1;
                const tt = i / (arcs.length - 1);
                gcol = [mix(accent[0], accent2[0], tt), mix(accent[1], accent2[1], tt), mix(accent[2], accent2[2], tt)];
                break;
              }
            }
          }

          if (glyph) {
            cr = gcol[0];
            cg = gcol[1];
            cb = gcol[2];
            ca = 255;
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
  ['favicon-32.png', 32, false],
];

for (const [name, size, maskable] of targets) {
  writeFileSync(resolve(OUT, name), drawIcon(size, { maskable }));
  console.log('wrote', name, size);
}
