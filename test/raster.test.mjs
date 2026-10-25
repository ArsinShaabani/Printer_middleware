/**
 * Raster helpers: RGBA -> 1bpp conversion, dithering, packing and the native
 * graphics commands of every supported printer language.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  luminance, toMono, floydSteinberg, atkinson, bayerDither, packBitmap, toHexString,
  scaleBitmap, fitWidth, escposRaster, starRaster, escpRaster, zplGfa, tsplBitmap,
  eplGwu, cpclExpand, iplGraphic, dplGraphic, bitmapToAscii
} from '../assets/js/core/raster.js';

/** Build RGBA data from a per-pixel grey/alpha callback. */
function rgba(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data };
}

const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const bitsOf = (mono) => [...mono.bits];

/** Number of black pixels in a packed bitmap. */
function blackPixels(mono) {
  let n = 0;
  for (const byte of mono.bits) for (let i = 0; i < 8; i++) if (byte & (0x80 >> i)) n++;
  return n;
}

/** 8x2 bitmap: black row on top, white row below. */
const stripes = () => toMono(rgba(8, 2, (x, y) => (y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])));

test('toMono packs a black/white RGBA image into 1bpp rows', () => {
  const mono = stripes();
  assert.equal(mono.width, 8);
  assert.equal(mono.height, 2);
  assert.equal(mono.bytesPerRow, 1);
  assert.deepEqual(bitsOf(mono), [0xff, 0x00]);
  assert.ok(mono.bits instanceof Uint8Array);
});

test('toMono on a horizontal gradient thresholds at the requested level', () => {
  const W = 16;
  const gradient = rgba(W, 1, (x) => {
    const v = Math.round((x * 255) / (W - 1));
    return [v, v, v, 255];
  });
  const mono = toMono(gradient);
  assert.equal(mono.bytesPerRow, 2);
  assert.deepEqual(bitsOf(mono), [0xff, 0x00], 'left half is dark, right half is light');

  const inverted = toMono(gradient, { invert: true });
  assert.deepEqual(bitsOf(inverted), [0x00, 0xff], 'invert flips the polarity');

  const lowThreshold = toMono(gradient, { threshold: 32 });
  assert.deepEqual(bitsOf(lowThreshold), [0xc0, 0x00], 'only the darkest two pixels stay black');
  const highThreshold = toMono(gradient, { threshold: 224 });
  assert.deepEqual(bitsOf(highThreshold), [0xff, 0xfc], 'a high threshold makes nearly everything black');

  // A threshold of 0 turns nothing black, 256 turns everything black.
  assert.deepEqual(bitsOf(toMono(gradient, { threshold: 0 })), [0x00, 0x00]);
  assert.deepEqual(bitsOf(toMono(gradient, { threshold: 256 })), [0xff, 0xff]);
});

test('toMono treats transparent pixels as white unless told otherwise', () => {
  const transparent = rgba(8, 1, () => [0, 0, 0, 0]);
  assert.deepEqual(bitsOf(toMono(transparent)), [0x00], 'transparent -> white');
  assert.deepEqual(bitsOf(toMono(transparent, { alphaThreshold: 0 })), [0xff], 'alpha above the threshold is kept');
  // Alpha is ignored when the image has no alpha channel at all.
  const noAlpha = { width: 2, height: 1, data: [0, 0, 0, undefined, 255, 255, 255, undefined] };
  assert.deepEqual(bitsOf(toMono(noAlpha)), [0x80]);
  assert.equal(luminance(255, 0, 0).toFixed(1), '76.2');
  assert.equal(luminance(0, 255, 0).toFixed(1), '149.7');
  assert.equal(luminance(0, 0, 255).toFixed(1), '29.1');
});

test('packBitmap sets the MSB first and rounds the row up to whole bytes', () => {
  const black = new Uint8Array(10);
  black[0] = 1; // x = 0
  black[8] = 1; // x = 8 -> second byte
  black[9] = 1; // x = 9
  const mono = packBitmap(black, 10, 1);
  assert.equal(mono.bytesPerRow, 2);
  assert.deepEqual(bitsOf(mono), [0x80, 0xc0]);
  assert.deepEqual(bitsOf(packBitmap(new Uint8Array(3), 3, 1)), [0x00]);
  assert.equal(packBitmap(new Uint8Array(0), 0, 0).bytesPerRow, 0);
  assert.equal(toHexString(new Uint8Array([0x0f, 0xa0, 0x01])), '0FA001');
});


test('dithering helpers return 1bpp rows and differ from a plain threshold', () => {
  const gray = new Float32Array([0, 64, 128, 192]);
  for (const [name, fn] of [['floyd', floydSteinberg], ['atkinson', atkinson], ['bayer', bayerDither]]) {
    const out = fn(gray, 4, 1, 128);
    assert.ok(out instanceof Uint8Array, `${name}: returns a Uint8Array`);
    assert.equal(out.length, 4, `${name}: one entry per pixel`);
    assert.ok([...out].every((v) => v === 0 || v === 1), `${name}: binary output`);
  }
  assert.deepEqual([...floydSteinberg(gray, 4, 1, 128)], [1, 1, 0, 0]);
  assert.deepEqual([...atkinson(gray, 4, 1, 128)], [1, 1, 0, 0]);
  assert.deepEqual([...bayerDither(gray, 4, 1, 128)], [1, 1, 1, 0], 'the ordered matrix keeps one more pixel');

  // A uniform mid-grey: a plain threshold makes everything black while the
  // ordered matrix alternates, so the two paths must differ.
  const flat = rgba(8, 8, () => [100, 100, 100, 255]);
  assert.ok(bitsOf(toMono(flat)).every((b) => b === 0xff), 'all 64 pixels black');
  const bayer = toMono(flat, { dither: 'bayer' });
  const bayerCount = blackPixels(bayer);
  assert.ok(bayerCount > 0 && bayerCount < 64, `bayer must dither, got ${bayerCount} black pixels`);
  assert.equal(blackPixels(toMono(flat)), 64, 'the plain threshold keeps every pixel black');
  assert.equal(bitsOf(toMono(flat, { dither: 'floyd' })).length, 8);
  assert.equal(bitsOf(toMono(flat, { dither: 'atkinson' })).length, 8);
  // Error diffusion on a uniform mid-grey spreads the error, so it must not
  // produce the same all-black result as the plain threshold path.
  const floydCount = blackPixels(toMono(flat, { dither: 'floyd' }));
  assert.ok(floydCount > 0 && floydCount < 64, `floyd must dither, got ${floydCount} black pixels`);
  const light = rgba(8, 8, () => [200, 200, 200, 255]);
  assert.equal(blackPixels(toMono(light)), 0, 'a light grey stays white with the default threshold');
  assert.ok(blackPixels(toMono(light, { dither: 'bayer' })) > 0, 'bayer still dithers a light grey');
});

test('scaleBitmap and fitWidth resize without losing the module grid', () => {
  const mono = stripes();
  const scaled = scaleBitmap(mono, 2);
  assert.equal(scaled.width, 16);
  assert.equal(scaled.height, 4);
  assert.equal(scaled.bytesPerRow, 2);
  assert.deepEqual(bitsOf(scaled), [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(scaleBitmap(mono, 1), mono, 'a factor of 1 is a no-op');
  assert.equal(scaleBitmap(mono, 0), mono);

  const cropped = fitWidth(mono, 4);
  assert.equal(cropped.width, 4);
  assert.equal(cropped.height, 2);
  assert.deepEqual(bitsOf(cropped), [0xf0, 0x00]);

  const grown = fitWidth(mono, 16);
  assert.equal(grown.width, 16);
  assert.equal(grown.height, 4);
  assert.equal(fitWidth(mono, 8), mono, 'a matching width is a no-op');
});

test('escposRaster emits the GS v 0 header and the packed bitmap', () => {
  const mono = stripes();
  assert.equal(hexOf(escposRaster(mono)), '1d 76 30 00 01 00 02 00 ff 00');
  const wide = packBitmap(new Uint8Array(300 * 300), 300, 300);
  const header = escposRaster(wide).slice(0, 8);
  assert.deepEqual(header, [0x1d, 0x76, 0x30, 0x00, 0x26, 0x00, 0x2c, 0x01], 'little endian width and height');
  assert.equal(escposRaster(wide).length, 8 + wide.bits.length);
});

test('starRaster wraps every row in an ESC * r A / ESC * r B block', () => {
  const bytes = starRaster(stripes());
  assert.deepEqual(bytes.slice(0, 4), [0x1b, 0x2a, 0x72, 0x41]);
  assert.deepEqual(bytes.slice(-4), [0x1b, 0x2a, 0x72, 0x42]);
  assert.equal(hexOf(bytes), '1b 2a 72 41 62 01 00 ff 62 01 00 00 1b 2a 72 42');
});

test('escpRaster emits 24-dot ESC * bands terminated by a line feed', () => {
  const bytes = escpRaster(stripes());
  assert.deepEqual(bytes.slice(0, 2), [0x1b, 0x40], 'starts with ESC @');
  assert.deepEqual(bytes.slice(2, 7), [0x1b, 0x2a, 39, 8, 0], '24-dot triple density, width 8');
  assert.equal(bytes[bytes.length - 1], 0x0a, 'each band ends with LF');
  assert.equal(escpRaster(stripes(), { mode: 33 })[4], 33, 'the mode is configurable');
});

test('zplGfa, tsplBitmap, eplGwu, cpclExpand, iplGraphic and dplGraphic match the documented syntax', () => {
  const mono = stripes();
  assert.equal(zplGfa(mono), '^FO0,0^GFA,2,2,1,FF00');
  assert.equal(zplGfa(mono, { x: 12, y: 34 }), '^FO12,34^GFA,2,2,1,FF00');
  assert.equal(tsplBitmap(mono), 'BITMAP 0,0,1,2,0,FF00');
  assert.equal(tsplBitmap(mono, { x: 1, y: 2 }), 'BITMAP 1,2,1,2,0,FF00');
  assert.equal(eplGwu(mono), 'GW0,0,1,2,FF00');
  assert.equal(eplGwu(mono, { x: 3, y: 4 }), 'GW3,4,1,2,FF00');
  assert.equal(cpclExpand(mono), 'EG1,2,0,0,FF00');
  assert.equal(cpclExpand(mono, { x: 5, y: 6 }), 'EG1,2,5,6,FF00');
  assert.equal(iplGraphic(mono, { x: 7, y: 8 }), '\u0002G1,2,7,8\r\n');
  assert.equal(dplGraphic(mono, { x: 9, y: 10 }), '\u0002G9,10,1,2,FF00\r');
  assert.match(zplGfa(mono), /^\^FO\d+,\d+\^GFA,\d+,\d+,\d+,([0-9A-F]{2})+$/);
  assert.match(tsplBitmap(mono), /^BITMAP \d+,\d+,\d+,\d+,0,([0-9A-F]{2})+$/);
  assert.match(eplGwu(mono), /^GW\d+,\d+,\d+,\d+,([0-9A-F]{2})+$/);
  assert.match(cpclExpand(mono), /^EG\d+,\d+,\d+,\d+,([0-9A-F]{2})+$/);
});

test('bitmapToAscii renders a readable preview', () => {
  const ascii = bitmapToAscii(stripes());
  assert.equal(ascii, '########\n........');
  assert.equal(bitmapToAscii(packBitmap(new Uint8Array([1, 0, 1, 0]), 2, 2)), '#.\n#.');
  assert.equal(bitmapToAscii(stripes(), { step: 2 }), '####');
  assert.equal(bitmapToAscii(packBitmap(new Uint8Array(0), 0, 0)), '');
});
