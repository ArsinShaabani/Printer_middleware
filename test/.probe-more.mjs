import bwipjs from 'bwip-js';
import * as bc from '../assets/js/core/barcode.js';
import { rsEncode, qrRows, qrEncode, formatBits, dataCapacity, pickVersion } from '../assets/js/core/qr.js';
const w = (p) => { let o=''; for (let i=0;i<p.length;i++) o += (i%2===0?'1':'0').repeat(+p[i]); return o; };
const ref = (sym,text,opts={}) => w(bwipjs.raw(sym,text,opts)[0].sbs);
const norm = (s) => s.replace(/[01]+$/,'');
const cmp = (l,m,r,exact=false) => {
  const ok = exact ? m===r : (norm(m)===norm(r) && Math.abs(m.length-r.length)<=1);
  if(!ok) console.log('FAIL',l,'mine',m.length,'ref',r.length,'\n mine:',m.slice(-50),'\n ref :',r.slice(-50));
  return ok;
};
let ok=true;
ok &= cmp('c128 1234', bc.code128('1234').modules, ref('code128','1234'), true);
ok &= cmp('c128 A1B2C3', bc.code128('A1B2C3').modules, ref('code128','A1B2C3'), true);
ok &= cmp('c128 123456789012', bc.code128('123456789012').modules, ref('code128','123456789012'), true);
ok &= cmp('c39 AB', bc.code39('AB').modules, ref('code39','AB'));
ok &= cmp('c39 12345', bc.code39('12345').modules, ref('code39','12345'));
ok &= cmp('c39 ARSIN-PS', bc.code39('ARSIN-PS').modules, ref('code39','ARSIN-PS'));
ok &= cmp('c39 SP $/+%', bc.code39('A B$/+%').modules, ref('code39','A B$/+%'));
ok &= cmp('itf 1234', bc.itf('1234').modules, ref('interleaved2of5','1234'));
ok &= cmp('itf 123456', bc.itf('123456').modules, ref('interleaved2of5','123456'));
ok &= cmp('itf 123', bc.itf('123').modules, ref('interleaved2of5','0123'));
ok &= cmp('ean13', bc.ean13('4006381333931').modules, ref('ean13','4006381333931'), true);
ok &= cmp('ean13b', bc.ean13('9780306406157').modules, ref('ean13','9780306406157'), true);
ok &= cmp('ean8', bc.ean8('9638507').modules, ref('ean8','9638507'), true);
ok &= cmp('ean8b', bc.ean8('1234567').modules, ref('ean8','1234567'), true);
ok &= cmp('upca', bc.upca('12345678901').modules, ref('upca','12345678901'), true);
ok &= cmp('upca2', bc.upca('03600029145').modules, ref('upca','03600029145'), true);
ok &= cmp('codabar A123A', bc.codabar('A123A').modules, ref('rationalizedCodabar','A123A'));
ok &= cmp('codabar 40156', bc.codabar('40156').modules, ref('rationalizedCodabar','A40156A'));
ok &= cmp('codabar B12.5D', bc.codabar('B12.5D').modules, ref('rationalizedCodabar','B12.5D'));
// code93 full ascii
for (const t of ['0','A','HELLO','a','Z9','ab-c']) {
  const mine = bc.code93(t).modules, r = ref('code93', t);
  console.log('c93', JSON.stringify(t), norm(mine)===norm(r) ? 'OK' : 'DIFF', mine.length, r.length);
  if (norm(mine)!==norm(r)) { console.log(' mine', mine); console.log(' ref ', r); }
}
// rsEncode vector
const data = [0x40,0xD2,0x75,0x47,0x76,0x17,0x32,0x06,0x27,0x26,0x96,0xC6,0xC6,0x96,0x70,0xEC];
const ecc = rsEncode(data, 10).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
console.log('rsEncode:', ecc, ecc==='BC 2A 90 13 6B AF EF FD 4B E0' ? 'OK':'FAIL');
console.log('qrRows hello:', qrRows('hello world').length);
console.log('all 1D', ok);
