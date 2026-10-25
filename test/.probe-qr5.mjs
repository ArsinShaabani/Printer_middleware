import QRCode from 'qrcode';
const FORMAT_COORDS=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
const ECC_BY_BITS={1:'L',0:'M',3:'Q',2:'H'};
function ref(text,ecc){const code=QRCode.create(text,{errorCorrectionLevel:ecc});const size=code.modules.size;const rows=[];for(let r=0;r<size;r++){let s='';for(let c=0;c<size;c++)s+=code.modules.get(r,c)?'1':'0';rows.push(s);}return rows;}
function read(rows){let bits=0;for(const [r,c] of FORMAT_COORDS)bits=(bits<<1)|(rows[r][c]==='1'?1:0);const data=bits^0x5412;return {raw:bits,data,ecc:ECC_BY_BITS[(data>>3)&3],mask:data&7};}
const text='abcde';
for (const ecc of ['L','M','Q','H']) { const rows=ref(text,ecc); const f=read(rows); console.log('req',ecc,'size',rows.length,'read',JSON.stringify(f)); }
console.log('--- order: ecc outer, lengths inner');
for (const ecc of ['L','M','Q','H']) { for (const n of [5,12]) { const t=Array.from({length:n},(_,i)=>String.fromCharCode(97+(i%26))).join(''); const f=read(ref(t,ecc)); console.log(ecc,n,f.ecc,f.mask); } }
