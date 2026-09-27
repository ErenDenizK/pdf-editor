import { describe, expect, it } from 'vitest';

import { createSequentialIdGenerator } from '../ids';
import {
  deletePages,
  effectiveBates,
  insertBlankPage,
  setDocumentBates,
  setDocumentFurniture,
  updateDocumentOverlays,
} from '../pages';
import { deserializeWorkspace, serializeWorkspace } from '../serialize';
import { getDocument } from '../selectors';
import type { DocumentId, OverlayOp } from '../types';
import { check, expectCode, open } from './fixtures';

const numbers: OverlayOp = {
  kind: 'text',
  layer: 'over',
  template: 'Page {page} of {pages}',
  anchor: 'bottom-right',
  offset: { x: -36, y: 36 },
  font: { family: 'Inter', size: 10, weight: 700 },
  color: { r: 0, g: 0, b: 0 },
  opacity: 0.8,
  pages: { from: 2, parity: 'odd' },
  mirror: true,
  startNumber: 3,
  role: 'page-number',
};

const watermark: OverlayOp = {
  kind: 'text',
  layer: 'behind',
  template: 'DRAFT',
  anchor: 'center',
  offset: { x: 0, y: 0 },
  font: { family: 'Noto Serif', size: 72 },
  color: { r: 1, g: 0, b: 0 },
  opacity: 0.2,
  rotate: 45,
  tile: { gapX: 40, gapY: 60 },
  role: 'watermark',
};

describe('page furniture in the model', () => {
  const { ws, docs } = open(['A', 3], ['B', 2]);
  const [a, b] = docs as [DocumentId, DocumentId];

  it('updateDocumentOverlays rewrites every page in one step and keeps other documents', () => {
    const next = check(updateDocumentOverlays(ws, a, (overlays) => [...overlays, numbers]));
    expect(getDocument(next, a).pages.every((p) => p.overlays.length === 1)).toBe(true);
    expect(getDocument(next, b)).toBe(getDocument(ws, b));
    expect(updateDocumentOverlays(next, a, (overlays) => overlays)).toBe(next);
    const replaced = check(
      updateDocumentOverlays(next, a, (overlays, _page, index) =>
        index === 0 ? overlays.filter((o) => o.role !== 'page-number') : overlays,
      ),
    );
    expect(getDocument(replaced, a).pages.map((p) => p.overlays.length)).toEqual([0, 1, 1]);
  });

  it('validates page ranges and tile gaps', () => {
    expectCode(
      () => updateDocumentOverlays(ws, a, () => [{ ...numbers, pages: { from: 0 } }]),
      'invalid-argument',
    );
    expectCode(
      () => updateDocumentOverlays(ws, a, () => [{ ...watermark, tile: { gapX: -1, gapY: 0 } }]),
      'invalid-argument',
    );
  });

  it('sets and clears Bates numbering', () => {
    const bates = { prefix: 'ABC', width: 6, start: 11, suffix: '-X' };
    const next = check(setDocumentBates(ws, b, bates));
    expect(getDocument(next, b).bates).toEqual(bates);
    expect(getDocument(next, a).bates).toBeUndefined();
    const cleared = check(setDocumentBates(next, b, undefined));
    expect('bates' in getDocument(cleared, b)).toBe(false);
    expect(setDocumentBates(cleared, b, undefined)).toBe(cleared);
    expectCode(() => setDocumentBates(ws, b, { ...bates, width: 0 }), 'invalid-argument');
    expectCode(() => setDocumentBates(ws, b, { ...bates, start: -1 }), 'invalid-argument');
  });

  it('round-trips the new fields through serialization', () => {
    let next = check(updateDocumentOverlays(ws, a, () => [numbers, watermark]));
    next = check(setDocumentBates(next, a, { prefix: 'P', width: 4, start: 1, suffix: '' }));
    const restored = deserializeWorkspace(JSON.stringify(serializeWorkspace(next)));
    expect(getDocument(restored, a)).toEqual(getDocument(next, a));
  });

  it('keeps document-level furniture for pages added later, and clears it', () => {
    const next = check(setDocumentFurniture(ws, a, [numbers, watermark]));
    expect(getDocument(next, a).furniture).toEqual([numbers, watermark]);
    const inserted = check(
      insertBlankPage(next, { document: a, index: 1 }, createSequentialIdGenerator('n')),
    );
    // The new page has no overlays of its own: it inherits the document's furniture.
    expect(getDocument(inserted, a).pages[1]?.overlays).toEqual([]);
    expect(getDocument(inserted, a).furniture).toEqual([numbers, watermark]);
    const cleared = check(setDocumentFurniture(inserted, a, []));
    expect('furniture' in getDocument(cleared, a)).toBe(false);
    expect(setDocumentFurniture(cleared, a, undefined)).toBe(cleared);
    expectCode(() => setDocumentFurniture(ws, a, [{ ...numbers, opacity: 3 }]), 'invalid-argument');
    const restored = deserializeWorkspace(JSON.stringify(serializeWorkspace(next)));
    expect(getDocument(restored, a).furniture).toEqual([numbers, watermark]);
  });

  it('derives Bates starts of a run from the current page counts', () => {
    const run = { id: 'run-1', documents: [a, b] };
    const config = { prefix: 'X', width: 4, start: 10, suffix: '', run };
    let next = check(setDocumentBates(ws, a, config));
    next = check(setDocumentBates(next, b, config));
    // A has 3 pages: B starts at 13.
    expect(effectiveBates(next, a)).toEqual({ prefix: 'X', width: 4, start: 10, suffix: '' });
    expect(effectiveBates(next, b)?.start).toBe(13);
    // Inserting a page into A moves B on: numbers stay unique and contiguous.
    const inserted = check(
      insertBlankPage(next, { document: a, index: 3 }, createSequentialIdGenerator('n')),
    );
    expect(effectiveBates(inserted, b)?.start).toBe(14);
    const removed = check(
      deletePages(
        inserted,
        getDocument(inserted, a)
          .pages.slice(0, 2)
          .map((p) => p.id),
      ),
    );
    expect(effectiveBates(removed, b)?.start).toBe(12);
    // A member leaving the run (Bates removed) no longer counts.
    expect(effectiveBates(check(setDocumentBates(next, a, undefined)), b)?.start).toBe(10);
    expect(effectiveBates(ws, a)).toBeUndefined();
    const restored = deserializeWorkspace(JSON.stringify(serializeWorkspace(next)));
    expect(getDocument(restored, b).bates).toEqual(config);
  });
});
