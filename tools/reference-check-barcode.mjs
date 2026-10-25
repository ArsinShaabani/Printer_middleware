/** Reference cross-check: compares every encoder in assets/js/core/barcode.js with
 *  bwip-js (dev dependency). Run: node tools/reference-check-barcode.mjs */
import bwipjs from 'bwip-js';
import * as bc from '../assets/js/core/barcode.js';

const w = (p) => { let o = ''; for (let i = 0; i < p.length; i++) o += (i % 2 === 0 ? '1' : '0').repeat(+p[i]); return o; };
const ref = (sym, text) => w(bwipjs.raw(sym, text, {})[0].sbs);
const trim = (s) => s.replace(/[01]+$/, '');
const cmp = (label, mine, reference, exact) => {
  const ok = exact ? mine === reference : trim(mine) === trim(reference);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} mine=${mine.length} ref=${reference.length}`);
  if (!ok) {
    console.log('  mine:', mine.slice(0, 120));
    console.log('  ref :', reference.slice(0, 120));
  }
  return ok;
};

let all = true;
all &= cmp('code128 1234', bc.code128('1234').modules, ref('code128', '1234'), true);
all &= cmp('code128 ARSIN128', bc.code128('ARSIN128').modules, ref('code128', 'ARSIN128'), true);
all &= cmp('code128 A1B2C3', bc.code128('A1B2C3').modules, ref('code128', 'A1B2C3'), true);
all &= cmp('code128 123456789012', bc.code128('123456789012').modules, ref('code128', '123456789012'), true);
all &= cmp('code39 AB', bc.code39('AB').modules, ref('code39', 'AB'));
all &= cmp('code39 12345', bc.code39('12345').modules, ref('code39', '12345'));
all &= cmp('code39 ARSIN-PS', bc.code39('ARSIN-PS').modules, ref('code39', 'ARSIN-PS'));
all &= cmp('itf 1234', bc.itf('1234').modules, ref('interleaved2of5', '1234'));
all &= cmp('itf 123456', bc.itf('123456').modules, ref('interleaved2of5', '123456'));
all &= cmp('ean13', bc.ean13('4006381333931').modules, ref('ean13', '4006381333931'), true);
all &= cmp('ean13 b', bc.ean13('9780306406157').modules, ref('ean13', '9780306406157'), true);
all &= cmp('ean8', bc.ean8('9638507').modules, ref('ean8', '9638507'), true);
all &= cmp('upca', bc.upca('12345678901').modules, ref('upca', '12345678901'), true);
all &= cmp('codabar A123A', bc.codabar('A123A').modules, ref('rationalizedCodabar', 'A123A'));
all &= cmp('codabar 40156', bc.codabar('40156').modules, ref('rationalizedCodabar', 'A40156A'));
all &= cmp('code93 0', bc.code93('0').modules, ref('code93', '0'));
console.log(all ? '\nALL REFERENCE COMPARISONS PASSED' : '\nSOME COMPARISONS FAILED');
