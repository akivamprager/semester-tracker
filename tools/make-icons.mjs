// Generates the app icons (blue square with a white check mark) without dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function icon(size, bg = [31, 95, 209]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const s = size / 100;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.min(distToSeg(x, y, 27 * s, 52 * s, 43 * s, 68 * s), distToSeg(x, y, 43 * s, 68 * s, 74 * s, 34 * s));
      const a = Math.max(0, Math.min(1, 6 * s - d + 0.5)); // anti-aliased stroke
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(bg[i] * (1 - a) + 255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// 152 = iPad, 167 = iPad Pro, 180 = iPhone (apple-touch-icon); 192/512 = manifest.
for (const size of [152, 167, 180, 192, 512]) writeFileSync(`icon-${size}.png`, icon(size));
// App-icon shortcuts (long-press menu), one color per tab.
const shortcuts = { todo: [31, 95, 209], schedule: [13, 148, 136], tasks: [217, 119, 6], exams: [139, 92, 246] };
for (const [name, color] of Object.entries(shortcuts)) writeFileSync(`shortcut-${name}.png`, icon(96, color));
