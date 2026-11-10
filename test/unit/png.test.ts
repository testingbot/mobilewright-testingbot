import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pngSize, transformPng } from '../../src/png.js';

/** Build a test PNG whose pixel (x, y) is [x, y, x ^ y, 255], using every filter type. */
function makePng(width: number, height: number, bpp = 4, filters = [0, 1, 2, 3, 4]): Buffer {
  const pixel = (x: number, y: number) => [x & 0xff, y & 0xff, (x ^ y) & 0xff, 255].slice(0, bpp);
  const stride = width * bpp;
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(...pixel(x, y));
    rows.push(row);
  }
  const raw: number[] = [];
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]!;
    raw.push(f);
    for (let i = 0; i < stride; i++) {
      const cur = rows[y]![i]!;
      const left = i >= bpp ? rows[y]![i - bpp]! : 0;
      const up = y > 0 ? rows[y - 1]![i]! : 0;
      const ul = y > 0 && i >= bpp ? rows[y - 1]![i - bpp]! : 0;
      const pred = [0, left, up, (left + up) >> 1, paeth(left, up, ul)][f]!;
      raw.push((cur - pred) & 0xff);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC unchecked by decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode our own (Sub-filtered) output back to pixel rows. */
function readPixels(png: Buffer, bpp: number): number[][] {
  const { width, height } = pngSize(png)!;
  let off = 8; const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off); const type = png.toString('latin1', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)); const stride = width * bpp; const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(1);
    const row: number[] = [];
    for (let i = 0; i < stride; i++) row.push((raw[y * (stride + 1) + 1 + i]! + (i >= bpp ? row[i - bpp]! : 0)) & 0xff);
    rows.push(row);
  }
  return rows;
}

describe('transformPng', () => {
  it('crops to the rect across all five filter types (RGBA)', () => {
    const out = transformPng(makePng(40, 30), { x: 5, y: 7, width: 10, height: 6 })!;
    expect(pngSize(out)).toEqual({ width: 10, height: 6 });
    const rows = readPixels(out, 4);
    expect(rows[0]!.slice(0, 4)).toEqual([5, 7, 5 ^ 7, 255]);
    expect(rows[5]!.slice(-4)).toEqual([14, 12, 14 ^ 12, 255]);
  });

  it('crops RGB images', () => {
    const out = transformPng(makePng(20, 20, 3), { x: 2, y: 3, width: 4, height: 4 })!;
    expect(readPixels(out, 3)[0]!.slice(0, 3)).toEqual([2, 3, 2 ^ 3]);
  });

  it('clamps a rect that overhangs the image and rounds fractional edges outward', () => {
    const out = transformPng(makePng(20, 20), { x: 15.5, y: -3, width: 10, height: 5.2 })!;
    expect(pngSize(out)).toEqual({ width: 5, height: 3 });
  });

  it('returns undefined for a rect fully outside the image', () => {
    expect(transformPng(makePng(10, 10), { x: 50, y: 50, width: 5, height: 5 })).toBeUndefined();
  });

  it('downscales by box-averaging', () => {
    const out = transformPng(makePng(8, 8), undefined, 0.5)!;
    expect(pngSize(out)).toEqual({ width: 4, height: 4 });
    // Output (0,0) averages source x,y in {0,1}: R = (0+1+0+1)/4 = 0.5 → 1 (round half up).
    expect(readPixels(out, 4)[0]!.slice(0, 2)).toEqual([1, 1]);
  });

  it('returns undefined for non-PNG or unsupported formats', () => {
    expect(transformPng(Buffer.from('not a png'), undefined)).toBeUndefined();
    const palette = makePng(4, 4);
    palette[8 + 8 + 9] = 3; // IHDR color type → palette
    expect(transformPng(palette, { x: 0, y: 0, width: 2, height: 2 })).toBeUndefined();
  });
});
