/**
 * Export pipeline against the real engines (PDFium adapter with its pdf-lib inspector and
 * the pdf-lib assembler) on corpus files; only the engine service is replaced by a thin
 * wrapper so the test controls source bytes.
 */
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  deletePages,
  getDocument,
  mergeDocuments,
  rotatePages,
  type SourceId,
  sourceId,
  type Workspace,
} from '@pdf-editor/document-model';
import { PdfiumAdapter, PdfLibAssembler } from '@pdf-editor/engine';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import encryptedUrl from '../../../../test/fixtures/encrypted-aes-256.pdf?url';
import pageLabelsUrl from '../../../../test/fixtures/page-labels.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { type ExportDependencies, type ExportProgress, prepareExport } from './export-service';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const assembler = new PdfLibAssembler();
const adapter = new PdfiumAdapter({ wasmUrl, inspector: assembler });
const original = new Map<SourceId, ArrayBuffer>();

async function openInto(
  ws: Workspace,
  id: string,
  url: string,
  name: string,
  password?: string,
): Promise<{ ws: Workspace; doc: DocumentId }> {
  const bytes = await fetchBytes(url);
  original.set(sourceId(id), bytes.slice(0));
  const opened = await adapter.open(
    sourceId(id),
    bytes,
    password === undefined ? {} : { password },
  );
  const added = addSource(
    ws,
    { ...opened, name, byteLength: original.get(sourceId(id))?.byteLength ?? 0 },
    createSequentialIdGenerator(id),
    { sourceId: sourceId(id) },
  );
  return { ws: added.workspace, doc: added.documentId };
}

function deps(ws: Workspace, overrides: Partial<ExportDependencies['engine']> = {}) {
  const engine: ExportDependencies['engine'] = {
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
    ...overrides,
  };
  return { engine, assembler: () => Promise.resolve(assembler), workspace: () => ws };
}

let merged: Workspace;
let mergedId: DocumentId;

beforeAll(async () => {
  let ws = createWorkspace();
  const a = await openInto(ws, 'labels', pageLabelsUrl, 'page-labels.pdf');
  const b = await openInto(a.ws, 'rotated', rotatedUrl, 'rotated-pages.pdf');
  ws = mergeDocuments(
    b.ws,
    { documentIds: [a.doc, b.doc], title: 'Merged' },
    createSequentialIdGenerator('m'),
  );
  mergedId = ws.activeDocument as DocumentId;
  const pages = getDocument(ws, mergedId).pages;
  ws = rotatePages(ws, [pages[8]?.id as never], 90);
  ws = deletePages(ws, [pages[1]?.id as never]);
  merged = ws;
});

afterAll(async () => {
  await adapter.destroy();
});

describe('prepareExport', () => {
  it('assembles, verifies and reports progress in phase order', async () => {
    const phases: ExportProgress['phase'][] = [];
    const result = await prepareExport(
      mergedId,
      { onProgress: (p) => phases.push(p.phase) },
      deps(merged),
    );
    if (!result.ok) throw new Error(result.error.message);
    const { verification, report, pageCount } = result.value;
    expect(verification).toEqual({ ok: true, problems: [] });
    expect(pageCount).toBe(11);
    expect(report.outlineNodesKept).toBe(2); // one wrapper node per file
    expect([...new Set(phases)]).toEqual(['reading', 'assembling', 'verifying']);

    const out = await adapter.open(sourceId('out'), result.value.bytes.slice(0));
    await adapter.close(sourceId('out'));
    // Page 2 ("ii") deleted; labels continue the authored ones, then positions.
    expect(out.pages.map((p) => p.label)).toEqual([
      'i',
      'iii',
      '1',
      '2',
      '3',
      'A-1',
      'A-2',
      '8',
      '9',
      '10',
      '11',
    ]);
    // rotated-pages.pdf page 1 (/Rotate 0) got +90.
    expect(out.pages.map((p) => p.rotation)).toEqual([0, 0, 0, 0, 0, 0, 0, 90, 90, 180, 270]);
  });

  it('writes compatibility output', async () => {
    const result = await prepareExport(mergedId, { compatibility: true }, deps(merged));
    if (!result.ok) throw new Error(result.error.message);
    const head = new TextDecoder('latin1').decode(result.value.bytes.slice(0, 8));
    expect(head).toBe('%PDF-1.4');
  });

  it('routes encrypted sources through the engine save with security removed', async () => {
    const opened = await openInto(createWorkspace(), 'locked', encryptedUrl, 'locked.pdf', 'user');
    const saveSource = vi.fn<ExportDependencies['engine']['saveSource']>(async (id, options) => ({
      ok: true,
      value: await adapter.save(id, options),
    }));
    const sourceBytes = vi.fn<ExportDependencies['engine']['sourceBytes']>();
    const result = await prepareExport(
      opened.doc,
      {},
      deps(opened.ws, { saveSource, sourceBytes }),
    );
    expect(result.ok).toBe(true);
    expect(saveSource).toHaveBeenCalledWith(sourceId('locked'), { removeSecurity: true });
    expect(sourceBytes).not.toHaveBeenCalled();
  });

  it('never offers unverified bytes and reports failures as values', async () => {
    const result = await prepareExport(
      mergedId,
      {},
      deps(merged, {
        verify: () => Promise.resolve({ ok: false, error: { code: 'corrupt', message: 'nope' } }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toContain('nope');

    const aborted = new AbortController();
    aborted.abort();
    expect(await prepareExport(mergedId, { signal: aborted.signal }, deps(merged))).toMatchObject({
      ok: false,
      error: { code: 'aborted' },
    });

    const { ws, doc } = await openInto(createWorkspace(), 'simple', simpleUrl, 'simple.pdf');
    const emptied = deletePages(
      ws,
      getDocument(ws, doc).pages.map((p) => p.id),
    );
    expect(await prepareExport(doc, {}, deps(emptied))).toMatchObject({
      ok: false,
      error: { message: 'The document has no pages to export.' },
    });
  });
});
