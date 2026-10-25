/**
 * Arsin Print Server - QR Code encoder (pure, byte mode, versions 1-10).
 *
 * Returns { size, modules } where modules is a 2D array of 0/1 (1 = dark).
 * Used for the on-screen label preview and for raster / ESC/POS output; label
 * printers additionally get the native ^BQ / QRCODE command from label.js.
 */

/** [blocks, dataCodewordsPerBlock, eccPerBlock] - extra blocks for larger versions. */
const ECC_TABLE = {
  1: { L: [[1, 19, 7]], M: [[1, 16, 10]], Q: [[1, 13, 13]], H: [[1, 9, 17]] },
  2: { L: [[1, 34, 10]], M: [[1, 28, 16]], Q: [[1, 22, 22]], H: [[1, 16, 28]] },
  3: { L: [[1, 55, 15]], M: [[1, 44, 26]], Q: [[2, 17, 18]], H: [[2, 13, 22]] },
  4: { L: [[1, 80, 20]], M: [[2, 32, 18]], Q: [[2, 24, 26]], H: [[4, 9, 16]] },
  5: { L: [[1, 108, 26]], M: [[2, 43, 24]], Q: [[2, 15, 18], [2, 16, 18]], H: [[2, 11, 22], [2, 12, 22]] },
  6: { L: [[2, 68, 18]], M: [[4, 27, 16]], Q: [[4, 19, 24]], H: [[4, 15, 28]] },
  7: { L: [[2, 78, 20]], M: [[4, 31, 18]], Q: [[2, 14, 18], [4, 15, 18]], H: [[4, 13, 26], [1, 14, 26]] },
  8: { L: [[2, 97, 24]], M: [[2, 38, 22], [2, 39, 22]], Q: [[4, 18, 22], [2, 19, 22]], H: [[4, 14, 26], [2, 15, 26]] },
  9: { L: [[2, 116, 30]], M: [[3, 36, 22], [2, 37, 22]], Q: [[4, 16, 20], [4, 17, 20]], H: [[4, 12, 24], [4, 13, 24]] },
  10: { L: [[2, 68, 18], [2, 69, 18]], M: [[4, 43, 26], [1, 44, 26]], Q: [[6, 19, 24], [2, 20, 24]], H: [[6, 15, 28], [2, 16, 28]] }
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/* ------------------------------------------------------------ GF(256) math */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

export function rsEncode(data, eccLen) {
  const gen = rsGenerator(eccLen);
  const res = new Array(eccLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

/* ------------------------------------------------------------- bit buffer */

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

function utf8Bytes(text) {
  return [...new TextEncoder().encode(String(text))];
}

export function dataCapacity(version, ecc) {
  return ECC_TABLE[version][ecc].reduce((sum, [blocks, data]) => sum + blocks * data, 0);
}

/** Pick the smallest version 1-10 that fits the payload for the ECC level. */
export function pickVersion(byteLen, ecc) {
  for (let v = 1; v <= 10; v++) {
    const capacity = dataCapacity(v, ecc);
    const header = 4 + (v <= 9 ? 8 : 16);
    if (capacity * 8 >= header + byteLen * 8) return v;
  }
  throw new Error('QR payload too large (max version 10, ~200 bytes)');
}

/* ------------------------------------------------------------ matrix build */

export function qrEncode(text, opts = {}) {
  const ecc = opts.ecc || 'M';
  const bytes = utf8Bytes(text);
  const version = opts.version || pickVersion(bytes.length, ecc);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version, ecc);
  const matrix = new Array(size).fill(0).map(() => new Array(size).fill(0));
  const reserved = new Array(size).fill(0).map(() => new Array(size).fill(0));
  placeFunctionPatterns(matrix, reserved, version);
  placeData(matrix, reserved, codewords);
  if (opts.mask != null) {
    const forced = matrix.map((row) => row.slice());
    applyMask(forced, reserved, opts.mask);
    placeFormat(forced, ecc, opts.mask);
    return { version, ecc, size, mask: opts.mask, modules: forced, text: String(text), forced: true };
  }
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = matrix.map((row) => row.slice());
    applyMask(candidate, reserved, mask);
    placeFormat(candidate, ecc, mask);
    const penalty = score(candidate);
    if (!best || penalty < best.penalty) best = { mask, penalty, matrix: candidate };
  }
  return { version, ecc, size, mask: best.mask, modules: best.matrix, text: String(text) };
}

function buildCodewords(bytes, version, ecc) {
  const buf = new BitBuffer();
  buf.put(4, 4); // byte mode
  buf.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);
  const capacityBits = dataCapacity(version, ecc) * 8;
  buf.put(0, Math.min(4, capacityBits - buf.length));
  while (buf.length % 8 !== 0) buf.put(0, 1);
  const dataCw = [];
  for (let i = 0; i < buf.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j];
    dataCw.push(byte);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (dataCw.length < capacityBits / 8) dataCw.push(pads[p++ % 2]);

  const groups = ECC_TABLE[version][ecc];
  const blocks = [];
  let offset = 0;
  for (const [count, dataLen, eccLen] of groups) {
    for (let i = 0; i < count; i++) {
      const data = dataCw.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data, ecc: rsEncode(data, eccLen) });
    }
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  const maxEcc = Math.max(...blocks.map((b) => b.ecc.length));
  const out = [];
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < maxEcc; i++) for (const b of blocks) if (i < b.ecc.length) out.push(b.ecc[i]);
  return out;
}

/** BCH(15,5) format information with the 0x5412 mask. */
export function formatBits(ecc, mask) {
  const data = (ECC_BITS[ecc] << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((value >> (10 + i)) & 1) value ^= 0x537 << i;
  }
  return ((data << 10) | value) ^ 0x5412;
}

/** BCH(18,6) version information (versions 7+). */
export function versionBits(version) {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((value >> (12 + i)) & 1) value ^= 0x1f25 << i;
  }
  return (version << 12) | value;
}


function placeFunctionPatterns(m, reserved, version) {
  const size = m.length;
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r][c] = v;
    reserved[r][c] = 1;
  };
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(row + r, col + c, inRing || inCore ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }
  // reserve format information areas
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  m[size - 8][8] = 1; // fixed dark module
  reserved[size - 8][8] = 1;
  // reserve + write version information (versions 7 and above)
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
}

function placeData(m, reserved, codewords) {
  const size = m.length;
  const total = codewords.length * 8;
  const bitAt = (i) => (i < total ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0);
  let bitIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const upward = ((size - 1 - col) >> 1) % 2 === 0;
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        m[row][cc] = bitAt(bitIndex++);
      }
    }
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function applyMask(m, reserved, mask) {
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (reserved[r][c]) continue;
      if (MASKS[mask](r, c)) m[r][c] ^= 1;
    }
  }
}

function placeFormat(m, ecc, mask) {
  const size = m.length;
  const bits = formatBits(ecc, mask);
  const bit = (i) => (bits >> i) & 1;
  // First copy, most significant bit first (ISO/IEC 18004 figure 25).
  for (let i = 0; i <= 5; i++) m[8][i] = bit(14 - i);
  m[8][7] = bit(8);
  m[8][8] = bit(7);
  m[7][8] = bit(6);
  for (let i = 0; i < 6; i++) m[5 - i][8] = bit(5 - i);
  // Second copy.
  for (let i = 0; i < 7; i++) m[size - 1 - i][8] = bit(14 - i);
  for (let i = 0; i < 8; i++) m[8][size - 8 + i] = bit(7 - i);
  m[size - 8][8] = 1;
}


/** Penalty score (ISO/IEC 18004 rules 1-4) used for mask selection. */
function score(m) {
  const size = m.length;
  let penalty = 0;
  for (let i = 0; i < size; i++) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j++) {
      runRow = m[i][j] === m[i][j - 1] ? runRow + 1 : 1;
      runCol = m[j][i] === m[j - 1][i] ? runCol + 1 : 1;
      if (runRow === 5) penalty += 3;
      else if (runRow > 5) penalty += 1;
      if (runCol === 5) penalty += 3;
      else if (runCol > 5) penalty += 1;
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) penalty += 3;
    }
  }
  const pat = [1, 0, 1, 1, 1, 0, 1];
  const zeros = (get, start, end) => {
    for (let i = start; i < end; i++) if (get(i) !== 0) return false;
    return true;
  };
  const finderLike = (get, start) => {
    for (let i = 0; i < 7; i++) if (get(start + i) !== pat[i]) return false;
    return true;
  };
  for (let i = 0; i < size; i++) {
    const rowGet = (k) => m[i][k];
    const colGet = (k) => m[k][i];
    for (let j = 0; j + 7 <= size; j++) {
      const before = j - 4 >= 0 && zeros(rowGet, j - 4, j);
      const after = j + 11 <= size && zeros(rowGet, j + 7, j + 11);
      if (finderLike(rowGet, j) && before && after) penalty += 40;
      const beforeC = j - 4 >= 0 && zeros(colGet, j - 4, j);
      const afterC = j + 11 <= size && zeros(colGet, j + 7, j + 11);
      if (finderLike(colGet, j) && beforeC && afterC) penalty += 40;
    }
  }
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return penalty;
}

/** QR as an array of "1"/"0" row strings - convenient for tests and rendering. */
export function qrRows(text, opts) {
  const qr = qrEncode(text, opts);
  return qr.modules.map((row) => row.join(''));
}

/**
 * Test / diagnostic hook: exposes the codeword stream and the reserved-module
 * map so the unit tests can compare the data layout against a reference
 * implementation cell by cell.
 */
export function qrDebug(text, opts = {}) {
  const ecc = opts.ecc || 'M';
  const bytes = utf8Bytes(text);
  const version = opts.version || pickVersion(bytes.length, ecc);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version, ecc);
  const matrix = new Array(size).fill(0).map(() => new Array(size).fill(0));
  const reserved = new Array(size).fill(0).map(() => new Array(size).fill(0));
  placeFunctionPatterns(matrix, reserved, version);
  return { version, ecc, size, codewords, reserved, codewordBits: codewords.map((c) => c.toString(2).padStart(8, '0')).join('') };
}

