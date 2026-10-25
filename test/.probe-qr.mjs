import QRCode from 'qrcode';
import { qrEncode } from '../assets/js/core/qr.js';

function refMatrix(text, ecc) {
  const qr = QRCode.create(text, { errorCorrectionLevel: ecc });
  const size = qr.modules.size;
  const rows = [];
  for (let r = 0; r < size; r++) {
    let s = '';
    for (let c = 0; c < size; c++) s += qr.modules.get(r, c) ? '1' : '0';
    rows.push(s);
  }
  return rows;
}
function readFormat(rows) {
  let bits = 0;
  const at = (r,c) => rows[r][c] === '1' ? 1 : 0;
  const seq = [];
  for (let i=0;i<=5;i++) seq.push([8,i]);
  seq.push([8,7]); seq.push([8,8]); seq.push([7,8]);
  for (let i=5;i>=0;i--) seq.push([i,8]);
  for (const [r,c] of seq) bits = (bits<<1) | at(r,c);
  const data = bits ^ 0x5412;
  return { raw: bits, data, eccBits: (data>>3)&3, mask: data & 7 };
}
const ECC_BY_BITS = {1:'L',0:'M',3:'Q',2:'H'};
let fail=0, pass=0;
for (const ecc of ['L','M','Q','H']) {
  for (const n of [5,12,22,33,42,60,92,130,152,175]) {
    const text = Array.from({length:n},(_,i)=>String.fromCharCode(97+(i%26))).join('');
    const rows = refMatrix(text, ecc);
    const f = readFormat(rows);
    const mine = qrEncode(text, { ecc: ECC_BY_BITS[f.eccBits], mask: f.mask });
    const same = mine.modules.map(r=>r.join('')).join('\n') === rows.join('\n');
    if (same) pass++; else { fail++; console.log('DIFF', ecc, n, 'v'+(rows.length-17)/4, 'fmt-ecc='+ECC_BY_BITS[f.eccBits], 'mask='+f.mask); }
  }
}
console.log('pass',pass,'fail',fail);
