import QRCode from 'qrcode';
import { qrEncode, formatBits } from '../assets/js/core/qr.js';
function refMatrix(text, ecc) {
  const qr = QRCode.create(text, { errorCorrectionLevel: ecc });
  const size = qr.modules.size;
  const rows = [];
  for (let r = 0; r < size; r++) { let s=''; for (let c=0;c<size;c++) s += qr.modules.get(r,c)?'1':'0'; rows.push(s); }
  return rows;
}
function read(rows){ let bits=0; const seq=[]; for(let i=0;i<=5;i++)seq.push([8,i]); seq.push([8,7],[8,8],[7,8]); for(let i=5;i>=0;i--)seq.push([i,8]); for(const [r,c] of seq) bits=(bits<<1)|(rows[r][c]==='1'?1:0); return bits; }
for (const n of [5,12,22]) {
  const text = Array.from({length:n},(_,i)=>String.fromCharCode(97+(i%26))).join('');
  for (const ecc of ['L','M','Q','H']) {
    const rows = refMatrix(text, ecc);
    const raw = read(rows);
    let match = null;
    for (const e of ['L','M','Q','H']) for (let m=0;m<8;m++) if (formatBits(e,m)===raw) match = e+'/'+m;
    const mine = qrEncode(text, { ecc, mask: match ? Number(match.split('/')[1]) : 0 });
    const same = mine.modules.map(r=>r.join('')).join('\n') === rows.join('\n');
    console.log(`n=${n} req=${ecc} v=${(rows.length-17)/4} read=${match} same=${same} (raw=${raw.toString(2).padStart(15,'0')})`);
  }
}
