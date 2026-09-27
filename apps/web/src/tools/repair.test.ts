/**
 * "Save repaired copy" and the structural check on an encrypted, damaged source (review
 * M3 #6), and verification of a compressed copy before download (review M3 #5). Runs
 * against the app's engine service and compress worker.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';

import encryptedUrl from '../../../../test/fixtures/encrypted-aes-256.pdf?url';
import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import { getEngineService } from '../engine/engine-service';
import { disposeCompressor } from './compress-client';
import { repairedCopy, structuralCheck } from './repair';
import { verifyCopy } from './verify-copy';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();

/** Moves the final startxref 100 bytes early, as broken-xref.pdf does. */
function breakXref(bytes: ArrayBuffer): ArrayBuffer {
  const text = new TextDecoder('latin1').decode(bytes);
  const at = text.lastIndexOf('startxref');
  const match = /startxref\s+(\d+)/.exec(text.slice(at));
  if (!match?.[1]) throw new Error('no startxref');
  const broken = `${text.slice(0, at)}startxref\n${Number(match[1]) - 100}\n%%EOF\n`;
  return Uint8Array.from(broken, (c) => c.charCodeAt(0)).buffer;
}

afterAll(async () => {
  await disposeCompressor();
});

describe('repair of an encrypted source', () => {
  it('repairs with the open password and keeps the protection', async () => {
    const engine = getEngineService();
    const opened = await engine.open(
      new File([breakXref(await fetchBytes(encryptedUrl))], 'locked-broken.pdf'),
      'user',
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { id, document } = opened.value;
    expect(document.flags).toMatchObject({ repaired: true, encrypted: true });
    try {
      const copy = await repairedCopy({
        id,
        pageCount: document.pageCount,
        pages: document.pages.map((p) => ({ size: p.size, rotation: p.rotation })),
      });
      expect(copy.repaired).toBe(true);
      await expect(PDFDocument.load(copy.bytes.slice(0))).rejects.toThrow();
      const reopened = await PDFDocument.load(copy.bytes.slice(0), { password: 'user' });
      expect(reopened.getPageCount()).toBe(3);

      const check = structuralCheck(id);
      expect(structuralCheck(id)).toBe(check); // memoized per source
      expect(await check).toMatchObject({ repaired: true, encrypted: true, unreadable: false });
      expect((await check).warnings.join(' ')).toMatch(/xref|damaged|reconstruct/i);
    } finally {
      await engine.close(id);
    }
  });
});

describe('compressed copy verification', () => {
  it('accepts a faithful copy and reports a copy that lost pages', async () => {
    const source = await fetchBytes(imagesUrl);
    expect(await verifyCopy(source, source.slice(0))).toEqual([]);
    const shorter = await PDFDocument.load(source.slice(0));
    shorter.removePage(2);
    const problems = await verifyCopy(source, (await shorter.save()).slice().buffer);
    expect(problems.join(' ')).toMatch(/Page count is 2, expected 3/);
    // Neither buffer was detached.
    expect(source.byteLength).toBeGreaterThan(0);
  });
});
