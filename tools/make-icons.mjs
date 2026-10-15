// Generates the app icons without dependencies: a graduation cap inside a semester-progress
// ring (≈70%), white on the app blue. Shapes are drawn on a 100×100 grid with 4×4
// supersampling. Run from the tracker folder: node tools/make-icons.mjs
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
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const WHITE = [255, 255, 255];
const LIGHT = [181, 212, 244]; // cap band
const GOLD = [250, 199, 117]; // tassel
const RING_R = 33, RING_W = 6, RING_PART = 0.7; // progress ring, filled from 12 o'clock clockwise

// The design, back to front: [color, opacity] of the topmost layer covering point (x, y), or null.
function layers(x, y) {
  const hit = [];
  const r = Math.hypot(x - 50, y - 50);
  if (Math.abs(r - RING_R) <= RING_W / 2) hit.push([WHITE, 0.28]);
  // progress arc (+ round caps at both ends)
  const angle = (Math.atan2(x - 50, -(y - 50)) + 2 * Math.PI) % (2 * Math.PI); // 0 = up, clockwise
  const end = RING_PART * 2 * Math.PI;
  const capAt = (a) => Math.hypot(x - (50 + RING_R * Math.sin(a)), y - (50 - RING_R * Math.cos(a))) <= RING_W / 2;
  if ((Math.abs(r - RING_R) <= RING_W / 2 && angle <= end) || capAt(0) || capAt(end)) hit.push([WHITE, 1]);
  // cap band: x 38–62, from y 52 down to a curved bottom (60 at the sides, 63.5 in the middle)
  if (x >= 38 && x <= 62 && y >= 52 && y <= 60 + 3.5 * (1 - ((x - 50) / 12) ** 2)) hit.push([LIGHT, 1]);
  // mortarboard: diamond centered (50, 46), 44 wide, 20 high
  if (Math.abs(x - 50) / 22 + Math.abs(y - 46) / 10 <= 1) hit.push([WHITE, 1]);
  // tassel: cord from the center to the corner and down, ending in a knot
  if (Math.min(distToSeg(x, y, 50, 46, 66, 50), distToSeg(x, y, 66, 50, 66, 60)) <= 1.25) hit.push([GOLD, 1]);
  if (Math.hypot(x - 66, y - 62) <= 3.5) hit.push([GOLD, 1]);
  return hit;
}

// bg = null → transparent background, everything drawn white (Android notification badge).
function icon(size, bg = [31, 95, 209]) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 100;
          const y = ((py + (sy + 0.5) / SS) / size) * 100;
          let c = bg ? [...bg] : [0, 0, 0];
          let alpha = bg ? 1 : 0;
          for (const [color, op] of layers(x, y)) {
            const col = bg ? color : WHITE;
            c = c.map((v, i) => v * (1 - op) + col[i] * op);
            alpha = alpha + op * (1 - alpha);
          }
          r += c[0] * alpha; g += c[1] * alpha; b += c[2] * alpha; a += alpha;
        }
      }
      const o = (py * size + px) * 4;
      const n = SS * SS;
      out[o + 3] = Math.round((a / n) * 255);
      // un-premultiply so edges keep their color
      out[o] = a ? Math.round(r / a) : 0; out[o + 1] = a ? Math.round(g / a) : 0; out[o + 2] = a ? Math.round(b / a) : 0;
    }
  }
  return png(size, out);
}

// 152 = iPad, 167 = iPad Pro, 180 = iPhone (apple-touch-icon); 192/512 = manifest (512 also
// maskable: everything sits inside the central 80% circle).
for (const size of [152, 167, 180, 192, 512]) writeFileSync(`icon-${size}.png`, icon(size));
// Android notification badge: shape only, on transparent.
writeFileSync('badge-96.png', icon(96, null));
// App-icon shortcuts (long-press menu), one color per tab.
const shortcuts = { todo: [31, 95, 209], schedule: [13, 148, 136], tasks: [217, 119, 6], exams: [139, 92, 246] };
for (const [name, color] of Object.entries(shortcuts)) writeFileSync(`shortcut-${name}.png`, icon(96, color));
