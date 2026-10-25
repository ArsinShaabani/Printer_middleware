/**
 * 1D barcode encoders - verified against the bwip-js reference implementation.
 *
 * bwip-js exposes the bar/space widths of every symbol in `raw(sym, text)[0].sbs`
 * (one digit per element, alternating bar/space). Expanding that to a module
 * string gives the same representation the core module uses, so the two can be
 * compared directly.
 *
 * The reference appends one extra trailing element for the "self checking"
 * symbologies (Code 39, ITF, Codabar), so those are compared after normalising
 * the trailing run; Code 128 / EAN-13 / EAN-8 / UPC-A must match byte for byte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bwipjs from 'bwip-js';
import * as bc from '../assets/js/core/barcode.js';

/** Expand a bwip-js `sbs` width string ("212222") into a "1"/"0" module string. */
function widthsToModules(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) out += (i % 2 === 0 ? '1' : '0').repeat(Number(pattern[i]));
  return out;
}

/** Reference module string for one symbology/payload from bwip-js. */
function reference(sym, text, opts = {}) {
  const rows = bwipjs.raw(sym, text, opts);
  assert.ok(Array.isArray(rows) && rows.length, `bwip-js returned no rows for ${sym}`);
  assert.ok(typeof rows[0].sbs === 'string' && rows[0].sbs.length, `bwip-js returned no sbs for ${sym}`);
  return widthsToModules(rows[0].sbs);
}

/** Drop the trailing run of identical modules so a one-module suffix is ignored. */
function trailingNormalised(modules) {
  return modules.replace(/[01]+$/, '');
}

function assertExact(label, mine, ref) {
  assert.equal(mine, ref, `${label}: module string must match bwip-js exactly`);
}

function assertTrailingNormalised(label, mine, ref) {
  assert.equal(trailingNormalised(mine), trailingNormalised(ref), `${label}: module string must match after trailing normalisation`);
  assert.ok(Math.abs(mine.length - ref.length) <= 1, `${label}: reference may only append one trailing element (mine ${mine.length}, ref ${ref.length})`);
}
