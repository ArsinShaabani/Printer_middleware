/**
 * Arsin Print Server - monochrome raster helpers (pure).
 *
 * Turns any RGBA image data (canvas ImageData, an uploaded logo, a rendered
 * label) into 1 bit per pixel bitmaps and emits the native raster command of
 * every supported printer language. This is the universal printing path: if a
 * printer understands only graphics, it still prints what the designer shows.
 *
 * Bitmaps are { width, height, bytesPerRow, bits } where `bits` is row packed,
 * most significant bit first, 1 = black (mark), 0 = white.
 */

/** Relative luminance 0..255 from r,g,b. */
export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Convert RGBA image data to a 1bpp bitmap.
 * @param {{width:number,height:number,data:Uint8ClampedArray|number[]}} image
 * @param {{threshold?:number, dither?:'none'|'floyd'|'atkinson'|'bayer', invert?:boolean, alphaThreshold?:number}} opts
 */
export function toMono(image, opts = {}) {
  const { width, height, data } = image;
  const threshold = opts.threshold == null ? 128 : opts.threshold;
  const dither = opts.dither || 'none';
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    const alpha = a == null ? 255 : a;
    let v = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (alpha < (opts.alphaThreshold == null ? 128 : opts.alphaThreshold)) v = 255; // transparent -> white
    gray[i] = opts.invert ? 255 - v : v;
  }
  let black;
  if (dither === 'floyd') black = floydSteinberg(gray, width, height, threshold);
  else if (dither === 'atkinson') black = atkinson(gray, width, height, threshold);
  else if (dither === 'bayer') black = bayerDither(gray, width, height, threshold);
  else black = simpleThreshold(gray, threshold);
  return packBitmap(black, width, height);
}

function simpleThreshold(gray, threshold) {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] < threshold ? 1 : 0;
  return out;
}

/** Floyd-Steinberg error diffusion. */
export function floydSteinberg(gray, width, height, threshold) {
  const buf = Float32Array.from(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const val = old < threshold ? 0 : 255;
      const err = old - val;
      out[i] = val === 0 ? 1 : 0;
      if (x + 1 < width) buf[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += (err * 3) / 16;
        buf[i + width] += (err * 5) / 16;
        if (x + 1 < width) buf[i + width + 1] += (err * 1) / 16;
      }
    }
  }
  return out;
}

/** Atkinson dithering - lighter, higher contrast look. */
export function atkinson(gray, width, height, threshold) {
  const buf = Float32Array.from(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const val = old < threshold ? 0 : 255;
      const err = Math.floor((old - val) / 8);
      out[i] = val === 0 ? 1 : 0;
      for (const [dx, dy] of [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny < height) buf[ny * width + nx] += err;
      }
    }
  }
  return out;
}

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21]
];

/** Ordered 8x8 Bayer dithering - fastest, deterministic output. */
export function bayerDither(gray, width, height, threshold) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const limit = ((BAYER8[y % 8][x % 8] + 0.5) * 255) / 64;
      out[i] = gray[i] * 0.35 + limit * 0.65 < threshold ? 1 : 0;
    }
  }
  return out;
}

/** Row pack 1bpp data, MSB first. */
export function packBitmap(black, width, height) {
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

export function toHexString(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0').toUpperCase();
  return out;
}

/** Scale a bitmap by an integer factor (1 = unchanged). */
export function scaleBitmap(mono, factor) {
  if (!factor || factor === 1) return mono;
  const width = mono.width * factor;
  const height = mono.height * factor;
  const black = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / factor);
      const sy = Math.floor(y / factor);
      if (mono.bits[sy * mono.bytesPerRow + (sx >> 3)] & (0x80 >> (sx & 7))) black[y * width + x] = 1;
    }
  }
  return packBitmap(black, width, height);
}

/** Crop or (optionally) scale a bitmap so it fits the target width in dots. */
export function fitWidth(mono, targetWidth, opts = {}) {
  if (mono.width === targetWidth) return mono;
  if (mono.width > targetWidth) {
    const black = new Uint8Array(targetWidth * mono.height);
    for (let y = 0; y < mono.height; y++) {
      for (let x = 0; x < targetWidth; x++) {
        if (mono.bits[y * mono.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) black[y * targetWidth + x] = 1;
      }
    }
    return packBitmap(black, targetWidth, mono.height);
  }
  const factor = Math.max(1, Math.round(targetWidth / mono.width));
  const scaled = scaleBitmap(mono, factor);
  if (scaled.width === targetWidth || !opts.pad) return scaled;
  const black = new Uint8Array(targetWidth * scaled.height);
  for (let y = 0; y < scaled.height; y++) {
    for (let x = 0; x < Math.min(targetWidth, scaled.width); x++) {
      if (scaled.bits[y * scaled.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) black[y * targetWidth + x] = 1;
    }
  }
  return packBitmap(black, targetWidth, scaled.height);
}

/* --------------------------------------------------- native raster output */

const ESC = 0x1b;
const GS = 0x1d;

/** ESC/POS GS v 0 raster bit image. */
export function escposRaster(mono) {
  const xL = mono.bytesPerRow & 0xff;
  const xH = (mono.bytesPerRow >> 8) & 0xff;
  const yL = mono.height & 0xff;
  const yH = (mono.height >> 8) & 0xff;
  return [GS, 0x76, 0x30, 0x00, xL, xH, yL, yH, ...mono.bits];
}

/** Star Line Mode raster graphics (ESC * r A ... ESC * r B). */
export function starRaster(mono) {
  const out = [ESC, 0x2a, 0x72, 0x41];
  for (let y = 0; y < mono.height; y++) {
    const nL = mono.bytesPerRow & 0xff;
    const nH = (mono.bytesPerRow >> 8) & 0xff;
    out.push(0x62, nL, nH);
    for (let b = 0; b < mono.bytesPerRow; b++) out.push(mono.bits[y * mono.bytesPerRow + b]);
  }
  out.push(ESC, 0x2a, 0x72, 0x42);
  return out;
}

/** ESC/P bit image (ESC * m nL nH data) using the 24 dot vertical modes. */
export function escpRaster(mono, opts = {}) {
  const mode = opts.mode == null ? 39 : opts.mode; // 39 = 24-dot triple density
  const out = [ESC, 0x40];
  const rows = Math.ceil(mono.height / 24);
  for (let band = 0; band < rows; band++) {
    out.push(ESC, 0x2a, mode, mono.width & 0xff, (mono.width >> 8) & 0xff);
    for (let x = 0; x < mono.width; x++) {
      for (let k = 0; k < 3; k++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const y = band * 24 + k * 8 + bit;
          if (y >= mono.height) continue;
          if (mono.bits[y * mono.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) byte |= 0x80 >> bit;
        }
        out.push(byte);
      }
    }
    out.push(0x0a);
  }
  return out;
}

/** ZPL ^GFA graphic field. */
export function zplGfa(mono, opts = {}) {
  const x = opts.x || 0;
  const y = opts.y || 0;
  const total = mono.bits.length;
  const hex = toHexString(mono.bits);
  return `^FO${x},${y}^GFA,${total},${total},${mono.bytesPerRow},${hex}`;
}

/** TSPL BITMAP command. */
export function tsplBitmap(mono, opts = {}) {
  const x = opts.x || 0;
  const y = opts.y || 0;
  return `BITMAP ${x},${y},${mono.bytesPerRow},${mono.height},0,${toHexString(mono.bits)}`;
}

/** EPL GW (graphics write) command. */
export function eplGwu(mono, opts = {}) {
  const x = opts.x || 0;
  const y = opts.y || 0;
  return `GW${x},${y},${mono.bytesPerRow},${mono.height},${toHexString(mono.bits)}`;
}

/** CPCL EG (expanded graphics) command. */
export function cpclExpand(mono, opts = {}) {
  const x = opts.x || 0;
  const y = opts.y || 0;
  return `EG${mono.bytesPerRow},${mono.height},${x},${y},${toHexString(mono.bits)}`;
}

/** IPL graphic field. */
export function iplGraphic(mono, opts = {}) {
  const x = opts.x || 0;
  const y = opts.y || 0;
  return `\u0002G${mono.bytesPerRow},${mono.height},${x},${y}\r\n`;
}

/** DPL graphic field (Datamax). */
export function dplGraphic(mono, opts = {}) {
  const x = opts.x || 0;
  const y = opts.y || 0;
  return `\u0002G${x},${y},${mono.bytesPerRow},${mono.height},${toHexString(mono.bits)}\r`;
}

/** A quick ASCII preview of a bitmap (used by tests and the CLI tools). */
export function bitmapToAscii(mono, opts = {}) {
  const step = opts.step || 1;
  const rows = [];
  for (let y = 0; y < mono.height; y += step) {
    let line = '';
    for (let x = 0; x < mono.width; x += step) {
      const on = mono.bits[y * mono.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7));
      line += on ? '#' : '.';
    }
    rows.push(line);
  }
  return rows.join('\n');
}

