/**
 * Compression inside the export pipeline: the real assembler and PDFium verifier, and the
 * real compress worker (qpdf + PDFium decoder) behind `compressExport`.
 */
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { PDFDocument } from '@cantoo/pdf-lib';
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  type SourceId,
  sourceId,
  type Workspace,
} from '@pdf-editor/document-model';
import { PdfiumAdapter, PdfLibAssembler, presetSettings } from '@pdf-editor/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import { type ExportDependencies, prepareExport } from '../export/export-service';
import { disposeCompressor } from './compress-client';
import { compressExport } from './export-compression';
import { setExportCompression, useToolsStore } from './tools-store';

const assembler = new PdfLibAssembler();
const adapter = new PdfiumAdapter({ wasmUrl, inspector: assembler });
const original = new Map<SourceId, ArrayBuffer>();
let ws: Workspace;
let documentId: DocumentId;

beforeAll(async () => {
  const bytes = await (await fetch(imagesUrl)).arrayBuffer();
  original.set(sourceId('img'), bytes.slice(0));
  const opened = await adapter.open(sourceId('img'), bytes);
  const added = addSource(
    createWorkspace(),
    { ...opened, name: 'images.pdf', byteLength: original.get(sourceId('img'))?.byteLength ?? 0 },
    createSequentialIdGenerator('img'),
    { sourceId: sourceId('img') },
  );
  ws = added.workspace;
  documentId = added.documentId;
});

afterAll(async () => {
  await disposeCompressor();
  await adapter.destroy();
  useToolsStore.setState({ exportCompression: {} });
});

function deps(overrides: Partial<ExportDependencies> = {}): ExportDependencies {
  return {
    engine: {
      sourceBytes: (id) => {
        const bytes = original.get(id);
        return Promise.resolve(
          bytes
            ? { ok: true, value: bytes.slice(0) }
            : { ok: false, error: { code: 'internal', message: 'unknown source' } },
        );
      },
      saveSource: async (id, options) => ({ ok: true, value: await adapter.save(id, options) }),
      verify: async (bytes, expectation) => ({
        ok: true,
        value: await adapter.verify(bytes, expectation),
      }),
    },
    assembler: () => Promise.resolve(assembler),
    workspace: () => ws,
    compress: compressExport,
    compressionFor: (id) => useToolsStore.getState().exportCompression[id],
    ...overrides,
  };
}

describe('export with compression', () => {
  it('compresses the assembled bytes with the applied preset and verifies them', async () => {
    const plain = await prepareExport(documentId, {}, deps());
    expect(plain.ok && plain.value.compression).toBe(undefined);

    setExportCompression(documentId, { ...presetSettings('screen'), flattenAlpha: true });
    const result = await prepareExport(documentId, {}, deps());
    expect(result.ok).toBe(true);
    if (!result.ok || !plain.ok) return;
    expect(result.value.verification.ok).toBe(true);
    expect(result.value.compression).toMatchObject({ preset: 'screen' });
    expect(result.value.compression?.after).toBe(result.value.bytes.byteLength);
    expect(result.value.bytes.byteLength).toBeLessThan(plain.value.bytes.byteLength);
    const doc = await PDFDocument.load(result.value.bytes.slice(0), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);

    // An explicit `null` turns it off for one export (the compress dialog's own source).
    const off = await prepareExport(documentId, { compression: null }, deps());
    expect(off.ok && off.value.compression).toBe(undefined);
  });

  it('re-encrypts an encrypted export after compressing it', async () => {
    setExportCompression(documentId, presetSettings('ebook'));
    const result = await prepareExport(
      documentId,
      {
        security: {
          algorithm: 'aes-256',
          userPassword: 'user',
          ownerPassword: 'owner',
          permissions: {
            print: true,
            printHighQuality: true,
            modify: false,
            copy: false,
            annotate: true,
            fillForms: true,
            accessibility: true,
            assemble: false,
          },
        },
      },
      deps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verification).toEqual({ ok: true, problems: [] });
    await expect(PDFDocument.load(result.value.bytes.slice(0))).rejects.toThrow();
    const reopened = await PDFDocument.load(result.value.bytes.slice(0), { password: 'user' });
    expect(reopened.getPageCount()).toBe(3);
  });
});
