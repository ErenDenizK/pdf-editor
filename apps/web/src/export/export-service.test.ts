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
import {
  applyEngineEditWithResult,
  checkAnnotationConformance,
  PdfiumAdapter,
  PdfLibAssembler,
  serializeAnnotation,
} from '@pdf-editor/engine';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import brokenXrefUrl from '../../../../test/fixtures/broken-xref.pdf?url';
import encryptedUrl from '../../../../test/fixtures/encrypted-aes-256.pdf?url';
import ownerOnlyUrl from '../../../../test/fixtures/encrypted-owner-only-aes-256.pdf?url';
import pageLabelsUrl from '../../../../test/fixtures/page-labels.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import {
  type ExportDependencies,
  type ExportProgress,
  needsEngineSave,
  prepareExport,
} from './export-service';

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

function deps(
  ws: Workspace,
  overrides: Partial<ExportDependencies['engine']> = {},
  dirty?: ReadonlySet<SourceId>,
): ExportDependencies {
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
    editor: () => Promise.resolve(adapter),
    ...overrides,
  };
  return {
    engine,
    assembler: () => Promise.resolve(assembler),
    workspace: () => ws,
    ...(dirty ? { dirtySources: () => dirty } : {}),
  };
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
    if (!result.ok) throw new Error(result.error.message);
    expect(saveSource).toHaveBeenCalledWith(sourceId('locked'), { removeSecurity: true });
    expect(sourceBytes).not.toHaveBeenCalled();
    // Never silent (ARCHITECTURE.md §5): the summary and the report say so.
    expect(result.value.sourceNotes).toEqual({ securityRemoved: ['locked.pdf'], repaired: [] });
    expect(result.value.report.warnings).toContain(
      'Password protection from 1 file was removed; set a new password in Export options',
    );
  });

  it('reports removed protection for owner-password-only sources too', async () => {
    const opened = await openInto(createWorkspace(), 'owner', ownerOnlyUrl, 'owner-only.pdf');
    expect(opened.ws.sources[sourceId('owner')]?.flags.encrypted).toBe(true);
    const result = await prepareExport(opened.doc, {}, deps(opened.ws));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.sourceNotes.securityRemoved).toEqual(['owner-only.pdf']);
    expect(result.value.verification.ok).toBe(true);
  });

  it('encrypts the output when asked and verifies it with the user password', async () => {
    const opened = await openInto(createWorkspace(), 'locked2', encryptedUrl, 'l.pdf', 'user');
    const all = {
      print: true,
      printHighQuality: true,
      modify: true,
      copy: true,
      annotate: true,
      fillForms: true,
      accessibility: true,
      assemble: true,
    };
    const result = await prepareExport(
      opened.doc,
      { security: { algorithm: 'aes-256', userPassword: 'new-pw', permissions: all } },
      deps(opened.ws),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification).toEqual({ ok: true, problems: [] });
    // The old protection was replaced by the new one, not dropped.
    expect(result.value.sourceNotes.securityRemoved).toEqual([]);
    await expect(
      adapter.open(sourceId('reenc'), result.value.bytes.slice(0)),
    ).rejects.toMatchObject({ code: 'password-required' });
  });

  it('exports repaired sources from the engine’s repaired copy and says so', async () => {
    const opened = await openInto(createWorkspace(), 'broken', brokenXrefUrl, 'broken.pdf');
    expect(opened.ws.sources[sourceId('broken')]?.flags.repaired).toBe(true);
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
    if (!result.ok) throw new Error(result.error.message);
    expect(saveSource).toHaveBeenCalledWith(sourceId('broken'), { removeSecurity: false });
    expect(sourceBytes).not.toHaveBeenCalled();
    expect(result.value.verification.ok).toBe(true);
    expect(result.value.sourceNotes).toEqual({ securityRemoved: [], repaired: ['broken.pdf'] });
    expect(result.value.report.warnings).toContain(
      '1 file had to be repaired when opened; the output was built from the repaired copy',
    );
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

  describe('annotations', () => {
    /** simple-text.pdf with a commented highlight and a note recorded as engine edits. */
    async function annotated(id: string) {
      const opened = await openInto(createWorkspace(), id, simpleUrl, `${id}.pdf`);
      const source = sourceId(id);
      const edits = [];
      for (const annotation of [
        {
          kind: 'highlight' as const,
          pageIndex: 0,
          rect: { x: 72, y: 700, width: 120, height: 14 },
          quads: [{ x: 72, y: 700, width: 120, height: 14 }],
          contents: 'Check this',
        },
        {
          kind: 'text' as const,
          pageIndex: 0,
          rect: { x: 400, y: 700, width: 20, height: 20 },
          contents: 'A note',
        },
      ]) {
        const { applied } = await applyEngineEditWithResult(adapter, {
          id: `${id}-${edits.length}`,
          source,
          pageIndex: 0,
          kind: 'annotation.create',
          payload: { annotation: await serializeAnnotation(annotation) },
        });
        edits.push(applied);
      }
      return { ...opened, ws: { ...opened.ws, engineEdits: edits }, source };
    }

    it('saves edited sources through the engine and verifies counts and conformance', async () => {
      const { ws, doc, source } = await annotated('annotated');
      const verify = vi.fn<ExportDependencies['engine']['verify']>(async (bytes, expectation) => ({
        ok: true,
        value: await adapter.verify(bytes, expectation),
      }));
      const result = await prepareExport(doc, {}, deps(ws, { verify }));
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.verification).toEqual({ ok: true, problems: [] });
      const expectation = verify.mock.calls[0]?.[1];
      expect(expectation?.annotationCounts).toEqual({ 0: 2, 1: 0, 2: 0 });
      expect(expectation?.checkAnnotations).toBe(true);
      expect(expectation?.annotationIds).toHaveLength(2);
      const report = await checkAnnotationConformance(result.value.bytes.slice(0), {
        ids: expectation?.annotationIds ?? [],
      });
      expect(report).toMatchObject({ ok: true, counts: [2, 0, 0] });
      // Highlight popup + note popup.
      const out = await PDFDocument.load(result.value.bytes.slice(0));
      expect(out.getPage(0).node.Annots()?.size()).toBe(4);

      const noComments = await prepareExport(doc, { includeComments: false }, deps(ws));
      if (!noComments.ok) throw new Error(noComments.error.message);
      const bare = await PDFDocument.load(noComments.value.bytes.slice(0));
      expect(bare.getPage(0).node.Annots()?.size()).toBe(2);
      expect(noComments.value.verification.ok).toBe(true);

      const flat = await prepareExport(doc, { flattenAnnotations: true }, deps(ws));
      if (!flat.ok) throw new Error(flat.error.message);
      expect(flat.value.verification).toEqual({ ok: true, problems: [] });
      const flattened = await PDFDocument.load(flat.value.bytes.slice(0));
      expect(flattened.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
      // The open source keeps its annotations.
      expect(await adapter.listAnnotations(source, 0)).toHaveLength(2);
    });

    it('reads the store’s dirty sources when edits are not in the workspace yet', async () => {
      const { ws, doc, source } = await annotated('dirty');
      const bare = { ...ws, engineEdits: [] };
      expect(needsEngineSave(bare, source)).toBe(false);
      expect(needsEngineSave(bare, source, { dirty: new Set([source]) })).toBe(true);
      expect(needsEngineSave(bare, source, { flattenAnnotations: true })).toBe(true);
      expect(needsEngineSave(bare, source, { includeComments: false })).toBe(true);
      const saveSource = vi.fn<ExportDependencies['engine']['saveSource']>(async (id, options) => ({
        ok: true,
        value: await adapter.save(id, options),
      }));
      const result = await prepareExport(doc, {}, deps(bare, { saveSource }, new Set([source])));
      if (!result.ok) throw new Error(result.error.message);
      expect(saveSource).toHaveBeenCalledWith(source, { removeSecurity: false });
      expect(result.value.verification).toEqual({ ok: true, problems: [] });
      const out = await PDFDocument.load(result.value.bytes.slice(0));
      expect(out.getPage(0).node.Annots()?.size()).toBe(4);
    });
  });
});
