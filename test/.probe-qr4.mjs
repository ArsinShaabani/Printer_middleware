import QRCode from 'qrcode';
import { qrEncode, formatBits, dataCapacity } from '../assets/js/core/qr.js';
function refMatrix(text, ecc) {
  const qr = QRCode.create(text, { errorCorrectionLevel: ecc });
  const size = qr.modules.size; const rows=[];
  for (let r=0;r<size;r++){let s='';for(let c=0;c<size;c++)s+=qr.modules.get(r,c)?'1':'0';rows.push(s);}
  return rows;
}
function read(rows){let bits=0;const seq=[];for(let i=0;i<=5;i++)seq.push([8,i]);seq.push([8,7],[8,8],[7,8]);for(let i=5;i>=0;i--)seq.push([i,8]);for(const [r,c] of seq)bits=(bits<<1)|(rows[r][c]==='1'?1:0);return bits;}
const LEN = { L:[5,12,20,28,35,45,52,65,80,95,110,130,150,170,200,230,265], M:[5,12,20,28,35,45,52,65,80,95,110,130,150,175,200], Q:[5,12,20,28,35,45,52,65,80,95,110,125,145,160], H:[5,10,14,20,25,30,40,50,60,70,80,95,110,120] };
let pass=0, fail=0; const versions={L:new Set(),M:new Set(),Q:new Set(),H:new Set()};
for (const ecc of ['L','M','Q','H']) {
  for (const n of LEN[ecc]) {
    const text = Array.from({length:n},(_,i)=>String.fromCharCode(97+(i%26))).join('');
    const rows = refMatrix(text, ecc);
    const v = (rows.length-17)/4; versions[ecc].add(v);
    const raw = read(rows);
    let match=null;
    for (const e of ['L','M','Q','H']) for(let m=0;m<8;m++) if(formatBits(e,m)===raw) match={e,m};
    if (!match) { fail++; console.log('no format match', ecc, n); continue; }
    let mine;
    try { mine = qrEncode(text, { ecc: match.e, mask: match.m }); } catch(e){ fail++; console.log('throw',ecc,n,e.message); continue; }
    const same = mine.modules.map(r=>r.join('')).join('\n') === rows.join('\n');
    if (same && mine.version===v && match.e===ecc) pass++; else { fail++; console.log('MISMATCH', ecc, n, 'v'+v, 'mine v'+mine.version, 'detected', match.e+'/'+match.m, 'same='+same); }
  }
}
console.log('pass',pass,'fail',fail);
for (const e of ['L','M','Q','H']) console.log(e, 'versions', [...versions[e]].sort((a,b)=>a-b).join(','));
