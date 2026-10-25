import bwipjs from 'bwip-js';
import * as bc from '../assets/js/core/barcode.js';
const w = (p) => { let o=''; for (let i=0;i<p.length;i++) o += (i%2===0?'1':'0').repeat(+p[i]); return o; };
const ref = (s,t) => w(bwipjs.raw(s,t)[0].sbs);
const norm = (s) => s.replace(/[01]+$/,'');
const exact = (l,m,r) => { if(m!==r){console.log('EXACT FAIL',l,m.length,r.length);} return m===r; };
const near = (l,m,r) => { const ok = norm(m)===norm(r) && Math.abs(m.length-r.length)<=1; if(!ok) console.log('NEAR FAIL',l,m.length,r.length); return ok; };
let ok=true;
for (const t of ['1234','A1B2C3','123456789012','ARSIN128','Hello, World!','code128','0000000000','X','AB12CD34EF','1234567890']) ok &= exact('c128 '+t, bc.code128(t).modules, ref('code128',t));
for (const t of ['AB','12345','ARSIN-PS','A B$/+%','CODE39TEST','0']) ok &= near('c39 '+t, bc.code39(t).modules, ref('code39',t));
for (const t of ['1234','123456','123','0000','9876543210']) ok &= near('itf '+t, bc.itf(t).modules, ref('interleaved2of5', t.length%2?'0'+t:t));
for (const t of ['A123A','40156','B12.5D','C1234D']) ok &= near('coda '+t, bc.codabar(t).modules, ref('rationalizedCodabar', /^[A-D]/.test(t)?t:'A'+t+'A'));
try { console.log('coda plus', bc.codabar('A1+2A').modules.length, ref('rationalizedCodabar','A1+2A').length); } catch(e){ console.log('coda plus ref error:', e.message.slice(0,60)); }
for (const t of ['4006381333931','9780306406157','5901234123457']) ok &= exact('ean13 '+t, bc.ean13(t).modules, ref('ean13',t));
for (const t of ['9638507','1234567','7351353']) ok &= exact('ean8 '+t, bc.ean8(t).modules, ref('ean8',t));
for (const t of ['12345678901','03600029145','04210000526']) ok &= exact('upca '+t, bc.upca(t).modules, ref('upca',t));
console.log('ALL', ok);
// code93 base table
const BASE='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
let t2=true;
for (const ch of BASE) { const r = ref('code93',ch); const ours = bc.code93(ch).modules; if(!(r.slice(0,9)==='101011110' && r.slice(9,18)===ours.slice(9,18) && r.slice(18)==='1010111101')) { t2=false; console.log('TBL FAIL',ch);} }
console.log('code93 table', t2);
console.log('code93 checks', bc.code93('0').checks, bc.code93('CODE93').checks);
console.log('code93 full ascii a:', bc.code93('a').modules.slice(9,18), 'shift?', bc.code93('a').modules.includes('111010110'));
console.log('encodeBarcode dispatch', bc.encodeBarcode('code39','AB').symbology, bc.encodeBarcode('ean13','4006381333931').symbology);
try { bc.encodeBarcode('qr','x'); } catch(e) { console.log('2d error:', e.message.slice(0,40)); }
console.log('ean13Check', bc.ean13Check('400638133393'), 'upcCheck', bc.upcCheck('12345678901'), 'ean8Check', bc.ean8Check('963850'));
console.log('SYMBOLOGIES', bc.SYMBOLOGIES.length, 'is2D qr', bc.is2D('qr'), 'is2D code39', bc.is2D('code39'));
console.log('code128 forceC', bc.code128('1234',{forceC:true}).codewords.join(','));
try { bc.code128('abc\u00e9'); } catch(e){ console.log('c128 non-ascii:', e.message.slice(0,50)); }
try { bc.code39('ab'); console.log('c39 lowercase ok', bc.code39('ab').text); } catch(e){ console.log('c39 lower err', e.message.slice(0,40)); }
