/**
 * Open-path facts EmbedPDF does not report: page labels and /Lang (pdf-lib inspector) and
 * the `repaired` flag (pure xref check). Uses the shared corpus in test/fixtures.
 */

import { PDFName, PDFString } from '@cantoo/pdf-lib';
import brokenXrefUrl from '../../../test/fixtures/broken-xref.pdf?url';
import encryptedUrl from '../../../test/fixtures/encrypted-aes-256.pdf?url';
import garbagePrefixUrl from '../../../test/fixtures/garbage-prefix.pdf?url';
import manyPagesUrl from '../../../test/fixtures/many-pages.pdf?url';
import pageLabelsUrl from '../../../test/fixtures/page-labels.pdf?url';
import simpleTextUrl from '../../../test/fixtures/simple-text.pdf?url';
import truncatedUrl from '../../../test/fixtures/truncated.pdf?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import { checkXrefStructure } from '../src/structure/xref-check';
import { createAssemblerProxy } from '../src/worker/create-assembler-proxy';
import { makePdf, sid, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const PAGE_LABELS = ['i', 'ii', 'iii', '1', '2', '3', 'A-1', 'A-2'];

const inspector = new PdfLibAssembler();
let adapter: PdfiumAdapter;

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl, inspector });
});
afterAll(async () => {
  await adapter.destroy();
});

describe('page labels', () => {
  test('pdf-lib expands the /PageLabels number tree', async () => {
    const labels = await inspector.getPageLabels(await fetchBytes(pageLabelsUrl));
    expect(labels).toEqual(PAGE_LABELS);
    expect(await inspector.getPageLabels(await fetchBytes(simpleTextUrl))).toBeUndefined();
  });

  test('the adapter puts labels on OpenedDocument pages', async () => {
    const opened = await adapter.open(sid('labels'), await fetchBytes(pageLabelsUrl));
    await adapter.close(sid('labels'));
    expect(opened.pages.map((p) => p.label)).toEqual(PAGE_LABELS);
    const plain = await adapter.open(sid('plain'), await fetchBytes(simpleTextUrl));
    await adapter.close(sid('plain'));
    expect(plain.pages.map((p) => p.label)).toEqual([undefined, undefined, undefined]);
  });

  test('labels are read through the assembly worker, and pages before the first range are numbered', async () => {
    const bytes = await makePdf(
      [{ size: [100, 100] }, { size: [100, 100] }, { size: [100, 100] }, { size: [100, 100] }],
      (doc) => {
        // Kids-based number tree, first range at page 2, no /S (prefix only), /St 5.
        const leaf = doc.context.obj({
          Nums: [2, { S: 'R', St: 5 }, 3, { P: PDFString.of('Cover') }],
        });
        doc.catalog.set(
          PDFName.of('PageLabels'),
          doc.context.obj({ Kids: [doc.context.register(leaf)] }),
        );
        doc.setLanguage('de-CH');
      },
    );
    const worker = new Worker(new URL('../src/worker/assembler.worker.ts', import.meta.url), {
      type: 'module',
    });
    const proxy = createAssemblerProxy(worker);
    try {
      const inspection = await proxy.inspect(bytes.slice(0));
      expect(inspection).toEqual({ pageLabels: ['1', '2', 'V', 'Cover'], language: 'de-CH' });
      // Damaged input never rejects.
      expect(await proxy.inspect(new TextEncoder().encode('not a pdf').buffer)).toEqual({});
    } finally {
      proxy.dispose();
    }
  });

  test('/Lang reaches OpenedDocument metadata', async () => {
    const bytes = await makePdf([{ size: [100, 100] }], (doc) => doc.setLanguage('fr-FR'));
    const opened = await adapter.open(sid('lang'), bytes);
    await adapter.close(sid('lang'));
    expect(opened.metadata.language).toBe('fr-FR');
  });

  test('encrypted files: labels are read with the password', async () => {
    const opened = await adapter.open(sid('enc'), await fetchBytes(encryptedUrl), {
      password: 'user',
    });
    await adapter.close(sid('enc'));
    expect(opened.pageCount).toBe(3);
    expect(opened.flags.repaired).toBe(false);
  });
});

describe('repaired flag', () => {
  const cases = [
    { name: 'broken-xref.pdf', url: brokenXrefUrl, repaired: true },
    { name: 'truncated.pdf', url: truncatedUrl, repaired: true },
    { name: 'garbage-prefix.pdf', url: garbagePrefixUrl, repaired: true },
    { name: 'simple-text.pdf', url: simpleTextUrl, repaired: false },
    { name: 'many-pages.pdf (xref stream)', url: manyPagesUrl, repaired: false },
    { name: 'encrypted-aes-256.pdf', url: encryptedUrl, repaired: false },
  ];

  test.each(cases)('xref check: $name → repaired $repaired', async ({ url, repaired }) => {
    const result = checkXrefStructure(await fetchBytes(url));
    expect(result.repaired).toBe(repaired);
    if (repaired) expect(result.reason).toBeTruthy();
  });

  test.each(
    cases.filter((c) => !c.name.startsWith('encrypted') && !c.name.startsWith('truncated')),
  )('PDFium open: $name → flags.repaired $repaired', async ({ name, url, repaired }) => {
    const id = sid(`repair-${name}`);
    const opened = await adapter.open(id, await fetchBytes(url));
    await adapter.close(id);
    expect(opened.flags.repaired).toBe(repaired);
    expect(opened.pageCount).toBe(name.startsWith('many') ? 400 : 3);
  });

  test('PDFium refuses truncated.pdf with a clear error (the fixture allows either)', async () => {
    await expect(
      adapter.open(sid('truncated'), await fetchBytes(truncatedUrl)),
    ).rejects.toMatchObject({
      code: 'corrupt',
    });
  });

  test('pdf-lib output and incremental updates pass; a bad /Prev fails', async () => {
    const bytes = new Uint8Array(await makePdf([{ size: [100, 100], text: 'x' }]));
    expect(checkXrefStructure(bytes).repaired).toBe(false);
    const text = new TextDecoder('latin1').decode(bytes);
    // Append an incremental update whose /Prev points at the original xref stream.
    const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)?.[1]);
    const update = (prev: number) => {
      const body = `\n99 0 obj\n(extra)\nendobj\n`;
      const objOffset = bytes.length + 1;
      const xrefOffset = bytes.length + body.length;
      const xref =
        `xref\n0 1\n0000000000 65535 f \n99 1\n${String(objOffset).padStart(10, '0')} 00000 n \n` +
        `trailer\n<< /Size 100 /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      const tail = new TextEncoder().encode(body + xref);
      const out = new Uint8Array(bytes.length + tail.length);
      out.set(bytes);
      out.set(tail, bytes.length);
      return out;
    };
    expect(checkXrefStructure(update(startxref))).toEqual({ repaired: false });
    expect(checkXrefStructure(update(startxref - 7)).repaired).toBe(true);
  });
});
