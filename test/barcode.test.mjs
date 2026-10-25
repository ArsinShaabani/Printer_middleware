/**
 * 1D barcode encoders - verified against the bwip-js reference implementation.
 *
 * bwip-js exposes the bar/space widths of every symbol in `raw(sym, text)[0].sbs`
 * (one digit per element, alternating bar/space). Expanding that to a module
 * string gives the same representation the core module uses, so the two can be
 * compared directly.
 *
 * The reference appends one extra trailing element for the "self checking"
 * symbologies (Code 39, ITF, Codabar), so those are compared after normalising
 * the trailing run; Code 128 / EAN-13 / EAN-8 / UPC-A must match byte for byte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bwipjs from 'bwip-js';
import * as bc from '../assets/js/core/barcode.js';

/**
 * Expand a bwip-js `sbs` width list ("212222", or [2,1,2,2,2,2] for some
 * symbologies) into a "1"/"0" module string. Element 0 is always a bar.
 */
function widthsToModules(pattern) {
  assert.ok(pattern != null, 'bwip-js returned no sbs');
  assert.ok(pattern.length > 0, 'bwip-js returned an empty sbs');
  let out = '';
  for (let i = 0; i < pattern.length; i++) out += (i % 2 === 0 ? '1' : '0').repeat(Number(pattern[i]));
  return out;
}

/** Reference module string for one symbology/payload from bwip-js. */
function reference(sym, text, opts = {}) {
  const rows = bwipjs.raw(sym, text, opts);
  assert.ok(Array.isArray(rows) && rows.length, `bwip-js returned no rows for ${sym}`);
  return widthsToModules(rows[0].sbs);
}

/** Drop the trailing run of identical modules so a one-module suffix is ignored. */
function trailingNormalised(modules) {
  return modules.replace(/[01]+$/, '');
}

function assertExact(label, mine, ref) {
  assert.equal(mine, ref, `${label}: module string must match bwip-js exactly`);
}

function assertTrailingNormalised(label, mine, ref) {
  assert.equal(trailingNormalised(mine), trailingNormalised(ref), `${label}: module string must match after trailing normalisation`);
  assert.ok(Math.abs(mine.length - ref.length) <= 1, `${label}: reference may only append one trailing element (mine ${mine.length}, ref ${ref.length})`);
}


test('Code 128 matches bwip-js exactly for numeric, alphanumeric and mixed payloads', () => {
  const payloads = ['1234', '123456789012', '1234567890', '0000000000', 'A1B2C3', 'ARSIN128', 'AB12CD34EF', 'Hello, World!', 'code128', 'X'];
  for (const text of payloads) {
    assertExact(`code128 ${JSON.stringify(text)}`, bc.code128(text).modules, reference('code128', text));
  }
});

test('Code 128 result carries the checksum and the codeword list', () => {
  const enc = bc.code128('ARSIN128');
  assert.equal(enc.symbology, 'code128');
  assert.equal(enc.text, 'ARSIN128');
  assert.equal(enc.width, enc.modules.length);
  assert.equal(enc.humanReadable, 'ARSIN128');
  assert.ok(Number.isInteger(enc.checksum) && enc.checksum >= 0 && enc.checksum < 103);
  assert.equal(enc.codewords[enc.codewords.length - 1], enc.checksum);
  assert.ok([104, 105].includes(enc.codewords[0]), 'start code is subset B (104) or subset C (105)');
});

test('Code 128 subset C is used for even runs of digits (forceC)', () => {
  const enc = bc.code128('1234', { forceC: true });
  assert.equal(enc.codewords[0], 105, 'subset C start code');
  assert.deepEqual(enc.codewords.slice(0, 3), [105, 12, 34]);
});

test('Code 128 rejects characters outside subset B and empty payloads', () => {
  assert.throws(() => bc.code128('abc\u00e9'), /subset B cannot encode/);
  assert.throws(() => bc.code128(''), /needs data/);
});

test('Code 39 matches bwip-js after trailing normalisation', () => {
  const payloads = ['AB', '0', '12345', 'ARSIN-PS', 'A B$/+%', 'CODE39TEST'];
  for (const text of payloads) {
    assertTrailingNormalised(`code39 ${JSON.stringify(text)}`, bc.code39(text).modules, reference('code39', text));
  }
  // Code 39 is case insensitive: the module pattern is the uppercased payload.
  assert.equal(bc.code39('ab').modules, bc.code39('AB').modules);
  assert.equal(bc.code39('ab').text, 'ab');
  assert.throws(() => bc.code39('a*b'), /Code 39 accepts/);
});

test('Interleaved 2 of 5 matches bwip-js (odd lengths are zero padded)', () => {
  for (const digits of ['1234', '123456', '0000', '9876543210']) {
    assertTrailingNormalised(`itf ${digits}`, bc.itf(digits).modules, reference('interleaved2of5', digits));
  }
  assertTrailingNormalised('itf 123 -> 0123', bc.itf('123').modules, reference('interleaved2of5', '0123'));
  assert.equal(bc.itf('123').text, '0123');
  assert.throws(() => bc.itf(''), /ITF needs digits/);
});

test('Codabar matches bwip-js and adds the A guards when they are missing', () => {
  for (const text of ['A123A', 'B12.5D', 'C1234D']) {
    assertTrailingNormalised(`codabar ${text}`, bc.codabar(text).modules, reference('rationalizedCodabar', text));
  }
  assertTrailingNormalised('codabar 40156', bc.codabar('40156').modules, reference('rationalizedCodabar', 'A40156A'));
  assert.equal(bc.codabar('40156').text, 'A40156A');
  assert.throws(() => bc.codabar('abc!'), /Codabar accepts/);
});


test('EAN-13 matches bwip-js exactly (including the check digit)', () => {
  for (const text of ['4006381333931', '9780306406157', '5901234123457']) {
    assertExact(`ean13 ${text}`, bc.ean13(text).modules, reference('ean13', text));
  }
  const enc = bc.ean13('400638133393');
  assert.equal(enc.text, '4006381333931');
  assert.equal(enc.humanReadable, '4 006381 33393 1');
  assert.equal(enc.width, 95);
});

test('EAN-8 matches bwip-js exactly (including the check digit)', () => {
  for (const text of ['9638507', '1234567', '7351353']) {
    assertExact(`ean8 ${text}`, bc.ean8(text).modules, reference('ean8', text));
  }
  assert.equal(bc.ean8('9638507').text, '96385074');
  assert.equal(bc.ean8('9638507').width, 67);
});

test('UPC-A matches bwip-js exactly (including the check digit)', () => {
  for (const text of ['12345678901', '03600029145', '04210000526']) {
    assertExact(`upca ${text}`, bc.upca(text).modules, reference('upca', text));
  }
  assert.equal(bc.upca('12345678901').text, '123456789012');
  assert.equal(bc.upca('12345678901').width, 95);
});

test('check digit helpers agree with the published values', () => {
  assert.equal(bc.ean13Check('400638133393'), 1);
  assert.equal(bc.ean13Check('978030640615'), 7);
  assert.equal(bc.ean8Check('9638507'), 4);
  assert.equal(bc.upcCheck('12345678901'), 2);
  assert.equal(bc.upcCheck('03600029145'), 2);
  assert.throws(() => bc.ean13Check('123'), /needs 12 digits/);
  assert.throws(() => bc.ean8Check('123456'), /needs 7 digits/);
  assert.throws(() => bc.upcCheck('123'), /needs 11 digits/);
});

test('EAN/UPC encoders reject a wrong check digit and bad lengths', () => {
  assert.throws(() => bc.ean13('4006381333932'), /check digit should be 1/);
  assert.throws(() => bc.ean13('123'), /EAN-13 needs 12 or 13 digits/);
  assert.throws(() => bc.ean8('96385070'), /check digit should be 4/);
  assert.throws(() => bc.ean8('123'), /EAN-8 needs 7 or 8 digits/);
  assert.throws(() => bc.upca('123456789013'), /check digit should be 2/);
  assert.throws(() => bc.upca('123'), /UPC-A needs 11 or 12 digits/);
});


/* ------------------------------------------------------------- Code 93 ----- */

const CODE93_BASE = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const CODE93_START = '101011110';
const CODE93_STOP_AND_TERM = '1010111101';

test('Code 93 character table matches the patterns derived from bwip-js', () => {
  // bwip-js emits start + <char> + stop + termination bar for a single character
  // (no check characters unless includecheck is requested), so the character
  // pattern is the 9-module slice in the middle.
  for (const ch of CODE93_BASE) {
    const ref = reference('code93', ch);
    assert.equal(ref.length, 28, `code93 ${JSON.stringify(ch)}: reference layout`);
    assert.equal(ref.slice(0, 9), CODE93_START, `code93 ${JSON.stringify(ch)}: start pattern`);
    assert.equal(ref.slice(18), CODE93_STOP_AND_TERM, `code93 ${JSON.stringify(ch)}: stop + termination`);
    const mine = bc.code93(ch).modules;
    assert.equal(mine.slice(0, 9), CODE93_START, `code93 ${JSON.stringify(ch)}: our start pattern`);
    assert.equal(mine.slice(9, 18), ref.slice(9, 18), `code93 ${JSON.stringify(ch)}: character pattern must equal bwip-js`);
    assert.equal(mine.slice(-10), CODE93_STOP_AND_TERM, `code93 ${JSON.stringify(ch)}: our stop + termination`);
  }
  assert.equal(CODE93_BASE.length, 43, 'Code 93 defines 43 base characters');
});

test('Code 93 wraps the payload with start/stop characters and two check characters', () => {
  const enc = bc.code93('CODE93');
  assert.equal(enc.symbology, 'code93');
  assert.equal(enc.text, 'CODE93');
  assert.equal(enc.checks.length, 2);
  assert.ok(enc.checks.every((c) => c >= 0 && c < 47));
  // start (9) + 6 chars + 2 checks (9 each) + stop + term
  assert.equal(enc.modules.length, 9 + 6 * 9 + 2 * 9 + 9 + 1);
  assert.equal(enc.width, enc.modules.length);
  assert.throws(() => bc.code93(''), /needs data/);
});

test('Code 93 full-ASCII extension uses the shift characters', () => {
  // lowercase "a" -> shift b (value 44) + "A"
  const lower = bc.code93('a').modules;
  assert.equal(lower.slice(9, 18), '100110010', 'shift b pattern for lowercase');
  assert.equal(lower.slice(18, 27), bc.code93('A').modules.slice(9, 18), 'uppercased payload character');
  // NUL is %U, "!" is /A
  assert.equal(bc.code93('\u0000').modules.slice(9, 18), bc.code93('%').modules.slice(9, 18));
  assert.equal(bc.code93('\u0000').modules.slice(18, 27), bc.code93('U').modules.slice(9, 18));
  assert.equal(bc.code93('!').modules.slice(9, 18), bc.code93('/').modules.slice(9, 18));
  assert.equal(bc.code93('!').modules.slice(18, 27), bc.code93('A').modules.slice(9, 18));
});

/* ---------------------------------------------------------- dispatcher ----- */

test('encodeBarcode dispatches 1D symbologies and rejects 2D ones', () => {
  assert.equal(bc.encodeBarcode('code128', '1234').symbology, 'code128');
  assert.equal(bc.encodeBarcode('code39', 'AB').symbology, 'code39');
  assert.equal(bc.encodeBarcode('code93', 'AB').symbology, 'code93');
  assert.equal(bc.encodeBarcode('itf', '1234').symbology, 'itf');
  assert.equal(bc.encodeBarcode('ean13', '4006381333931').symbology, 'ean13');
  assert.equal(bc.encodeBarcode('ean8', '9638507').symbology, 'ean8');
  assert.equal(bc.encodeBarcode('upca', '12345678901').symbology, 'upca');
  assert.equal(bc.encodeBarcode('codabar', 'A123A').symbology, 'codabar');
  assert.throws(() => bc.encodeBarcode('qr', 'x'), /is a 2D symbology/);
  assert.throws(() => bc.encodeBarcode('datamatrix', 'x'), /is a 2D symbology/);
  assert.throws(() => bc.encodeBarcode('nope', 'x'), /is a 2D symbology/);
});

test('SYMBOLOGIES metadata is consistent', () => {
  assert.equal(bc.SYMBOLOGIES.length, 11);
  const ids = bc.SYMBOLOGIES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'symbology ids are unique');
  for (const s of bc.SYMBOLOGIES) {
    assert.ok(['1d', '2d'].includes(s.kind), `${s.id}: kind`);
    assert.ok(s.name && s.chars, `${s.id}: name and char set`);
    assert.ok(s.printer && typeof s.printer === 'object', `${s.id}: printer commands`);
  }
  assert.equal(bc.SYMBOLOGY_BY_ID.code128.printer.escpos, 0x49);
  assert.equal(bc.SYMBOLOGY_BY_ID.qr.printer.zpl, 'BQ');
  assert.equal(bc.is2D('qr'), true);
  assert.equal(bc.is2D('datamatrix'), true);
  assert.equal(bc.is2D('code39'), false);
  assert.equal(bc.is2D('nope'), false);
});

test('every encoder returns a module string that starts and ends with a bar', () => {
  const encoders = [
    bc.code128('ARSIN128'),
    bc.code39('AB'),
    bc.code93('AB'),
    bc.itf('1234'),
    bc.ean13('4006381333931'),
    bc.ean8('9638507'),
    bc.upca('12345678901'),
    bc.codabar('A123A')
  ];
  for (const enc of encoders) {
    assert.match(enc.modules, /^[01]+$/, `${enc.symbology}: module alphabet`);
    assert.equal(enc.modules[0], '1', `${enc.symbology}: starts with a bar`);
    assert.equal(enc.modules[enc.modules.length - 1], '1', `${enc.symbology}: ends with a bar`);
    assert.equal(enc.width, enc.modules.length, `${enc.symbology}: width`);
    assert.equal(typeof enc.humanReadable, 'string');
  }
});
