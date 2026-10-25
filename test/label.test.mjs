/**
 * Label document model + renderers. A document with text, a barcode, a QR code,
 * a box and a monochrome image element is rendered to every supported printer
 * language, to SVG and to a raw raster payload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  createLabelDoc, SIZE_PRESETS, mmToDots, dotsToMm, substituteVars, renderLabel, renderLabelSvg,
  renderLabelRaster, NATIVE_RENDERERS, RASTER_ONLY, barcodeToMono, qrToMono, fontSizeDots, elementBBox
} from '../assets/js/core/label.js';
import { toMono } from '../assets/js/core/raster.js';
import { encodeBarcode } from '../assets/js/core/barcode.js';
import { qrEncode } from '../assets/js/core/qr.js';

const LANGS = ['zpl', 'tspl', 'epl', 'cpcl', 'escpos', 'starprnt', 'escp', 'ipl', 'dpl', 'plain'];

/** 8x8 bitmap: first row black, rest white. */
function sampleBitmap() {
  const mono = toMono({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) });
  mono.bits[0] = 0xff;
  return mono;
}

/** The fixture document used by most tests: 50 x 30 mm at 203 dpi. */
function fixtureDoc(language = 'zpl') {
  const doc = createLabelDoc({ preset: 'label-50x30', name: 'Arsin label' });
  doc.language = language;
  doc.variables = { serial: '00042' };
  doc.elements = [
    { id: 't1', type: 'text', x: 2, y: 2, text: 'HELLO {{serial}}', fontSizeMm: 4, bold: true, w: 40 },
    { id: 'b1', type: 'barcode', x: 2, y: 8, symbology: 'code128', data: 'ARSIN-{{serial}}', heightMm: 8, narrowMm: 0.25, showText: true, w: 30 },
    { id: 'q1', type: 'qrcode', x: 34, y: 8, data: 'ARSIN-{{serial}}', sizeMm: 12, ecc: 'M' },
    { id: 'x1', type: 'box', x: 1, y: 1, w: 48, h: 27, thicknessMm: 0.3 },
    { id: 'i1', type: 'image', x: 2, y: 20, w: 10, h: 8, mono: sampleBitmap() }
  ];
  return doc;
}

const asText = (result) => String.fromCharCode(...result.bytes);

test('createLabelDoc fills the documented defaults and presets', () => {
  const doc = createLabelDoc({ preset: 'label-50x30' });
  assert.equal(doc.width, 50);
  assert.equal(doc.height, 30);
  assert.equal(doc.gap, 2);
  assert.equal(doc.dpi, 203);
  assert.equal(doc.copies, 1);
  assert.equal(doc.rotation, 0);
  assert.equal(doc.darkness, 8);
  assert.equal(doc.speed, 4);
  assert.equal(doc.mediaType, 'gap');
  assert.equal(doc.language, 'zpl', 'label presets default to ZPL');
  assert.deepEqual(doc.elements, []);
  assert.deepEqual(doc.variables, {});
  assert.equal(doc.name, 'Untitled label');

  const receipt = createLabelDoc({ preset: 'receipt-80' });
  assert.equal(receipt.language, 'escpos', 'receipt presets default to ESC/POS');
  assert.equal(receipt.profile, 'receipt');
  assert.equal(createLabelDoc().width, SIZE_PRESETS[0].width, 'an unknown preset falls back to the first one');
  const custom = createLabelDoc({ preset: 'a4', name: 'Invoice', copies: 2, variables: { a: 1 } });
  assert.equal(custom.name, 'Invoice');
  assert.equal(custom.copies, 2);
  assert.deepEqual(custom.variables, { a: 1 });

  assert.equal(SIZE_PRESETS.length, 10);
  for (const p of SIZE_PRESETS) {
    assert.ok(p.id && p.name && p.profile, `${p.id}: preset metadata`);
    assert.ok(p.width > 0 && p.height > 0 && p.dpi > 0, `${p.id}: dimensions`);
    assert.ok(p.gap >= 0);
  }
  assert.deepEqual(SIZE_PRESETS.map((p) => p.profile).filter((v, i, a) => a.indexOf(v) === i).sort(), ['inkjet', 'label', 'receipt']);
});

test('mmToDots/dotsToMm, fontSizeDots and elementBBox do the unit maths', () => {
  assert.equal(mmToDots(50, 203), 400);
  assert.equal(mmToDots(25.4, 203), 203);
  assert.equal(mmToDots(0, 203), 0);
  assert.equal(dotsToMm(203, 203), 25.4);
  assert.ok(Math.abs(dotsToMm(mmToDots(30, 300), 300) - 30) < 0.05, 'dot rounding stays within a tenth of a millimetre');

  assert.equal(fontSizeDots({ fontSizeMm: 3 }, 203), 24);
  assert.equal(fontSizeDots({}, 203), 24, 'default font size is 3 mm');
  assert.equal(fontSizeDots({ fontSizeMm: 0.1 }, 203), 6, 'minimum size is 6 dots');

  const box = elementBBox({ x: 2, y: 4, w: 40, h: 20 }, 203);
  assert.deepEqual(box, { x: 16, y: 32, w: 320, h: 160 });
  const square = elementBBox({ x: 0, y: 0, sizeMm: 10 }, 203);
  assert.equal(square.w, square.h);
  assert.equal(elementBBox({}, 203).w, mmToDots(10, 203), 'a default 10 mm box');
});

test('substituteVars replaces known variables and keeps unknown ones', () => {
  assert.equal(substituteVars('S/N {{serial}}', { serial: '00042' }), 'S/N 00042');
  assert.equal(substituteVars('{{a}}-{{b}}', { a: 1 }), '1-{{b}}');
  assert.equal(substituteVars('{{ spaced }}', { spaced: 'x' }), 'x', 'whitespace inside the braces is allowed');
  assert.equal(substituteVars('no vars'), 'no vars');
  assert.equal(substituteVars(null), '');
  assert.equal(substituteVars('{{a}}', {}), '{{a}}');
});

test('renderLabel returns a Uint8Array for every language and reports its size', () => {
  for (const lang of LANGS) {
    const doc = fixtureDoc(lang);
    const result = renderLabel(doc, { lang, mode: 'native' });
    assert.equal(result.lang, lang);
    assert.equal(result.mode, 'native');
    assert.ok(result.bytes instanceof Uint8Array, `${lang}: bytes are a Uint8Array`);
    assert.ok(result.bytes.length > 0, `${lang}: non-empty payload`);
    // The label renderers return a command string; the ESC/POS style renderers
    // return a list of byte chunks.
    assert.ok(typeof result.chunks === 'string' || (Array.isArray(result.chunks) && result.chunks.length > 0), `${lang}: chunks`);
    assert.equal(result.elementCount, 5, `${lang}: element count`);
    assert.deepEqual(result.size, { width: 50, height: 30, dpi: 203 });
    assert.ok(Array.isArray(result.warnings));
    assert.equal(typeof result.text, 'string');
    // IPL/DPL are raster-only dialects, so a native render must warn about it.
    if (RASTER_ONLY.includes(lang)) assert.ok(result.warnings.length > 0, `${lang}: raster-only warning`);
  }
  assert.deepEqual(Object.keys(NATIVE_RENDERERS).sort(), [...LANGS].sort());
  assert.deepEqual(RASTER_ONLY, ['ipl', 'dpl']);
});

test('renderLabel emits the documented native commands per language', () => {
  const zpl = asText(renderLabel(fixtureDoc('zpl'), { lang: 'zpl' }));
  assert.ok(zpl.startsWith('^XA\n^CI28\n^PW400\n^LL240\n^PR4\n~SD16\n^MNY'), 'ZPL header');
  assert.ok(zpl.includes('^FO16,16^A0N,32,32'), 'ZPL text field');
  assert.ok(zpl.includes('HELLO 00042'), 'ZPL text content');
  assert.ok(zpl.includes('^BCN,'), 'ZPL Code 128 command');
  assert.ok(zpl.includes('^BQN,2,'), 'ZPL QR command');
  assert.ok(zpl.includes('^GB'), 'ZPL box command');
  assert.ok(zpl.includes('^GFA,'), 'ZPL graphic field for the image');
  assert.ok(zpl.endsWith('^PQ1\n^XZ'), 'ZPL terminator');

  const tspl = asText(renderLabel(fixtureDoc('tspl'), { lang: 'tspl' }));
  assert.ok(tspl.startsWith('SIZE 50 mm,30 mm\nGAP 2 mm,0 mm\nDIRECTION 0\nDENSITY 8\nSPEED 4\nCLS'), 'TSPL header');
  assert.ok(tspl.includes('TEXT 16,16,"3",0,1,1,"HELLO 00042"'), 'TSPL text');
  assert.ok(tspl.includes('BARCODE 16,64,"128",'), 'TSPL barcode');
  assert.ok(tspl.includes('QRCODE 272,64,M,'), 'TSPL QR');
  assert.ok(tspl.includes('BITMAP 16,160,'), 'TSPL bitmap');
  assert.ok(tspl.includes('BOX 8,8,392,224,'), 'TSPL box');
  assert.ok(tspl.endsWith('PRINT 1,1'), 'TSPL terminator');

  const epl = asText(renderLabel(fixtureDoc('epl'), { lang: 'epl' }));
  assert.ok(epl.startsWith('N\nq400\nQ240,16\nD0\nS4'), 'EPL header');
  assert.ok(epl.includes('A16,16,0,3,1,1,N,"HELLO 00042"'), 'EPL text');
  assert.ok(epl.includes('GW16,160,1,8,FF00'), 'EPL graphic write');
  assert.ok(epl.includes('X8,8,'), 'EPL box');
  assert.ok(epl.endsWith('\nP1'), 'EPL terminator');

  const cpcl = asText(renderLabel(fixtureDoc('cpcl'), { lang: 'cpcl' }));
  assert.ok(cpcl.startsWith('! 0 200 200 240 1\r\nPAGE-WIDTH 400\r\nDENSITY 8'), 'CPCL header');
  assert.ok(cpcl.includes('TEXT 5 32 16 16 HELLO 00042'), 'CPCL text');
  assert.ok(cpcl.includes('BARCODE 128 1 1 '), 'CPCL barcode');
  assert.ok(cpcl.includes('BARCODE QR 2 1 '), 'CPCL QR');
  assert.ok(cpcl.includes('EG1,8,16,160,FF00'), 'CPCL expanded graphics');
  assert.ok(cpcl.includes('BOX 8 8 392 224 '), 'CPCL box');
  assert.ok(cpcl.endsWith('FORM\r\nPRINT'), 'CPCL terminator');

  const escpos = renderLabel(fixtureDoc('escpos'), { lang: 'escpos' }).bytes;
  assert.deepEqual([...escpos.slice(0, 2)], [0x1b, 0x40], 'ESC/POS initialise');
  assert.ok(escpos.some((b, i) => b === 0x1d && escpos[i + 1] === 0x76 && escpos[i + 2] === 0x30), 'GS v 0 raster');
  assert.ok(escpos.some((b, i) => b === 0x1d && escpos[i + 1] === 0x28 && escpos[i + 2] === 0x6b), 'GS ( k QR block');
  assert.ok(escpos.some((b, i) => b === 0x1d && escpos[i + 1] === 0x6b), 'GS k barcode');
  assert.ok(escpos.some((b, i) => b === 0x1d && escpos[i + 1] === 0x56), 'GS V cut');

  const star = renderLabel(fixtureDoc('starprnt'), { lang: 'starprnt' }).bytes;
  assert.deepEqual([...star.slice(0, 2)], [0x1b, 0x40]);
  assert.ok(star.some((b, i) => b === 0x1b && star[i + 1] === 0x62), 'ESC b barcode');
  assert.ok(star.some((b, i) => b === 0x1b && star[i + 1] === 0x2a && star[i + 2] === 0x72), 'Star raster block');
  assert.ok(star.some((b, i) => b === 0x1b && star[i + 1] === 0x64 && star[i + 2] === 0x03), 'ESC d cut');

  const escp = renderLabel(fixtureDoc('escp'), { lang: 'escp' }).bytes;
  assert.deepEqual([...escp.slice(0, 2)], [0x1b, 0x40]);
  assert.ok(escp.some((b, i) => b === 0x1b && escp[i + 1] === 0x2a), 'ESC * bit image');
  assert.equal(escp[escp.length - 1], 0x0c, 'ESC/P ends with a form feed');

  const ipl = asText(renderLabel(fixtureDoc('ipl'), { lang: 'ipl' }));
  assert.ok(ipl.startsWith('\u0002\u001bL\r\n'), 'IPL header');
  assert.ok(ipl.includes('\u0002G1,8,16,160\r\n'), 'IPL graphic');
  assert.ok(ipl.endsWith('\u0002E1\r\n'), 'IPL terminator');

  const dpl = asText(renderLabel(fixtureDoc('dpl'), { lang: 'dpl' }));
  assert.ok(dpl.startsWith('\u0002L\r'), 'DPL header');
  assert.ok(dpl.includes('\u00021A16,16,0,1,1,1,HELLO 00042\r'), 'DPL text');
  assert.ok(dpl.includes('\u0002G16,160,1,8,FF00'), 'DPL graphic');
  assert.ok(dpl.endsWith('\u0002P1\r'), 'DPL terminator');

  const plain = asText(renderLabel(fixtureDoc('plain'), { lang: 'plain' }));
  assert.ok(plain.startsWith('HELLO 00042\nARSIN-00042\nARSIN-00042'), 'plain text only');
  assert.equal(plain[plain.length - 1], '\u000c');
  assert.ok(!plain.includes('FF00'), 'plain mode has no graphics');
});



test('renderLabelSvg produces a well-formed SVG preview containing the text', () => {
  const doc = fixtureDoc('zpl');
  const svg = renderLabelSvg(doc, { showBorder: true });
  const dom = new JSDOM(svg, { contentType: 'image/svg+xml' });
  const root = dom.window.document.documentElement;
  assert.equal(dom.window.document.getElementsByTagName('parsererror').length, 0, 'SVG parses');
  assert.equal(root.tagName.toLowerCase(), 'svg');
  assert.equal(root.getAttribute('viewBox'), '0 0 400 240');
  assert.equal(root.getAttribute('aria-label'), 'Arsin label');
  assert.ok(!svg.includes('NaN'), 'no NaN in the preview');
  assert.ok(!svg.includes('undefined'), 'no undefined in the preview');

  const text = root.textContent;
  assert.ok(text.includes('HELLO 00042'), 'substituted text element');
  assert.ok(text.includes('ARSIN-00042'), 'barcode human readable text');
  assert.ok(root.querySelectorAll('path').length >= 2, 'vector elements are drawn');
  assert.ok(root.querySelectorAll('rect').length >= 2, 'the box element is drawn');
  assert.ok(svg.includes('stroke-dasharray="6 4"'), 'the optional page border is drawn');

  const withGrid = renderLabelSvg(doc, { grid: true });
  assert.ok(withGrid.includes('stroke="#e2e8f0"'), 'grid overlay');
  assert.ok(renderLabelSvg(doc, { displayWidth: '320px' }).includes('width="320px"'));
  // Variables passed through opts win over the document variables.
  assert.ok(renderLabelSvg(doc, { variables: { serial: '99999' } }).includes('HELLO 99999'));

  // An empty document still renders a valid white page.
  const empty = renderLabelSvg(createLabelDoc({ preset: 'label-40x30' }));
  const emptyDom = new JSDOM(empty, { contentType: 'image/svg+xml' });
  assert.equal(emptyDom.window.document.getElementsByTagName('parsererror').length, 0);
  assert.equal(emptyDom.window.document.documentElement.getAttribute('viewBox'), '0 0 320 240');
});

test('renderLabelRaster works for every language', () => {
  const mono = sampleBitmap();
  const expected = {
    escpos: '1d 76 30 00',
    starprnt: '1b 2a 72 41',
    escp: '1b 40 1b 2a',
    zpl: '5e 58 41 5e 43 49 32 38',
    tspl: '53 49 5a 45',
    epl: '4e 0a',
    cpcl: '21 20 30',
    ipl: '02 1b 4c',
    dpl: '02 4c'
  };
  for (const lang of LANGS) {
    const chunks = renderLabelRaster(fixtureDoc(lang), lang, mono);
    assert.ok(Array.isArray(chunks) && chunks.length === 1, `${lang}: one chunk`);
    const bytes = Uint8Array.from(typeof chunks[0] === 'string' ? [...chunks[0]].map((c) => c.charCodeAt(0)) : chunks[0]);
    assert.ok(bytes.length > 0, `${lang}: non-empty`);
    if (expected[lang]) {
      const prefix = [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      assert.ok(prefix.startsWith(expected[lang]), `${lang}: header ${prefix}`);
    }
  }
  // The plain language has no raster path: it falls back to a text page.
  assert.ok(asText(renderLabel(fixtureDoc('plain'), { lang: 'plain', mode: 'raster', raster: mono })).length > 0);
  assert.throws(() => renderLabelRaster(fixtureDoc('zpl'), 'nope', mono), /unknown printer language "nope"/);
});

test('renderLabel validates the requested language and raster mode', () => {
  assert.throws(() => renderLabel(fixtureDoc('zpl'), { lang: 'nope' }), /unknown printer language "nope"/);
  assert.throws(() => renderLabel(fixtureDoc('escpos'), { lang: 'escpos', mode: 'raster' }), /raster mode needs a monochrome bitmap/);
  const auto = renderLabel(fixtureDoc('ipl'), { lang: 'ipl', mode: 'auto' });
  assert.equal(auto.mode, 'native', 'auto mode falls back to native without a bitmap');
  const autoRaster = renderLabel(fixtureDoc('ipl'), { lang: 'ipl', mode: 'auto', raster: sampleBitmap() });
  assert.equal(autoRaster.mode, 'raster');
  assert.equal(autoRaster.warnings.length, 0, 'raster mode needs no raster-only warning');
  const native = renderLabel(fixtureDoc('ipl'), { lang: 'ipl', mode: 'native' });
  assert.ok(native.warnings.some((w) => w.includes('verify the output')), 'native IPL warns about firmware dialects');
});

test('barcodeToMono and qrToMono build bitmaps with quiet zones', () => {
  const enc = encodeBarcode('code128', 'ARSIN128');
  const mono = barcodeToMono(enc, { moduleWidth: 2, height: 40, quietModules: 10 });
  assert.equal(mono.width, (enc.modules.length + 20) * 2);
  assert.equal(mono.height, 40);
  assert.equal(mono.bytesPerRow, Math.ceil(mono.width / 8));
  assert.equal(mono.bits[0], 0x00, 'left quiet zone is white');
  assert.equal(mono.bits[mono.bytesPerRow - 1] & 0x01, 0, 'right quiet zone is white');
  const withText = barcodeToMono(enc, { moduleWidth: 2, height: 40, showText: true });
  assert.ok(withText.height > mono.height, 'human readable text adds rows');

  const qr = qrEncode('arsin');
  const qrMono = qrToMono(qr, { moduleSize: 4, quietModules: 4 });
  assert.equal(qrMono.width, (qr.size + 8) * 4);
  assert.equal(qrMono.height, qrMono.width);
  assert.equal(qrMono.bytesPerRow, Math.ceil(qrMono.width / 8));
  const px = 4 * 4;
  const bit = qrMono.bits[px * qrMono.bytesPerRow + (px >> 3)];
  assert.ok(bit & (0x80 >> (px & 7)), 'finder pattern is drawn after the quiet zone');
  // A falsy moduleWidth falls back to the 2-dot default.
  assert.equal(barcodeToMono(enc, { moduleWidth: 0, height: 1 }).width, (enc.modules.length + 20) * 2);
  assert.equal(barcodeToMono(enc, { moduleWidth: 1, height: 1 }).width, enc.modules.length + 20);
});
