/**
 * The eraser (craft spec §5.6): the Partial cut geometry and the split rule (a cut through
 * the middle leaves two paths with interpolated widths, an end shortens, a short stroke
 * goes), Stroke taking whole paths, highlighter ink and Highlights erased whole, the cursor,
 * and with real PDFium one history entry per drag that one undo restores.
 */
import '../index';

import {
  getActiveDocument,
  historyEntries,
  type SourceId,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import type { Annotation, InkAnnotation, NewAnnotation } from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../../test/store-harness';
import { useAnnouncer } from '../../shell/announcer';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { createAnnotations } from '../actions';
import { type PageTarget, resetAnnotationStore } from '../annotation-store';
import { markupDraft } from '../drafts';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import type { Point } from '../ink';
import {
  capsuleInterval,
  commitErase,
  eraseInk,
  erasePath,
  eraseLabel,
  erasePlan,
  eraserCursor,
  type EraserSweep,
  MIN_PIECE_PT,
  sweepTouchesQuads,
} from './eraser';

/** A horizontal path along y from x0 to x1 in steps of 10 pt. */
function line(x0: number, x1: number, y: number): Point[] {
  const out: Point[] = [];
  for (let x = x0; x <= x1; x += 10) out.push({ x, y });
  return out;
}

function ink(paths: Point[][], extra: Partial<InkAnnotation> = {}): InkAnnotation {
  return {
    id: 'ink-1',
    kind: 'ink',
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    color: '#1A1A1A',
    opacity: 1,
    strokeWidth: 2,
    paths,
    ...extra,
  };
}

/** A vertical eraser pass at x from y0 to y1 (user space), radius r. */
function pass(x: number, y0: number, y1: number, r: number): EraserSweep {
  return {
    points: [
      { x, y: y0 },
      { x, y: y1 },
    ],
    radius: r,
  };
}

describe('the eraser circle', () => {
  it('a capsule crossing a segment erases the interval within its reach', () => {
    const hit = capsuleInterval(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: -20 },
      {
        x: 50,
        y: 20,
      },
      5,
    );
    expect(hit?.[0]).toBeCloseTo(0.45, 6);
    expect(hit?.[1]).toBeCloseTo(0.55, 6);
    // The end discs: a press beside the segment's end.
    const end = capsuleInterval(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 103, y: 0 },
      {
        x: 103,
        y: 0,
      },
      5,
    );
    expect(end?.[0]).toBeCloseTo(0.98, 6);
    expect(end?.[1]).toBe(1);
    expect(
      capsuleInterval({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 6 }, { x: 60, y: 6 }, 5),
    ).toBeNull();
  });

  it('a fast drag whose events fall on either side of a stroke still crosses it', () => {
    const sweep: EraserSweep = {
      points: [
        { x: 50, y: -40 },
        { x: 50, y: 40 },
      ],
      radius: 2,
    };
    const pieces = erasePath(
      line(0, 100, 0).map((p) => ({ ...p, w: 2 })),
      sweep,
      (wa, wb) => 2 + (wa + wb) / 4,
    );
    expect(pieces).toHaveLength(2);
  });
});

describe('Partial', () => {
  it('a cut through the middle leaves two paths of the same ink, widths interpolated', () => {
    const path = line(0, 100, 0);
    // Widths rise from 1 to 3 pt along the stroke (1 + x / 50).
    const widths = path.map((p) => 1 + p.x / 50);
    const outcome = eraseInk(ink([path], { widths: [widths] }), pass(50, -20, 20, 5), 'partial');
    if (!outcome || outcome.remove) throw new Error('expected an update');
    const { update } = outcome;
    expect(update.id).toBe('ink-1');
    expect(update.paths).toHaveLength(2);
    expect(update.widths?.map((w) => w.length)).toEqual(update.paths.map((p) => p.length));
    // Left cut: segment 40–50 (widths 1.8–2.0) erased within 5 + 0.95 pt of x = 50.
    const left = update.paths[0] ?? [];
    expect(left[0]).toEqual({ x: 0, y: 0 });
    expect(left.at(-1)?.x).toBeCloseTo(44.05, 2);
    expect(update.widths?.[0]?.at(-1)).toBeCloseTo(1.8 + 0.2 * 0.405, 3);
    // Right cut: segment 50–60 (widths 2.0–2.2) erased within 5 + 1.05 pt.
    const right = update.paths[1] ?? [];
    expect(right[0]?.x).toBeCloseTo(56.05, 2);
    expect(right.at(-1)).toEqual({ x: 100, y: 0 });
    expect(update.widths?.[1]?.[0]).toBeCloseTo(2 + 0.2 * 0.605, 3);
    // The kept points keep their own widths.
    expect(update.widths?.[0]?.[1]).toBeCloseTo(1.2, 6);
    // The rect follows what remains.
    expect(update.rect.x).toBeLessThanOrEqual(0);
    expect(update.rect.x + update.rect.width).toBeGreaterThanOrEqual(100);
  });

  it('erasing an end shortens the path', () => {
    const outcome = eraseInk(ink([line(0, 100, 0)]), pass(100, -20, 20, 5), 'partial');
    if (!outcome || outcome.remove) throw new Error('expected an update');
    expect(outcome.update.paths).toHaveLength(1);
    const kept = outcome.update.paths[0] ?? [];
    expect(kept[0]).toEqual({ x: 0, y: 0 });
    // Constant width 2: reach 5 + 1.
    expect(kept.at(-1)?.x).toBeCloseTo(94, 2);
    // No widths before, none after.
    expect(outcome.update.widths).toBeUndefined();
  });

  it('erasing the whole of a short stroke removes the ink; specks go with it', () => {
    expect(eraseInk(ink([line(0, 10, 0)]), pass(5, -20, 20, 8), 'partial')).toEqual({
      remove: true,
      count: 1,
      cut: 0,
    });
    // A dot (one point) under the circle goes.
    expect(eraseInk(ink([[{ x: 3, y: 3 }]]), pass(3, 0, 6, 1), 'partial')?.remove).toBe(true);
    // A cut that leaves less than MIN_PIECE_PT at an end drops that piece.
    const outcome = eraseInk(
      ink([line(0, 100, 0)]),
      pass(100 - 6 - MIN_PIECE_PT / 2, -20, 20, 5),
      'partial',
    );
    if (!outcome || outcome.remove) throw new Error('expected an update');
    expect(outcome.update.paths).toHaveLength(1);
  });

  it('a burst keeps its other paths, in order, around the pieces', () => {
    const burst = ink([line(0, 40, 0), line(0, 100, 50), line(0, 40, 100)], {
      widths: [
        line(0, 40, 0).map(() => 2),
        line(0, 100, 50).map(() => 3),
        line(0, 40, 100).map(() => 2),
      ],
    });
    const outcome = eraseInk(burst, pass(50, 30, 70, 5), 'partial');
    if (!outcome || outcome.remove) throw new Error('expected an update');
    const { paths, widths } = outcome.update;
    expect(paths.map((p) => p[0]?.y)).toEqual([0, 50, 50, 100]);
    expect(widths?.map((w) => w.length)).toEqual(paths.map((p) => p.length));
    expect(widths?.[1]?.every((w) => w === 3)).toBe(true);
    // The sweep did not reach it: untouched.
    expect(eraseInk(burst, pass(200, 0, 100, 5), 'partial')).toBeUndefined();
  });

  it('highlighter ink (Multiply) erases whole paths, and Highlights erase whole', () => {
    const free = ink([line(0, 100, 0), line(0, 100, 50)], { blendMode: 'multiply' });
    const outcome = eraseInk(free, pass(50, -10, 10, 3), 'partial');
    if (!outcome || outcome.remove) throw new Error('expected an update');
    expect(outcome.update.paths).toEqual([line(0, 100, 50)]);

    const highlight = {
      id: 'hl-1',
      kind: 'highlight',
      pageIndex: 0,
      rect: { x: 200, y: 200, width: 100, height: 12 },
      quads: [{ x: 200, y: 200, width: 100, height: 12 }],
      color: '#FFEA00',
      opacity: 1,
    } as unknown as Annotation;
    const locked = ink([line(0, 100, 50)], { id: 'locked', flags: { locked: true } });
    const plan = erasePlan(
      [free, highlight, locked],
      {
        points: [
          { x: 250, y: 190 },
          { x: 250, y: 230 },
          { x: 50, y: 52 },
        ],
        radius: 3,
      },
      'partial',
    );
    expect(plan.removals.map((a) => a.id)).toEqual(['hl-1']);
    expect(plan.updates.map((a) => a.id)).toEqual(['ink-1']);
    // The free Multiply stroke goes whole, as does the highlight: two strokes, nothing cut.
    expect({ strokes: plan.strokes, cuts: plan.cuts }).toEqual({ strokes: 2, cuts: 0 });
    expect(
      sweepTouchesQuads(
        highlight.kind === 'highlight' ? highlight.quads : [],
        pass(150, 0, 100, 3),
      ),
    ).toBe(false);
  });
});

describe('labels', () => {
  it('names an erase by what it did, in the plural where it counts', () => {
    expect(eraseLabel({ strokes: 1, cuts: 0 })).toBe('Erased 1 stroke');
    expect(eraseLabel({ strokes: 3, cuts: 0 })).toBe('Erased 3 strokes');
    expect(eraseLabel({ strokes: 0, cuts: 1 })).toBe('Erased part of a stroke');
    expect(eraseLabel({ strokes: 1, cuts: 1 })).toBe('Erased parts of 2 strokes');
  });

  it('counts a cut path apart from a path erased whole', () => {
    const short = [
      { x: 4, y: 20 },
      { x: 6, y: 20 },
    ];
    const outcome = eraseInk(ink([line(0, 100, 0), short]), pass(5, -20, 30, 2), 'partial');
    // The long path is cut near its start (a piece remains); the short one goes whole.
    expect(outcome).toMatchObject({ count: 2, cut: 1 });
  });
});

describe('Stroke', () => {
  it('takes whole paths the circle touches, within half the nominal width', () => {
    const burst = ink([line(0, 100, 0), line(0, 100, 20)]);
    const outcome = eraseInk(burst, pass(50, -5, 5, 2), 'stroke');
    if (!outcome || outcome.remove) throw new Error('expected an update');
    expect(outcome.update.paths).toEqual([line(0, 100, 20)]);
    // Radius 2 plus half of 2 pt: 3.5 pt from the stroke is out of reach.
    expect(eraseInk(burst, pass(50, 23.5, 30, 2), 'stroke')).toBeUndefined();
    expect(eraseInk(burst, pass(50, 22.5, 30, 2), 'stroke')?.count).toBe(1);
    const both = eraseInk(burst, pass(50, -5, 25, 2), 'stroke');
    expect(both?.remove).toBe(true);
  });
});

describe('the cursor', () => {
  it('is a hollow circle of the eraser size with a centred hot spot', () => {
    const cursor = eraserCursor(24);
    expect(cursor).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(cursor).toMatch(/ 14 14, cell$/);
    const svg = decodeURIComponent(cursor.slice(cursor.indexOf(',') + 1, cursor.indexOf('")')));
    expect(svg).toContain('r="12"');
    expect(svg).toContain('width="28"');
  });
});

// ---------------------------------------------------------------------------
// With real PDFium: one entry per drag, undo restores
// ---------------------------------------------------------------------------

const model = () => useWorkspaceStore.getState();
const labels = () => historyEntries(model().history).map((e) => e.label);

async function open(): Promise<{ source: SourceId; target: PageTarget }> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  return {
    source: first.ref.source,
    target: { source: first.ref.source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

describe('erasing with the engine', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetAnnotationStore();
    resetWorkspace();
  });

  it('a partial drag over a burst, another ink and a highlight is one entry; undo restores', async () => {
    const { source, target } = await open();
    const burst: NewAnnotation = {
      kind: 'ink',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      color: '#1A1A1A',
      opacity: 1,
      strokeWidth: 2,
      paths: [line(100, 200, 600), line(100, 200, 560)],
      widths: [line(100, 200, 600).map(() => 2), line(100, 200, 560).map(() => 2)],
    };
    const short: NewAnnotation = {
      kind: 'ink',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      color: '#1A1A1A',
      opacity: 1,
      strokeWidth: 2,
      paths: [line(145, 155, 520)],
    };
    await createAnnotations(target, [burst]);
    await createAnnotations(target, [short]);
    await createAnnotations(target, [
      markupDraft('highlight', 0, [{ x: 140, y: 470, width: 30, height: 12 }], '#FFEA00', 1),
    ]);
    await whenIdle();
    const before = await readAnnotations(source, 0);
    const burstId = before.find((a) => a.kind === 'ink' && a.paths.length === 2)?.id;
    const entries = labels().length;

    // Down through x = 150: the burst's first path is cut, the short ink and the highlight go.
    await commitErase(target, pass(150, 610, 460, 4), 'partial');
    await whenIdle();
    const after = await readAnnotations(source, 0);
    expect(labels()).toHaveLength(entries + 1);
    // Two burst paths cut, the short ink and the highlight whole: parts of four strokes.
    expect(labels().at(-1)).toBe('Erased parts of 4 strokes');
    expect(useAnnouncer.getState().message).toBe('Erased parts of 4 strokes');
    expect(after.filter((a) => a.kind === 'highlight')).toEqual([]);
    const inks = after.filter((a): a is InkAnnotation => a.kind === 'ink');
    expect(inks.map((a) => a.id)).toEqual([burstId]);
    // Both burst paths cross x = 150: each is cut in two, still one annotation.
    expect(inks[0]?.paths).toHaveLength(4);
    expect(inks[0]?.widths?.map((w) => w.length)).toEqual(inks[0]?.paths.map((p) => p.length));
    const ends = inks[0]?.paths.map((p) => [p[0]?.x, p.at(-1)?.x]) ?? [];
    expect(ends[0]?.[0]).toBeCloseTo(100, 1);
    expect(ends[0]?.[1]).toBeCloseTo(145, 1);
    expect(ends[1]?.[0]).toBeCloseTo(155, 1);

    model().undo();
    await whenIdle();
    const undone = await readAnnotations(source, 0);
    expect(undone.filter((a) => a.kind === 'highlight')).toHaveLength(1);
    const back = undone.filter((a): a is InkAnnotation => a.kind === 'ink');
    expect(back.map((a) => a.paths.length).sort()).toEqual([1, 2]);
  });

  it('a stroke drag that removes one ink and shortens a burst is one entry too', async () => {
    const { source, target } = await open();
    const draft = (paths: Point[][]): NewAnnotation => ({
      kind: 'ink',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      color: '#1A1A1A',
      opacity: 1,
      strokeWidth: 2,
      paths,
    });
    await createAnnotations(target, [draft([line(100, 200, 600), line(100, 200, 500)])]);
    await createAnnotations(target, [draft([line(100, 200, 560)])]);
    await whenIdle();
    const entries = labels().length;
    await commitErase(target, pass(150, 610, 550, 3), 'stroke');
    await whenIdle();
    expect(labels()).toHaveLength(entries + 1);
    const inks = (await readAnnotations(source, 0)).filter(
      (a): a is InkAnnotation => a.kind === 'ink',
    );
    expect(inks.map((a) => a.paths.map((p) => p[0]?.y))).toEqual([[500]]);
    model().undo();
    await whenIdle();
    const back = (await readAnnotations(source, 0)).filter((a) => a.kind === 'ink');
    expect(back).toHaveLength(2);
  });
});
