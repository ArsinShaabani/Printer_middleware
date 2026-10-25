import bwipjs from 'bwip-js';
import { qrEncode } from '../assets/js/core/qr.js';

// Read the format information (first copy) exactly as ISO 18004 places it:
// most significant bit first, (8,0)..(8,5),(8,7),(8,8),(7,8),(5,8)..(0,8).
const readFormat = (at) => {
  const pos = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  let s = '';
  for (const [r, c] of pos) s += at(r, c);
  const value = parseInt(s, 2) ^ 0x5412;
  const eccBits = (value >> 13) & 3;
  return { ecc: { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[eccBits], mask: (value >> 10) & 7, value };
};

const cases = [];
for (const ecc of ['L', 'M', 'Q', 'H']) {
  for (const n of [5, 12, 22, 33, 42, 60, 92]) {
    cases.push([Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''), ecc]);
  }
}

let pass = 0;
const fails = [];
for (const [text, ecc] of cases) {
  const r = bwipjs.raw('qrcode', text, { scale: 1, eclevel: ecc })[0];
  const size = r.pixx;
  const at = (row, col) => r.pixs[row * size + col];
  const fmt = readFormat(at);
  let rows = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) rows += at(y, x);
  }
  let mine = '';
  try {
    mine = qrEncode(text, { ecc: fmt.ecc, mask: fmt.mask }).modules.map((row) => row.join('')).join('');
  } catch (e) {
    fails.push(`${text.length}/${ecc}: ${e.message}`);
    continue;
  }
  if (mine === rows) pass++;
  else fails.push(`len=${text.length} requested=${ecc} bwipUsed=${fmt.ecc} mask=${fmt.mask} v${(size - 17) / 4}`);
}
console.log(`${pass} / ${cases.length} match exactly (ecc + mask taken from the reference matrix)`);
if (fails.length) console.log('failures:', fails.join(' | '));
