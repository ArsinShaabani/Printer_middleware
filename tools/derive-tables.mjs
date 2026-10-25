/**
 * Derive reference barcode tables from bwip-js (dev-only helper).
 *
 * Used to validate / regenerate the static pattern tables in
 * assets/js/core/barcode.js. Run:  node tools/derive-tables.mjs
 */
import bwipjs from 'bwip-js';

function sbs(sym, text) {
  const r = bwipjs.raw(sym, text, { includetext: false });
  return r[0].sbs;
}

function widthsToModules(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) out += (i % 2 === 0 ? '1' : '0').repeat(Number(pattern[i]));
  return out;
}

const chars39 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
console.log('// Code 39 (9 elements per char, 1 = wide)');
const t39 = {};
for (const c of chars39) {
  const p = sbs('code39', c);
  const mid = p.slice(1, p.length - 1); // strip start/stop '*'
  t39[c] = mid.join('');
}
console.log(JSON.stringify(t39));

console.log('\n// Code 93 (9 modules per char)');
const chars93 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const t93 = {};
for (const c of chars93) {
  const p = widthsToModules(sbs('code93', c));
  // code93 = start(9) + data(9) + check1(9) + check2(9) + stop(9) + term bar(1)
  t93[c] = p.slice(9, 18);
}
console.log(JSON.stringify(t93));
console.log('// start/stop pattern:', widthsToModules(sbs('code93', '0')).slice(0, 9), widthsToModules(sbs('code93', '0')).slice(-10));

console.log('\n// Codabar (7 elements per char, 1 = wide)');
const charsCoda = '0123456789-$:/.+';
const tc = {};
for (const c of charsCoda) {
  const p = sbs('rationalizedCodabar', `A${c}A`);
  tc[c] = p.slice(1, 8).join('');
}
console.log(JSON.stringify(tc));
console.log('// codabar A guard:', sbs('rationalizedCodabar', 'A1A').slice(0, 7).join(''));

console.log('\n// ITF patterns (5 elements per digit)');
const ti = {};
for (let d = 0; d <= 9; d++) {
  const p = sbs('interleaved2of5', `${d}${d}`);
  ti[d] = p.slice(2, 7).join(''); // skip start '1010'
}
console.log(JSON.stringify(ti));
console.log('// itf start/stop:', sbs('interleaved2of5', '12').slice(0, 2).join(''), sbs('interleaved2of5', '12').slice(-3).join(''));

console.log('\n// Code128 reference module strings');
for (const s of ['ARSIN128', '1234', 'A1B2C3D4E5']) {
  console.log(s, widthsToModules(sbs('code128', s)).length);
}
