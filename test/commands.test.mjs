/**
 * Printer command library: every language x action must produce bytes or an
 * explicit "unsupported" result with a note, the documented ESC/POS and ZPL
 * sequences must be byte exact, and the raw console parser must handle hex,
 * escape sequences and plain text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS, ACTION_BY_ID, LANGUAGES, LANGUAGE_BY_ID, LANGUAGE_BUILDERS, DEVICE_PROFILES, CONFIDENCE, PARAMS,
  buildCommand, actionsForLanguage, languagesForProfile, bytesFromText, bytesFromHex, toHex, toAscii, toUint8, parseRawInput
} from '../assets/js/core/commands.js';

const hex = (bytes) => toHex(bytes);
const cmd = (lang, action, params) => buildCommand(lang, action, params);

test('every language exposes metadata and a builder table', () => {
  assert.equal(LANGUAGES.length, 10);
  assert.equal(ACTIONS.length, 19);
  const ids = LANGUAGES.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'language ids are unique');
  assert.deepEqual(ids, ['escpos', 'zpl', 'epl', 'tspl', 'cpcl', 'starprnt', 'escp', 'ipl', 'dpl', 'plain']);
  for (const l of LANGUAGES) {
    assert.ok(l.name && l.vendor && l.type, `${l.id}: metadata`);
    assert.ok(Array.isArray(l.dpi) || Number.isInteger(l.dpi), `${l.id}: dpi`);
    assert.ok(Array.isArray(l.widths) && l.widths.length > 0, `${l.id}: paper widths`);
    assert.ok(Array.isArray(l.charsets) && l.charsets.length > 0, `${l.id}: charsets`);
    assert.equal(typeof l.textMode, 'boolean', `${l.id}: textMode`);
    assert.ok(l.note.length > 10, `${l.id}: note`);
    assert.ok(LANGUAGE_BUILDERS[l.id], `${l.id}: builder table`);
    assert.ok(Object.keys(LANGUAGE_BUILDERS[l.id]).length >= 6, `${l.id}: builder count`);
    assert.equal(LANGUAGE_BY_ID[l.id], l);
  }
  for (const a of ACTIONS) {
    assert.ok(a.name && a.group && a.desc, `${a.id}: metadata`);
    assert.ok(['test', 'status', 'maintenance', 'config'].includes(a.group), `${a.id}: group`);
    assert.equal(ACTION_BY_ID[a.id], a);
  }
});

test('every language x action either returns bytes or an unsupported result with a note', () => {
  for (const lang of LANGUAGES) {
    for (const action of ACTIONS) {
      const result = cmd(lang.id, action.id);
      assert.equal(result.lang, lang.id);
      assert.equal(result.action, action.id);
      assert.equal(result.actionName, action.name);
      if (result.supported) {
        assert.ok(Array.isArray(result.bytes), `${lang.id}/${action.id}: bytes array`);
        assert.ok(result.bytes.length > 0, `${lang.id}/${action.id}: non-empty payload`);
        assert.ok(result.bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255), `${lang.id}/${action.id}: byte range`);
        assert.equal(result.hex, hex(result.bytes), `${lang.id}/${action.id}: hex matches bytes`);
        assert.equal(result.ascii.length, result.bytes.length, `${lang.id}/${action.id}: ascii preview`);
        assert.ok(CONFIDENCE[result.confidence], `${lang.id}/${action.id}: confidence level`);
        assert.equal(result.confidenceText, CONFIDENCE[result.confidence]);
      } else {
        assert.deepEqual(result.bytes, [], `${lang.id}/${action.id}: unsupported has no bytes`);
        assert.equal(result.hex, '');
        assert.ok(result.note.length > 10, `${lang.id}/${action.id}: unsupported needs an explanatory note`);
        assert.match(result.note, /not defined for/);
      }
    }
  }
});

test('actionsForLanguage mirrors buildCommand support and confidence', () => {
  for (const lang of LANGUAGES) {
    const actions = actionsForLanguage(lang.id);
    assert.equal(actions.length, ACTIONS.length);
    for (const action of actions) {
      const built = cmd(lang.id, action.id);
      assert.equal(action.supported, built.supported, `${lang.id}/${action.id}: supported flag`);
      assert.equal(action.confidence, built.confidence, `${lang.id}/${action.id}: confidence`);
      if (action.supported) assert.equal(action.note, built.note, `${lang.id}/${action.id}: note`);
      else assert.match(action.note, /Not defined for/, `${lang.id}/${action.id}: unsupported note`);
    }
  }
  // ESC/POS is the most complete language, IPL/DPL the most limited.
  assert.equal(actionsForLanguage('escpos').filter((a) => a.supported).length, 19);
  assert.equal(actionsForLanguage('zpl').filter((a) => a.supported).length, 18);
  assert.equal(actionsForLanguage('ipl').filter((a) => a.supported).length, 6);
  assert.equal(actionsForLanguage('dpl').filter((a) => a.supported).length, 6);
  assert.equal(actionsForLanguage('plain').filter((a) => a.supported).length, 7);
  assert.equal(actionsForLanguage('nope').every((a) => !a.supported), true);
});

test('buildCommand rejects unknown languages and actions', () => {
  assert.throws(() => cmd('nope', 'selftest'), /unknown printer language "nope"/);
  assert.throws(() => cmd('escpos', 'nope'), /unknown action "nope"/);
});

test('ESC/POS maintenance sequences are byte exact', () => {
  assert.equal(hex(cmd('escpos', 'selftest').bytes), '1B 40 1D 28 41 02 00 01 00');
  assert.equal(hex(cmd('escpos', 'initialize').bytes), '1B 40');
  assert.equal(hex(cmd('escpos', 'config').bytes), '1B 40 1D 28 41 02 00 01 01');
  assert.equal(hex(cmd('escpos', 'status').bytes), '10 04 01 1D 72 01');
  assert.equal(hex(cmd('escpos', 'feed', { lines: 3 }).bytes), '1B 64 03');
  assert.equal(hex(cmd('escpos', 'feed').bytes), '1B 64 03', 'lines default to 3');
  assert.equal(hex(cmd('escpos', 'feed', { lines: 999 }).bytes), '1B 64 FF', 'lines are clamped to 255');
  assert.equal(hex(cmd('escpos', 'cut').bytes), '1B 64 03 1D 56 00');
  assert.equal(hex(cmd('escpos', 'cut', { cutter: 'partial' }).bytes), '1B 64 03 1D 56 01');
  assert.equal(hex(cmd('escpos', 'drawer').bytes), '1B 70 00 19 FA');
  assert.equal(hex(cmd('escpos', 'density', { darkness: 10 }).bytes), '1B 40 1D 28 4B 02 00 30 0A');
  assert.equal(hex(cmd('escpos', 'density').bytes), '1B 40 1D 28 4B 02 00 30 08', 'darkness default is 8');
  assert.equal(hex(cmd('escpos', 'resetcounter').bytes), '1B 40 1D 28 58 06 00 00 00 00 00');
  assert.equal(hex(cmd('escpos', 'factoryreset').bytes), '1B 40 1D 28 58 04 00 00 00');
  assert.equal(hex(cmd('escpos', 'media').bytes), '1B 40 1D 28 45 02 00 00 01');
  assert.equal(hex(cmd('escpos', 'media', { media: 'continuous' }).bytes), '1B 40 1D 28 45 02 00 00 03');
  assert.equal(hex(cmd('escpos', 'media', { media: 'blackmark' }).bytes), '1B 40 1D 28 45 02 00 00 02');
  assert.equal(hex(cmd('escpos', 'info').bytes), '1B 40 1D 49 31 1D 28 41 02 00 01 01');
  assert.equal(hex(cmd('escpos', 'saveconfig').bytes), '1B 40 1D 28 4B 02 00 31 01');
  // The composite test sheets start with the initialise command and are long.
  assert.ok(cmd('escpos', 'barcodetest').bytes.length > 80);
  assert.ok(cmd('escpos', 'headclean').bytes.length > 80);
  assert.equal(hex(cmd('escpos', 'barcodetest').bytes.slice(0, 2)), '1B 40');
  assert.match(cmd('escpos', 'barcodetest').ascii, /CODE39/);
  assert.match(cmd('escpos', 'barcodetest').ascii, /QR CODE/);
  assert.equal(cmd('escpos', 'initialize').text, '', 'binary-only languages have no text view');
});

test('ZPL maintenance sequences are byte exact', () => {
  assert.equal(hex(cmd('zpl', 'selftest').bytes), '7E 57 43');
  assert.equal(hex(cmd('zpl', 'status').bytes), '7E 48 51 45 53');
  assert.equal(hex(cmd('zpl', 'config').bytes), '7E 57 43 7E 48 53');
  assert.equal(hex(cmd('zpl', 'initialize').bytes), '7E 4A 52');
  assert.equal(hex(cmd('zpl', 'calibrate').bytes), '7E 4A 43');
  assert.equal(hex(cmd('zpl', 'align').bytes), '5E 58 41 5E 4D 4C 5E 58 5A');
  assert.equal(hex(cmd('zpl', 'cut').bytes), '5E 58 41 5E 4D 4D 43 2C 59 5E 58 5A');
  assert.equal(hex(cmd('zpl', 'saveconfig').bytes), '5E 58 41 5E 4A 55 53 5E 58 5A');
  assert.equal(hex(cmd('zpl', 'factoryreset').bytes), '5E 58 41 5E 4A 55 52 5E 58 5A');
  assert.equal(hex(cmd('zpl', 'info').bytes), '7E 48 49 7E 48 53');
  assert.equal(hex(cmd('zpl', 'counter').bytes), '7E 48 53');
  assert.equal(hex(cmd('zpl', 'density', { darkness: 8 }).bytes), '7E 53 44 31 36');
  assert.equal(cmd('zpl', 'density', { darkness: 8 }).text, '~SD16');
  assert.equal(hex(cmd('zpl', 'feed', { lines: 2 }).bytes), '5E 58 41 5E 46 44 5E 46 53 5E 50 51 32 5E 58 5A');
  assert.equal(cmd('zpl', 'feed', { lines: 2 }).text, '^XA^FD^FS^PQ2^XZ');
  assert.equal(hex(cmd('zpl', 'media').bytes), '5E 58 41 5E 4D 4E 59 5E 58 5A');
  assert.equal(hex(cmd('zpl', 'media', { media: 'continuous' }).bytes), '5E 58 41 5E 4D 4E 4E 5E 58 5A');
  assert.equal(hex(cmd('zpl', 'media', { media: 'blackmark' }).bytes), '5E 58 41 5E 4D 4E 4D 5E 58 5A');
  assert.ok(cmd('zpl', 'barcodetest').text.includes('^BQN,2,6'), 'QR command in the barcode sheet');
  assert.ok(cmd('zpl', 'headclean').text.startsWith('^XA^CI28'));
  assert.ok(cmd('zpl', 'headclean').text.endsWith('^XZ'));
});


test('TSPL, EPL, CPCL, Star, ESC/P, IPL, DPL and plain sequences are byte exact', () => {
  assert.equal(hex(cmd('tspl', 'selftest').bytes), '1B 21 3F');
  assert.equal(hex(cmd('tspl', 'initialize').bytes), '1B 40');
  assert.equal(cmd('tspl', 'feed', { lines: 4 }).text, 'FEED 4\n');
  assert.equal(cmd('tspl', 'cut').text, 'CUT\n');
  assert.equal(cmd('tspl', 'calibrate').text, 'GAP 2 mm,0\nAUTODETECT\n');
  assert.equal(cmd('tspl', 'calibrate', { media: 'continuous' }).text, 'GAP 0 mm,0\nAUTODETECT\n');
  assert.equal(cmd('tspl', 'calibrate', { media: 'blackmark' }).text, 'BLINE 3 mm,0\nAUTODETECT\n');
  assert.equal(cmd('tspl', 'density', { darkness: 8 }).text, 'DENSITY 8\n');
  assert.equal(cmd('tspl', 'media').text, 'GAP 2 mm,0\n');
  assert.equal(cmd('tspl', 'status').text, '~!@');

  assert.equal(cmd('epl', 'selftest').text, 'U\n');
  assert.equal(hex(cmd('epl', 'status').bytes), '1B 3F');
  assert.equal(cmd('epl', 'initialize').text, 'N\n');
  assert.equal(cmd('epl', 'calibrate').text, 'Z\n');
  assert.equal(cmd('epl', 'factoryreset').text, 'e\n');
  assert.equal(cmd('epl', 'density', { darkness: 8 }).text, 'D0\n');

  assert.equal(cmd('cpcl', 'selftest').text, '! U1 do "device.selftest" ""\r\n');
  assert.equal(cmd('cpcl', 'media').text, '! U1 setvar "media.type" "label"\r\n');
  assert.equal(cmd('cpcl', 'media', { media: 'continuous' }).text, '! U1 setvar "media.type" "journal"\r\n');
  assert.equal(cmd('cpcl', 'media', { media: 'blackmark' }).text, '! U1 setvar "media.type" "mark"\r\n');
  assert.equal(cmd('cpcl', 'density', { darkness: 8 }).text, '! U1 setvar "print.tone" "64"\r\n');

  assert.equal(hex(cmd('starprnt', 'drawer').bytes), '07');
  assert.equal(hex(cmd('starprnt', 'selftest').bytes), '1B 2A 72 41');
  assert.equal(hex(cmd('starprnt', 'initialize').bytes), '1B 40');
  assert.equal(hex(cmd('starprnt', 'feed', { lines: 2 }).bytes), '1B 61 02');
  assert.equal(hex(cmd('starprnt', 'cut').bytes), '1B 64 03');
  assert.equal(hex(cmd('starprnt', 'status').bytes), '1B 06 01');

  assert.equal(hex(cmd('escp', 'initialize').bytes), '1B 40');
  assert.equal(hex(cmd('escp', 'cut').bytes), '0C');
  assert.equal(hex(cmd('escp', 'feed', { lines: 2 }).bytes), '1B 30 0A 0A');

  assert.equal(hex(cmd('ipl', 'selftest').bytes), '02 1B 45 01 0D');
  assert.equal(hex(cmd('ipl', 'feed', { lines: 2 }).bytes), '02 1B 46 02 0D');
  assert.equal(hex(cmd('dpl', 'selftest').bytes), '02 4B 63 30 31 0D');

  assert.equal(hex(cmd('plain', 'feed', { lines: 2 }).bytes), '0A 0A');
  assert.equal(hex(cmd('plain', 'cut').bytes), '0C');
  const plainTest = cmd('plain', 'selftest');
  const plainText = String.fromCharCode(...plainTest.bytes);
  assert.ok(plainText.startsWith('ARSIN PRINT SERVER - ASCII TEST PAGE'));
  assert.equal(plainTest.bytes[plainTest.bytes.length - 1], 0x0c, 'the page ends with a form feed');
  // Observation: buildCommand only fills `text` for the label languages
  // (TEXT_LANGS), so the plain/ESC-POS/Star payloads have to be read as hex.
  assert.equal(plainTest.text, '');
  assert.equal(cmd('escpos', 'initialize').text, '');
  assert.ok(cmd('tspl', 'feed', { lines: 4 }).text.length > 0, 'label languages get a text view');
});



test('parameters are clamped and defaulted', () => {
  assert.equal(cmd('zpl', 'density', { darkness: 99 }).text, '~SD30', 'ZPL darkness caps at 30');
  assert.equal(cmd('zpl', 'density', { darkness: -5 }).text, '~SD0');
  assert.equal(cmd('escpos', 'density', { darkness: 99 }).bytes[8], 0x0f);
  assert.equal(cmd('tspl', 'density', { darkness: -3 }).text, 'DENSITY 0\n');
  assert.equal(cmd('plain', 'feed', { lines: 0 }).bytes.length, 1, 'lines clamp to 1');
  assert.equal(cmd('escpos', 'cut', { cutter: 'nonsense' }).bytes[5], 0x00, 'unknown cutter falls back to full cut');
  assert.equal(cmd('escpos', 'media', { media: 'nonsense' }).bytes[8], 0x01, 'unknown media falls back to gap');
  // The resolved parameter set is echoed back for the UI.
  assert.deepEqual(cmd('escpos', 'feed', { lines: 7 }).params, { lines: 7 });
  assert.deepEqual(cmd('escpos', 'feed').params, { lines: 3 });
});

test('the action registry exposes the parameters the UI renders', () => {
  const feed = actionsForLanguage('escpos').find((a) => a.id === 'feed');
  assert.deepEqual(feed.params.map((p) => p.id), ['lines']);
  assert.equal(PARAMS.lines.default, 3);
  assert.equal(PARAMS.lines.min, 1);
  assert.equal(PARAMS.lines.max, 255);
  const cut = actionsForLanguage('escpos').find((a) => a.id === 'cut');
  assert.deepEqual(cut.params.map((p) => p.id), ['cutter']);
  assert.deepEqual(PARAMS.cutter.options.map((o) => o.value), ['full', 'partial']);
  const media = actionsForLanguage('zpl').find((a) => a.id === 'media');
  assert.deepEqual(media.params.map((p) => p.id), ['media']);
  assert.deepEqual(PARAMS.media.options.map((o) => o.value), ['gap', 'blackmark', 'continuous']);
  // Actions without parameters report an empty list.
  assert.deepEqual(actionsForLanguage('escpos').find((a) => a.id === 'drawer').params, []);
});

test('language builder tables only contain actions the UI can reach', () => {
  const declared = new Set(ACTIONS.map((a) => a.id));
  // 'speed' is defined in six builder tables but has no ACTIONS entry, so the
  // maintenance console can never offer it (it is exposed through 'density').
  // Recorded here so the mismatch stays visible instead of silently rotting.
  const extras = new Set(['speed']);
  for (const lang of LANGUAGES) {
    for (const key of Object.keys(LANGUAGE_BUILDERS[lang.id])) {
      assert.ok(declared.has(key) || extras.has(key), `${lang.id}: unexpected builder action "${key}"`);
    }
  }
  assert.deepEqual(LANGUAGE_BUILDERS.zpl.speed.bytes({ speed: 4 }), bytesFromText('^XA^PR4^XZ'));
  assert.equal(LANGUAGE_BUILDERS.tspl.speed.bytes({ speed: 4 })[0], 0x53, 'TSPL speed starts with "S"');
  assert.throws(() => cmd('zpl', 'speed', { speed: 4 }), /unknown action "speed"/);
});

test('device profiles map onto languages', () => {
  assert.ok(DEVICE_PROFILES.length >= 4);
  for (const p of DEVICE_PROFILES) {
    assert.ok(p.id && p.name && p.hint, `${p.id}: profile copy`);
    assert.ok(Array.isArray(p.languages) && p.languages.length > 0, `${p.id}: languages`);
    for (const id of p.languages) assert.ok(LANGUAGE_BY_ID[id], `${p.id}: unknown language ${id}`);
    assert.ok(p.defaultSize && p.defaultSize.width > 0 && p.defaultSize.height > 0, `${p.id}: default size`);
    assert.deepEqual(languagesForProfile(p.id).map((l) => l.id), p.languages);
  }
  assert.deepEqual(languagesForProfile('receipt').map((l) => l.id), ['escpos', 'starprnt', 'plain']);
  assert.deepEqual(languagesForProfile('label').map((l) => l.id), ['zpl', 'tspl', 'epl', 'cpcl', 'ipl', 'dpl']);
  assert.equal(languagesForProfile('nope').length, LANGUAGES.length, 'an unknown profile offers every language');
});


test('parseRawInput handles hex, escapes and plain text', () => {
  // auto mode: a separated hex byte list is decoded as hex
  assert.deepEqual(parseRawInput('1B 40'), [0x1b, 0x40]);
  assert.deepEqual(parseRawInput('0x1B,0x40'), [0x1b, 0x40]);
  assert.deepEqual(parseRawInput('1b 64 03 1d 56 00'), [0x1b, 0x64, 0x03, 0x1d, 0x56, 0x00]);
  assert.deepEqual(parseRawInput('  1D 56 00  '), [0x1d, 0x56, 0x00]);
  // auto mode: everything else is treated as (escaped) text
  assert.deepEqual(parseRawInput('\\x1b@'), [0x1b, 0x40]);
  assert.deepEqual(parseRawInput('\\e@'), [0x1b, 0x40]);
  assert.deepEqual(parseRawInput('hello'), [104, 101, 108, 108, 111]);
  assert.deepEqual(parseRawInput('hi\\n'), [104, 105, 10]);
  assert.deepEqual(parseRawInput('\\r\\t\\0\\\\'), [13, 9, 0, 92]);
  // explicit modes
  assert.deepEqual(parseRawInput('1B 40', 'hex'), [0x1b, 0x40]);
  assert.deepEqual(parseRawInput('1B 40', 'text'), [49, 66, 32, 52, 48]);
  assert.deepEqual(parseRawInput('', 'auto'), []);
  assert.deepEqual(parseRawInput(null), []);
  // a single hex-looking token is ambiguous, so it stays text
  assert.deepEqual(parseRawInput('1B'), [49, 66]);
  // BUG (reported to the lead, not fixed here): the auto detector accepts a
  // compact 4-hex-digit token such as "1B40" as hex, but bytesFromHex() parses
  // it as one 16-bit number and truncates it to 0x40, so the console sends a
  // single wrong byte. See the skipped test below for the wanted result.
  assert.deepEqual(parseRawInput('1B40'), [0x40]);
});

// Documents a bug found in assets/js/core/commands.js (owned by the lead, not
// patched here): bytesFromHex() must decode hex two digits at a time.
// Un-skip once the core module is fixed.
test('BUG: compact hex input "1B40" should decode as two bytes', { skip: 'reported to the lead - bytesFromHex() truncates unseparated hex to one byte' }, () => {
  assert.deepEqual(parseRawInput('1B40'), [0x1b, 0x40]);
  assert.deepEqual(bytesFromHex('1B40'), [0x1b, 0x40]);
});

test('bytesFromText, bytesFromHex and the preview helpers agree', () => {
  assert.deepEqual(bytesFromText('AB'), [65, 66]);
  assert.deepEqual(bytesFromText('\\x41\\x42'), [65, 66]);
  assert.deepEqual(bytesFromText('\\X41'), [65]);
  assert.deepEqual(bytesFromText('\\q'), [92, 113], 'an unknown escape keeps the backslash');
  assert.deepEqual(bytesFromText('\\xZZ'), [92, 120, 90, 90], 'a malformed escape keeps the literal text');
  assert.deepEqual(bytesFromText('\\n\\r\\t\\e\\0'), [10, 13, 9, 27, 0]);
  // non-ASCII characters are UTF-8 encoded
  assert.deepEqual(bytesFromText('\u00e9'), [0xc3, 0xa9]);
  assert.deepEqual(bytesFromText('\u0633'), [0xd8, 0xb3]);

  assert.deepEqual(bytesFromHex('1B 40 1D 56 00'), [0x1b, 0x40, 0x1d, 0x56, 0x00]);
  assert.deepEqual(bytesFromHex('0x1b,0x40'), [0x1b, 0x40]);
  assert.deepEqual(bytesFromHex(''), []);
  assert.deepEqual(bytesFromHex('FF'), [0xff]);

  assert.equal(toHex([0, 15, 255]), '00 0F FF');
  assert.equal(toAscii([0x41, 0x42, 0x00, 0x1b, 0x7f]), 'AB...');
  assert.deepEqual([...toUint8([0x1ff, -1, 256])], [0xff, 0xff, 0x00]);
  assert.ok(toUint8([1, 2, 3]) instanceof Uint8Array);
  assert.equal(toAscii([]), '');
  assert.equal(toHex([]), '');
});

test('round trip: every supported action payload survives hex encoding', () => {
  for (const lang of LANGUAGES) {
    for (const action of actionsForLanguage(lang.id)) {
      if (!action.supported) continue;
      const result = cmd(lang.id, action.id);
      assert.deepEqual(bytesFromHex(result.hex), result.bytes, `${lang.id}/${action.id}: hex round trip`);
      assert.deepEqual([...toUint8(result.bytes)], result.bytes, `${lang.id}/${action.id}: uint8 round trip`);
    }
  }
});
