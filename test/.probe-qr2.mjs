import QRCode from 'qrcode';
import { qrEncode, formatBits } from '../assets/js/core/qr.js';

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
function readBits(rows, coords) {
  let bits = 0;
  for (const [r,c] of coords) bits = (bits<<1) | (rows[r][c]==='1'?1:0);
  return bits;
}
const coordsA = [];
for (let i=0;i<=5;i++) coordsA.push([8,i]);
coordsA.push([8,7],[8,8],[7,8]);
for (let i=5;i>=0;i--) coordsA.push([i,8]);
// alternate: interpret first coordinate as col
const coordsB = coordsA.map(([r,c])=>[c,r]);

const text = 'abcdefghijkl';
for (const ecc of ['L','M','Q','H']) {
  const rows = refMatrix(text, ecc);
  const a = readBits(rows, coordsA);
  const b = readBits(rows, coordsB);
  let matchA = null, matchB = null;
  for (const e of ['L','M','Q','H']) for (let m=0;m<8;m++) {
    const fb = formatBits(e,m);
    if (fb === a) matchA = e+'/'+m;
    if (fb === b) matchB = e+'/'+m;
  }
  console.log(ecc, 'A(raw)='+a.toString(2).padStart(15,'0'), matchA, '| B='+b.toString(2).padStart(15,'0'), matchB, '| expected fb='+formatBits(ecc,0).toString(2).padStart(15,'0'));
}
