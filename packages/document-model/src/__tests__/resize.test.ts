import { describe, expect, it } from 'vitest';
import { canUndo, createHistory, currentWorkspace, pushHistory, redo, undo } from '../history';
import { checkWorkspaceInvariants } from '../invariants';
import {
  duplicatePages,
  insertBlankPage,
  resizePages,
  rotatePages,
  setPageCropBox,
  setPageResize,
} from '../pages';
import {
  ANCHOR_POSITIONS,
  displayedAnchor,
  matchPaperSize,
  PAPER_SIZES,
  pageContentPlacement,
  pagesOfSize,
  resizeContentPlacement,
  resizeTransform,
  unrotatedAnchor,
} from '../resize';
import { getPage, pageContentSize, pageDisplaySize, pageUnrotatedSize } from '../selectors';
import { deserializeWorkspace, serializeWorkspace } from '../serialize';
import type { Anchor, DocumentId, PageResize, Rotation, Workspace } from '../types';
import { check, expectCode, LETTER, open, pageIds, pageTuple } from './fixtures';

const A4 = PAPER_SIZES.a4;

const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 6);

describe('resizeTransform', () => {
  const content = { width: 200, height: 100 };

  it('fit scales uniformly by the smaller ratio and anchors the margins', () => {
    const t = resizeTransform(content, { width: 400, height: 400, mode: 'fit', anchor: 'center' });
    expect(t).toEqual({ scaleX: 2, scaleY: 2, offsetX: 0, offsetY: 100 });
    const top = resizeTransform(content, {
      width: 400,
      height: 400,
      mode: 'fit',
      anchor: 'top-left',
    });
    expect(top).toEqual({ scaleX: 2, scaleY: 2, offsetX: 0, offsetY: 200 });
    const bottom = resizeTransform(content, {
      width: 400,
      height: 400,
      mode: 'fit',
      anchor: 'bottom-right',
    });
    expect(bottom).toEqual({ scaleX: 2, scaleY: 2, offsetX: 0, offsetY: 0 });
  });

  it('scale covers the page (larger ratio) and stretch fills it per axis', () => {
    const cover = resizeTransform(content, {
      width: 400,
      height: 400,
      mode: 'scale',
      anchor: 'middle-left',
    });
    expect(cover).toEqual({ scaleX: 4, scaleY: 4, offsetX: 0, offsetY: 0 });
    const right = resizeTransform(content, {
      width: 400,
      height: 400,
      mode: 'scale',
      anchor: 'top-right',
    });
    // 800 wide content in a 400 wide page, flush right: 400 cut off on the left.
    expect(right).toEqual({ scaleX: 4, scaleY: 4, offsetX: -400, offsetY: 0 });
    const stretch = resizeTransform(content, {
      width: 400,
      height: 400,
      mode: 'scale',
      anchor: 'top-right',
      stretch: true,
    });
    expect(stretch).toEqual({ scaleX: 2, scaleY: 4, offsetX: 0, offsetY: 0 });
  });

  it('canvas keeps 100% and places the content at the anchor', () => {
    const grow = resizeTransform(content, {
      width: 300,
      height: 300,
      mode: 'canvas',
      anchor: 'bottom-center',
    });
    expect(grow).toEqual({ scaleX: 1, scaleY: 1, offsetX: 50, offsetY: 0 });
    const shrink = resizeTransform(content, {
      width: 100,
      height: 50,
      mode: 'canvas',
      anchor: 'top-right',
    });
    expect(shrink).toEqual({ scaleX: 1, scaleY: 1, offsetX: -100, offsetY: -50 });
  });
});

describe('anchors under rotation', () => {
  it('turns anchors clockwise with the page and back', () => {
    expect(displayedAnchor('top-center', 90)).toBe('middle-right');
    expect(displayedAnchor('top-left', 90)).toBe('top-right');
    expect(displayedAnchor('top-left', 180)).toBe('bottom-right');
    expect(displayedAnchor('middle-left', 270)).toBe('bottom-center');
    expect(unrotatedAnchor('top-center', 90)).toBe('middle-left');
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      for (const anchor of ANCHOR_POSITIONS) {
        expect(unrotatedAnchor(displayedAnchor(anchor, rotation), rotation)).toBe(anchor);
      }
      expect(displayedAnchor('center', rotation)).toBe('center');
    }
  });
});

describe('paper sizes', () => {
  it('matches presets in either orientation', () => {
    expect(matchPaperSize(LETTER)).toEqual({ id: 'letter', landscape: false });
    expect(matchPaperSize({ width: 842, height: 595 })).toEqual({ id: 'a4', landscape: true });
    expect(matchPaperSize({ width: 500, height: 500 })).toBeUndefined();
  });
});

describe('resizePages', () => {
  const { ws, docs, ids } = open(['A', 3], ['B', 1]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const [a1, a2, a3] = pageTuple(ws, a, 3);

  it('changes the displayed size and records the unrotated resize', () => {
    const next = check(
      resizePages(ws, [a1, a2], {
        width: A4.width,
        height: A4.height,
        mode: 'fit',
        anchor: 'center',
      }),
    );
    const page = getPage(next, a1);
    expect(page.resize).toEqual({
      width: A4.width,
      height: A4.height,
      mode: 'fit',
      anchor: 'center',
    });
    expect(pageDisplaySize(next, page)).toEqual(A4);
    expect(pageUnrotatedSize(next, page)).toEqual(A4);
    // The content box is still the source page.
    expect(pageContentSize(next, page)).toEqual(LETTER);
    expect(getPage(next, a3)).toBe(getPage(ws, a3));
    expect(next.documents[b]).toBe(ws.documents[b]);
    expect(next.documents[a]?.clean).toBe(false);
  });

  it('speaks in displayed terms on rotated pages', () => {
    const rotated = check(rotatePages(ws, [a1], 90));
    // The page shows landscape (792 × 612); ask for A4 landscape anchored at the displayed top.
    const next = check(
      resizePages(rotated, [a1], {
        width: A4.height,
        height: A4.width,
        mode: 'fit',
        anchor: 'top-center',
      }),
    );
    const page = getPage(next, a1);
    expect(page.resize).toEqual({
      width: A4.width,
      height: A4.height,
      mode: 'fit',
      // The displayed top of a page turned 90° clockwise is its unrotated left side.
      anchor: 'middle-left',
    });
    expect(pageDisplaySize(next, page)).toEqual({ width: A4.height, height: A4.width });
    // Rotating the resized page turns it as a whole.
    const turned = check(rotatePages(next, [a1], 90));
    expect(pageDisplaySize(turned, getPage(turned, a1))).toEqual(A4);
  });

  it('keeps each page orientation when asked', () => {
    const rotated = check(rotatePages(ws, [a2], 90));
    const next = check(
      resizePages(rotated, [a1, a2], {
        width: A4.width,
        height: A4.height,
        mode: 'fit',
        anchor: 'center',
        matchOrientation: true,
      }),
    );
    expect(pageDisplaySize(next, getPage(next, a1))).toEqual(A4);
    expect(pageDisplaySize(next, getPage(next, a2))).toEqual({
      width: A4.height,
      height: A4.width,
    });
  });

  it('stores stretch only for the scale mode', () => {
    const scale = resizePages(ws, [a1], {
      width: 400,
      height: 400,
      mode: 'scale',
      anchor: 'center',
      stretch: true,
    });
    expect(getPage(scale, a1).resize?.stretch).toBe(true);
    const fit = resizePages(ws, [a1], {
      width: 400,
      height: 400,
      mode: 'fit',
      anchor: 'center',
      stretch: false,
    });
    expect(getPage(fit, a1).resize).not.toHaveProperty('stretch');
  });

  it('replaces an earlier resize and clears it for the original size', () => {
    const once = resizePages(ws, [a1], { width: 400, height: 400, mode: 'fit', anchor: 'center' });
    const twice = check(
      resizePages(once, [a1], { width: 300, height: 500, mode: 'canvas', anchor: 'top-left' }),
    );
    expect(getPage(twice, a1).resize).toEqual({
      width: 300,
      height: 500,
      mode: 'canvas',
      anchor: 'top-left',
    });
    const original = check(
      resizePages(twice, [a1], { ...LETTER, mode: 'scale', anchor: 'center' }),
    );
    expect('resize' in getPage(original, a1)).toBe(false);
    const cleared = check(resizePages(twice, [a1], undefined));
    expect('resize' in getPage(cleared, a1)).toBe(false);
    // Nothing to do: the same workspace, so no empty undo step.
    expect(resizePages(ws, [a1], undefined)).toBe(ws);
    expect(
      resizePages(once, [a1], { width: 400, height: 400, mode: 'fit', anchor: 'center' }),
    ).toBe(once);
  });

  it('is relative to the crop box', () => {
    const cropped = setPageCropBox(ws, a1, { x: 50, y: 50, width: 300, height: 200 });
    const next = check(
      resizePages(cropped, [a1], { width: 600, height: 600, mode: 'fit', anchor: 'center' }),
    );
    const page = getPage(next, a1);
    expect(pageContentSize(next, page)).toEqual({ width: 300, height: 200 });
    expect(pageDisplaySize(next, page)).toEqual({ width: 600, height: 600 });
    // 300 × 200 scaled by 2 to 600 × 400, centred vertically in 600 × 600.
    const placement = pageContentPlacement(next, page);
    close(placement?.left ?? Number.NaN, 0);
    close(placement?.top ?? Number.NaN, 1 / 6);
    close(placement?.width ?? Number.NaN, 1);
    close(placement?.height ?? Number.NaN, 2 / 3);
  });

  it('carries over to duplicates and new blank pages take the displayed size', () => {
    const resized = resizePages(ws, [a3], {
      width: 400,
      height: 300,
      mode: 'fit',
      anchor: 'center',
    });
    const duplicated = check(duplicatePages(resized, [a3], ids));
    const copy = pageIds(duplicated, a)[3];
    expect(copy).toBeDefined();
    if (copy === undefined) return;
    expect(getPage(duplicated, copy).resize).toEqual(getPage(resized, a3).resize);
    const blank = check(insertBlankPage(resized, { document: a, index: 3 }, ids));
    const inserted = getPage(blank, pageIds(blank, a)[3] ?? a1);
    expect(inserted.ref).toEqual({ kind: 'blank', size: { width: 400, height: 300 } });
  });

  it('undoes and redoes through the history', () => {
    let history = createHistory(ws);
    const next = resizePages(ws, [a1], { ...A4, mode: 'fit', anchor: 'center' });
    history = pushHistory(history, next, 'Resize', { now: 1 });
    expect(canUndo(history)).toBe(true);
    history = undo(history);
    expect(currentWorkspace(history)).toBe(ws);
    expect('resize' in getPage(currentWorkspace(history), a1)).toBe(false);
    history = redo(history);
    expect(getPage(currentWorkspace(history), a1).resize?.width).toBe(A4.width);
  });

  it('rejects invalid requests', () => {
    const base = { width: 400, height: 400, mode: 'fit', anchor: 'center' } as const;
    expectCode(() => resizePages(ws, [a1], { ...base, width: 0 }), 'invalid-argument');
    expectCode(() => resizePages(ws, [a1], { ...base, height: 20_000 }), 'invalid-argument');
    expectCode(() => resizePages(ws, [a1], { ...base, width: Number.NaN }), 'invalid-argument');
    expectCode(
      () => resizePages(ws, [a1], { ...base, mode: 'squash' as 'fit' }),
      'invalid-argument',
    );
    expectCode(
      () => resizePages(ws, [a1], { ...base, anchor: 'middle' as Anchor }),
      'invalid-argument',
    );
    expectCode(() => resizePages(ws, [a1], { ...base, stretch: true }), 'invalid-argument');
    expectCode(() => resizePages(ws, [], base), 'invalid-argument');
    expectCode(
      () => setPageResize(ws, a1, { width: 2, height: 400, mode: 'fit', anchor: 'center' }),
      'invalid-argument',
    );
  });
});

describe('invariants and serialization', () => {
  const { ws, docs } = open(['A', 2]);
  const [a1] = pageTuple(ws, docs[0] as DocumentId, 2);

  function withRawResize(resize: unknown): Workspace {
    const doc = ws.documents[docs[0] as DocumentId];
    if (doc === undefined) throw new Error('missing document');
    const pages = doc.pages.map((p, i) => (i === 0 ? { ...p, resize: resize as PageResize } : p));
    return { ...ws, documents: { ...ws.documents, [doc.id]: { ...doc, pages } } };
  }

  it('reports invalid resizes', () => {
    expect(
      checkWorkspaceInvariants(
        withRawResize({ width: 1, height: 400, mode: 'fit', anchor: 'center' }),
      ),
    ).toEqual([expect.stringContaining('resize width and height')]);
    expect(
      checkWorkspaceInvariants(
        withRawResize({ width: 400, height: 400, mode: 'fit', anchor: 'center', stretch: true }),
      ),
    ).toEqual([expect.stringContaining('stretch')]);
    expect(
      checkWorkspaceInvariants(
        withRawResize({ width: 400, height: 400, mode: 'x', anchor: 'center' }),
      ),
    ).toEqual([expect.stringContaining('mode')]);
  });

  it('round-trips a resize and refuses a broken one', () => {
    const resized = setPageResize(ws, a1, {
      width: 400,
      height: 300,
      mode: 'scale',
      anchor: 'top-right',
      stretch: true,
    });
    const restored = deserializeWorkspace(JSON.stringify(serializeWorkspace(resized)));
    expect(getPage(restored, a1).resize).toEqual(getPage(resized, a1).resize);
    const broken = JSON.parse(JSON.stringify(serializeWorkspace(resized))) as {
      documents: { pages: { resize?: { mode: string } }[] }[];
    };
    const first = broken.documents[0]?.pages[0]?.resize;
    expect(first).toBeDefined();
    if (first) first.mode = 'squash';
    expectCode(() => deserializeWorkspace(broken), 'invalid-serialized');
  });
});

describe('content placement on screen', () => {
  const content = { width: 200, height: 100 };
  const resize = { width: 400, height: 400, mode: 'fit', anchor: 'top-left' } as const;

  it('maps the content box into the displayed page for every rotation', () => {
    // Unrotated: 400 × 200 content flush with the top of a 400 × 400 page.
    expect(resizeContentPlacement(content, resize, 0)).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 0.5,
    });
    // Turned 90° clockwise, the unrotated top is on the right.
    expect(resizeContentPlacement(content, resize, 90)).toEqual({
      left: 0.5,
      top: 0,
      width: 0.5,
      height: 1,
    });
    expect(resizeContentPlacement(content, resize, 180)).toEqual({
      left: 0,
      top: 0.5,
      width: 1,
      height: 0.5,
    });
    expect(resizeContentPlacement(content, resize, 270)).toEqual({
      left: 0,
      top: 0,
      width: 0.5,
      height: 1,
    });
  });

  it('reaches outside the page when content is cut off', () => {
    const placement = resizeContentPlacement(
      content,
      { width: 100, height: 100, mode: 'scale', anchor: 'center' },
      0,
    );
    close(placement.left, -0.5);
    close(placement.width, 2);
    close(placement.top, 0);
    close(placement.height, 1);
  });

  it('is undefined for pages without a resize', () => {
    const { ws, docs } = open(['A', 1]);
    const [p] = pageTuple(ws, docs[0] as DocumentId, 1);
    expect(pageContentPlacement(ws, getPage(ws, p))).toBeUndefined();
  });
});

describe('pagesOfSize', () => {
  it('finds pages displayed at a size in either orientation', () => {
    const { ws, docs } = open(['A', 3]);
    const doc = docs[0] as DocumentId;
    const [p1, p2, p3] = pageTuple(ws, doc, 3);
    let next = rotatePages(ws, [p2], 90);
    next = resizePages(next, [p3], { ...A4, mode: 'fit', anchor: 'center' });
    expect(pagesOfSize(next, doc, LETTER)).toEqual([p1, p2]);
    expect(pagesOfSize(next, doc, { width: A4.height, height: A4.width })).toEqual([p3]);
  });
});
