/**
 * Repeated occurrences of one source page: each occurrence gets its own rotation and crop
 * (starting from the source page, not from an earlier occurrence), and encrypted output
 * keeps their annotations' strings intact (no direct object is shared, and so encrypted
 * twice). Also: the user password reaches the verifier through the export plan.
 */

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from '@cantoo/pdf-lib';
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  type SecurityPolicy,
  type VirtualPage,
} from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { planExport } from '../src/export-plan';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { encryptStrings, PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type { LinkAnnotation } from '../src/types';
import { makePdf, sid, vdoc, vpage, wasmUrl } from './helpers';

const S = sid('dup-src');
const assembler = new PdfLibAssembler();
let adapter: PdfiumAdapter;

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl, inspector: assembler });
});
afterAll(async () => {
  await adapter.destroy();
});

const SOURCE_CROP = { x: 5, y: 5, width: 190, height: 290 };
const URI = 'https://example.com/a?b=c';

/** One 200x300 page with its own CropBox and a URI link whose /A is a direct dictionary. */
async function source(): Promise<ArrayBuffer> {
  return makePdf([{ size: [200, 300], text: 'Dup' }], (doc) => {
    const page = doc.getPage(0);
    page.setCropBox(SOURCE_CROP.x, SOURCE_CROP.y, SOURCE_CROP.width, SOURCE_CROP.height);
    const link = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [20, 20, 120, 40],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of(URI) },
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  });
}

const occurrence = (extra: Partial<Omit<VirtualPage, 'ref'>> = {}) =>
  vpage({ kind: 'source', source: S, index: 0 }, extra);

async function assemblePages(pages: VirtualPage[], security?: SecurityPolicy) {
  const result = await assembler.assemble(
    { document: vdoc(pages), sources: new Map([[S, await source()]]), blobs: new Map() },
    security ? { security } : {},
  );
  return result;
}

async function boxes(bytes: ArrayBuffer) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => ({
    rotation: page.getRotation().angle,
    crop: page.getCropBox(),
  }));
}

const POLICY: SecurityPolicy = {
  algorithm: 'aes-256',
  userPassword: 'dup-pw',
  permissions: {
    print: true,
    printHighQuality: true,
    modify: true,
    copy: true,
    annotate: true,
    fillForms: true,
    accessibility: true,
    assemble: true,
  },
};

describe('repeated source pages', () => {
  test('rotating only the first occurrence leaves the second unrotated', async () => {
    const { bytes } = await assemblePages([occurrence({ rotation: 90 }), occurrence()]);
    expect((await boxes(bytes)).map((b) => b.rotation)).toEqual([90, 0]);
  });

  test('rotating both occurrences rotates each once', async () => {
    const { bytes } = await assemblePages([
      occurrence({ rotation: 90 }),
      occurrence({ rotation: 90 }),
    ]);
    expect((await boxes(bytes)).map((b) => b.rotation)).toEqual([90, 90]);
  });

  test('cropping only the first occurrence leaves the source crop on the second', async () => {
    const crop = { x: 10, y: 10, width: 50, height: 50 };
    const { bytes } = await assemblePages([occurrence({ cropBox: crop }), occurrence()]);
    expect((await boxes(bytes)).map((b) => b.crop)).toEqual([crop, SOURCE_CROP]);
  });

  test('encrypted output keeps the link URI on every occurrence', async () => {
    const { bytes } = await assemblePages([occurrence(), occurrence({ rotation: 180 })], POLICY);
    const raw = new TextDecoder('latin1').decode(bytes);
    expect(raw).not.toContain(URI);
    const id = sid('dup-secure');
    await adapter.open(id, bytes.slice(0), { password: 'dup-pw' });
    try {
      for (const pageIndex of [0, 1]) {
        const links = (await adapter.listAnnotations(id, pageIndex)).filter(
          (a): a is LinkAnnotation => a.kind === 'link',
        );
        expect(links.map((l) => l.uri)).toEqual([URI]);
      }
    } finally {
      await adapter.close(id);
    }
  });
});

test('encryptStrings encrypts a direct object shared by two indirect objects once', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([100, 100]);
  const shared = doc.context.obj({ S: 'URI', URI: PDFString.of(URI) });
  const link = () =>
    doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: shared }),
    );
  page.node.set(PDFName.of('Annots'), doc.context.obj([link(), link()]));
  doc.encrypt({ algorithm: 'AES-256', userPassword: 'pw' });
  await doc.flush();
  encryptStrings(doc);
  const bytes = await doc.save({ useObjectStreams: false });
  const reopened = await PDFDocument.load(bytes, { password: 'pw' });
  const annots = reopened.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  // The first holder's key wins; the second visit leaves the (already encrypted) string.
  const first = reopened.context.lookup(annots.get(0), PDFDict).lookup(PDFName.of('A'), PDFDict);
  const uri = first.lookup(PDFName.of('URI'));
  expect(uri instanceof PDFString || uri instanceof PDFHexString).toBe(true);
  expect((uri as PDFString | PDFHexString).decodeText()).toBe(URI);
});

describe('verifying encrypted output', () => {
  test('the export plan carries the user password to the verifier', async () => {
    const opened = await adapter.open(sid('dup-plan'), await source());
    await adapter.close(sid('dup-plan'));
    const added = addSource(
      createWorkspace(),
      { ...opened, name: 'dup.pdf', byteLength: 1 },
      createSequentialIdGenerator('d'),
      { sourceId: S },
    );
    const documentId: DocumentId = added.documentId;
    expect(planExport(added.workspace, documentId).expectation.password).toBeUndefined();
    const plan = planExport(added.workspace, documentId, { security: POLICY });
    expect(plan.security).toBe(POLICY);
    expect(plan.expectation.password).toBe('dup-pw');

    const { bytes } = await assembler.assemble(
      { document: plan.document, sources: new Map([[S, await source()]]), blobs: new Map() },
      { security: POLICY },
    );
    expect(await adapter.verify(bytes.slice(0), plan.expectation)).toEqual({
      ok: true,
      problems: [],
    });
    const { password: _password, ...withoutPassword } = plan.expectation;
    const locked = await adapter.verify(bytes.slice(0), withoutPassword);
    expect(locked.ok).toBe(false);
    expect(locked.problems.join(' ')).toContain('does not open');
  });
});
