// Нарезка иконок PWA из logo.png (в корне проекта).
// Запуск:  node tools/make-icons.mjs
// Требует ffmpeg в PATH.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(root, 'logo.png');
const OUT = resolve(root, 'icons');
const BG = '0x080b09'; // фон логотипа — для безопасной зоны maskable
const SAFE = 0.78;     // доля стороны под артворк в maskable

mkdirSync(OUT, { recursive: true });

function ff(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}
function plain(size, name) {
  ff(['-i', SRC, '-vf', `scale=${size}:${size}:flags=lanczos`, '-frames:v', '1', resolve(OUT, name)]);
}
function maskable(size, name) {
  const inner = Math.round(size * SAFE);
  ff([
    '-i', SRC,
    '-vf', `scale=${inner}:${inner}:flags=lanczos,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=${BG}`,
    '-frames:v', '1', resolve(OUT, name),
  ]);
}

// Обычные иконки
[
  ['icon-192.png', 192],
  ['icon-384.png', 384],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
  ['favicon-48.png', 48],
  ['favicon-32.png', 32],
  ['favicon-16.png', 16],
].forEach(([name, size]) => plain(size, name));

// Maskable (артворк в безопасной зоне, фон залит)
[
  ['icon-maskable-192.png', 192],
  ['icon-maskable-512.png', 512],
].forEach(([name, size]) => maskable(size, name));

// favicon.ico — контейнер с PNG (16/32/48), понимают все современные браузеры
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const b = i * 16;
    entries[b] = img.size >= 256 ? 0 : img.size;
    entries[b + 1] = img.size >= 256 ? 0 : img.size;
    entries.writeUInt16LE(1, b + 4);
    entries.writeUInt16LE(32, b + 6);
    entries.writeUInt32LE(img.png.length, b + 8);
    entries.writeUInt32LE(offset, b + 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}
writeFileSync(
  resolve(OUT, 'favicon.ico'),
  buildIco([48, 32, 16].map((size) => ({ size, png: readFileSync(resolve(OUT, `favicon-${size}.png`)) })))
);

console.log('Иконки готовы в icons/ из logo.png');
