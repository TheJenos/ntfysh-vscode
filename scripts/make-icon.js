// Generates media/icon.png (256x256) without external deps.
// Draws a rounded teal square with a white bell glyph.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;
const bg = [49, 127, 111]; // ntfy-ish teal
const bgDark = [38, 99, 87];
const white = [255, 255, 255];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

const buf = Buffer.alloc(SIZE * SIZE * 4, 0);

function set(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

// Rounded-rect background with vertical gradient.
const radius = 56;
function insideRoundRect(x, y) {
  const min = 0;
  const max = SIZE - 1;
  const rx = Math.min(Math.max(x, min + radius), max - radius);
  const ry = Math.min(Math.max(y, min + radius), max - radius);
  const dx = x - rx;
  const dy = y - ry;
  return dx * dx + dy * dy <= radius * radius;
}

for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  const color = mix(bg, bgDark, t);
  for (let x = 0; x < SIZE; x++) {
    if (insideRoundRect(x, y)) {
      set(x, y, color);
    }
  }
}

// Bell glyph (centered). Built from simple primitives.
const cx = 128;
function inCircle(x, y, ox, oy, r) {
  const dx = x - ox;
  const dy = y - oy;
  return dx * dx + dy * dy <= r * r;
}

function inBell(x, y) {
  // top knob
  if (inCircle(x, y, cx, 70, 10)) return true;
  // dome + flaring body between y 80 and 168
  if (y >= 80 && y <= 168) {
    const t = (y - 80) / (168 - 80);
    const halfTop = 30;
    const halfBottom = 60;
    const half = halfTop + (halfBottom - halfTop) * Math.pow(t, 1.3);
    // dome rounding near the top
    const domeLimit = 80 + 24;
    if (y < domeLimit) {
      const dr = 44;
      if (!inCircle(x, y, cx, 80 + 24, dr)) {
        // still allow body sides
        if (Math.abs(x - cx) > half) return false;
      }
    }
    if (Math.abs(x - cx) <= half) return true;
  }
  // bottom rim bar
  if (y >= 168 && y <= 180 && Math.abs(x - cx) <= 66) return true;
  // clapper
  if (inCircle(x, y, cx, 196, 12)) return true;
  return false;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (inBell(x, y)) {
      set(x, y, white);
    }
  }
}

// Encode PNG (truecolor + alpha, no filter).
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) {
    c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type none
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw);

const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0))
]);

const out = path.join(__dirname, "..", "media", "icon.png");
fs.writeFileSync(out, png);
console.log("Wrote", out, png.length, "bytes");
