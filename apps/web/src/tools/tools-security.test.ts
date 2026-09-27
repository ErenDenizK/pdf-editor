/**
 * The tools never see the document's password (review M3 #3): the Compress dialog's
 * analysis and "Export as images" on pages with overlays work on a document that has a
 * password set, while the real export still encrypts. Runs against the app's engine
 * service and compress worker.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import type { DocumentId, OverlayOp, SecurityPolicy } from '@pdf-editor/document-model';
import { presetSettings } from '@pdf-editor/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import { prepareExport } from '../export/export-service';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { disposeCompressor, getCompressor } from './compress-client';
import { rasterizeDocument } from './rasterize';
import { toolSourceBytes } from './tool-source';

const policy: SecurityPolicy = {
  algorithm: 'aes-256',
  userPassword: 'secret',
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

const overlay: OverlayOp = {
  kind: 'text',
  layer: 'over',
  template: '{page}/{pages}',
  anchor: 'bottom-center',
  offset: { x: 0, y: 10 },
  font: { family: 'Helvetica', size: 10 },
  color: { r: 0, g: 0, b: 0 },
  opacity: 1,
};

let documentId: DocumentId;

beforeAll(async () => {
  resetWorkspace();
  const bytes = await (await fetch(imagesUrl)).arrayBuffer();
  await useWorkspaceStore.getState().openFiles([new File([bytes], 'images.pdf')]);
  const { workspace } = useWorkspaceStore.getState();
  documentId = workspace.activeDocument as DocumentId;
  const doc = workspace.documents[documentId];
  if (!doc) throw new Error('not opened');
  useWorkspaceStore.setState({
    workspace: {
      ...workspace,
      documents: {
        ...workspace.documents,
        [documentId]: {
          ...doc,
          security: policy,
          pages: doc.pages.map((page, i) => (i === 0 ? { ...page, overlays: [overlay] } : page)),
        },
      },
    },
  });
});

afterAll(async () => {
  resetWorkspace();
  await disposeCompressor();
});

describe('document tools on a password-protected document', () => {
  it('the export itself is encrypted', async () => {
    const prepared = await prepareExport(documentId);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await expect(PDFDocument.load(prepared.value.bytes.slice(0))).rejects.toThrow();
  });

  it('compression analysis reads the unencrypted assembled copy', async () => {
    const bytes = await toolSourceBytes(documentId);
    const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    const analysis = await (await getCompressor()).analyze(bytes.slice(0));
    expect(analysis.images).toHaveLength(3);
  });

  it('reports progress on repeated runs (the progress proxy is released after each)', async () => {
    const bytes = await toolSourceBytes(documentId);
    const compressor = await getCompressor();
    for (let run = 0; run < 3; run++) {
      const phases: string[] = [];
      const result = await compressor.compress(bytes.slice(0), presetSettings('screen'), {
        onProgress: (p) => phases.push(p.phase),
      });
      expect(result.after).toBeLessThanOrEqual(result.before);
      expect(phases).toContain('lossless');
    }
  });

  it('exports a page with overlays as an image', async () => {
    const file = await rasterizeDocument(documentId, {
      format: 'png',
      dpi: 72,
      quality: 90,
      background: 'white',
      pages: [0],
      template: '{title}-{page}',
    });
    expect(file.type).toBe('image/png');
    const bitmap = await createImageBitmap(file.blob);
    const [source] = Object.values(useWorkspaceStore.getState().workspace.sources);
    const size = source?.pages[0]?.size;
    expect([bitmap.width, bitmap.height]).toEqual([
      Math.round(size?.width ?? 0),
      Math.round(size?.height ?? 0),
    ]);
  });

  it('streams several pages into a ZIP', async () => {
    const file = await rasterizeDocument(documentId, {
      format: 'jpeg',
      dpi: 36,
      quality: 70,
      background: 'white',
      pages: [0, 1, 2],
      template: 'p{page}',
    });
    expect(file).toMatchObject({ type: 'application/zip', name: 'images-images.zip' });
    const head = new Uint8Array(await file.blob.slice(0, 4).arrayBuffer());
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
