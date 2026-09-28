/**
 * Page resize with annotation transforms (page-resize.ts): corpus files are opened through
 * the PDFium adapter into a workspace, resized with the model's `resizePages` (what the
 * dialog commits), exported like the app does (`planExport` -> assembler -> verifier) and
 * re-opened with PDFium and pdf-lib.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
} from '@cantoo/pdf-lib';
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  getDocument,
  getPage,
  type IdGenerator,
  PAPER_SIZES,
  type PageId,
  pageContentPlacement,
  type Rect,
  type ResizeRequest,
  resizePages,
  type SourceId,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';
import annotationsUrl from '../../../test/fixtures/annotations.pdf?url';
import cropboxUrl from '../../../test/fixtures/cropbox.pdf?url';
import formsAUrl from '../../../test/fixtures/forms-a.pdf?url';
import outlineUrl from '../../../test/fixtures/outline-named-dests.pdf?url';
import rotatedUrl from '../../../test/fixtures/rotated-pages.pdf?url';
import { afterAll, describe, expect, test } from 'vitest';

import { planExport } from '../src/export-plan';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import {
  boxRect,
  pageResizeMatrix,
  type ResizeMatrix,
  transformRect,
} from '../src/pdflib/page-resize';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type {
  AssemblyResult,
  EngineOutlineNode,
  LinkAnnotation,
  VerificationResult,
} from '../src/types';
import { makePdf, sid, vdoc, vpage, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const A4 = PAPER_SIZES.a4;
const A5 = PAPER_SIZES.a5;

const adapter = new PdfiumAdapter({ wasmUrl, inspector: new PdfLibAssembler() });
const assembler = new PdfLibAssembler();
let counter = 0;

afterAll(async () => {
  await adapter.destroy();
});

interface Opened {
  readonly ws: Workspace;
  readonly ids: IdGenerator;
  readonly doc: DocumentId;
  readonly source: SourceId;
  readonly bytes: ArrayBuffer;
}

/** Opens a fixture through PDFium (kept open as the source) into a fresh workspace. */
async function openFixture(url: string, name: string): Promise<Opened> {
  const ids = createSequentialIdGenerator(`resize${++counter}`);
  const source = sid(`resize-src-${counter}`);
  const bytes = await fetchBytes(url);
  const opened = await adapter.open(source, bytes.slice(0));
  const added = addSource(
    createWorkspace(),
    { ...opened, name, byteLength: bytes.byteLength },
    ids,
    { sourceId: source },
  );
  return { ws: added.workspace, ids, doc: added.documentId, source, bytes };
}

function allPages(ws: Workspace, doc: DocumentId): PageId[] {
  return getDocument(ws, doc).pages.map((p) => p.id);
}

interface Exported {
  readonly result: AssemblyResult;
  readonly out: SourceId;
  readonly verification: VerificationResult;
  readonly plan: ReturnType<typeof planExport>;
}

/** Exports like the app: plan, assemble, verify (PDFium re-open); keeps the output open. */
async function exportDoc(o: Opened, ws: Workspace): Promise<Exported> {
  const plan = planExport(ws, o.doc);
  const result = await assembler.assemble({
    document: plan.document,
    sources: new Map([[o.source, o.bytes.slice(0)]]),
    blobs: new Map(),
    sourceNames: plan.sourceNames,
  });
  const verification = await adapter.verify(result.bytes.slice(0), plan.expectation);
  const out = sid(`resize-out-${++counter}`);
  await adapter.open(out, result.bytes.slice(0));
  return { result, out, verification, plan };
}

/** The resize matrix the assembler used for a page of the exported document. */
function matrixOf(ws: Workspace, pageId: PageId, contentBox: Rect): ResizeMatrix {
  const resize = getPage(ws, pageId).resize;
  if (!resize) throw new Error('page is not resized');
  return pageResizeMatrix(contentBox, resize);
}

function expectRect(actual: Rect, expected: Rect, tolerance = 0.6): void {
  expect(Math.abs(actual.x - expected.x), `x ${actual.x} vs ${expected.x}`).toBeLessThan(tolerance);
  expect(Math.abs(actual.y - expected.y), `y ${actual.y} vs ${expected.y}`).toBeLessThan(tolerance);
  expect(Math.abs(actual.width - expected.width), 'width').toBeLessThan(tolerance);
  expect(Math.abs(actual.height - expected.height), 'height').toBeLessThan(tolerance);
}

function inside(rect: Rect, width: number, height: number, tolerance = 0.5): boolean {
  return (
    rect.x >= -tolerance &&
    rect.y >= -tolerance &&
    rect.x + rect.width <= width + tolerance &&
    rect.y + rect.height <= height + tolerance
  );
}

const fitA4: ResizeRequest = { ...A4, mode: 'fit', anchor: 'center' };

describe('annotations.pdf: resize to A4 (fit)', () => {
  test('page size, annotations inside the page and scaled by the fit factor', async () => {
    const o = await openFixture(annotationsUrl, 'annotations.pdf');
    const ws = resizePages(o.ws, allPages(o.ws, o.doc), fitA4);
    const exported = await exportDoc(o, ws);
    // Fit keeps the content inside the page: the verifier checks every annotation.
    expect(exported.plan.expectation.annotationsInsidePages).toEqual([0, 1]);
    expect(exported.verification).toEqual({ ok: true, problems: [] });
    expect(exported.result.report.warnings).toEqual([]);

    const letter = { x: 0, y: 0, width: 612, height: 792 };
    const scale = Math.min(A4.width / 612, A4.height / 792);
    const opened = await adapter.open(sid('resize-annots-size'), exported.result.bytes.slice(0));
    await adapter.close(sid('resize-annots-size'));
    for (const page of opened.pages) {
      expect(page.size.width).toBeCloseTo(A4.width, 1);
      expect(page.size.height).toBeCloseTo(A4.height, 1);
    }
    for (const [index, pageId] of allPages(ws, o.doc).entries()) {
      const m = matrixOf(ws, pageId, letter);
      expect(m.a).toBeCloseTo(scale, 6);
      const before = await adapter.listAnnotations(o.source, index);
      const after = await adapter.listAnnotations(exported.out, index);
      expect(before.length).toBeGreaterThan(0);
      expect(after.map((a) => a.id).sort()).toEqual(before.map((a) => a.id).sort());
      for (const annotation of before) {
        const moved = after.find((a) => a.id === annotation.id);
        if (!moved) throw new Error(`annotation ${annotation.id} lost`);
        expectRect(moved.rect, transformRect(m, annotation.rect));
        expect(moved.rect.width / annotation.rect.width).toBeCloseTo(scale, 2);
        expect(inside(moved.rect, A4.width, A4.height), `${annotation.id} inside`).toBe(true);
        if (annotation.kind === 'highlight' && moved.kind === 'highlight') {
          expect(moved.quads).toHaveLength(annotation.quads.length);
          annotation.quads.forEach((quad, i) => {
            expectRect(moved.quads[i] as Rect, transformRect(m, quad));
          });
        }
        if (annotation.kind === 'ink' && moved.kind === 'ink') {
          const [x, y] = [annotation.paths[0]?.[0]?.x ?? 0, annotation.paths[0]?.[0]?.y ?? 0];
          expect(moved.paths[0]?.[0]?.x).toBeCloseTo(m.a * x + m.e, 1);
          expect(moved.paths[0]?.[0]?.y).toBeCloseTo(m.d * y + m.f, 1);
        }
      }
    }
    // The popup of the note moved with it (it is not listed by the adapter).
    const out = await PDFDocument.load(exported.result.bytes, { updateMetadata: false });
    const annots = out.context.lookup(out.getPage(1).node.get(PDFName.of('Annots')), PDFArray);
    const popup = annots
      .asArray()
      .map((ref) => out.context.lookup(ref, PDFDict))
      .find((a) => a.get(PDFName.of('Subtype')) === PDFName.of('Popup'));
    const m = matrixOf(ws, allPages(ws, o.doc)[1] as PageId, letter);
    expectRect(
      boxRect(out, popup?.get(PDFName.of('Rect'))) as Rect,
      transformRect(m, { x: 100, y: 560, width: 200, height: 100 }),
    );
    await adapter.close(exported.out);
    await adapter.close(o.source);
  });

  test('a second occurrence of the same page resizes on its own; blank pages resize too', async () => {
    const bytes = await fetchBytes(annotationsUrl);
    const source = sid('resize-dup');
    const resize = { width: 400, height: 400, mode: 'fit', anchor: 'bottom-left' } as const;
    const document: VirtualDocument = vdoc([
      vpage({ kind: 'source', source, index: 0 }),
      { ...vpage({ kind: 'source', source, index: 0 }), resize },
      {
        ...vpage({ kind: 'blank', size: { width: 200, height: 100 } }),
        resize: { ...resize, mode: 'canvas' },
      },
    ]);
    const result = await assembler.assemble({
      document,
      sources: new Map([[source, bytes]]),
      blobs: new Map(),
    });
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const sizes = out.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    expect(sizes).toEqual([
      [612, 792],
      [400, 400],
      [400, 400],
    ]);
    const rects = (index: number) =>
      out.context
        .lookup(out.getPage(index).node.get(PDFName.of('Annots')), PDFArray)
        .asArray()
        .map((ref) => boxRect(out, out.context.lookup(ref, PDFDict).get(PDFName.of('Rect'))));
    // The first occurrence keeps the source geometry; the resized copy is scaled into 400².
    expect(rects(0)).toEqual([
      { x: 72, y: 675, width: 315.94, height: 20 },
      { x: 72, y: 420, width: 200, height: 150 },
    ]);
    const s = 400 / 792;
    expectRect(
      rects(1)[1] as Rect,
      { x: 72 * s, y: 420 * s, width: 200 * s, height: 150 * s },
      0.01,
    );
  });
});

describe('forms-a.pdf: stretched to A5', () => {
  test('widgets follow the non-uniform scale and the fields stay fillable', async () => {
    const o = await openFixture(formsAUrl, 'forms-a.pdf');
    const ws = resizePages(o.ws, allPages(o.ws, o.doc), {
      ...A5,
      mode: 'scale',
      stretch: true,
      anchor: 'center',
    });
    const exported = await exportDoc(o, ws);
    expect(exported.verification).toEqual({ ok: true, problems: [] });
    const m = matrixOf(ws, allPages(ws, o.doc)[0] as PageId, {
      x: 0,
      y: 0,
      width: 612,
      height: 792,
    });
    expect(m.a).toBeCloseTo(A5.width / 612, 6);
    expect(m.d).toBeCloseTo(A5.height / 792, 6);
    const before = await adapter.listFormFields(o.source);
    const after = await adapter.listFormFields(exported.out);
    expect(after.map((f) => f.name).sort()).toEqual(before.map((f) => f.name).sort());
    for (const field of before) {
      const moved = after.find((f) => f.name === field.name);
      expect(moved?.pageIndex).toBe(field.pageIndex);
      expectRect(moved?.rect as Rect, transformRect(m, field.rect));
      expect(inside(moved?.rect as Rect, A5.width, A5.height)).toBe(true);
    }
    await adapter.setFormFieldValue(exported.out, 'name', 'Resized Example');
    const saved = await adapter.save(exported.out);
    await adapter.open(sid('resize-forms-filled'), saved);
    const filled = await adapter.listFormFields(sid('resize-forms-filled'));
    expect(filled.find((f) => f.name === 'name')?.value).toBe('Resized Example');
    await adapter.close(sid('resize-forms-filled'));
    await adapter.close(o.source);
  });
});

describe('rotated-pages.pdf: every /Rotate', () => {
  test('a displayed request lands under each rotation; content moves with the matrix', async () => {
    const o = await openFixture(rotatedUrl, 'rotated-pages.pdf');
    // Letter portrait as seen on screen, content flush with the displayed top-left corner.
    const ws = resizePages(o.ws, allPages(o.ws, o.doc), {
      width: 612,
      height: 792,
      mode: 'fit',
      anchor: 'top-left',
    });
    const exported = await exportDoc(o, ws);
    expect(exported.verification).toEqual({ ok: true, problems: [] });
    const opened = await adapter.open(sid('resize-rot'), exported.result.bytes.slice(0));
    await adapter.close(sid('resize-rot'));
    expect(opened.pages.map((p) => p.rotation)).toEqual([0, 90, 180, 270]);
    const a4 = { x: 0, y: 0, width: 595.28, height: 841.89 };
    for (const [index, pageId] of allPages(ws, o.doc).entries()) {
      const quarter = index % 2 === 1;
      const size = opened.pages[index]?.size;
      expect(size?.width).toBeCloseTo(quarter ? 792 : 612, 1);
      expect(size?.height).toBeCloseTo(quarter ? 612 : 792, 1);
      // On screen the content sits in the top-left corner whatever the rotation.
      const placement = pageContentPlacement(ws, getPage(ws, pageId));
      expect(placement?.left).toBeCloseTo(0, 6);
      expect(placement?.top).toBeCloseTo(0, 6);
      // The page text moved by exactly the matrix the model describes.
      const m = matrixOf(ws, pageId, a4);
      const before = (await adapter.getPageText(o.source, index)).flatMap((r) => r.glyphs);
      const after = (await adapter.getPageText(exported.out, index)).flatMap((r) => r.glyphs);
      expect(after.map((g) => g.text).join('')).toBe(before.map((g) => g.text).join(''));
      // Glyph boxes are font-metric boxes rounded by PDFium: compare their centres.
      const centre = (r: Rect) => [r.x + r.width / 2, r.y + r.height / 2];
      for (const [i, glyph] of before.entries()) {
        if (glyph.text.trim() === '') continue;
        const [ax, ay] = centre((after[i] as { rect: Rect }).rect);
        const [ex, ey] = centre(transformRect(m, glyph.rect));
        expect(Math.hypot((ax ?? 0) - (ex ?? 0), (ay ?? 0) - (ey ?? 0))).toBeLessThan(1.5);
      }
    }
    await adapter.close(exported.out);
    await adapter.close(o.source);
  });
});

describe('cropbox.pdf: resize after crop', () => {
  test('the crop box is the content box; page boxes follow; hidden content stays clipped', async () => {
    const o = await openFixture(cropboxUrl, 'cropbox.pdf');
    const [p1, p2] = allPages(o.ws, o.doc) as [PageId, PageId];
    let ws = resizePages(o.ws, [p1], { ...A4, mode: 'fit', anchor: 'bottom-left' });
    ws = resizePages(ws, [p2], { width: 400, height: 400, mode: 'canvas', anchor: 'center' });
    const exported = await exportDoc(o, ws);
    expect(exported.verification).toEqual({ ok: true, problems: [] });

    const out = await PDFDocument.load(exported.result.bytes, { updateMetadata: false });
    const box = (index: number, key: string) =>
      boxRect(out, out.getPage(index).node.get(PDFName.of(key)));
    expect(box(0, 'MediaBox')).toEqual({ x: 0, y: 0, width: A4.width, height: A4.height });
    expect(box(0, 'CropBox')).toEqual({ x: 0, y: 0, width: A4.width, height: A4.height });
    expect(box(1, 'MediaBox')).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    // TrimBox [160 210 440 490] of the 300² crop [150 200 450 500], centred in 400².
    expect(box(1, 'TrimBox')).toEqual({ x: 60, y: 60, width: 280, height: 280 });
    const bleed = box(1, 'BleedBox');
    expect(bleed === undefined || inside(bleed, 400, 400)).toBe(true);

    // Content is wrapped: q <matrix> cm <old crop> re W n … Q.
    const contents = out.context.lookup(out.getPage(1).node.get(PDFName.of('Contents')), PDFArray);
    const first = out.context.lookup(contents.get(0));
    if (!(first instanceof PDFRawStream)) throw new Error('expected a raw content stream');
    const text = new TextDecoder().decode(decodePDFRawStream(first).decode());
    expect(text.replace(/\s+/g, ' ')).toContain('1 0 0 1 -100 -150 cm 150 200 300 300 re W n');

    // Text inside the crop moved by the matrix.
    const m = matrixOf(ws, p2, { x: 150, y: 200, width: 300, height: 300 });
    const before = (await adapter.getPageText(o.source, 1)).flatMap((r) => r.glyphs);
    const after = (await adapter.getPageText(exported.out, 1)).flatMap((r) => r.glyphs);
    const within = (r: Rect) =>
      r.x >= 150 && r.y >= 200 && r.x + r.width <= 450 && r.y + r.height <= 500;
    const kept = before.filter((g) => g.text.trim() !== '' && within(g.rect));
    expect(kept.length).toBeGreaterThan(0);
    for (const glyph of kept) {
      const moved = transformRect(m, glyph.rect);
      expect(
        after.some(
          (g) =>
            g.text === glyph.text &&
            Math.abs(g.rect.x - moved.x) < 1 &&
            Math.abs(g.rect.y - moved.y) < 1,
        ),
        `glyph ${glyph.text} at ${moved.x},${moved.y}`,
      ).toBe(true);
    }
    await adapter.close(exported.out);
    await adapter.close(o.source);
  });
});

/** Destination arrays of the outline items, depth first. */
function outlineDests(doc: PDFDocument): (PDFArray | undefined)[] {
  const out: (PDFArray | undefined)[] = [];
  const outlines = doc.context.lookupMaybe(doc.catalog.get(PDFName.of('Outlines')), PDFDict);
  const walk = (ref: PDFObject | undefined) => {
    let item = doc.context.lookupMaybe(ref, PDFDict);
    while (item) {
      out.push(doc.context.lookupMaybe(item.get(PDFName.of('Dest')), PDFArray));
      walk(item.get(PDFName.of('First')));
      item = doc.context.lookupMaybe(item.get(PDFName.of('Next')), PDFDict);
    }
  };
  walk(outlines?.get(PDFName.of('First')));
  return out;
}

/** Link destination arrays of a page, in /Annots order (URI links give undefined). */
function linkDests(doc: PDFDocument, index: number): (PDFArray | undefined)[] {
  const annots = doc.context.lookupMaybe(
    doc.getPage(index).node.get(PDFName.of('Annots')),
    PDFArray,
  );
  return (annots?.asArray() ?? []).map((ref) => {
    const annot = doc.context.lookup(ref, PDFDict);
    const dest = doc.context.lookupMaybe(annot.get(PDFName.of('Dest')), PDFArray);
    if (dest) return dest;
    const action = doc.context.lookupMaybe(annot.get(PDFName.of('A')), PDFDict);
    return action ? doc.context.lookupMaybe(action.get(PDFName.of('D')), PDFArray) : undefined;
  });
}

/** [kind, coordinates…] with nulls as null, for comparing destinations. */
function destValues(doc: PDFDocument, dest: PDFArray | undefined): (string | number | null)[] {
  if (!dest) return [];
  return dest
    .asArray()
    .slice(1)
    .map((item) => {
      const value = doc.context.lookup(item);
      if (value instanceof PDFNumber) return value.asNumber();
      if (value instanceof PDFName) return value.decodeText();
      return null;
    });
}

/** What a destination's coordinates become under `m` (the assembler's rule). */
function expectedDest(
  values: (string | number | null)[],
  m: ResizeMatrix,
): (string | number | null)[] {
  const [kind, ...rest] = values;
  const x = (v: string | number | null) => (typeof v === 'number' ? m.a * v + m.e : v);
  const y = (v: string | number | null) => (typeof v === 'number' ? m.d * v + m.f : v);
  switch (kind) {
    case 'XYZ':
      return [kind, x(rest[0] ?? null), y(rest[1] ?? null), rest[2] ?? null];
    case 'FitH':
    case 'FitBH':
      return [kind, y(rest[0] ?? null)];
    case 'FitV':
    case 'FitBV':
      return [kind, x(rest[0] ?? null)];
    case 'FitR':
      return [kind, x(rest[0] ?? null), y(rest[1] ?? null), x(rest[2] ?? null), y(rest[3] ?? null)];
    default:
      return values;
  }
}

function closeValues(actual: (string | number | null)[], expected: (string | number | null)[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => {
    const want = expected[i];
    if (typeof value === 'number' && typeof want === 'number') expect(value).toBeCloseTo(want, 3);
    else expect(value).toBe(want);
  });
}

describe('outline-named-dests.pdf: destinations follow the resize', () => {
  test('outline and link destinations point at the same spot on the resized pages', async () => {
    const o = await openFixture(outlineUrl, 'outline-named-dests.pdf');
    const plain = await exportDoc(o, o.ws);
    // Anchored at the displayed top-right so both offsets are non-zero.
    const ws = resizePages(o.ws, allPages(o.ws, o.doc), {
      width: 500,
      height: 900,
      mode: 'fit',
      anchor: 'top-right',
    });
    const resized = await exportDoc(o, ws);
    expect(resized.verification).toEqual({ ok: true, problems: [] });
    const m = matrixOf(ws, allPages(ws, o.doc)[0] as PageId, {
      x: 0,
      y: 0,
      width: 612,
      height: 792,
    });
    expect(m.e).toBeGreaterThan(-1);
    expect(m.f).toBeGreaterThan(0);

    const before = await PDFDocument.load(plain.result.bytes, { updateMetadata: false });
    const after = await PDFDocument.load(resized.result.bytes, { updateMetadata: false });
    const outlineBefore = outlineDests(before);
    const outlineAfter = outlineDests(after);
    expect(outlineAfter).toHaveLength(outlineBefore.length);
    let numeric = 0;
    outlineBefore.forEach((dest, i) => {
      const values = destValues(before, dest);
      if (values.some((v) => typeof v === 'number')) numeric++;
      closeValues(destValues(after, outlineAfter[i]), expectedDest(values, m));
    });
    expect(numeric).toBeGreaterThan(0);

    const linksBefore = linkDests(before, 1);
    const linksAfter = linkDests(after, 1);
    expect(linksAfter).toHaveLength(linksBefore.length);
    linksBefore.forEach((dest, i) => {
      closeValues(destValues(after, linksAfter[i]), expectedDest(destValues(before, dest), m));
    });

    // PDFium resolves the same targets.
    const targets = async (id: SourceId) =>
      (await adapter.listAnnotations(id, 1))
        .filter((a): a is LinkAnnotation => a.kind === 'link')
        .map((a) => a.targetPageIndex ?? a.uri);
    expect(await targets(resized.out)).toEqual(await targets(plain.out));
    const pagesOf = (nodes: readonly EngineOutlineNode[]): (number | undefined)[] =>
      nodes.flatMap((n) => [
        n.destination?.kind === 'page' ? n.destination.pageIndex : undefined,
        ...pagesOf(n.children),
      ]);
    const openedPlain = await adapter.open(sid('resize-outline-a'), plain.result.bytes.slice(0));
    const openedResized = await adapter.open(
      sid('resize-outline-b'),
      resized.result.bytes.slice(0),
    );
    expect(pagesOf(openedResized.outline)).toEqual(pagesOf(openedPlain.outline));
    for (const index of pagesOf(openedResized.outline)) {
      if (index !== undefined) expect(index).toBeLessThan(openedResized.pageCount);
    }
    await adapter.close(sid('resize-outline-a'));
    await adapter.close(sid('resize-outline-b'));
    await adapter.close(plain.out);
    await adapter.close(resized.out);
    await adapter.close(o.source);
  });
});

describe('verification: annotations inside resized pages', () => {
  test('pages whose content fits are listed; covering pages are not', async () => {
    const o = await openFixture(annotationsUrl, 'annotations.pdf');
    const [p1, p2] = allPages(o.ws, o.doc) as [PageId, PageId];
    let ws = resizePages(o.ws, [p1], { width: 300, height: 300, mode: 'scale', anchor: 'center' });
    ws = resizePages(ws, [p2], { width: 800, height: 900, mode: 'canvas', anchor: 'top-left' });
    const plan = planExport(ws, o.doc);
    expect(plan.expectation.annotationsInsidePages).toEqual([1]);
    expect(planExport(o.ws, o.doc).expectation.annotationsInsidePages).toBeUndefined();
    await adapter.close(o.source);
  });

  test('the verifier reports annotations outside a listed page', async () => {
    // The page was "resized" to 200 × 200 but its square was left where it was.
    const bytes = await makePdf([{ size: [200, 200] }], (doc) => {
      const square = doc.context.register(
        doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [72, 420, 272, 570], NM: 'sq' }),
      );
      doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([square]));
    });
    const expectation = { pageCount: 1, pageSizes: [{ width: 200, height: 200 }] };
    expect(await adapter.verify(bytes.slice(0), expectation)).toEqual({ ok: true, problems: [] });
    expect(
      await adapter.verify(bytes.slice(0), { ...expectation, annotationsInsidePages: [0] }),
    ).toEqual({ ok: false, problems: ['Page 1: 1 annotation outside the resized page'] });
  });
});
