/**
 * Arsin Print Server - label / receipt document model and renderers (pure).
 *
 * A document is resolution independent (millimetres + DPI) and is rendered to
 * the native command set of the selected printer language, or to a monochrome
 * raster payload that works on any printer that accepts graphics.
 *
 * Element types: text, barcode, qrcode, image, line, box.
 */

import { encodeBarcode, SYMBOLOGY_BY_ID } from './barcode.js';
import { qrEncode } from './qr.js';
import { toHexString, escposRaster, starRaster, escpRaster, zplGfa, tsplBitmap, eplGwu, cpclExpand, iplGraphic, dplGraphic } from './raster.js';
import { bytesFromText, toUint8 } from './commands.js';

export const MM_PER_INCH = 25.4;

export function mmToDots(mm, dpi) {
  return Math.round((Number(mm) * dpi) / MM_PER_INCH);
}

export function dotsToMm(dots, dpi) {
  return (Number(dots) * MM_PER_INCH) / dpi;
}

/** Standard label / receipt presets offered by the designer. */
export const SIZE_PRESETS = [
  { id: 'label-50x30', profile: 'label', name: '50 x 30 mm label', width: 50, height: 30, gap: 2, dpi: 203 },
  { id: 'label-40x30', profile: 'label', name: '40 x 30 mm label', width: 40, height: 30, gap: 2, dpi: 203 },
  { id: 'label-60x40', profile: 'label', name: '60 x 40 mm label', width: 60, height: 40, gap: 2, dpi: 203 },
  { id: 'label-100x150', profile: 'label', name: '100 x 150 mm shipping label', width: 100, height: 150, gap: 3, dpi: 203 },
  { id: 'label-102x152', profile: 'label', name: '4 x 6 in shipping label', width: 101.6, height: 152.4, gap: 3, dpi: 203 },
  { id: 'receipt-58', profile: 'receipt', name: '58 mm receipt roll', width: 48, height: 120, gap: 0, dpi: 203 },
  { id: 'receipt-80', profile: 'receipt', name: '80 mm receipt roll', width: 72, height: 150, gap: 0, dpi: 203 },
  { id: 'receipt-112', profile: 'receipt', name: '112 mm receipt roll (Star)', width: 104, height: 150, gap: 0, dpi: 203 },
  { id: 'a4', profile: 'inkjet', name: 'A4 sheet (210 x 297 mm)', width: 210, height: 297, gap: 0, dpi: 360 },
  { id: 'a5', profile: 'inkjet', name: 'A5 sheet (148 x 210 mm)', width: 148, height: 210, gap: 0, dpi: 360 }
];

/** Create a new document with sensible defaults. */
export function createLabelDoc(opts = {}) {
  const preset = SIZE_PRESETS.find((p) => p.id === opts.preset) || SIZE_PRESETS[0];
  return {
    name: opts.name || 'Untitled label',
    profile: opts.profile || preset.profile,
    width: opts.width || preset.width,
    height: opts.height || preset.height,
    gap: opts.gap == null ? preset.gap : opts.gap,
    dpi: opts.dpi || preset.dpi,
    copies: opts.copies || 1,
    rotation: opts.rotation || 0,
    speed: opts.speed || 4,
    darkness: opts.darkness == null ? 8 : opts.darkness,
    mediaType: opts.mediaType || 'gap',
    language: opts.language || (preset.profile === 'label' ? 'zpl' : 'escpos'),
    variables: opts.variables || {},
    elements: opts.elements || []
  };
}

/** Replace {{variable}} placeholders. */
export function substituteVars(text, vars = {}) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => (vars[key] == null ? m : String(vars[key])));
}

export function elementBBox(el, dpi) {
  const x = mmToDots(el.x || 0, dpi);
  const y = mmToDots(el.y || 0, dpi);
  const w = el.w != null ? mmToDots(el.w, dpi) : el.size != null ? mmToDots(el.size, dpi) : mmToDots(el.sizeMm || 10, dpi);
  const h = el.h != null ? mmToDots(el.h, dpi) : el.height != null ? mmToDots(el.height, dpi) : w;
  return { x, y, w, h };
}

/** Text elements: resolve the effective dot height for the selected language. */
export function fontSizeDots(el, dpi) {
  return Math.max(6, mmToDots(el.fontSizeMm || 3, dpi));
}

/* --------------------------------------------------------- 1D/2D -> bitmap */

/** Turn an encoder result into a 1bpp bitmap (pure - no canvas needed). */
export function barcodeToMono(encoded, opts = {}) {
  const moduleWidth = Math.max(1, Math.round(opts.moduleWidth || 2));
  const height = Math.max(8, Math.round(opts.height || 60));
  const quiet = opts.quietModules == null ? 10 : opts.quietModules;
  const textRows = opts.showText ? 12 : 0;
  const totalModules = encoded.modules.length + quiet * 2;
  const width = totalModules * moduleWidth;
  const rows = height + textRows;
  const black = new Uint8Array(width * rows);
  for (let y = 0; y < height; y++) {
    for (let m = 0; m < encoded.modules.length; m++) {
      if (encoded.modules[m] !== '1') continue;
      for (let w = 0; w < moduleWidth; w++) {
        black[y * width + (quiet + m) * moduleWidth + w] = 1;
      }
    }
  }
  if (textRows) {
    // Simple 5x7 font so barcodes printed as graphics still carry the HRI text.
    const text = String(opts.showText === true ? encoded.humanReadable || encoded.text : opts.showText);
    const scale = Math.max(1, Math.floor((height + textRows) / 40));
    const textWidth = text.length * 6 * scale;
    const startX = Math.max(0, Math.floor((width - textWidth) / 2));
    for (let i = 0; i < text.length; i++) {
      const glyph = FONT5X7[text[i]] || FONT5X7['?'];
      for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 7; row++) {
          if (!(glyph[col] & (1 << row))) continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = startX + (i * 6 + col) * scale + sx;
              const py = height + 2 * scale + row * scale + sy;
              if (px >= 0 && px < width && py < rows) black[py * width + px] = 1;
            }
          }
        }
      }
    }
  }
  return packBitmap(black, width, rows);
}

/** Turn a QR matrix into a 1bpp bitmap. */
export function qrToMono(qr, opts = {}) {
  const moduleSize = Math.max(1, Math.round(opts.moduleSize || 4));
  const quiet = opts.quietModules == null ? 4 : opts.quietModules;
  const modules = qr.size + quiet * 2;
  const width = modules * moduleSize;
  const black = new Uint8Array(width * width);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue;
      for (let y = 0; y < moduleSize; y++) {
        for (let x = 0; x < moduleSize; x++) {
          const py = (r + quiet) * moduleSize + y;
          const px = (c + quiet) * moduleSize + x;
          black[py * width + px] = 1;
        }
      }
    }
  }
  return packBitmap(black, width, width);
}

function packBitmap(black, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const bits = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!black[y * width + x]) continue;
      bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height, bytesPerRow, bits };
}

/** Minimal 5x7 ASCII font (columns, bit 0 = top row) for graphic HRI text. */
export const FONT5X7 = (() => {
  const glyphs = {
    '0': [0x3e, 0x51, 0x49, 0x45, 0x3e], '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
    '2': [0x42, 0x61, 0x51, 0x49, 0x46], '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
    '4': [0x18, 0x14, 0x12, 0x7f, 0x10], '5': [0x27, 0x45, 0x45, 0x45, 0x39],
    '6': [0x3c, 0x4a, 0x49, 0x49, 0x30], '7': [0x01, 0x71, 0x09, 0x05, 0x03],
    '8': [0x36, 0x49, 0x49, 0x49, 0x36], '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
    A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36],
    C: [0x3e, 0x41, 0x41, 0x41, 0x22], D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
    E: [0x7f, 0x49, 0x49, 0x49, 0x41], F: [0x7f, 0x09, 0x09, 0x09, 0x01],
    G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
    I: [0x00, 0x41, 0x7f, 0x41, 0x00], J: [0x20, 0x40, 0x41, 0x3f, 0x01],
    K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
    M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
    O: [0x3e, 0x41, 0x41, 0x41, 0x3e], P: [0x7f, 0x09, 0x09, 0x09, 0x06],
    Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46],
    S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01],
    U: [0x3f, 0x40, 0x40, 0x40, 0x3f], V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
    W: [0x3f, 0x40, 0x38, 0x40, 0x3f], X: [0x63, 0x14, 0x08, 0x14, 0x63],
    Y: [0x07, 0x08, 0x70, 0x08, 0x07], Z: [0x61, 0x51, 0x49, 0x45, 0x43],
    '-': [0x08, 0x08, 0x08, 0x08, 0x08], '.': [0x00, 0x60, 0x60, 0x00, 0x00],
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00], ':': [0x00, 0x36, 0x36, 0x00, 0x00],
    '/': [0x20, 0x10, 0x08, 0x04, 0x02], '$': [0x24, 0x2a, 0x7f, 0x2a, 0x12],
    '+': [0x08, 0x08, 0x3e, 0x08, 0x08], '%': [0x23, 0x13, 0x08, 0x64, 0x62],
    '*': [0x22, 0x14, 0x08, 0x14, 0x22], '#': [0x14, 0x7f, 0x14, 0x7f, 0x14],
    '?': [0x02, 0x01, 0x51, 0x09, 0x06]
  };
  return glyphs;
})();

/* ------------------------------------------------------------ SVG preview */

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function runsToPath(modules, ox, oy, mw, mh, quiet = 0) {
  let d = '';
  let runStart = -1;
  for (let i = 0; i <= modules.length; i++) {
    const on = i < modules.length && modules[i] === '1';
    if (on && runStart < 0) runStart = i;
    if (!on && runStart >= 0) {
      d += `M${ox + (quiet + runStart) * mw} ${oy}h${(i - runStart) * mw}v${mh}h-${(i - runStart) * mw}z`;
      runStart = -1;
    }
  }
  return d;
}

/**
 * Render a document to SVG - the pure, dependency free preview used by the
 * designer and by the unit tests.
 */
export function renderLabelSvg(doc, opts = {}) {
  const dpi = doc.dpi || 203;
  const width = mmToDots(doc.width, dpi);
  const height = mmToDots(doc.height, dpi);
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" ` +
      `width="${opts.displayWidth || '100%'}" preserveAspectRatio="xMidYMid meet" font-family="'DejaVu Sans Mono',ui-monospace,monospace" role="img" aria-label="${esc(doc.name)}">`
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  if (opts.grid) parts.push(gridPath(width, height, dpi));
  for (const el of doc.elements || []) {
    const svg = renderElementSvg(el, doc, dpi, opts);
    if (svg) parts.push(svg);
  }
  if (opts.showBorder) {
    parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#cbd5e1" stroke-dasharray="6 4"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function gridPath(width, height, dpi) {
  let d = '';
  for (let x = 0; x <= width; x += mmToDots(5, dpi)) d += `M${x} 0V${height}`;
  for (let y = 0; y <= height; y += mmToDots(5, dpi)) d += `M0 ${y}H${width}`;
  return `<path d="${d}" stroke="#e2e8f0" stroke-width="0.5" fill="none"/>`;
}

function elementTransform(el, dpi) {
  if (!el.rotation) return '';
  const { x, y } = elementBBox(el, dpi);
  return ` transform="rotate(${el.rotation} ${x} ${y})"`;
}

function renderElementSvg(el, doc, dpi, opts) {
  const { x, y, w, h } = elementBBox(el, dpi);
  const vars = { ...(doc.variables || {}), ...(opts.variables || {}) };
  switch (el.type) {
    case 'text': {
      const size = fontSizeDots(el, dpi);
      const anchor = el.align === 'center' ? 'middle' : el.align === 'right' ? 'end' : 'start';
      const tx = el.align === 'center' ? x + (el.w ? w / 2 : 0) : el.align === 'right' ? x + w : x;
      const lines = substituteVars(el.text, vars).split('\n');
      const fill = el.reverse ? '#ffffff' : '#000000';
      const out = [];
      if (el.reverse) out.push(`<rect x="${x}" y="${y}" width="${w || size * 8}" height="${size * lines.length * 1.2}" fill="#000000"/>`);
      lines.forEach((line, i) => {
        out.push(
          `<text x="${tx}" y="${y + size * (i + 1) - size * 0.15}" font-size="${size}" font-weight="${el.bold ? 'bold' : 'normal'}" ` +
            `font-style="${el.italic ? 'italic' : 'normal'}" fill="${fill}" text-anchor="${anchor}"${el.underline ? ' text-decoration="underline"' : ''}>${esc(line)}</text>`
        );
      });
      return `<g${elementTransform(el, dpi)}>${out.join('')}</g>`;
    }
    case 'barcode': {
      const enc = encodeBarcode(el.symbology, substituteVars(el.data, vars), {});
      const mw = Math.max(1, Math.round(mmToDots(el.narrowMm || 0.25, dpi)));
      const barHeight = el.heightMm ? mmToDots(el.heightMm, dpi) : h;
      const quiet = el.quietModules == null ? 10 : el.quietModules;
      const totalW = (enc.modules.length + quiet * 2) * mw;
      const scale = el.w && totalW > mmToDots(el.w, dpi) ? mmToDots(el.w, dpi) / totalW : 1;
      const d = runsToPath(enc.modules, x, y, mw * scale, barHeight, quiet);
      const out = [`<path d="${d}" fill="#000000"/>`];
      if (el.showText) {
        const ts = mmToDots(el.textSizeMm || 2.6, dpi);
        out.push(`<text x="${x + (totalW * scale) / 2}" y="${y + barHeight + ts}" font-size="${ts}" text-anchor="middle" fill="#000000">${esc(enc.humanReadable || enc.text)}</text>`);
      }
      return `<g${elementTransform(el, dpi)}>${out.join('')}</g>`;
    }
    case 'qrcode': {
      const qr = qrEncode(substituteVars(el.data, vars), { ecc: el.ecc || 'M' });
      const size = el.sizeMm ? mmToDots(el.sizeMm, dpi) : Math.min(w || h, h || w) || 100;
      const quiet = 4;
      const mw = size / (qr.size + quiet * 2);
      let d = '';
      for (let r = 0; r < qr.size; r++) {
        d += runsToPath(qr.modules[r].map((v) => String(v)), x, y + (r + quiet) * mw, mw, mw, quiet);
      }
      return `<g${elementTransform(el, dpi)}><path d="${d}" fill="#000000"/></g>`;
    }
    case 'image': {
      if (!el.src) return '';
      return (
        `<g${elementTransform(el, dpi)}><image href="${esc(el.src)}" xlink:href="${esc(el.src)}" x="${x}" y="${y}" width="${w}" height="${h}" ` +
        `preserveAspectRatio="${esc(el.fit || 'xMidYMid meet')}" style="image-rendering:pixelated"/></g>`
      );
    }
    case 'line': {
      const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, dpi));
      return `<rect x="${x}" y="${y}" width="${el.w ? w : t}" height="${el.h ? h : t}" fill="#000000"/>`;
    }
    case 'box': {
      const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, dpi));
      if (el.filled) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000000"/>`;
      return (
        `<g fill="#000000"><rect x="${x}" y="${y}" width="${w}" height="${t}"/>` +
        `<rect x="${x}" y="${y + h - t}" width="${w}" height="${t}"/>` +
        `<rect x="${x}" y="${y}" width="${t}" height="${h}"/>` +
        `<rect x="${x + w - t}" y="${y}" width="${t}" height="${h}"/></g>`
      );
    }
    default:
      return '';
  }
}


/* ------------------------------------------------------ native renderers */

function ctxFor(doc) {
  const dpi = doc.dpi || 203;
  return {
    dpi,
    widthDots: mmToDots(doc.width, dpi),
    heightDots: mmToDots(doc.height, dpi),
    vars: doc.variables || {},
    warnings: []
  };
}

function textOf(el, ctx) {
  return substituteVars(el.text, ctx.vars);
}

function num(v) {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Zebra ZPL II. */
export function renderZpl(doc, ctx = ctxFor(doc)) {
  const out = [];
  out.push('^XA');
  out.push('^CI28');
  out.push(`^PW${ctx.widthDots}`);
  out.push(`^LL${ctx.heightDots}`);
  out.push(`^PR${Math.max(1, Math.min(14, doc.speed || 4))}`);
  out.push(`~SD${Math.max(0, Math.min(30, (doc.darkness == null ? 8 : doc.darkness) * 2))}`);
  out.push(`^MN${doc.mediaType === 'continuous' ? 'N' : doc.mediaType === 'blackmark' ? 'M' : 'Y'}`);
  for (const el of doc.elements || []) {
    const { x, y, w, h } = elementBBox(el, ctx.dpi);
    const rot = el.rotation ? '^FWR' : '';
    switch (el.type) {
      case 'text': {
        const size = fontSizeDots(el, ctx.dpi);
        const align = el.align === 'center' ? 'C' : el.align === 'right' ? 'R' : 'L';
        out.push(`^FO${x},${y}${rot}^A0N,${size},${size}^FB${w || ctx.widthDots - x},1,0,${align}^FD${textOf(el, ctx)}^FS`);
        break;
      }
      case 'barcode': {
        const enc = encodeBarcode(el.symbology, substituteVars(el.data, ctx.vars), {});
        const barH = el.heightMm ? mmToDots(el.heightMm, ctx.dpi) : h || 80;
        const human = el.showText ? 'Y' : 'N';
        const t = el.symbology;
        if (t === 'code128') out.push(`^FO${x},${y}^BCN,${barH},${human},N,N^FD${enc.text}^FS`);
        else if (t === 'code39') out.push(`^FO${x},${y}^B3N,N,${barH},${human},N^FD${enc.text}^FS`);
        else if (t === 'code93') out.push(`^FO${x},${y}^B9N,${barH},${human},N^FD${enc.text}^FS`);
        else if (t === 'itf') out.push(`^FO${x},${y}^B2N,${barH},${human},N,N^FD${enc.text}^FS`);
        else if (t === 'ean13') out.push(`^FO${x},${y}^BEN,${barH},${human},N^FD${enc.text}^FS`);
        else if (t === 'ean8') out.push(`^FO${x},${y}^B8N,${barH},${human},N^FD${enc.text}^FS`);
        else if (t === 'upca') out.push(`^FO${x},${y}^BUN,${barH},${human},N^FD${enc.text}^FS`);
        else if (t === 'codabar') out.push(`^FO${x},${y}^BKN,${barH},${human},N^FD${enc.text}^FS`);
        else if (t === 'datamatrix') out.push(`^FO${x},${y}^BXN,6,200^FD${substituteVars(el.data, ctx.vars)}^FS`);
        else if (t === 'pdf417') out.push(`^FO${x},${y}^B7N,5,2,8,${el.showText ? 'Y' : 'N'}^FD${substituteVars(el.data, ctx.vars)}^FS`);
        else {
          ctx.warnings.push(`ZPL has no native ${t}; use QR or a 1D symbology`);
        }
        break;
      }
      case 'qrcode': {
        const mag = Math.max(1, Math.min(10, Math.round((el.sizeMm ? mmToDots(el.sizeMm, ctx.dpi) : h || 120) / 40)));
        out.push(`^FO${x},${y}^BQN,2,${mag},M^FDLA,${substituteVars(el.data, ctx.vars)}^FS`);
        break;
      }
      case 'image': {
        if (el.mono) out.push(zplGfa(el.mono, { x, y }));
        else ctx.warnings.push('image element skipped: no raster data available for ZPL output');
        break;
      }
      case 'line': {
        const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi));
        out.push(`^FO${x},${y}^GB${el.w ? w : t},${el.h ? h : t},${t}^FS`);
        break;
      }
      case 'box':
        out.push(`^FO${x},${y}^GB${w},${h},${Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi))}${el.filled ? ',B' : ''}^FS`);
        break;
      default:
        break;
    }
  }
  out.push(`^PQ${Math.max(1, doc.copies || 1)}`);
  out.push('^XZ');
  return out.join('\n');
}


/** TSC / Godex / Argox TSPL(2). */
export function renderTspl(doc, ctx = ctxFor(doc)) {
  const out = [];
  out.push(`SIZE ${num(doc.width)} mm,${num(doc.height)} mm`);
  if (doc.mediaType === 'continuous') out.push('GAP 0 mm,0 mm');
  else if (doc.mediaType === 'blackmark') out.push(`BLINE ${num(doc.gap || 3)} mm,0 mm`);
  else out.push(`GAP ${num(doc.gap || 2)} mm,0 mm`);
  out.push('DIRECTION 0');
  out.push(`DENSITY ${Math.max(0, Math.min(15, doc.darkness == null ? 8 : doc.darkness))}`);
  out.push(`SPEED ${Math.max(1, Math.min(14, doc.speed || 4))}`);
  out.push('CLS');
  for (const el of doc.elements || []) {
    const { x, y, w, h } = elementBBox(el, ctx.dpi);
    const rot = el.rotation ? 90 : 0;
    switch (el.type) {
      case 'text': {
        const size = fontSizeDots(el, ctx.dpi);
        const font = size <= 16 ? '1' : size <= 24 ? '2' : size <= 32 ? '3' : size <= 48 ? '4' : '5';
        out.push(`TEXT ${x},${y},"${font}",${rot},1,1,"${textOf(el, ctx)}"`);
        break;
      }
      case 'barcode': {
        const enc = encodeBarcode(el.symbology, substituteVars(el.data, ctx.vars), {});
        const barH = el.heightMm ? mmToDots(el.heightMm, ctx.dpi) : h || 80;
        const meta = SYMBOLOGY_BY_ID[el.symbology];
        const type = meta && meta.printer ? meta.printer.tspl : null;
        if (!type) {
          ctx.warnings.push(`TSPL has no native ${el.symbology}; element skipped`);
          break;
        }
        const narrow = Math.max(1, Math.round(mmToDots(el.narrowMm || 0.25, ctx.dpi) * 2));
        out.push(`BARCODE ${x},${y},"${type}",${barH},${el.showText ? 1 : 0},${rot},${narrow},${narrow * 2},"${enc.text}"`);
        break;
      }
      case 'qrcode': {
        const mag = Math.max(1, Math.min(10, Math.round((el.sizeMm ? mmToDots(el.sizeMm, ctx.dpi) : h || 120) / 32)));
        out.push(`QRCODE ${x},${y},${el.ecc || 'M'},${mag},A,${rot},"${substituteVars(el.data, ctx.vars)}"`);
        break;
      }
      case 'image':
        if (el.mono) out.push(tsplBitmap(el.mono, { x, y }));
        else ctx.warnings.push('image element skipped: no raster data available for TSPL output');
        break;
      case 'line': {
        const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi));
        out.push(`BAR ${x},${y},${el.w ? w : t},${el.h ? h : t}`);
        break;
      }
      case 'box': {
        const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi));
        out.push(el.filled ? `BAR ${x},${y},${w},${h}` : `BOX ${x},${y},${x + w},${y + h},${t}`);
        break;
      }
      default:
        break;
    }
  }
  out.push(`PRINT ${Math.max(1, doc.copies || 1)},1`);
  return out.join('\n');
}

/** Zebra EPL2 (legacy desktop label printers). Text, boxes and graphics only -
 *  barcode elements are rendered as graphics because the EPL 'B' type numbers
 *  differ between firmware generations. */
export function renderEpl(doc, ctx = ctxFor(doc)) {
  const out = [];
  out.push('N');
  out.push(`q${ctx.widthDots}`);
  out.push(`Q${ctx.heightDots},${doc.gap ? mmToDots(doc.gap, ctx.dpi) : 0}`);
  out.push(`D${Math.max(-15, Math.min(15, (doc.darkness == null ? 8 : doc.darkness) - 8))}`);
  out.push(`S${Math.max(1, Math.min(6, doc.speed || 4))}`);
  if (doc.mediaType === 'blackmark') out.push('b');
  for (const el of doc.elements || []) {
    const { x, y, w, h } = elementBBox(el, ctx.dpi);
    switch (el.type) {
      case 'text': {
        const size = fontSizeDots(el, ctx.dpi);
        const font = size <= 16 ? 1 : size <= 24 ? 2 : size <= 32 ? 3 : size <= 48 ? 4 : 5;
        out.push(`A${x},${y},0,${font},1,1,${el.reverse ? 'R' : 'N'},"${textOf(el, ctx)}"`);
        break;
      }
      case 'image':
      case 'barcode':
      case 'qrcode': {
        if (el.mono) out.push(eplGwu(el.mono, { x, y }));
        else ctx.warnings.push(`${el.type} element needs raster data for EPL output`);
        break;
      }
      case 'line': {
        const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi));
        out.push(`LO${x},${y},${el.w ? w : t},${el.h ? h : t}`);
        break;
      }
      case 'box':
        out.push(`X${x},${y},${Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi))},${w},${h}`);
        break;
      default:
        break;
    }
  }
  out.push(`P${Math.max(1, doc.copies || 1)}`);
  return out.join('\n');
}


/** Zebra mobile / Honeywell CPCL. */
export function renderCpcl(doc, ctx = ctxFor(doc)) {
  const out = [];
  out.push(`! 0 200 200 ${ctx.heightDots} ${Math.max(1, doc.copies || 1)}`);
  out.push(`PAGE-WIDTH ${ctx.widthDots}`);
  out.push(`DENSITY ${Math.max(0, Math.min(15, doc.darkness == null ? 8 : doc.darkness))}`);
  for (const el of doc.elements || []) {
    const { x, y, w, h } = elementBBox(el, ctx.dpi);
    switch (el.type) {
      case 'text': {
        const size = fontSizeDots(el, ctx.dpi);
        const font = size <= 12 ? 2 : size <= 18 ? 3 : size <= 24 ? 4 : size <= 32 ? 5 : 6;
        out.push(`TEXT ${font} ${size} ${x} ${y} ${textOf(el, ctx)}`);
        break;
      }
      case 'barcode': {
        const enc = encodeBarcode(el.symbology, substituteVars(el.data, ctx.vars), {});
        const barH = el.heightMm ? mmToDots(el.heightMm, ctx.dpi) : h || 80;
        const type = { code128: '128', code39: '39', ean13: 'EAN13', ean8: 'EAN8', upca: 'UPCA', itf: 'I2OF5', codabar: 'CODABAR', code93: '93' }[el.symbology];
        if (!type) {
          ctx.warnings.push(`CPCL has no native ${el.symbology}; use QR or a 1D symbology`);
          break;
        }
        out.push(`BARCODE ${type} 1 1 ${barH} ${x} ${y} ${enc.text}`);
        break;
      }
      case 'qrcode': {
        const mag = Math.max(1, Math.min(10, Math.round((el.sizeMm ? mmToDots(el.sizeMm, ctx.dpi) : h || 120) / 40)));
        out.push(`BARCODE QR 2 1 ${mag * 40} ${x} ${y} M 1 U ${mag} ${substituteVars(el.data, ctx.vars)}`);
        break;
      }
      case 'image':
        if (el.mono) out.push(cpclExpand(el.mono, { x, y }));
        else ctx.warnings.push('image element skipped: no raster data available for CPCL output');
        break;
      case 'line': {
        const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi));
        out.push(`LINE ${x} ${y} ${x + (el.w ? w : t)} ${y + (el.h ? h : t)} ${t}`);
        break;
      }
      case 'box':
        out.push(`BOX ${x} ${y} ${x + w} ${y + h} ${Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi))}`);
        break;
      default:
        break;
    }
  }
  out.push('FORM');
  out.push('PRINT');
  return out.join('\r\n');
}

function packBlack(width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const bits = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return bits;
}


/** ESC/POS receipt printers - line oriented, so elements are emitted in y order. */
export function renderEscpos(doc, ctx = ctxFor(doc)) {
  const out = [bytesFromText('\u001b@')];
  const els = [...(doc.elements || [])].sort((a, b) => (a.y || 0) - (b.y || 0));
  let currentLine = 0;
  for (const el of els) {
    const { x, y, w, h } = elementBBox(el, ctx.dpi);
    const feeds = Math.max(0, Math.round((el.y || 0) - currentLine));
    for (let i = 0; i < feeds; i++) out.push(bytesFromText('\n'));
    currentLine = el.y || 0;
    const col = Math.max(0, Math.min(65535, Math.round(x / 8)));
    switch (el.type) {
      case 'text': {
        const size = fontSizeDots(el, ctx.dpi);
        const scale = size >= 48 ? 3 : size >= 32 ? 2 : 1;
        out.push([0x1b, 0x24, col & 0xff, (col >> 8) & 0xff]);
        out.push([0x1b, 0x61, el.align === 'center' ? 1 : el.align === 'right' ? 2 : 0]);
        out.push([0x1d, 0x21, scale === 3 ? 0x33 : scale === 2 ? 0x11 : 0x00]);
        out.push([0x1b, 0x21, el.bold ? 0x08 : 0x00]);
        out.push(bytesFromText(`${textOf(el, ctx)}\n`));
        out.push([0x1b, 0x21, 0x00, 0x1d, 0x21, 0x00, 0x1b, 0x61, 0x00]);
        break;
      }
      case 'barcode': {
        const enc = encodeBarcode(el.symbology, substituteVars(el.data, ctx.vars), {});
        const meta = SYMBOLOGY_BY_ID[el.symbology];
        const m = meta && meta.printer ? meta.printer.escpos : null;
        if (m == null) {
          ctx.warnings.push(`ESC/POS has no native ${el.symbology}; element skipped`);
          break;
        }
        const barH = Math.max(2, Math.min(255, Math.round(el.heightMm ? mmToDots(el.heightMm, ctx.dpi) / 4 : 60)));
        out.push([0x1d, 0x68, barH]);
        out.push([0x1d, 0x77, 2]);
        out.push([0x1d, 0x48, el.showText ? 2 : 0]);
        out.push([0x1d, 0x6b, m]);
        out.push(bytesFromText(`${enc.text}\u0000`));
        break;
      }
      case 'qrcode': {
        const data = bytesFromText(substituteVars(el.data, ctx.vars));
        const mag = Math.max(1, Math.min(8, Math.round((el.sizeMm ? mmToDots(el.sizeMm, ctx.dpi) : 120) / 60)));
        out.push([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
        out.push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, mag]);
        out.push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, el.ecc === 'H' ? 0x33 : el.ecc === 'Q' ? 0x32 : el.ecc === 'L' ? 0x30 : 0x31]);
        const len = data.length + 3;
        out.push([0x1d, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...data]);
        out.push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
        out.push(bytesFromText('\n'));
        break;
      }
      case 'image':
        if (el.mono) out.push(escposRaster(el.mono));
        else ctx.warnings.push('image element skipped: no raster data available for ESC/POS output');
        break;
      case 'line': {
        const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi));
        const w2 = el.w ? w : t;
        out.push(escposRaster({ width: w2, height: t, bytesPerRow: Math.ceil(w2 / 8), bits: packBlack(w2, t) }));
        break;
      }
      case 'box': {
        const t = Math.max(1, mmToDots(el.thicknessMm || 0.4, ctx.dpi));
        if (el.filled) {
          out.push(escposRaster({ width: w, height: h, bytesPerRow: Math.ceil(w / 8), bits: packBlack(w, h) }));
        } else {
          out.push(escposRaster({ width: w, height: t, bytesPerRow: Math.ceil(w / 8), bits: packBlack(w, t) }));
          for (let i = 0; i < Math.max(1, Math.round(h / t) - 1); i++) out.push(bytesFromText('\n'));
          out.push(escposRaster({ width: w, height: t, bytesPerRow: Math.ceil(w / 8), bits: packBlack(w, t) }));
        }
        break;
      }
      default:
        break;
    }
  }
  out.push(bytesFromText('\n\n\n'));
  if (doc.cut !== false) out.push([0x1b, 0x64, 0x03, 0x1d, 0x56, doc.cut === 'partial' ? 0x01 : 0x00]);
  return out;
}


/** Star Micronics line mode. */
export function renderStar(doc, ctx = ctxFor(doc)) {
  const out = [bytesFromText('\u001b@')];
  const els = [...(doc.elements || [])].sort((a, b) => (a.y || 0) - (b.y || 0));
  let currentLine = 0;
  for (const el of els) {
    const { x, y, w, h } = elementBBox(el, ctx.dpi);
    const feeds = Math.max(0, Math.round((el.y || 0) - currentLine));
    for (let i = 0; i < feeds; i++) out.push(bytesFromText('\n'));
    currentLine = el.y || 0;
    const col = Math.max(0, Math.min(65535, Math.round(x / 8)));
    switch (el.type) {
      case 'text': {
        const size = fontSizeDots(el, ctx.dpi);
        const scale = size >= 48 ? 3 : size >= 32 ? 2 : 1;
        out.push([0x1b, 0x24, col & 0xff, (col >> 8) & 0xff]);
        out.push([0x1b, 0x1d, scale === 3 ? 0x33 : scale === 2 ? 0x11 : 0x00]);
        out.push([0x1b, 0x45, el.bold ? 1 : 0]);
        out.push(bytesFromText(`${textOf(el, ctx)}\n`));
        out.push([0x1b, 0x45, 0, 0x1b, 0x1d, 0x00]);
        break;
      }
      case 'barcode': {
        const enc = encodeBarcode(el.symbology, substituteVars(el.data, ctx.vars), {});
        const type = { code128: 0x36, code39: 0x31, ean13: 0x33, ean8: 0x32, itf: 0x34, upca: 0x30, codabar: 0x35, code93: 0x37 }[el.symbology];
        if (type == null) {
          ctx.warnings.push(`Star Line Mode has no native ${el.symbology}; element skipped`);
          break;
        }
        out.push([0x1b, 0x62, type, 0x02, 0x02, Math.max(1, Math.min(9, Math.round((el.heightMm ? mmToDots(el.heightMm, ctx.dpi) : h || 60) / 20)))]);
        out.push(bytesFromText(`${enc.text}\u0000`));
        out.push(bytesFromText('\n'));
        break;
      }
      case 'qrcode':
      case 'image':
        if (el.mono) out.push(starRaster(el.mono));
        else if (el.type === 'qrcode') {
          const qr = qrEncode(substituteVars(el.data, ctx.vars), { ecc: el.ecc || 'M' });
          out.push(starRaster(qrToMono(qr, { moduleSize: 4 })));
        } else ctx.warnings.push('image element skipped: no raster data available for Star output');
        break;
      default:
        break;
    }
  }
  out.push(bytesFromText('\n\n\n'));
  if (doc.cut !== false) out.push([0x1b, 0x64, 0x03]);
  return out;
}

/** Epson ESC/P (impact + inkjet). */
export function renderEscp(doc, ctx = ctxFor(doc)) {
  const out = [bytesFromText('\u001b@')];
  const els = [...(doc.elements || [])].sort((a, b) => (a.y || 0) - (b.y || 0));
  for (const el of els) {
    const { x, y, w, h } = elementBBox(el, ctx.dpi);
    const col = Math.max(0, Math.min(65535, Math.round(x / 8)));
    if (el.type === 'text') {
      out.push([0x1b, 0x24, col & 0xff, (col >> 8) & 0xff]);
      out.push([0x1b, 0x21, el.bold ? 0x08 : 0x00]);
      out.push(bytesFromText(`${textOf(el, ctx)}\n`));
      out.push([0x1b, 0x21, 0x00]);
    } else if (el.mono) {
      out.push(escpRaster(el.mono));
    } else if (el.type === 'qrcode') {
      out.push(escpRaster(qrToMono(qrEncode(substituteVars(el.data, ctx.vars), { ecc: el.ecc || 'M' }), { moduleSize: 6 })));
    } else if (el.type === 'barcode') {
      const enc = encodeBarcode(el.symbology, substituteVars(el.data, ctx.vars), {});
      out.push(escpRaster(barcodeToMono(enc, { moduleWidth: 2, height: 80, showText: el.showText ? true : false })));
    } else {
      ctx.warnings.push(`${el.type} element skipped: ESC/P output needs raster data`);
    }
  }
  out.push([0x0c]); // form feed
  return out;
}

/** Plain ASCII - no graphics, text only. */
export function renderPlain(doc, ctx = ctxFor(doc)) {
  const els = [...(doc.elements || [])].sort((a, b) => (a.y || 0) - (b.y || 0));
  const lines = [];
  for (const el of els) {
    if (el.type === 'text') lines.push(textOf(el, ctx));
    else if (el.type === 'barcode') lines.push(substituteVars(el.data, ctx.vars));
    else if (el.type === 'qrcode') lines.push(substituteVars(el.data, ctx.vars));
  }
  return [bytesFromText(`${lines.join('\n')}\n\u000c`)];
}

/** Intermec IPL - graphics based (firmware dialects vary a lot). */
export function renderIpl(doc, ctx = ctxFor(doc)) {
  const out = [bytesFromText('\u0002\u001bL\r\n')];
  for (const el of doc.elements || []) {
    const { x, y } = elementBBox(el, ctx.dpi);
    if (el.mono) out.push(bytesFromText(iplGraphic(el.mono, { x, y })));
    else if (el.type === 'text') out.push(bytesFromText(`${textOf(el, ctx)}\r\n`));
  }
  out.push(bytesFromText(`\u0002E${Math.max(1, doc.copies || 1)}\r\n`));
  return out;
}

/** Datamax DPL - graphics based. */
export function renderDpl(doc, ctx = ctxFor(doc)) {
  const out = [bytesFromText('\u0002L\r')];
  for (const el of doc.elements || []) {
    const { x, y } = elementBBox(el, ctx.dpi);
    if (el.mono) out.push(bytesFromText(dplGraphic(el.mono, { x, y })));
    else if (el.type === 'text') out.push(bytesFromText(`\u00021A${x},${y},0,1,1,1,${textOf(el, ctx)}\r`));
  }
  out.push(bytesFromText(`\u0002P${Math.max(1, doc.copies || 1)}\r`));
  return out;
}

/** Native renderer dispatch. */
export const NATIVE_RENDERERS = {
  zpl: renderZpl,
  tspl: renderTspl,
  epl: renderEpl,
  cpcl: renderCpcl,
  escpos: renderEscpos,
  starprnt: renderStar,
  escp: renderEscp,
  ipl: renderIpl,
  dpl: renderDpl,
  plain: renderPlain
};

/** Languages that cannot print vector text/graphics and always need raster data. */
export const RASTER_ONLY = ['ipl', 'dpl'];


/** Raster payload for a language (used when native output is unavailable). */
export function renderLabelRaster(doc, lang, mono, opts = {}) {
  switch (lang) {
    case 'escpos':
      return [escposRaster(mono)];
    case 'starprnt':
      return [starRaster(mono)];
    case 'escp':
      return [escpRaster(mono)];
    case 'zpl':
      return [bytesFromText(`^XA^CI28^PW${mono.width}^LL${mono.height}${zplGfa(mono, { x: 0, y: 0 })}^PQ${Math.max(1, doc.copies || 1)}^XZ`)];
    case 'tspl':
      return [
        bytesFromText(
          `SIZE ${num(doc.width)} mm,${num(doc.height)} mm\nGAP ${num(doc.gap || 2)} mm,0 mm\nDIRECTION 0\nCLS\n${tsplBitmap(mono, {
            x: 0,
            y: 0
          })}\nPRINT ${Math.max(1, doc.copies || 1)},1\n`
        )
      ];
    case 'epl':
      return [bytesFromText(`N\nq${mono.width}\nQ${mono.height},0\n${eplGwu(mono, { x: 0, y: 0 })}\nP${Math.max(1, doc.copies || 1)}\n`)];
    case 'cpcl':
      return [bytesFromText(`! 0 200 200 ${mono.height} ${Math.max(1, doc.copies || 1)}\r\nPAGE-WIDTH ${mono.width}\r\n${cpclExpand(mono, { x: 0, y: 0 })}\r\nFORM\r\nPRINT\r\n`)];
    case 'ipl':
      return [bytesFromText(`\u0002\u001bL\r\n${iplGraphic(mono, { x: 0, y: 0 })}\u0002E${Math.max(1, doc.copies || 1)}\r\n`)];
    case 'dpl':
      return [bytesFromText(`\u0002L\r${dplGraphic(mono, { x: 0, y: 0 })}\u0002P${Math.max(1, doc.copies || 1)}\r`)];
    case 'plain': {
      const text = opts.text || doc.name || 'ARSIN PRINT SERVER';
      return [bytesFromText(`${text}\n\u000c`)];
    }
    default:
      throw new Error(`unknown printer language "${lang}"`);
  }
}

/** Concatenate command chunks into one Uint8Array. */
export function flattenPayloads(chunks) {
  const parts = [];
  for (const chunk of chunks) {
    if (chunk == null) continue;
    if (typeof chunk === 'string') parts.push(bytesFromText(chunk));
    else if (chunk instanceof Uint8Array) parts.push([...chunk]);
    else parts.push([...chunk]);
  }
  return toUint8(parts.flat());
}

/**
 * Render a document for a printer language.
 *
 * @param {object} doc     label document (see createLabelDoc)
 * @param {{lang:string, mode?:'native'|'raster'|'auto', raster?:object, text?:string}} opts
 * @returns {{lang:string, mode:string, chunks:Array, bytes:Uint8Array, text:string, warnings:string[], elementCount:number}}
 */
export function renderLabel(doc, opts = {}) {
  const lang = opts.lang || doc.language || 'zpl';
  const mode = opts.mode || 'native';
  const ctx = ctxFor(doc);
  const renderer = NATIVE_RENDERERS[lang];
  if (!renderer) throw new Error(`unknown printer language "${lang}"`);
  const warnings = [];
  let chunks;
  let usedMode = mode;
  if (mode === 'raster' || (mode === 'auto' && RASTER_ONLY.includes(lang))) {
    if (!opts.raster) {
      if (mode === 'raster') throw new Error('raster mode needs a monochrome bitmap (opts.raster)');
      chunks = renderer(doc, ctx);
      usedMode = 'native';
    } else {
      chunks = renderLabelRaster(doc, lang, opts.raster, opts);
      usedMode = 'raster';
    }
  } else {
    chunks = renderer(doc, ctx);
  }
  if (usedMode === 'native' && RASTER_ONLY.includes(lang)) {
    warnings.push(`${lang} firmware dialects differ; verify the output on your device or switch to raster mode`);
  }
  warnings.push(...ctx.warnings);
  const bytes = flattenPayloads(chunks);
  const text = typeof chunks === 'string' ? chunks : typeof chunks[0] === 'string' ? chunks.join('') : safeDecode(bytes);
  return {
    lang,
    mode: usedMode,
    chunks,
    bytes,
    text,
    warnings,
    elementCount: (doc.elements || []).length,
    size: { width: doc.width, height: doc.height, dpi: doc.dpi }
  };
}

function safeDecode(bytes) {
  let out = '';
  for (const b of bytes) out += b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 ? '\n' : b === 13 ? '\r' : '.';
  return out;
}

