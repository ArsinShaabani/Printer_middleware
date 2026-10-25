/**
 * Arsin Print Server - barcode encoders (pure).
 *
 * Every encoder returns the same structure so the label designer, the ZPL /
 * ESC/POS / TSPL renderers and the unit tests can treat them uniformly:
 *
 *   { symbology, text, modules, width, humanReadable }
 *
 * `modules` is a string of "1" (bar) and "0" (space) at module resolution,
 * starting and ending with a bar. Quiet zones are added by the renderers.
 */

const CODE128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

/** Code 39: 9 elements per character, 1 = wide element. */
const CODE39 = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
  '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
  A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000',
  F: '001011000', G: '000001101', H: '100001100', I: '001001100', J: '000011100',
  K: '100000011', L: '001000011', M: '101000010', N: '000010011', O: '100010010',
  P: '001010010', Q: '000000111', R: '100000110', S: '001000110', T: '000010110',
  U: '110000001', V: '011000001', W: '111000000', X: '010010001', Y: '110010000',
  Z: '011010000', '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100'
};

/** Code 93: 9 modules per character (3 bars + 3 spaces). */
const CODE93 = {
  '0': '100010100', '1': '101001000', '2': '101000100', '3': '101000010', '4': '100101000',
  '5': '100100100', '6': '100100010', '7': '101010000', '8': '100010010', '9': '100001010',
  A: '110101000', B: '110100100', C: '110100010', D: '110010100', E: '110010010',
  F: '110001010', G: '101101000', H: '101100100', I: '101100010', J: '100110100',
  K: '100011010', L: '101011000', M: '101001100', N: '101000110', O: '100101100',
  P: '100010110', Q: '110110100', R: '110110010', S: '110101100', T: '110100110',
  U: '110010110', V: '110011010', W: '101101100', X: '101100110', Y: '100110110',
  Z: '100111010', '-': '100101110', '.': '111010100', ' ': '111010010', '$': '111001010',
  '/': '101101110', '+': '101110110', '%': '110101110'
};
const CODE93_START = '101011110';
const CODE93_TERM = '1';
/** Full ASCII shift characters (a)-(d), values 43-46. */
const CODE93_SHIFT_PATTERN = ['111010110', '100110010', '110110010', '110101100'];

/** Interleaved 2 of 5: each digit is 5 elements (2 wide). */
const ITF = { '0': '00110', '1': '10001', '2': '01001', '3': '11000', '4': '00101', '5': '10100', '6': '01100', '7': '00011', '8': '10010', '9': '01010' };

/** Codabar: 7 elements per character, 1 = wide. */
const CODABAR = {
  '0': '0000011', '1': '0000110', '2': '0001001', '3': '1100000', '4': '0010010', '5': '1000010',
  '6': '0100001', '7': '0100100', '8': '0110000', '9': '1001000', '-': '0001100', '$': '0011000',
  ':': '1000101', '/': '1010001', '.': '1010100', '+': '0011101', A: '0011010', B: '0101001',
  C: '0001011', D: '0001110'
};

/** EAN / UPC digit sets. */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export const SYMBOLOGIES = [
  { id: 'code128', name: 'Code 128', kind: '1d', chars: 'Any ASCII (auto subset B/C)', printer: { escpos: 0x49, zpl: 'BC', tspl: '128' } },
  { id: 'code39', name: 'Code 39', kind: '1d', chars: '0-9 A-Z - . space $ / + %', printer: { escpos: 0x04, zpl: 'B3', tspl: '39' } },
  { id: 'code93', name: 'Code 93', kind: '1d', chars: 'ASCII with full-ASCII extension', printer: { escpos: 0x48, zpl: 'B9', tspl: '93' } },
  { id: 'itf', name: 'ITF / Interleaved 2 of 5', kind: '1d', chars: 'Even number of digits', printer: { escpos: 0x05, zpl: 'B2', tspl: 'ITF' } },
  { id: 'ean13', name: 'EAN-13', kind: '1d', chars: '12 or 13 digits', printer: { escpos: 0x02, zpl: 'BE', tspl: 'EAN13' } },
  { id: 'ean8', name: 'EAN-8', kind: '1d', chars: '7 or 8 digits', printer: { escpos: 0x03, zpl: 'B8', tspl: 'EAN8' } },
  { id: 'upca', name: 'UPC-A', kind: '1d', chars: '11 or 12 digits', printer: { escpos: 0x00, zpl: 'BU', tspl: 'UPCA' } },
  { id: 'codabar', name: 'Codabar', kind: '1d', chars: '0-9 - $ : / . + and A-D guards', printer: { escpos: 0x06, zpl: 'BK', tspl: 'CODA' } },
  { id: 'qr', name: 'QR Code', kind: '2d', chars: 'Any text / URL / UTF-8', printer: { escpos: 0x31, zpl: 'BQ', tspl: 'QRCODE' } },
  { id: 'datamatrix', name: 'Data Matrix', kind: '2d', chars: 'Any text (ECC200)', printer: { zpl: 'BX', tspl: 'DMATRIX' } },
  { id: 'pdf417', name: 'PDF417', kind: '2d', chars: 'Any text', printer: { zpl: 'B7', tspl: 'PDF417' } }
];

export const SYMBOLOGY_BY_ID = Object.fromEntries(SYMBOLOGIES.map((s) => [s.id, s]));

function widthsToModules(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) out += (i % 2 === 0 ? '1' : '0').repeat(Number(pattern[i]));
  return out;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function modStr(bits) {
  return Array.isArray(bits) ? bits.join('') : String(bits);
}

function patternToModules(pattern, ratio) {
  const wide = ratio || 3;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const w = pattern[i] === '1' ? wide : 1;
    out += (i % 2 === 0 ? '1' : '0').repeat(w);
  }
  return out;
}

/* --------------------------------------------------------------- Code 128 --- */

export function code128(data, opts = {}) {
  const s = String(data);
  assert(s.length > 0, 'Code 128 needs data');
  const codes = [];
  let mode;
  let i = 0;
  const digitsAt = (idx) => {
    let n = 0;
    while (n < 6 && idx + n < s.length && /[0-9]/.test(s[idx + n])) n++;
    return n;
  };
  const lead = digitsAt(0);
  if (opts.forceC || (lead >= 4 && lead % 2 === 0) || (lead >= 6 && s.length - lead <= 2)) {
    mode = 'C';
    codes.push(105);
  } else {
    mode = 'B';
    codes.push(104);
  }
  while (i < s.length) {
    if (mode === 'B') {
      const run = digitsAt(i);
      const rest = s.length - i;
      if (run >= 6 || (run >= 4 && run % 2 === 0 && run === rest)) {
        codes.push(99); // switch to subset C
        mode = 'C';
        continue;
      }
      const code = s.charCodeAt(i);
      assert(code >= 32 && code <= 126, `Code 128 subset B cannot encode "${s[i]}"`);
      codes.push(code - 32);
      i++;
    } else {
      if (i + 1 >= s.length || !/^[0-9]{2}$/.test(s.substr(i, 2))) {
        codes.push(100); // switch back to subset B
        mode = 'B';
        continue;
      }
      codes.push(Number(s.substr(i, 2)));
      i += 2;
    }
  }
  let sum = codes[0];
  for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
  const check = sum % 103;
  const full = [...codes, check, 106];
  const modules = full.map((c) => widthsToModules(CODE128[c])).join('');
  return {
    symbology: 'code128',
    text: s,
    modules,
    width: modules.length,
    humanReadable: s,
    checksum: check,
    codewords: [...codes, check]
  };
}

/* ---------------------------------------------------------------- Code 39 --- */

export function code39(data, opts = {}) {
  const raw = String(data);
  const s = raw.toUpperCase();
  assert(/^[0-9A-Z\-. $/+%]+$/.test(s), 'Code 39 accepts 0-9, A-Z, - . space $ / + %');
  const ratio = opts.ratio || 3;
  const chars = ['*', ...s.split(''), '*'];
  const parts = chars.map((c) => patternToModules(CODE39[c], ratio));
  const modules = parts.join('0'); // narrow inter-character gap
  return { symbology: 'code39', text: raw, modules, width: modules.length, humanReadable: raw, ratio };
}

/* ---------------------------------------------------------------- Code 93 --- */

const CODE93_VALUE = (() => {
  const map = {};
  '0123456789'.split('').forEach((c, i) => (map[c] = i));
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => (map[c] = 10 + i));
  map['-'] = 36; map['.'] = 37; map[' '] = 38; map['$'] = 39; map['/'] = 40; map['+'] = 41; map['%'] = 42;
  return map;
})();

/**
 * Full-ASCII -> Code 93 mapping. Shift markers are the letters a/b/c/d which
 * stand for the four shift characters (values 43-46); '%', '/' and '+' are
 * ordinary base characters used as prefixes by the standard table.
 */
const CODE93_ASCII = (() => {
  const map = {};
  for (let c = 1; c <= 26; c++) map[c] = ['a', String.fromCharCode(64 + c)];
  map[0] = ['%', 'U'];
  map[27] = ['%', 'A']; map[28] = ['%', 'B']; map[29] = ['%', 'C']; map[30] = ['%', 'D']; map[31] = ['%', 'E'];
  map[32] = [' '];
  map[33] = ['/', 'A']; map[34] = ['/', 'B']; map[35] = ['/', 'C']; map[36] = ['/', 'D']; map[37] = ['/', 'E'];
  map[38] = ['/', 'F']; map[39] = ['/', 'G']; map[40] = ['/', 'H']; map[41] = ['/', 'I']; map[42] = ['/', 'J'];
  map[43] = ['/', 'K']; map[44] = ['/', 'L']; map[45] = ['-']; map[46] = ['.']; map[47] = ['/', 'O'];
  map[58] = ['/', 'Z']; map[59] = ['%', 'F']; map[60] = ['%', 'G']; map[61] = ['%', 'H']; map[62] = ['%', 'I'];
  map[63] = ['%', 'J']; map[64] = ['%', 'V']; map[91] = ['%', 'K']; map[92] = ['%', 'L']; map[93] = ['%', 'M'];
  map[94] = ['%', 'N']; map[95] = ['%', 'O']; map[96] = ['%', 'W'];
  for (let c = 97; c <= 122; c++) map[c] = ['b', String.fromCharCode(c - 32)];
  map[123] = ['%', 'P']; map[124] = ['%', 'Q']; map[125] = ['%', 'R']; map[126] = ['%', 'S']; map[127] = ['%', 'T'];
  return map;
})();

const CODE93_SHIFT_CHAR = { 43: 'a', 44: 'b', 45: 'c', 46: 'd' };

export function code93(data, opts = {}) {
  const s = String(data);
  assert(s.length > 0, 'Code 93 needs data');
  const chars = [];
  for (const ch of s) {
    if (CODE93_VALUE[ch] != null) chars.push(ch);
    else {
      const ext = CODE93_ASCII[ch.charCodeAt(0)];
      assert(ext, `Code 93 cannot encode "${ch}"`);
      chars.push(...ext);
    }
  }
  const values = chars.map((c) => {
    if (CODE93_VALUE[c] != null) return CODE93_VALUE[c];
    const idx = ['a', 'b', 'c', 'd'].indexOf(c);
    assert(idx >= 0, `unknown Code 93 symbol "${c}"`);
    return 43 + idx;
  });
  const C = checksum93(values, 20);
  const K = checksum93([...values, C], 15);
  const seq = [...values, C, K];
  const modules = CODE93_START + seq.map((v) => (v <= 42 ? CODE93[charForValue(v)] : CODE93_SHIFT_PATTERN[v - 43])).join('') + CODE93_START + CODE93_TERM;
  return { symbology: 'code93', text: s, modules, width: modules.length, humanReadable: s, checks: [C, K] };
}

function checksum93(values, maxWeight) {
  let sum = 0;
  let weight = 1;
  for (let i = values.length - 1; i >= 0; i--) {
    sum += values[i] * weight;
    weight = weight === maxWeight ? 1 : weight + 1;
  }
  return sum % 47;
}

function charForValue(v) {
  for (const k of Object.keys(CODE93_VALUE)) if (CODE93_VALUE[k] === v) return k;
  throw new Error(`no Code 93 char for value ${v}`);
}


/* -------------------------------------------------------- ITF 2 of 5 ----- */

export function itf(data, opts = {}) {
  const s = String(data).replace(/\D/g, '');
  assert(s.length > 0, 'ITF needs digits');
  const padded = s.length % 2 === 1 ? `0${s}` : s;
  const ratio = opts.ratio || 2;
  let modules = '1010'; // narrow start
  for (let i = 0; i < padded.length; i += 2) {
    const bars = ITF[padded[i]];
    const spaces = ITF[padded[i + 1]];
    assert(bars && spaces, 'ITF accepts digits only');
    for (let k = 0; k < 5; k++) {
      modules += '1'.repeat(bars[k] === '1' ? ratio : 1);
      modules += '0'.repeat(spaces[k] === '1' ? ratio : 1);
    }
  }
  modules += '11' + '0' + '1'; // stop: wide bar, narrow space, narrow bar
  return { symbology: 'itf', text: padded, modules, width: modules.length, humanReadable: padded, ratio };
}

/* --------------------------------------------------------- EAN / UPC ------ */

export function ean13Check(digits12) {
  const d = String(digits12).replace(/\D/g, '');
  assert(d.length === 12, 'EAN-13 needs 12 digits for the check digit');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function upcCheck(digits11) {
  const d = String(digits11).replace(/\D/g, '');
  assert(d.length === 11, 'UPC-A needs 11 digits for the check digit');
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function ean8Check(digits7) {
  const d = String(digits7).replace(/\D/g, '');
  assert(d.length === 7, 'EAN-8 needs 7 digits for the check digit');
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function ean13(data) {
  const d = String(data).replace(/\D/g, '');
  assert(d.length === 12 || d.length === 13, 'EAN-13 needs 12 or 13 digits');
  const body = d.slice(0, 12);
  const check = ean13Check(body);
  assert(d.length === 12 || Number(d[12]) === check, `EAN-13 check digit should be ${check}`);
  const parity = EAN13_PARITY[Number(body[0])];
  let modules = '101';
  for (let i = 1; i < 7; i++) modules += parity[i - 1] === 'L' ? EAN_L[Number(body[i])] : EAN_G[Number(body[i])];
  modules += '01010';
  for (let i = 7; i <= 12; i++) modules += EAN_R[Number(i === 12 ? check : body[i])];
  modules += '101';
  return { symbology: 'ean13', text: body + check, modules, width: modules.length, humanReadable: `${body[0]} ${body.slice(1, 7)} ${body.slice(7)} ${check}` };
}

export function ean8(data) {
  const d = String(data).replace(/\D/g, '');
  assert(d.length === 7 || d.length === 8, 'EAN-8 needs 7 or 8 digits');
  const body = d.slice(0, 7);
  const check = ean8Check(body);
  assert(d.length === 7 || Number(d[7]) === check, `EAN-8 check digit should be ${check}`);
  let modules = '101';
  for (let i = 0; i < 4; i++) modules += EAN_L[Number(body[i])];
  modules += '01010';
  for (let i = 4; i <= 7; i++) modules += EAN_R[Number(i === 7 ? check : body[i])];
  modules += '101';
  return { symbology: 'ean8', text: body + check, modules, width: modules.length, humanReadable: `${body} ${check}` };
}

export function upca(data) {
  const d = String(data).replace(/\D/g, '');
  assert(d.length === 11 || d.length === 12, 'UPC-A needs 11 or 12 digits');
  const body = d.slice(0, 11);
  const check = upcCheck(body);
  assert(d.length === 11 || Number(d[11]) === check, `UPC-A check digit should be ${check}`);
  let modules = '101';
  for (let i = 0; i < 6; i++) modules += EAN_L[Number(body[i])];
  modules += '01010';
  for (let i = 6; i <= 11; i++) modules += EAN_R[Number(i === 11 ? check : body[i])];
  modules += '101';
  return { symbology: 'upca', text: body + check, modules, width: modules.length, humanReadable: `${body[0]} ${body.slice(1, 6)} ${body.slice(6)} ${check}` };
}

/* -------------------------------------------------------------- Codabar --- */

export function codabar(data, opts = {}) {
  let s = String(data).toUpperCase();
  assert(/^[0-9A-D\-.$:/+]+$/.test(s), 'Codabar accepts 0-9 - $ : / . + and A-D');
  if (!/^[A-D]/.test(s)) s = `A${s}`;
  if (!/[A-D]$/.test(s)) s = `${s}A`;
  const ratio = opts.ratio || 3;
  const modules = s.split('').map((c) => patternToModules(CODABAR[c], ratio)).join('0');
  return { symbology: 'codabar', text: s, modules, width: modules.length, humanReadable: s, ratio };
}

/* ------------------------------------------------------------- dispatcher -- */

/**
 * Encode a 1D barcode. 2D symbologies are rendered natively by the printer
 * commands (see label.js) and optionally previewed through qr.js.
 */
export function encodeBarcode(id, data, opts = {}) {
  switch (id) {
    case 'code128': return code128(data, opts);
    case 'code39': return code39(data, opts);
    case 'code93': return code93(data, opts);
    case 'itf': return itf(data, opts);
    case 'ean13': return ean13(data);
    case 'ean8': return ean8(data);
    case 'upca': return upca(data);
    case 'codabar': return codabar(data, opts);
    default: throw new Error(`"${id}" is a 2D symbology - it is emitted as a native printer command`);
  }
}

export function is2D(id) {
  const s = SYMBOLOGY_BY_ID[id];
  return !!s && s.kind === '2d';
}

