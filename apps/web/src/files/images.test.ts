import { describe, expect, it } from 'vitest';

import {
  A4,
  decodeImageFile,
  exceedsA4,
  imagePageSize,
  isImageFile,
  shouldAskImageSizing,
  sniffImageType,
} from './images';
import { isOpenableFile, partitionFiles } from './open-files';

async function canvasImage(type: string, width: number, height: number): Promise<File> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#3a7';
  context.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type });
  const extension = type.split('/')[1] ?? 'bin';
  return new File([blob], `generated.${extension}`, { type });
}

describe('image files', () => {
  it('recognizes PNG, JPEG and WebP by type or extension', () => {
    expect(isImageFile({ name: 'a.PNG', type: '' })).toBe(true);
    expect(isImageFile({ name: 'scan', type: 'image/webp' })).toBe(true);
    expect(isImageFile({ name: 'photo.jpeg', type: '' })).toBe(true);
    expect(isImageFile({ name: 'icon.gif', type: 'image/gif' })).toBe(false);
    expect(isImageFile({ name: '._a.png', type: 'image/png' })).toBe(false);
    expect(isOpenableFile({ name: 'a.pdf', type: '' })).toBe(true);
    const files = [
      { name: 'b.png', type: '' },
      { name: 'a.pdf', type: '' },
      { name: 'x.txt', type: '' },
      { name: 'c.jpg', type: '' },
    ];
    expect(partitionFiles(files)).toEqual({
      pdfs: [files[1]],
      images: [files[0], files[3]],
    });
  });

  it('sizes pages at 72 dpi, capped to A4 width when fitting', () => {
    expect(imagePageSize(400, 300, 'fit-a4')).toEqual({ width: 400, height: 300 });
    const wide = imagePageSize(2000, 1000, 'fit-a4');
    expect(wide.width).toBe(A4.width);
    expect(wide.height).toBeCloseTo(297.64, 1);
    expect(imagePageSize(2000, 1000, 'original')).toEqual({ width: 2000, height: 1000 });
    expect(exceedsA4(595, 842)).toBe(true);
    expect(exceedsA4(595, 841)).toBe(false);
    expect(shouldAskImageSizing([{ width: 100, height: 100 }])).toBe(false);
    expect(shouldAskImageSizing([{ width: 1000, height: 100 }])).toBe(true);
    expect(
      shouldAskImageSizing([
        { width: 1, height: 1 },
        { width: 1, height: 1 },
      ]),
    ).toBe(true);
  });

  it('sniffs PNG and JPEG signatures', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeUndefined();
  });

  it('keeps PNG and JPEG bytes and re-encodes WebP to PNG', async () => {
    const png = await decodeImageFile(await canvasImage('image/png', 40, 30));
    expect(png).toMatchObject({ type: 'image/png', width: 40, height: 30 });
    const jpeg = await decodeImageFile(await canvasImage('image/jpeg', 20, 10));
    expect(jpeg.type).toBe('image/jpeg');
    const webpFile = await canvasImage('image/webp', 16, 12);
    const webp = await decodeImageFile(webpFile);
    expect(webp).toMatchObject({ type: 'image/png', width: 16, height: 12 });
    expect(sniffImageType(new Uint8Array(webp.bytes, 0, 8))).toBe('image/png');
    await expect(
      decodeImageFile(new File(['nope'], 'bad.png', { type: 'image/png' })),
    ).rejects.toThrow();
  });
});
