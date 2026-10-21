// A small QR code encoder, so Settings can show the remote-control link as a
// code a phone camera scans. Vendored rather than a dependency: the link
// carries a live bearer token, so it must never leave this machine to be
// drawn, and the repo adds no package for one picture.
//
// Byte mode, error-correction level M, versions 1–10 (up to 213 bytes —
// a Tailscale link with its token is about 105). The algorithm follows the
// QR specification (ISO/IEC 18004) as laid out in Project Nayuki's reference
// implementation (MIT). Pure: qrMatrix() returns rows of booleans (true =
// dark) and touches no DOM, so test/t-remote-qr.js can decode it in Node.

// Level M, indexed by version - 1.
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

function rawModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver - 1] * BLOCKS[ver - 1];

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function encodeData(bytes, ver) {
  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  return out;
}

function interleave(data, ver) {
  const blocks = BLOCKS[ver - 1];
  const eccLen = ECC_PER_BLOCK[ver - 1];
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    all.push([...dat, ...ecc]);
  }
  const out = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]); });
  }
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(ver, codewords, mask) {
  const size = ver * 4 + 17;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { grid[y][x] = dark; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(ver);
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));

  // Format: level M is 00, then the mask, BCH(15,5), XOR 0x5412.
  const format = (() => {
    const data = (0 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  })();
  const bit = (value, i) => ((value >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6));
  set(8, 8, bit(format, 7));
  set(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, true);

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fixed[y][x] || i >= codewords.length * 8) continue;
        grid[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
        i++;
      }
    }
  }
  const masked = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && masked(x, y)) grid[y][x] = !grid[y][x];
  return grid;
}

// The spec's penalty rules 1 (runs), 2 (2×2 blocks) and 4 (balance). Rule 3
// (finder look-alikes) is left out: every mask yields a valid code, and the
// choice only nudges how easily a camera locks on.
function penalty(grid) {
  const size = grid.length;
  let score = 0;
  for (const line of [grid, grid[0].map((_, x) => grid.map((row) => row[x]))]) {
    for (const row of line) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && row[x] === row[x - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y][x]) dark++;
      if (y < size - 1 && x < size - 1) {
        const c = grid[y][x];
        if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) score += 3;
      }
    }
  }
  return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

/** The QR code for `text` as rows of booleans (true = dark), quiet zone not included. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > MAX_VERSION) throw new Error('Text is too long for a QR code here.');
  const codewords = interleave(encodeData(bytes, ver), ver);
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = build(ver, codewords, mask);
    const score = penalty(grid);
    if (score < bestScore) { best = grid; bestScore = score; }
  }
  return best;
}
