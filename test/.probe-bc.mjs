import bwipjs from 'bwip-js';
import * as bc from '../assets/js/core/barcode.js';
const w = (p) => { let o=''; for (let i=0;i<p.length;i++) o += (i%2===0?'1':'0').repeat(+p[i]); return o; };
const ref = (sym,text,opts={}) => w(bwipjs.raw(sym,text,opts)[0].sbs);
const show = (label, mine, reference) => {
  const exact = mine===reference;
  const trimT = mine.replace(/[01]+$/,'')===reference.replace(/[01]+$/,'');
  console.log(`${label}: mine=${mine.length} ref=${reference.length} exact=${exact} trimTrailing=${trimT}`);
  if (!trimT) { console.log('  mine:', mine.slice(-40)); console.log('  ref :', reference.slice(-40)); }
};
show('code128 ARSIN128', bc.code128('ARSIN128').modules, ref('code128','ARSIN128'));
show('code39 AB', bc.code39('AB').modules, ref('code39','AB'));
show('code93 0', bc.code93('0').modules, ref('code93','0'));
show('itf 1234', bc.itf('1234').modules, ref('interleaved2of5','1234'));
show('ean13 4006381333931', bc.ean13('4006381333931').modules, ref('ean13','4006381333931'));
show('ean8 9638507', bc.ean8('9638507').modules, ref('ean8','9638507'));
show('upca 12345678901', bc.upca('12345678901').modules, ref('upca','12345678901'));
show('codabar A123A', bc.codabar('A123A').modules, ref('rationalizedCodabar','A123A'));
// code93 table derivation
const START='101011110';
for (const ch of ['0','A','-','%']) {
  const r = ref('code93', ch);
  console.log('code93', JSON.stringify(ch), 'ref len', r.length, 'ours', bc.code93(ch).modules.length);
  console.log('  ref ', r);
  console.log('  ours', bc.code93(ch).modules);
}
