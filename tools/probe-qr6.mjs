import bwipjs from 'bwip-js';
import { qrEncode } from '../assets/js/core/qr.js';

// Pure lowercase payloads: alphanumeric/numeric modes cannot be used by the
// reference implementations, so byte mode is guaranteed on both sides.
const cases = [];
for (const ecc of ['L', 'M', 'Q', 'H']) {
  for (const n of [5, 12, 22, 33, 42, 60, 92, 130, 152, 175]) {
    const text = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    cases.push([text, ecc]);
  }
}

const refMatrix = (text, ecc) => {
  const r = bwipjs.raw('qrcode', text, { scale: 1, eclevel: ecc });
  const { pixs, pixx, pixy } = r[0];
  const rows = [];
  for (let y = 0; y < pixy; y++) {
    let s = '';
    for (let x = 0; x < pixx; x++) s += pixs[y * pixx + x] ? '1' : '0';
    rows.push(s);
  }
  return rows.join('\n');
};

let pass = 0;
const failures = [];
for (const [text, ecc] of cases) {
  const ref = refMatrix(text, ecc);
  const size = ref.split('\n')[0].length;
  let found = -1;
  try {
    for (let m = 0; m < 8; m++) {
      const rows = qrEncode(text, { ecc, mask: m }).modules.map((r) => r.join('')).join('\n');
      if (rows === ref) found = m;
    }
  } catch (e) {
    failures.push(`len=${text.length} ecc=${ecc} -> ${e.message}`);
    continue;
  }
  if (found >= 0) pass++;
  else failures.push(`len=${text.length} v${(size - 17) / 4} ecc=${ecc}`);
}
console.log(`${pass} / ${cases.length} cases match bwip-js exactly`);
if (failures.length) console.log('failures:', failures.join(', '));
