/**
 * QR encoder - verified against the `qrcode` reference implementation.
 *
 * `qrcode` picks its own mask and always emits the format information, so the
 * test reads the ECC level and mask straight out of the reference matrix
 * (ISO/IEC 18004 figure 25: 15 format bits, MSB first, XOR 0x5412) and then asks
 * the core encoder for exactly that ecc + mask combination. The two matrices
 * must be identical for every version 1-10 and every ECC level.
 *
 * Payloads are lowercase ASCII only, which forces byte mode on both sides.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import * as qr from '../assets/js/core/qr.js';

/** Format-information bit positions, most significant bit first. */
const FORMAT_COORDS = [
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [8, 7], [8, 8], [7, 8],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
];

/** 2-bit ECC indicator -> level name (ISO/IEC 18004 table 25). */
const ECC_BY_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

/** Reference matrix from the `qrcode` package as an array of "1"/"0" rows. */
function referenceMatrix(text, ecc) {
  const code = QRCode.create(text, { errorCorrectionLevel: ecc });
  const size = code.modules.size;
  const rows = [];
  for (let r = 0; r < size; r++) {
    let row = '';
    for (let c = 0; c < size; c++) row += code.modules.get(r, c) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}

/** Read the format information out of a matrix (MSB first, then unmask). */
function readFormat(rows) {
  let bits = 0;
  for (const [r, c] of FORMAT_COORDS) bits = (bits << 1) | (rows[r][c] === '1' ? 1 : 0);
  // bits = 15-bit BCH code; unmasking yields (5-bit data << 10) | BCH remainder.
  const field = bits ^ 0x5412;
  const data = field >> 10;
  return { raw: bits, field, data, eccBits: (data >> 3) & 3, ecc: ECC_BY_BITS[(data >> 3) & 3], mask: data & 7 };
}

/** Byte-mode-only payload (lowercase letters can never use alphanumeric mode). */
function bytePayload(length) {
  return Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
}

/** Payload lengths that cover versions 1-10 for each ECC level. */
const PAYLOAD_LENGTHS = {
  L: [5, 12, 20, 28, 35, 45, 52, 65, 80, 95, 110, 130, 150, 170, 200, 230, 260],
  M: [5, 12, 20, 28, 35, 45, 52, 65, 80, 95, 110, 130, 150, 175, 200],
  Q: [5, 12, 20, 28, 35, 45, 52, 65, 80, 95, 110, 125, 145],
  H: [5, 10, 14, 20, 25, 30, 40, 50, 60, 70, 80, 95, 110]
};

const matrixOf = (modules) => modules.map((row) => row.join('')).join('\n');


test('qrEncode matches the qrcode reference for every version 1-10 and ECC level', () => {
  const covered = { L: new Set(), M: new Set(), Q: new Set(), H: new Set() };
  let cases = 0;
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    for (const length of PAYLOAD_LENGTHS[ecc]) {
      const text = bytePayload(length);
      const ref = referenceMatrix(text, ecc);
      const version = (ref.length - 17) / 4;
      assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `reference version out of range for ${ecc}/${length}: ${version}`);
      covered[ecc].add(version);

      const fmt = readFormat(ref);
      assert.equal(fmt.ecc, ecc, `format bits must report the requested ECC level (${ecc}/${length})`);
      assert.ok(fmt.mask >= 0 && fmt.mask <= 7, `format bits must report a mask 0-7 (${ecc}/${length})`);
      assert.equal(fmt.raw, qr.formatBits(fmt.ecc, fmt.mask), `format bits round trip (${ecc}/${length})`);

      const mine = qr.qrEncode(text, { ecc: fmt.ecc, mask: fmt.mask });
      assert.equal(mine.version, version, `version must match the reference (${ecc}/${length})`);
      assert.equal(mine.size, ref.length, `matrix size must match the reference (${ecc}/${length})`);
      assert.equal(matrixOf(mine.modules), ref.join('\n'), `matrix must match the reference exactly (${ecc}/${length}, v${version}, mask ${fmt.mask})`);
      assert.equal(mine.mask, fmt.mask);
      cases++;
    }
  }
  assert.ok(cases >= 55, `expected a broad sweep, ran ${cases} cases`);
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    for (let v = 1; v <= 10; v++) {
      assert.ok(covered[ecc].has(v), `ECC ${ecc} must cover version ${v} (covered: ${[...covered[ecc]].sort((a, b) => a - b).join(',')})`);
    }
  }
});

test('qrEncode picks the smallest fitting version and its own mask', () => {
  const small = qr.qrEncode('arsin');
  assert.equal(small.version, 1);
  assert.equal(small.size, 21);
  assert.ok(small.mask >= 0 && small.mask <= 7);
  assert.equal(small.modules.length, 21);
  assert.ok(small.modules.every((row) => row.length === 21));
  assert.ok(small.modules.every((row) => row.every((v) => v === 0 || v === 1)));
  assert.equal(small.text, 'arsin');
  assert.equal(small.forced, undefined);

  // The chosen mask/ECC must round trip through the format information.
  const fmt = readFormat(small.modules.map((row) => row.join('')));
  assert.equal(fmt.ecc, small.ecc);
  assert.equal(fmt.mask, small.mask);
  assert.equal(fmt.raw, qr.formatBits(small.ecc, small.mask));

  const forced = qr.qrEncode('arsin', { ecc: 'H', mask: 3 });
  assert.equal(forced.mask, 3);
  assert.equal(forced.ecc, 'H');
  assert.equal(forced.forced, true);
  assert.equal(readFormat(forced.modules.map((row) => row.join(''))).mask, 3);
});

test('rsEncode reproduces the published "HELLO WORLD" version 1-M ECC vector', () => {
  const data = [0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec];
  const expected = [0xbc, 0x2a, 0x90, 0x13, 0x6b, 0xaf, 0xef, 0xfd, 0x4b, 0xe0];
  assert.deepEqual(qr.rsEncode(data, 10), expected);
  assert.equal(qr.rsEncode(data, 10).length, 10);
  // All-zero data produces all-zero ECC; the generator polynomial degree is respected.
  assert.deepEqual(qr.rsEncode(new Array(16).fill(0), 10), new Array(10).fill(0));
  assert.equal(qr.rsEncode([1, 2, 3], 7).length, 7);
});

test('formatBits and versionBits match the published BCH values', () => {
  // ISO/IEC 18004 table 25 / annex D.
  assert.equal(qr.formatBits('M', 0), 0b101010000010010);
  assert.equal(qr.formatBits('L', 0), 0b111011111000100);
  assert.equal(qr.formatBits('Q', 0), 0b011010101011111);
  assert.equal(qr.formatBits('H', 0), 0b001011010001001);
  assert.equal(qr.formatBits('M', 5), 0b100000011001110);
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    for (let mask = 0; mask < 8; mask++) {
      const bits = qr.formatBits(ecc, mask);
      assert.ok(bits >= 0 && bits <= 0x7fff, `format bits stay in 15 bits (${ecc}/${mask})`);
      assert.equal((bits >> 10) & 0b11111, (qr.formatBits(ecc, mask) >> 10) & 0b11111);
    }
  }
  assert.equal(qr.versionBits(7), 0x07c94);
  assert.equal(qr.versionBits(8), 0x085bc);
  assert.equal(qr.versionBits(9), 0x09a99);
  assert.equal(qr.versionBits(10), 0x0a4d3);
});

test('dataCapacity and pickVersion follow the ECC table', () => {
  assert.equal(qr.dataCapacity(1, 'L'), 19);
  assert.equal(qr.dataCapacity(1, 'M'), 16);
  assert.equal(qr.dataCapacity(1, 'Q'), 13);
  assert.equal(qr.dataCapacity(1, 'H'), 9);
  assert.equal(qr.dataCapacity(10, 'L'), 274);
  assert.equal(qr.dataCapacity(10, 'M'), 216);
  assert.equal(qr.dataCapacity(10, 'Q'), 154);
  assert.equal(qr.dataCapacity(10, 'H'), 122);

  assert.equal(qr.pickVersion(17, 'L'), 1);
  assert.equal(qr.pickVersion(18, 'L'), 2);
  assert.equal(qr.pickVersion(14, 'M'), 1);
  assert.equal(qr.pickVersion(15, 'M'), 2);
  assert.equal(qr.pickVersion(11, 'Q'), 1);
  assert.equal(qr.pickVersion(12, 'Q'), 2);
  assert.equal(qr.pickVersion(7, 'H'), 1);
  assert.equal(qr.pickVersion(8, 'H'), 2);
  assert.equal(qr.pickVersion(1, 'M'), 1);
  assert.throws(() => qr.pickVersion(400, 'H'), /payload too large/);
  assert.throws(() => qr.qrEncode(bytePayload(400), { ecc: 'H' }), /payload too large/);
});

test('qrRows returns one "1"/"0" row string per module row', () => {
  const rows = qr.qrRows('hello world');
  assert.equal(rows.length, 21);
  assert.ok(rows.every((r) => r.length === 21));
  assert.ok(rows.every((r) => /^[01]{21}$/.test(r)));
  const enc = qr.qrEncode('hello world');
  assert.deepEqual(rows, enc.modules.map((row) => row.join('')));
  assert.equal(rows.join('\n'), matrixOf(qr.qrEncode('hello world').modules));
});

test('qrDebug exposes the codeword stream and the reserved-module map', () => {
  const dbg = qr.qrDebug('A', { ecc: 'M', version: 1 });
  assert.equal(dbg.version, 1);
  assert.equal(dbg.ecc, 'M');
  assert.equal(dbg.size, 21);
  // v1-M: 16 data codewords + 10 ECC codewords in a single block.
  assert.equal(dbg.codewords.length, 26);
  assert.equal(dbg.codewordBits.length, 26 * 8);
  // mode 0100 + 8-bit count 1 + byte 0x41 + 4-bit terminator, then 0xEC/0x11 padding.
  assert.deepEqual(dbg.codewords.slice(0, 6), [0x40, 0x14, 0x10, 0xec, 0x11, 0xec]);
  assert.equal(dbg.codewordBits.slice(0, 32), '01000000000101000001000011101100');
  assert.equal(dbg.reserved.length, 21);
  assert.ok(dbg.reserved.every((row) => row.length === 21));
  // Function patterns are reserved, data modules are not.
  assert.equal(dbg.reserved[0][0], 1, 'finder pattern is reserved');
  assert.equal(dbg.reserved[6][6], 1, 'timing pattern is reserved');
  assert.equal(dbg.reserved[20][8], 1, 'dark module is reserved');
  assert.equal(dbg.reserved[10][10], 0, 'data area is free');
  // The reserved area must cover the full function-pattern footprint.
  const reservedCount = dbg.reserved.flat().reduce((a, b) => a + b, 0);
  assert.ok(reservedCount > 200 && reservedCount < 441, `reserved modules: ${reservedCount}`);
});

test('qrDebug reserves the version information blocks for versions 7 and above', () => {
  const dbg = qr.qrDebug(bytePayload(200), { ecc: 'L' });
  assert.ok(dbg.version >= 7, `payload should need version 7+ (got ${dbg.version})`);
  const size = dbg.size;
  // Version information occupies a 6x3 block next to each finder pattern.
  assert.equal(dbg.reserved[size - 11][0], 1);
  assert.equal(dbg.reserved[0][size - 11], 1);
  assert.equal(dbg.reserved[size - 9][2], 1);
});

test('every mask 0-7 produces a distinct, well-formed matrix', () => {
  const seen = new Set();
  for (let mask = 0; mask < 8; mask++) {
    const enc = qr.qrEncode('arsin-print-server', { ecc: 'Q', mask });
    const key = matrixOf(enc.modules);
    assert.equal(key.length, enc.size * (enc.size + 1) - 1);
    assert.ok(!seen.has(key), `mask ${mask} must differ from the other masks`);
    seen.add(key);
    assert.equal(readFormat(enc.modules.map((r) => r.join(''))).mask, mask);
  }
  assert.equal(seen.size, 8);
});

