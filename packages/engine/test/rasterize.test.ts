/** PDF → images planning, stitching and ZIP (spec §6). */
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { encodeRasterPage, zipFiles } from '../src/rasterize/encode-page';
import {
  fitsCanvas,
  parsePageRange,
  rasterFileName,
  rasterSize,
  rasterTiles,
  uniqueNames,
} from '../src/rasterize/plan';

describe('raster planning', () => {
  it('computes pixel sizes from points and dpi', () => {
    expect(rasterSize(612, 792, 72)).toEqual({ width: 612, height: 792 });
    expect(rasterSize(612, 792, 150)).toEqual({ width: 1275, height: 1650 });
    expect(rasterSize(595.28, 841.89, 600)).toEqual({ width: 4961, height: 7016 });
    expect(fitsCanvas(4961, 7016)).toBe(true);
    expect(fitsCanvas(40_000, 10)).toBe(false);
    expect(fitsCanvas(20_000, 20_000)).toBe(false);
  });

  it('tiles large pages in rows of at most 4096 px', () => {
    const tiles = rasterTiles(4961, 7016);
    expect(tiles).toHaveLength(4);
    expect(tiles[3]).toEqual({ x: 4096, y: 4096, width: 865, height: 2920 });
    expect(rasterTiles(100, 100)).toEqual([{ x: 0, y: 0, width: 100, height: 100 }]);
  });

  it('parses page ranges', () => {
    expect(parsePageRange('', 3)).toEqual([0, 1, 2]);
    expect(parsePageRange('1-3, 5', 6)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange('4-', 6)).toEqual([3, 4, 5]);
    expect(parsePageRange('-2', 6)).toEqual([0, 1]);
    expect(parsePageRange('2, 2, 1', 6)).toEqual([0, 1]);
    expect(parsePageRange('0', 6)).toBeNull();
    expect(parsePageRange('7', 6)).toBeNull();
    expect(parsePageRange('3-1', 6)).toBeNull();
    expect(parsePageRange('a', 6)).toBeNull();
  });

  it('names files from the template, padded and safe', () => {
    const name = (template: string, page: number, pageCount = 12) =>
      rasterFileName(template, { title: 'Q3: report', page, pageCount, label: 'iv' }, 'png');
    expect(name('{title}-{page}', 3)).toBe('Q3_ report-03.png');
    expect(name('{label}', 4)).toBe('iv.png');
    expect(name('', 1, 5)).toBe('Q3_ report-1.png');
    expect(rasterFileName('x', { title: 't', page: 1, pageCount: 1 }, 'jpeg')).toBe('x.jpg');
    expect(uniqueNames(['a.png', 'a.png', 'b.png', 'a.png'])).toEqual([
      'a.png',
      'a (2).png',
      'b.png',
      'a (3).png',
    ]);
  });
});

async function solidBitmap(width: number, height: number, colour: string): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no context');
  context.fillStyle = colour;
  context.fillRect(0, 0, width, height);
  return createImageBitmap(canvas);
}

describe('raster encoding', () => {
  it('stitches tiles into one PNG and zips several files', async () => {
    const png = await encodeRasterPage({
      name: 'p.png',
      width: 300,
      height: 100,
      tiles: [
        { bitmap: await solidBitmap(200, 100, '#ff0000'), x: 0, y: 0 },
        { bitmap: await solidBitmap(100, 100, '#0000ff'), x: 200, y: 0 },
      ],
      format: 'png',
      quality: 90,
      background: 'transparent',
    });
    const decoded = await createImageBitmap(
      new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
    );
    expect([decoded.width, decoded.height]).toEqual([300, 100]);
    const canvas = new OffscreenCanvas(300, 100);
    const context = canvas.getContext('2d');
    context?.drawImage(decoded, 0, 0);
    expect([...(context?.getImageData(250, 50, 1, 1).data ?? [])]).toEqual([0, 0, 255, 255]);
    expect([...(context?.getImageData(10, 50, 1, 1).data ?? [])]).toEqual([255, 0, 0, 255]);

    const jpeg = await encodeRasterPage({
      name: 'p.jpg',
      width: 50,
      height: 50,
      tiles: [],
      format: 'jpeg',
      quality: 80,
      background: 'transparent',
    });
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const zip = await zipFiles([
      { name: 'a.png', bytes: png },
      { name: 'b.jpg', bytes: jpeg },
    ]);
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(['a.png', 'b.jpg']);
    expect(files['b.jpg']?.length).toBe(jpeg.length);
  });

  it('refuses pages beyond the canvas limits', async () => {
    await expect(
      encodeRasterPage({
        name: 'x.png',
        width: 40_000,
        height: 10,
        tiles: [],
        format: 'png',
        quality: 90,
        background: 'white',
      }),
    ).rejects.toThrow(/canvas limits/);
  });
});
