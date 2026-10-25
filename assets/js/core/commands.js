/**
 * Arsin Print Server - printer command library (pure).
 *
 * A vendor-neutral catalogue of printer languages (ESC/POS, ZPL, EPL, TSPL,
 * CPCL, StarPRNT, ESC/P, IPL, DPL, plain) together with the maintenance and
 * troubleshooting commands each of them understands: self test, status query,
 * media calibration, print-head / nozzle check, counter reset, darkness and
 * factory reset. Every builder returns raw bytes so the same code path can be
 * used for the web console, the ESP32 bridge and the Raspberry Pi service.
 */

/* ------------------------------------------------------------------ helpers */

/** ASCII / escape sequence -> byte array. Supports \xNN, \n, \r, \t, \e. */
export function bytesFromText(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === 'x' || next === 'X') {
        const hex = text.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      if (next === 'n') { out.push(10); i++; continue; }
      if (next === 'r') { out.push(13); i++; continue; }
      if (next === 't') { out.push(9); i++; continue; }
      if (next === 'e') { out.push(27); i++; continue; }
      if (next === '0') { out.push(0); i++; continue; }
      if (next === '\\') { out.push(92); i++; continue; }
    }
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else out.push(...new TextEncoder().encode(ch));
  }
  return out;
}

/** "1B 40 1D 56 00" (or "0x1B,0x40") -> byte array. */
export function bytesFromHex(text) {
  return String(text)
    .replace(/0x/gi, '')
    .split(/[^0-9a-fA-F]+/)
    .filter(Boolean)
    .map((h) => parseInt(h, 16) & 0xff);
}

export function toHex(bytes) {
  return [...bytes].map((b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function toAscii(bytes) {
  return [...bytes].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
}

export function toUint8(bytes) {
  return Uint8Array.from([...bytes].map((b) => b & 0xff));
}

/** ZPL / TSPL / CPCL style builders return text, converted to bytes. */
function t(s) {
  return bytesFromText(s);
}

function concat(...chunks) {
  const out = [];
  for (const c of chunks) out.push(...(Array.isArray(c) ? c : bytesFromText(String(c))));
  return out;
}

/* ------------------------------------------------------------- action model */

/**
 * Canonical maintenance / troubleshooting actions. Languages advertise a
 * subset of these and provide the byte builder for each one.
 */
export const ACTIONS = [
  { id: 'selftest', name: 'Self test page', group: 'test', desc: 'Print the printer internal self test / configuration page.' },
  { id: 'status', name: 'Status query', group: 'status', desc: 'Ask the printer for its current status (paper, cover, error).' },
  { id: 'config', name: 'Dump configuration', group: 'status', desc: 'Print or return the active device configuration.' },
  { id: 'initialize', name: 'Initialise / reset buffer', group: 'maintenance', desc: 'Clear the receive buffer and reset printing parameters.' },
  { id: 'feed', name: 'Feed media', group: 'maintenance', desc: 'Advance the paper by a number of lines or dots.' },
  { id: 'cut', name: 'Cut / form feed', group: 'maintenance', desc: 'Cut the receipt (or issue a form feed on impact printers).' },
  { id: 'drawer', name: 'Kick cash drawer', group: 'maintenance', desc: 'Send the drawer kick pulse on the DK / drawer port.' },
  { id: 'headclean', name: 'Print head cleaning', group: 'maintenance', desc: 'Run the print-head cleaning routine / cleaning reminder test.' },
  { id: 'nozzlecheck', name: 'Nozzle check pattern', group: 'maintenance', desc: 'Print a nozzle / head test pattern to detect clogged jets.' },
  { id: 'align', name: 'Alignment test', group: 'maintenance', desc: 'Print an alignment / paper-sensor calibration pattern.' },
  { id: 'calibrate', name: 'Media calibration', group: 'maintenance', desc: 'Auto-calibrate the gap / black-mark / label sensor.' },
  { id: 'counter', name: 'Read counters', group: 'status', desc: 'Read the internal print counters (lifetime, trip, cutter).' },
  { id: 'resetcounter', name: 'Reset counters', group: 'maintenance', desc: 'Reset the trip / maintenance counters to zero.' },
  { id: 'density', name: 'Set darkness / density', group: 'config', desc: 'Change the print darkness, speed and temperature.' },
  { id: 'media', name: 'Set media type', group: 'config', desc: 'Select continuous, gap (die-cut) or black-mark media.' },
  { id: 'saveconfig', name: 'Save settings', group: 'config', desc: 'Persist the current settings to the printer EEPROM.' },
  { id: 'factoryreset', name: 'Factory reset', group: 'config', desc: 'Restore factory defaults (settings only, counters kept).' },
  { id: 'info', name: 'Device info / serial', group: 'status', desc: 'Request model, firmware version and serial number.' },
  { id: 'barcodetest', name: 'Barcode test', group: 'test', desc: 'Print one of every supported barcode to verify decoding.' }
];

export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

/** Common parameter descriptors reused by many builders. */
export const PARAMS = {
  lines: { id: 'lines', label: 'Lines / dots', type: 'number', default: 3, min: 1, max: 255 },
  copies: { id: 'copies', label: 'Copies', type: 'number', default: 1, min: 1, max: 20 },
  darkness: { id: 'darkness', label: 'Darkness (0-15)', type: 'number', default: 8, min: 0, max: 15 },
  speed: { id: 'speed', label: 'Speed (ips)', type: 'number', default: 4, min: 1, max: 14 },
  media: {
    id: 'media',
    label: 'Media type',
    type: 'select',
    default: 'gap',
    options: [
      { value: 'gap', label: 'Gap / die-cut label' },
      { value: 'blackmark', label: 'Black mark' },
      { value: 'continuous', label: 'Continuous' }
    ]
  },
  cutter: {
    id: 'cutter',
    label: 'Cut mode',
    type: 'select',
    default: 'full',
    options: [
      { value: 'full', label: 'Full cut' },
      { value: 'partial', label: 'Partial cut' }
    ]
  },
  pattern: {
    id: 'pattern',
    label: 'Pattern',
    type: 'select',
    default: 'standard',
    options: [
      { value: 'standard', label: 'Standard grid' },
      { value: 'full', label: 'Solid fill (head test)' },
      { value: 'barcode', label: 'Barcode matrix' }
    ]
  }
};

/* ------------------------------------------------------------- ESC/POS --- */

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;

/** Confidence levels: how portable a byte sequence is across vendors. */
export const CONFIDENCE = {
  standard: 'Documented standard command, works on compliant printers.',
  vendor: 'Vendor extension - works on most models of this brand, verify on your unit.',
  approximate: 'Best-effort sequence. Printers vary; use the front panel if it has no effect.'
};

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const ESCPOS = {
  selftest: {
    params: [],
    confidence: 'vendor',
    note: 'GS ( A: execute printer test (mechanism self test + status sheet on Epson-compatible units).',
    bytes: () => [ESC, 0x40, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x00]
  },
  status: {
    params: [],
    confidence: 'standard',
    note: 'DLE EOT 1 (printer status) + GS r 1 (transmit status). The bridge reads the reply back.',
    bytes: () => [DLE, 0x04, 0x01, GS, 0x72, 0x01]
  },
  config: {
    params: [],
    confidence: 'vendor',
    note: 'GS ( A with m=1 prints the status/configuration sheet.',
    bytes: () => [ESC, 0x40, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x01]
  },
  initialize: { params: [], confidence: 'standard', bytes: () => [ESC, 0x40] },
  feed: { params: [PARAMS.lines], confidence: 'standard', bytes: (p) => [ESC, 0x64, clamp(p.lines, 1, 255)] },
  cut: {
    params: [PARAMS.cutter],
    confidence: 'standard',
    note: 'ESC d 3 then GS V m - requires a cutter model.',
    bytes: (p) => [ESC, 0x64, 0x03, GS, 0x56, p.cutter === 'partial' ? 0x01 : 0x00]
  },
  drawer: {
    params: [],
    confidence: 'vendor',
    note: 'ESC p 0 25 250 - drawer kick pulse on pin 2.',
    bytes: () => [ESC, 0x70, 0x00, 0x19, 0xfa]
  },
  headclean: {
    params: [],
    confidence: 'approximate',
    note: 'Thermal heads have no cleaning routine. This prints a head-wear/cleaning test pattern; clean the head with isopropyl alcohol afterwards.',
    bytes: () => [ESC, 0x40, ...testPattern('ESC/POS head test')]
  },
  nozzlecheck: {
    params: [],
    confidence: 'approximate',
    note: 'Prints a 12x6 nozzle grid. Inkjet models that expose a native nozzle check usually do it from the front panel.',
    bytes: () => [ESC, 0x40, ...testPattern('Nozzle check')]
  },
  align: {
    params: [],
    confidence: 'approximate',
    bytes: () => [ESC, 0x40, ...testPattern('Alignment / paper sensor')]
  },
  calibrate: {
    params: [PARAMS.media],
    confidence: 'vendor',
    note: 'Thermal receipt printers auto-calibrate on power-up; this issues the media-sensor preset where supported.',
    bytes: (p) => [ESC, 0x40, GS, 0x28, 0x45, 0x02, 0x00, 0x00, p.media === 'blackmark' ? 0x02 : 0x01]
  },
  counter: {
    params: [],
    confidence: 'vendor',
    note: 'GS ( A test sheet includes the lifetime print counter on most models.',
    bytes: () => [ESC, 0x40, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x01]
  },
  resetcounter: {
    params: [],
    confidence: 'vendor',
    note: 'GS ( X 6 0 0 0 0 0 - resets the trip counters on models that implement it. Some units require a maintenance password.',
    bytes: () => [ESC, 0x40, GS, 0x28, 0x58, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00]
  },
  density: {
    params: [PARAMS.darkness],
    confidence: 'vendor',
    note: 'GS ( K style density/heat setting; also used as a darkness hint by the print pipeline.',
    bytes: (p) => [ESC, 0x40, GS, 0x28, 0x4b, 0x02, 0x00, 0x30, clamp(p.darkness, 0, 15)]
  },
  media: {
    params: [PARAMS.media],
    confidence: 'vendor',
    bytes: (p) => [ESC, 0x40, GS, 0x28, 0x45, 0x02, 0x00, 0x00, p.media === 'blackmark' ? 0x02 : p.media === 'continuous' ? 0x03 : 0x01]
  },
  saveconfig: {
    params: [],
    confidence: 'vendor',
    note: 'Stores the current settings in the printer NV memory.',
    bytes: () => [ESC, 0x40, GS, 0x28, 0x4b, 0x02, 0x00, 0x31, 0x01]
  },
  factoryreset: {
    params: [],
    confidence: 'vendor',
    note: 'GS ( X 4 0 0 0 - resets parameters (and counters on some models) to factory values.',
    bytes: () => [ESC, 0x40, GS, 0x28, 0x58, 0x04, 0x00, 0x00, 0x00]
  },
  info: {
    params: [],
    confidence: 'vendor',
    note: 'GS I / GS ( A - device id and configuration sheet.',
    bytes: () => [ESC, 0x40, GS, 0x49, 0x31, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x01]
  },
  barcodetest: {
    params: [],
    confidence: 'vendor',
    note: 'Prints CODE39, EAN13, CODE128 and a QR code for scanner verification.',
    bytes: () => [ESC, 0x40, ...barcodeSheet()]
  }
};

/** Human readable test pattern drawn with ESC/POS text commands. */
function testPattern(title) {
  const out = [ESC, 0x61, 0x01, ESC, 0x21, 0x10];
  out.push(...t(`${title}\n`));
  out.push(ESC, 0x21, 0x00);
  out.push(...t('--------------------------------\n'));
  for (let row = 0; row < 6; row++) {
    out.push(...t('|'));
    for (let col = 0; col < 12; col++) out.push(...t(row % 2 === col % 2 ? '# ' : '. '));
    out.push(...t('|\n'));
  }
  out.push(...t('--------------------------------\n'));
  out.push(ESC, 0x64, 0x04, ESC, 0x61, 0x00);
  return out;
}

/** CODE39 + EAN13 + CODE128 + QR test sheet. */
function barcodeSheet() {
  const out = [ESC, 0x61, 0x01];
  const codes = [
    { hri: 'CODE39', data: 'ARSIN123', cmd: [GS, 0x68, 0x28, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6b, 0x04] },
    { hri: 'EAN13', data: '400638133393', cmd: [GS, 0x68, 0x50, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6b, 0x02] },
    { hri: 'CODE128', data: '{BARSIN128', cmd: [GS, 0x68, 0x50, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6b, 0x49] }
  ];
  for (const c of codes) {
    out.push(...t(`${c.hri}\n`));
    out.push(...c.cmd, ...t(`${c.data}\0`));
  }
  out.push(...t('QR CODE\n'));
  out.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06);
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);
  out.push(GS, 0x28, 0x6b, 0x0a, 0x00, 0x31, 0x50, 0x30, ...t('ARSIN-PS\0'));
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
  out.push(ESC, 0x64, 0x04, ESC, 0x61, 0x00);
  return out;
}

/* ------------------------------------------------------------------ ZPL --- */

/** ZPL label printer test/calibration pattern. */
function zplPattern(title, lines) {
  const rows = lines || 8;
  let s = '^XA^CI28^PW600^LL400^FO30,30^A0N,32,32^FD' + title + '^FS';
  for (let i = 0; i < rows; i++) {
    s += `^FO30,${80 + i * 32}^A0N,24,24^FD${String(i + 1).padStart(2, '0')} |................................|^FS`;
  }
  s += '^FO30,380^GB540,4,4^FS^PQ1^XZ';
  return t(s);
}

const ZPL = {
  selftest: {
    params: [],
    confidence: 'standard',
    note: '~WC prints the configuration / network status label.',
    bytes: () => t('~WC')
  },
  status: {
    params: [],
    confidence: 'standard',
    note: '~HQES returns the host error status string on the same port.',
    bytes: () => t('~HQES')
  },
  config: { params: [], confidence: 'standard', note: '~WC + ~HS (host status).', bytes: () => t('~WC~HS') },
  initialize: { params: [], confidence: 'standard', note: '~JR = power-on reset.', bytes: () => t('~JR') },
  feed: { params: [PARAMS.lines], confidence: 'standard', note: 'Prints blank labels.', bytes: (p) => t(`^XA^FD^FS^PQ${clamp(p.lines, 1, 255)}^XZ`) },
  cut: { params: [], confidence: 'standard', note: '^MMC = cutter mode (requires a cutter).', bytes: () => t('^XA^MMC,Y^XZ') },
  headclean: {
    params: [],
    confidence: 'approximate',
    note: 'Thermal transfer heads are cleaned with a cleaning pen/card. This prints a head test pattern instead.',
    bytes: () => zplPattern('HEAD TEST', 12)
  },
  nozzlecheck: {
    params: [],
    confidence: 'approximate',
    note: 'Direct thermal / thermal transfer models have no nozzle check; the pattern verifies every dot row.',
    bytes: () => zplPattern('DOT ROW TEST', 16)
  },
  align: { params: [], confidence: 'vendor', note: '^ML sets the maximum label length used during calibration.', bytes: () => t('^XA^ML^XZ') },
  calibrate: { params: [], confidence: 'standard', note: '~JC auto-calibrates media length and sensor.', bytes: () => t('~JC') },
  counter: {
    params: [],
    confidence: 'standard',
    note: '~HS host status: the 2nd string contains the label / kms counters.',
    bytes: () => t('~HS')
  },
  resetcounter: {
    params: [],
    confidence: 'approximate',
    note: 'ZPL has no documented counter reset. Use the printer panel: MENU > TOOLS/DIAGNOSTICS > Reset counters.',
    bytes: () => t('~JR')
  },
  density: { params: [PARAMS.darkness], confidence: 'standard', note: '~SD sets darkness 0-30.', bytes: (p) => t(`~SD${clamp(p.darkness * 2, 0, 30)}`) },
  speed: { params: [PARAMS.speed], confidence: 'standard', bytes: (p) => t(`^XA^PR${clamp(p.speed, 1, 14)}^XZ`) },
  media: {
    params: [PARAMS.media],
    confidence: 'standard',
    note: '^MN media tracking: Y = non-continuous (gap), N = continuous, M = mark.',
    bytes: (p) => t(`^XA^MN${p.media === 'continuous' ? 'N' : p.media === 'blackmark' ? 'M' : 'Y'}^XZ`)
  },
  saveconfig: { params: [], confidence: 'standard', note: '^JUS stores settings to EEPROM.', bytes: () => t('^XA^JUS^XZ') },
  factoryreset: { params: [], confidence: 'standard', note: '^JUR restores factory defaults.', bytes: () => t('^XA^JUR^XZ') },
  info: { params: [], confidence: 'standard', note: '~HI returns model and firmware, ~HS the host status.', bytes: () => t('~HI~HS') },
  barcodetest: {
    params: [],
    confidence: 'standard',
    bytes: () =>
      t(
        '^XA^CI28^FO30,30^A0N,28,28^FDCODE128^FS^FO30,70^BCN,90,Y,N,N^FDARSIN128^FS' +
          '^FO30,180^A0N,28,28^FDEAN13^FS^FO30,220^BEN,80,Y,N^FD400638133393^FS' +
          '^FO330,70^A0N,28,28^FDQR^FS^FO330,110^BQN,2,6^FDLA,ARSIN-PS^FS' +
          '^FO330,300^A0N,28,28^FDDATAMATRIX^FS^FO330,330^BXN,6,200^FDARSIN-PS^FS^XZ'
      )
  }
};


/* ------------------------------------------------------------------ EPL --- */

const EPL = {
  selftest: { params: [], confidence: 'standard', note: 'U prints the configuration / self test label.', bytes: () => t('U\n') },
  status: { params: [], confidence: 'vendor', note: 'ESC ? queries the printer status.', bytes: () => [0x1b, 0x3f] },
  config: { params: [], confidence: 'standard', bytes: () => t('U\n') },
  initialize: { params: [], confidence: 'standard', note: 'N clears the image buffer.', bytes: () => t('N\n') },
  feed: { params: [PARAMS.lines], confidence: 'standard', note: 'Prints blank labels.', bytes: (p) => t(`N\nQ${clamp(p.lines, 1, 50) * 200},25\nP${clamp(p.lines, 1, 50)}\n`) },
  cut: { params: [], confidence: 'vendor', note: 'Cutter-equipped EPL models cut after P with the cutter enabled in the panel.', bytes: () => t('N\nP1\n') },
  calibrate: { params: [], confidence: 'standard', note: 'Z = calibrate sensor (gap / black mark).', bytes: () => t('Z\n') },
  align: { params: [], confidence: 'standard', bytes: () => t('Z\n') },
  density: { params: [PARAMS.darkness], confidence: 'standard', note: 'D sets density -15..+15.', bytes: (p) => t(`D${clamp(p.darkness - 8, -15, 15)}\n`) },
  speed: { params: [PARAMS.speed], confidence: 'standard', bytes: (p) => t(`S${clamp(p.speed, 1, 6)}\n`) },
  media: {
    params: [PARAMS.media],
    confidence: 'standard',
    note: 'o = continuous, Q with gap values = die-cut, b = black mark.',
    bytes: (p) => t(p.media === 'continuous' ? 'o\n' : p.media === 'blackmark' ? 'b\n' : 'o\nQ200,25\n')
  },
  saveconfig: { params: [], confidence: 'vendor', bytes: () => t('U\n') },
  factoryreset: { params: [], confidence: 'vendor', note: 'e restores factory defaults on EPL2 units.', bytes: () => t('e\n') },
  counter: { params: [], confidence: 'vendor', note: 'The self test label (U) lists the odometer / counters.', bytes: () => t('U\n') },
  resetcounter: {
    params: [],
    confidence: 'approximate',
    note: 'No EPL command; use the panel diagnostics menu to zero the counters.',
    bytes: () => t('U\n')
  },
  info: { params: [], confidence: 'standard', bytes: () => t('U\n') },
  barcodetest: {
    params: [],
    confidence: 'vendor',
    bytes: () =>
      t('N\nq400\nQ400,25\nA20,20,0,3,1,1,N,"EPL BARCODE TEST"\nB20,60,0,1,2,6,60,B,"ARSIN128"\nB20,160,0,1,1,4,80,B,"123456789"\nP1\n')
  }
};

/* ----------------------------------------------------------------- TSPL --- */

function mediaTspl(media) {
  if (media === 'continuous') return 'GAP 0 mm,0\n';
  if (media === 'blackmark') return 'BLINE 3 mm,0\n';
  return 'GAP 2 mm,0\n';
}

function tsplPattern(title) {
  let s = 'SIZE 60 mm,40 mm\nGAP 2 mm,0\nCLS\nTEXT 20,20,"3",0,1,1,"' + title + '"\n';
  for (let i = 0; i < 6; i++) s += `BAR 20,${60 + i * 20},8,${20 + i * 60}\n`;
  s += 'PRINT 1\n';
  return t(s);
}

const TSPL = {
  selftest: { params: [], confidence: 'standard', note: 'ESC ! ? prints the TSPL self test page.', bytes: () => [0x1b, 0x21, 0x3f] },
  status: { params: [], confidence: 'vendor', note: '~!@ returns the printer status string.', bytes: () => t('~!@') },
  config: { params: [], confidence: 'standard', bytes: () => [0x1b, 0x21, 0x3f] },
  initialize: { params: [], confidence: 'standard', note: 'ESC @ initialises the printer.', bytes: () => [0x1b, 0x40] },
  feed: { params: [PARAMS.lines], confidence: 'standard', bytes: (p) => t(`FEED ${clamp(p.lines, 1, 255)}\n`) },
  cut: { params: [], confidence: 'standard', note: 'CUT triggers the optional cutter.', bytes: () => t('CUT\n') },
  headclean: {
    params: [],
    confidence: 'approximate',
    note: 'No native head cleaning; prints a head test pattern. Clean the head with an alcohol swab.',
    bytes: () => tsplPattern('HEAD TEST')
  },
  nozzlecheck: { params: [], confidence: 'approximate', bytes: () => tsplPattern('DOT ROW TEST') },
  align: { params: [], confidence: 'vendor', note: 'AUTODETECT calibrates and prints the sensor values.', bytes: () => t('AUTODETECT\n') },
  calibrate: { params: [PARAMS.media], confidence: 'standard', note: 'GAP/BLINE plus AUTODETECT.', bytes: (p) => t(`${mediaTspl(p.media)}AUTODETECT\n`) },
  counter: { params: [], confidence: 'vendor', note: '~!I returns the printer information block.', bytes: () => t('~!I') },
  resetcounter: {
    params: [],
    confidence: 'approximate',
    note: 'Not exposed by TSPL. Power on while holding FEED, then reset counters from the panel.',
    bytes: () => t('~!I')
  },
  density: { params: [PARAMS.darkness], confidence: 'standard', bytes: (p) => t(`DENSITY ${clamp(p.darkness, 0, 15)}\n`) },
  speed: { params: [PARAMS.speed], confidence: 'standard', bytes: (p) => t(`SPEED ${clamp(p.speed, 1, 14)}\n`) },
  media: { params: [PARAMS.media], confidence: 'standard', bytes: (p) => t(mediaTspl(p.media)) },
  saveconfig: { params: [], confidence: 'vendor', note: 'TSPL settings persist immediately after SET commands.', bytes: () => t('SET TEAR ON\n') },
  factoryreset: {
    params: [],
    confidence: 'approximate',
    note: 'Hold FEED + PAUSE while powering on, then use the panel INITIALIZE menu.',
    bytes: () => t('SET TEAR ON\n')
  },
  info: { params: [], confidence: 'vendor', bytes: () => t('~!I') },
  barcodetest: {
    params: [],
    confidence: 'standard',
    bytes: () =>
      t(
        'SIZE 60 mm,60 mm\nGAP 2 mm,0\nCLS\nTEXT 20,20,"3",0,1,1,"TSPL BARCODE TEST"\n' +
          'BARCODE 20,60,"128",80,1,0,2,4,"ARSIN128"\nBARCODE 20,180,"EAN13",80,1,0,2,4,"400638133393"\n' +
          'QRCODE 20,300,M,6,A,0,"ARSIN-PS"\nPRINT 1\n'
      )
  }
};


/* ----------------------------------------------------------------- CPCL --- */

const CPCL = {
  selftest: { params: [], confidence: 'vendor', note: 'SELF-TEST via the CPCL ! U1 do command (firmware 2.x+).', bytes: () => t('! U1 do "device.selftest" ""\r\n') },
  status: { params: [], confidence: 'vendor', note: '! U1 getvar returns the value on the same port.', bytes: () => t('! U1 getvar "device.status"\r\n') },
  config: { params: [], confidence: 'vendor', bytes: () => t('! U1 getvar "allcv"\r\n') },
  initialize: { params: [], confidence: 'standard', note: 'CPCL form reset.', bytes: () => t('\r\n! 0 200 200 210 1\r\n') },
  feed: { params: [PARAMS.lines], confidence: 'standard', bytes: (p) => t(`! 0 200 200 ${clamp(p.lines, 1, 60) * 100} 1\r\nFORM\r\nPRINT\r\n`) },
  cut: { params: [], confidence: 'vendor', note: '! U1 setvar cutter mode.', bytes: () => t('! U1 setvar "cutter.mode" "cut-after-label"\r\n') },
  calibrate: { params: [], confidence: 'vendor', note: '! U1 do "media.calibrate".', bytes: () => t('! U1 do "media.calibrate" ""\r\n') },
  density: { params: [PARAMS.darkness], confidence: 'vendor', bytes: (p) => t(`! U1 setvar "print.tone" "${clamp(p.darkness * 8, 0, 120)}"\r\n`) },
  media: {
    params: [PARAMS.media],
    confidence: 'vendor',
    bytes: (p) => t(`! U1 setvar "media.type" "${p.media === 'continuous' ? 'journal' : p.media === 'blackmark' ? 'mark' : 'label'}"\r\n`)
  },
  saveconfig: { params: [], confidence: 'vendor', note: '! U1 do "device.save_settings".', bytes: () => t('! U1 do "device.save_settings" ""\r\n') },
  factoryreset: { params: [], confidence: 'vendor', note: '! U1 do "device.restore_defaults".', bytes: () => t('! U1 do "device.restore_defaults" ""\r\n') },
  counter: { params: [], confidence: 'vendor', bytes: () => t('! U1 getvar "odometer.total_label_count"\r\n') },
  resetcounter: { params: [], confidence: 'vendor', note: '! U1 setvar odometer.trip_reset.', bytes: () => t('! U1 setvar "odometer.trip_reset" "1"\r\n') },
  info: { params: [], confidence: 'vendor', bytes: () => t('! U1 getvar "appl.name"\r\n! U1 getvar "device.friendly_name"\r\n! U1 getvar "appl.version"\r\n') },
  barcodetest: {
    params: [],
    confidence: 'standard',
    bytes: () =>
      t(
        '! 0 200 200 400 1\r\n' +
          'TEXT 4 0 30 30 CPCL BARCODE TEST\r\n' +
          'BARCODE 128 2 1 80 30 80 90 ARSIN128\r\n' +
          'BARCODE EAN13 2 1 80 30 190 140 400638133393\r\n' +
          'BARCODE QR 2 1 80 30 270 M 1 U 6 ARSIN-PS\r\n' +
          'PRINT\r\n'
      )
  }
};

/* -------------------------------------------------------------- StarPRNT --- */

const STARPRNT = {
  selftest: { params: [], confidence: 'standard', note: 'ESC * r A - print test page (Star Line Mode).', bytes: () => [0x1b, 0x2a, 0x72, 0x41] },
  status: { params: [], confidence: 'standard', note: 'ESC ACK SOH requests the Star status block.', bytes: () => [0x1b, 0x06, 0x01] },
  config: { params: [], confidence: 'standard', note: 'ESC * r P - print current settings.', bytes: () => [0x1b, 0x2a, 0x72, 0x50] },
  initialize: { params: [], confidence: 'standard', note: 'ESC @ initialise.', bytes: () => [0x1b, 0x40] },
  feed: { params: [PARAMS.lines], confidence: 'standard', note: 'ESC a n - feed n lines.', bytes: (p) => [0x1b, 0x61, clamp(p.lines, 1, 255)] },
  cut: { params: [], confidence: 'standard', note: 'ESC d 3 - full cut with feed.', bytes: () => [0x1b, 0x64, 0x03] },
  drawer: { params: [], confidence: 'standard', note: 'BEL - drawer kick.', bytes: () => [0x07] },
  density: { params: [PARAMS.darkness], confidence: 'vendor', bytes: (p) => [0x1b, 0x2a, 0x72, 0x44, clamp(p.darkness, 0, 15)] },
  calibrate: { params: [PARAMS.media], confidence: 'vendor', note: 'ESC * r F - sensor calibration / feed button equivalent.', bytes: () => [0x1b, 0x2a, 0x72, 0x46] },
  headclean: {
    params: [],
    confidence: 'vendor',
    note: 'ESC * r C is used by some Star models for the cleaning routine; verify on your unit.',
    bytes: () => [0x1b, 0x2a, 0x72, 0x43]
  },
  nozzlecheck: { params: [], confidence: 'approximate', note: 'Prints a Star Line Mode nozzle/head grid.', bytes: () => [0x1b, 0x40, ...testPattern('Star head test')] },
  align: { params: [], confidence: 'approximate', bytes: () => [0x1b, 0x40, ...testPattern('Star alignment')] },
  counter: { params: [], confidence: 'standard', note: 'ESC * r A test page lists the counters.', bytes: () => [0x1b, 0x2a, 0x72, 0x41] },
  resetcounter: {
    params: [],
    confidence: 'approximate',
    note: 'Counter reset needs the Star utility / panel. The bridge cannot zero it on all models.',
    bytes: () => [0x1b, 0x2a, 0x72, 0x41]
  },
  saveconfig: { params: [], confidence: 'vendor', bytes: () => [0x1b, 0x2a, 0x72, 0x50] },
  factoryreset: { params: [], confidence: 'approximate', note: 'Hold the FEED button while powering on to restore defaults.', bytes: () => [0x1b, 0x2a, 0x72, 0x50] },
  info: { params: [], confidence: 'standard', bytes: () => [0x1b, 0x2a, 0x72, 0x49] },
  barcodetest: { params: [], confidence: 'vendor', note: 'Star barcode commands (ESC b).', bytes: () => [0x1b, 0x40, 0x1b, 0x62, 0x31, 0x02, 0x02, 0x32, 0x41, 0x52, 0x53, 0x49, 0x4e, 0x31, 0x32, 0x38, 0x00, 0x1b, 0x64, 0x03] }
};


/* ---------------------------------------------------- ESC/P (impact/inkjet) */

const ESCP = {
  selftest: {
    params: [],
    confidence: 'approximate',
    note: 'Impact printers run their self test from the panel (hold LF while powering on). This prints an ASCII pattern page instead.',
    bytes: () => [0x1b, 0x40, ...t('ESC/P SELF TEST\n'), ...t('='.repeat(48) + '\n'), ...t('!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`\n'), 0x0c]
  },
  config: { params: [], confidence: 'approximate', bytes: () => [0x1b, 0x40, ...t('ESC/P current settings dump\n'), 0x0c] },
  initialize: { params: [], confidence: 'standard', note: 'ESC @ initialise; FF (0x0C) ejects the page.', bytes: () => [0x1b, 0x40] },
  feed: { params: [PARAMS.lines], confidence: 'standard', note: 'ESC 0 (1/8 inch) then n LF.', bytes: (p) => [0x1b, 0x30, ...Array(clamp(p.lines, 1, 255)).fill(0x0a)] },
  cut: { params: [], confidence: 'approximate', note: 'Form feed - impact printers have no cutter.', bytes: () => [0x0c] },
  headclean: {
    params: [],
    confidence: 'approximate',
    note: 'Inkjet head cleaning is firmware/vendor specific. Use the vendor utility; this prints a cleaning/pattern page so you can verify improvement.',
    bytes: () => [0x1b, 0x40, ...t('HEAD CLEANING VERIFICATION PAGE\n'), ...testPattern('Nozzle grid')]
  },
  nozzlecheck: {
    params: [],
    confidence: 'approximate',
    note: 'Prints a nozzle grid. Epson/Canon native nozzle checks are triggered from the panel or vendor utility.',
    bytes: () => [0x1b, 0x40, ...testPattern('Nozzle grid')]
  },
  align: { params: [], confidence: 'approximate', bytes: () => [0x1b, 0x40, ...testPattern('Alignment grid')] },
  density: { params: [PARAMS.darkness], confidence: 'approximate', note: 'Inkjet density is not settable over ESC/P; recorded as a driver hint.', bytes: () => [0x1b, 0x40] },
  counter: { params: [], confidence: 'approximate', note: 'Impact printers keep mechanical counters only. Read them from the panel.', bytes: () => [0x1b, 0x40] },
  resetcounter: {
    params: [],
    confidence: 'approximate',
    note: 'No ESC/P counter reset. Impact printers use a mechanical/service counter reset by a technician.',
    bytes: () => [0x1b, 0x40]
  },
  saveconfig: { params: [], confidence: 'approximate', bytes: () => [0x1b, 0x40] },
  factoryreset: {
    params: [],
    confidence: 'approximate',
    note: 'Inkjet factory reset requires the panel/service mode (e.g. Epson: hold Stop+Power, then maintenance menu).',
    bytes: () => [0x1b, 0x40]
  },
  info: { params: [], confidence: 'approximate', note: 'ESC/P has no standard device-info query; print the config page.', bytes: () => [0x1b, 0x40, ...t('DEVICE INFO: see the panel / vendor utility\n'), 0x0c] },
  barcodetest: { params: [], confidence: 'approximate', note: 'Impact printers cannot print barcodes without a graphics pass.', bytes: () => [0x1b, 0x40, ...t('BARCODE TEST NOT SUPPORTED IN TEXT MODE\n'), 0x0c] }
};

/* ------------------------------------------------------------ IPL / DPL --- */

const IPL = {
  selftest: { params: [], confidence: 'approximate', note: 'IPL test label. IPL firmware revisions vary - verify on your unit.', bytes: () => [0x02, 0x1b, 0x45, 0x01, 0x0d] },
  status: { params: [], confidence: 'approximate', note: 'IPL status request.', bytes: () => [0x02, 0x1b, 0x45, 0x00, 0x0d] },
  initialize: { params: [], confidence: 'approximate', note: 'Start a new IPL label / clear the buffer.', bytes: () => [0x02, 0x1b, 0x4c, 0x0d] },
  feed: { params: [PARAMS.lines], confidence: 'approximate', bytes: (p) => [0x02, 0x1b, 0x46, clamp(p.lines, 1, 99), 0x0d] },
  config: { params: [], confidence: 'approximate', bytes: () => [0x02, 0x1b, 0x45, 0x01, 0x0d] },
  counter: { params: [], confidence: 'approximate', note: 'Use the IPL raw console: <STX><ESC>E... or the printer web page.', bytes: () => [0x02, 0x1b, 0x45, 0x00, 0x0d] }
};

const DPL = {
  selftest: { params: [], confidence: 'approximate', note: 'Datamax DPL configuration/test label (Kc command).', bytes: () => t('\x02Kc01\r') },
  status: { params: [], confidence: 'approximate', note: 'DPL status query.', bytes: () => t('\x02S\r') },
  initialize: { params: [], confidence: 'approximate', note: 'Start a DPL label.', bytes: () => t('\x02L\r') },
  feed: { params: [PARAMS.lines], confidence: 'approximate', bytes: (p) => t(`\x02L\rP${clamp(p.lines, 1, 99)}\r`) },
  config: { params: [], confidence: 'approximate', bytes: () => t('\x02Kc01\r') },
  counter: { params: [], confidence: 'approximate', note: 'DPL counters are read from the test label or the raw console.', bytes: () => t('\x02Kc01\r') }
};

/* ----------------------------------------------------------------- plain --- */

const PLAIN = {
  selftest: {
    params: [],
    confidence: 'standard',
    note: 'Plain ASCII page - works on any line printer or serial printer in text mode.',
    bytes: () => [...t('ARSIN PRINT SERVER - ASCII TEST PAGE\n'), ...t('='.repeat(44) + '\n'), ...t('The quick brown fox jumps over the lazy dog\n'), 0x0c]
  },
  initialize: { params: [], confidence: 'standard', note: 'Form feed / reset.', bytes: () => [0x0c] },
  feed: { params: [PARAMS.lines], confidence: 'standard', bytes: (p) => Array(clamp(p.lines, 1, 255)).fill(0x0a) },
  cut: { params: [], confidence: 'standard', note: 'Form feed (no cutter assumed).', bytes: () => [0x0c] },
  config: { params: [], confidence: 'standard', bytes: () => [...t('ARSIN PRINT SERVER ASCII CONFIG PAGE\n'), 0x0c] },
  counter: {
    params: [],
    confidence: 'approximate',
    note: 'Plain text mode cannot read counters; the bridge keeps its own job counter.',
    bytes: () => [...t('COUNTERS: not readable in plain text mode\n'), 0x0c]
  },
  resetcounter: {
    params: [],
    confidence: 'approximate',
    note: 'The bridge job counters can be reset from Settings > Maintenance.',
    bytes: () => [...t('BRIDGE COUNTER RESET REQUESTED\n'), 0x0c]
  }
};

/* ------------------------------------------------------------- registry --- */

export const LANGUAGE_BUILDERS = { escpos: ESCPOS, zpl: ZPL, epl: EPL, tspl: TSPL, cpcl: CPCL, starprnt: STARPRNT, escp: ESCP, ipl: IPL, dpl: DPL, plain: PLAIN };

/** Printer language metadata used by the UI, the designer and the firmware. */
export const LANGUAGES = [
  {
    id: 'escpos',
    name: 'ESC/POS',
    vendor: 'Epson / Epson-compatible',
    type: 'receipt',
    textMode: false,
    dpi: 203,
    widths: [58, 80],
    charsets: ['cp437', 'cp850', 'cp1252', 'cp1256', 'cp864'],
    note: 'The de-facto standard for thermal receipt printers (Epson TM, Bixolon SRP, Star in ESC/POS mode, Xprinter XP, Goojprt, most 58/80 mm units).'
  },
  {
    id: 'zpl',
    name: 'ZPL II',
    vendor: 'Zebra / compatible',
    type: 'label',
    textMode: true,
    dpi: [203, 300, 600],
    widths: [50, 76, 104],
    charsets: ['utf8', 'cp850'],
    note: 'Zebra ZD/ZT/GK and compatible label printers (Godex in ZPL mode, Argox, TSC with ZPL emulation, Honeywell ZPL emulation).'
  },
  {
    id: 'epl',
    name: 'EPL2',
    vendor: 'Zebra (legacy)',
    type: 'label',
    textMode: true,
    dpi: [203, 300],
    widths: [50, 76, 104],
    charsets: ['cp850'],
    note: 'Older Zebra LP/TLP, Eltron and many rebranded desktop label printers.'
  },
  {
    id: 'tspl',
    name: 'TSPL / TSPL2',
    vendor: 'TSC / Godex / Argox',
    type: 'label',
    textMode: true,
    dpi: [203, 300],
    widths: [50, 76, 104],
    charsets: ['utf8', 'cp850', 'big5', 'gb2312'],
    note: 'TSC TE/DA/TX, Godex G/EZ, Argox, Postek, iDPRT and most budget desktop label printers.'
  },
  {
    id: 'cpcl',
    name: 'CPCL',
    vendor: 'Zebra mobile / Honeywell',
    type: 'label',
    textMode: true,
    dpi: [203, 300],
    widths: [50, 72, 104],
    charsets: ['cp850'],
    note: 'Zebra QLn/ZQ, Honeywell RP2/RP4, mobile and portable label printers.'
  },
  {
    id: 'starprnt',
    name: 'Star Line Mode / StarPRNT',
    vendor: 'Star Micronics',
    type: 'receipt',
    textMode: false,
    dpi: 203,
    widths: [58, 80, 112],
    charsets: ['cp437', 'cp858'],
    note: 'Star TSP100/TSP650/TSP700, mC-Print, SM-L/SM-T and Star portable printers.'
  },
  {
    id: 'escp',
    name: 'ESC/P (ESC/P2)',
    vendor: 'Epson impact & inkjet',
    type: 'impact',
    textMode: false,
    dpi: [180, 360, 720],
    widths: [216, 241, 297],
    charsets: ['cp437', 'cp850'],
    note: 'Epson LX/FX/LQ dot-matrix and Stylus/EcoTank inkjet printers driven over serial/USB with ESC/P (text and graphics).'
  },
  {
    id: 'ipl',
    name: 'IPL (Intermec)',
    vendor: 'Honeywell / Intermec',
    type: 'label',
    textMode: true,
    dpi: [203, 300, 406],
    widths: [50, 104],
    charsets: ['cp850'],
    note: 'Intermec/Honeywell PD, PM and EasyCoder industrial label printers.'
  },
  {
    id: 'dpl',
    name: 'DPL (Datamax)',
    vendor: 'Honeywell / Datamax',
    type: 'label',
    textMode: true,
    dpi: [203, 300],
    widths: [50, 104],
    charsets: ['cp850'],
    note: "Datamax O'Neil M/H/I class and DMX printers in DPL mode."
  },
  {
    id: 'plain',
    name: 'Plain ASCII / raw',
    vendor: 'Any serial printer',
    type: 'impact',
    textMode: false,
    dpi: 203,
    widths: [80],
    charsets: ['ascii'],
    note: 'No command set - pure text plus CR/LF/FF. Use the raw console for anything proprietary.'
  }
];

export const LANGUAGE_BY_ID = Object.fromEntries(LANGUAGES.map((l) => [l.id, l]));


/** High level device profiles shown as the first choice in the wizard. */
export const DEVICE_PROFILES = [
  {
    id: 'receipt',
    name: 'Receipt / POS thermal printer',
    hint: '58 mm or 80 mm continuous roll, cutter optional',
    languages: ['escpos', 'starprnt', 'plain'],
    dpi: 203,
    defaultSize: { width: 80, height: 200 }
  },
  {
    id: 'label',
    name: 'Label printer (barcode / shipping)',
    hint: 'Die-cut or continuous labels, gap or black-mark sensor',
    languages: ['zpl', 'tspl', 'epl', 'cpcl', 'ipl', 'dpl'],
    dpi: 203,
    defaultSize: { width: 50, height: 30 }
  },
  {
    id: 'inkjet',
    name: 'Inkjet printer (nozzle check / cleaning)',
    hint: 'Epson, Canon, HP and compatible inkjets over ESC/P or raw',
    languages: ['escp', 'plain'],
    dpi: 360,
    defaultSize: { width: 210, height: 297 }
  },
  {
    id: 'impact',
    name: 'Dot-matrix / impact printer',
    hint: 'Epson LX/FX/LQ, OKI and other tractor-feed line printers',
    languages: ['escp', 'plain'],
    dpi: 180,
    defaultSize: { width: 241, height: 280 }
  }
];

export function languagesForProfile(profileId) {
  const p = DEVICE_PROFILES.find((x) => x.id === profileId);
  const ids = p ? p.languages : LANGUAGES.map((l) => l.id);
  return ids.map((id) => LANGUAGE_BY_ID[id]).filter(Boolean);
}

/* --------------------------------------------------------------- builders --- */

const TEXT_LANGS = ['zpl', 'epl', 'tspl', 'cpcl', 'ipl', 'dpl'];

/**
 * Build the byte sequence for one maintenance / troubleshooting action.
 * @param {string} langId   escpos | zpl | epl | tspl | cpcl | starprnt | escp | ipl | dpl | plain
 * @param {string} actionId see ACTIONS
 * @param {object} [params] action parameters (lines, darkness, media, ...)
 */
export function buildCommand(langId, actionId, params = {}) {
  const lang = LANGUAGE_BY_ID[langId];
  const action = ACTION_BY_ID[actionId];
  const builders = LANGUAGE_BUILDERS[langId];
  if (!lang || !builders) throw new Error(`unknown printer language "${langId}"`);
  if (!action) throw new Error(`unknown action "${actionId}"`);
  const spec = builders[actionId];
  if (!spec) {
    return {
      lang: langId,
      langName: lang.name,
      action: actionId,
      actionName: action.name,
      supported: false,
      confidence: 'approximate',
      note: `"${action.name}" is not defined for ${lang.name}. Use the raw command console, or run the action from the printer front panel.`,
      params,
      bytes: [],
      hex: '',
      ascii: '',
      text: ''
    };
  }
  const merged = { ...defaultParams(spec.params), ...params };
  const bytes = spec.bytes(merged);
  return {
    lang: langId,
    langName: lang.name,
    action: actionId,
    actionName: action.name,
    group: action.group,
    supported: true,
    confidence: spec.confidence || 'standard',
    confidenceText: CONFIDENCE[spec.confidence || 'standard'],
    note: spec.note || '',
    params: merged,
    bytes,
    hex: toHex(bytes),
    ascii: toAscii(bytes),
    text: TEXT_LANGS.includes(langId) ? new TextDecoder().decode(toUint8(bytes)) : ''
  };
}

function defaultParams(specs) {
  const out = {};
  for (const s of specs || []) out[s.id] = s.default;
  return out;
}

/** Every action a language can do, ready for rendering the console grid. */
export function actionsForLanguage(langId) {
  const builders = LANGUAGE_BUILDERS[langId] || {};
  const lang = LANGUAGE_BY_ID[langId];
  return ACTIONS.map((a) => {
    const spec = builders[a.id];
    return {
      ...a,
      supported: !!spec,
      confidence: spec ? spec.confidence || 'standard' : 'approximate',
      note: spec ? spec.note || '' : `Not defined for ${lang ? lang.name : langId} - use the raw console.`,
      params: spec ? spec.params || [] : []
    };
  });
}

/** Parse the raw console input (hex, escaped text or plain text) into bytes. */
export function parseRawInput(input, mode = 'auto') {
  const s = String(input == null ? '' : input);
  if (mode === 'hex') return bytesFromHex(s);
  if (mode === 'text') return bytesFromText(s);
  const looksHex = /^(?:0x)?[0-9a-fA-F]{2}(?:[\s,]*(?:0x)?[0-9a-fA-F]{2}){1,}$/.test(s.trim());
  return looksHex ? bytesFromHex(s) : bytesFromText(s);
}

