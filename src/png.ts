import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal PNG crop/downscale for `screenshot({ clip, scale })`. Appium returns
 * 8-bit RGB or RGBA screenshots, so that is all this decodes. Anything else
 * (palette, 16-bit, grayscale, interlaced) returns `undefined`, and the caller
 * falls back to the uncropped image instead of failing the screenshot.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Decoded {
  width: number;
  height: number;
  /** Bytes per pixel: 3 (RGB) or 4 (RGBA). */
  bpp: number;
  colorType: number;
  /** Unfiltered pixel rows, tightly packed. */
  pixels: Buffer;
}

export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Crop `png` to `rect` (in image pixels, clamped to the image) and then
 * downscale by `factor` (0 < factor <= 1). Returns undefined when the PNG
 * format is unsupported or the rect lies entirely outside the image.
 */
export function transformPng(png: Buffer, rect: PixelRect | undefined, factor = 1): Buffer | undefined {
  const img = decode(png);
  if (!img) return undefined;

  let x0 = 0, y0 = 0, w = img.width, h = img.height;
  if (rect) {
    x0 = clamp(Math.floor(rect.x), 0, img.width);
    y0 = clamp(Math.floor(rect.y), 0, img.height);
    const x1 = clamp(Math.ceil(rect.x + rect.width), 0, img.width);
    const y1 = clamp(Math.ceil(rect.y + rect.height), 0, img.height);
    w = x1 - x0;
    h = y1 - y0;
    if (w <= 0 || h <= 0) return undefined;
  }

  const { bpp } = img;
  const srcStride = img.width * bpp;
  let out: Buffer = Buffer.alloc(w * h * bpp);
  for (let row = 0; row < h; row++) {
    const start = (y0 + row) * srcStride + x0 * bpp;
    img.pixels.copy(out, row * w * bpp, start, start + w * bpp);
  }

  if (factor > 0 && factor < 1) {
    const dw = Math.max(1, Math.round(w * factor));
    const dh = Math.max(1, Math.round(h * factor));
    out = downscale(out, w, h, dw, dh, bpp);
    w = dw;
    h = dh;
  }
  return encode(out, w, h, bpp, img.colorType);
}

function decode(png: Buffer): Decoded | undefined {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let offset = 8;
  let width = 0, height = 0, colorType = -1, bitDepth = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp || bitDepth !== 8 || interlace !== 0 || !width || !height || !idat.length) return undefined;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return undefined;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = y > 0 ? dst - stride : -1;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? pixels[dst + i - bpp]! : 0;
      const up = prev >= 0 ? pixels[prev + i]! : 0;
      const upLeft = prev >= 0 && i >= bpp ? pixels[prev + i - bpp]! : 0;
      let pred: number;
      switch (filter) {
        case 0: pred = 0; break;
        case 1: pred = left; break;
        case 2: pred = up; break;
        case 3: pred = (left + up) >> 1; break;
        case 4: pred = paeth(left, up, upLeft); break;
        default: return undefined;
      }
      pixels[dst + i] = (raw[src + i]! + pred) & 0xff;
    }
  }
  return { width, height, bpp, colorType, pixels };
}

function encode(pixels: Buffer, width: number, height: number, bpp: number, colorType: number): Buffer {
  const stride = width * bpp;
  // Filter type 1 (Sub) on every row: cheap and compresses screenshots well.
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    const src = y * stride;
    raw[dst] = 1;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? pixels[src + i - bpp]! : 0;
      raw[dst + 1 + i] = (pixels[src + i]! - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-filter downscale: each output pixel averages the source pixels it covers. */
function downscale(src: Buffer, sw: number, sh: number, dw: number, dh: number, bpp: number): Buffer {
  const out = Buffer.alloc(dw * dh * bpp);
  const sum = new Array<number>(bpp);
  for (let dy = 0; dy < dh; dy++) {
    const ys = Math.floor((dy * sh) / dh);
    const ye = Math.max(ys + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const xs = Math.floor((dx * sw) / dw);
      const xe = Math.max(xs + 1, Math.floor(((dx + 1) * sw) / dw));
      sum.fill(0);
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          const p = (y * sw + x) * bpp;
          for (let c = 0; c < bpp; c++) sum[c]! += src[p + c]!;
        }
      }
      const n = (ye - ys) * (xe - xs);
      const o = (dy * dw + dx) * bpp;
      for (let c = 0; c < bpp; c++) out[o + c] = Math.round(sum[c]! / n);
    }
  }
  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

let crcTable: Int32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return crc ^ -1;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
