/**
 * Pen bursts (experience-redesign spec §6.4, §10, §11): the join rule with each condition and
 * its boundaries (pause N, gap D, the path limit, preset, page), the stored overrides, what
 * closes a burst, and the labels of a burst (history entry, Review row, close announcement,
 * delete). The engine tests use real PDFium through the workspace store.
 */
import type { Rect } from '@pdf-editor/document-model';
import { getActiveDocument } from '@pdf-editor/document-model';
import type { Annotation, InkAnnotation } from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../../test/store-harness';
import { currentPlatform } from '../../commands/shortcuts';
import { useAnnouncer } from '../../shell/announcer';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { resetToolStore, useToolStore } from '../../viewer/tool-store';
import {
  type PageTarget,
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import type { Point } from '../ink';
import { annotationName, burstClosedLabel, burstLabel, capitalize, deleteLabel } from '../labels';
import { INK } from '../palette';
import {
  burstLimits,
  type BurstStroke,
  closeBurst,
  commitPenStroke,
  currentBurst,
  DEFAULT_BURST_LIMITS,
  horizontalGap,
  INK_BURST_GAP_PT,
  INK_BURST_LINE_GAP,
  INK_BURST_LINE_OVERLAP,
  INK_BURST_MAX_PATHS,
  INK_BURST_MIN_BAND_PT,
  INK_BURST_PAUSE_MS,
  type InkBurst,
  joinsBurst,
  onBurstLine,
  resetBursts,
} from './bursts';
import { DEFAULT_PRESETS, PEN_PRESETS_STORAGE_KEY } from './presets';

const T1: PageTarget = { source: 's1' as never, pageIndex: 0, pageId: 'p1' as never, position: 1 };

const box = (x: number, y: number, width = 40, height = 10): Rect => ({ x, y, width, height });

function burst(over: Partial<InkBurst> = {}): InkBurst {
  const bounds = over.bounds ?? box(100, 100);
  return {
    target: T1,
    presetIndex: 0,
    preset: DEFAULT_PRESETS[0],
    bounds,
    strokes: [bounds],
    lastUpAt: 10_000,
    paths: 3,
    coalesceKey: 'ink-burst:test',
    ...over,
  };
}

function next(over: Partial<BurstStroke> = {}): BurstStroke {
  return {
    target: T1,
    presetIndex: 0,
    preset: DEFAULT_PRESETS[0],
    // 10 pt to the right of the burst.
    bounds: box(150, 100),
    downAt: 10_400,
    ...over,
  };
}

describe('joinsBurst (spec §6.4)', () => {
  it('has the spec defaults: N = 1,500 ms, D = 36 pt, 64 paths', () => {
    expect([INK_BURST_PAUSE_MS, INK_BURST_GAP_PT, INK_BURST_MAX_PATHS]).toEqual([1500, 36, 64]);
    expect(DEFAULT_BURST_LIMITS).toEqual({ pauseMs: 1500, gapPt: 36, maxPaths: 64 });
  });

  it('joins a near stroke soon after on the same page with the same preset', () => {
    expect(joinsBurst(burst(), next())).toBe(true);
    expect(joinsBurst(null, next())).toBe(false);
  });

  it('pause: up to N joins; N + 1 ms and N + 200 ms do not', () => {
    expect(joinsBurst(burst(), next({ downAt: 10_000 + 1500 }))).toBe(true);
    expect(joinsBurst(burst(), next({ downAt: 10_000 + 1501 }))).toBe(false);
    expect(joinsBurst(burst(), next({ downAt: 10_000 + INK_BURST_PAUSE_MS + 200 }))).toBe(false);
    // A press before the last release (a second pointer) is no pause.
    expect(joinsBurst(burst(), next({ downAt: 9_900 }))).toBe(true);
  });

  it('gap: up to D across in page space joins, beyond does not', () => {
    expect(horizontalGap(box(0, 0), box(20, 5))).toBe(0);
    expect(horizontalGap(box(0, 0), box(43, 14))).toBe(3);
    expect(horizontalGap(box(50, 0), box(0, 30))).toBe(10);
    expect(joinsBurst(burst(), next({ bounds: box(140 + 36, 100) }))).toBe(true);
    expect(joinsBurst(burst(), next({ bounds: box(140 + 36.5, 100) }))).toBe(false);
    expect(joinsBurst(burst(), next({ bounds: box(100 - 40 - 36.5, 100) }))).toBe(false);
  });

  it('line: the next line of writing starts a new burst; a dot or a bar on the line joins', () => {
    expect([INK_BURST_LINE_OVERLAP, INK_BURST_LINE_GAP, INK_BURST_MIN_BAND_PT]).toEqual([
      0.3, 0.6, 4,
    ]);
    // Letters 8 pt tall on a line at y 100–108 (user space, y up).
    const word = [box(100, 100, 6, 8), box(108, 100, 6, 8), box(116, 100, 6, 8)];
    const line = burst({ strokes: word, bounds: box(100, 100, 22, 8), paths: 3 });
    // The next letter on the line, even shifted down a little: joins.
    expect(joinsBurst(line, next({ bounds: box(124, 98, 6, 8) }))).toBe(true);
    // The next line 18 pt lower (a 10 pt gap between the bands): a new burst, although it
    // is well within D = 36 pt.
    expect(joinsBurst(line, next({ bounds: box(100, 82, 6, 8) }))).toBe(false);
    // A tall letter of the next line reaching 1.5 pt into this one (< 30 % overlap): new.
    expect(joinsBurst(line, next({ bounds: box(100, 91.5, 6, 10) }))).toBe(false);
    // The dot of an i just above (its 4 pt band 1.25 pt above, ≤ 0.6 × 8 pt) and the bar of
    // a t across: join.
    expect(joinsBurst(line, next({ bounds: box(117, 111, 0.5, 0.5) }))).toBe(true);
    expect(joinsBurst(line, next({ bounds: box(114, 104, 8, 0) }))).toBe(true);
    // A dot whose band is 5.25 pt above is beyond 0.6 × 8 = 4.8 pt.
    expect(joinsBurst(line, next({ bounds: box(117, 115, 0.5, 0.5) }))).toBe(false);
    // Flat strokes (a dash, a line) 5 pt apart: their 4 pt bands are 1 pt apart, which joins;
    // 10 pt apart they do not.
    const dash = burst({ strokes: [box(100, 100, 20, 0)], bounds: box(100, 100, 20, 0) });
    expect(joinsBurst(dash, next({ bounds: box(124, 95, 20, 0) }))).toBe(true);
    expect(joinsBurst(dash, next({ bounds: box(124, 90, 20, 0) }))).toBe(false);
    // The band is the last stroke's: after a dot, the letters under it still join.
    expect(onBurstLine([...word, box(117, 111, 0, 0)], box(124, 100, 6, 8))).toBe(true);
    expect(onBurstLine([], box(0, 0, 1, 1))).toBe(true);
  });

  it('count: a burst of 63 paths takes one more, one of 64 none', () => {
    expect(joinsBurst(burst({ paths: 63 }), next())).toBe(true);
    expect(joinsBurst(burst({ paths: 64 }), next())).toBe(false);
  });

  it('preset: another preset, or the same one edited, does not join', () => {
    expect(joinsBurst(burst(), next({ presetIndex: 1, preset: DEFAULT_PRESETS[1] }))).toBe(false);
    expect(joinsBurst(burst(), next({ preset: { ...DEFAULT_PRESETS[0], width: 3 } }))).toBe(false);
  });

  it('page: another page, document page or source does not join', () => {
    expect(joinsBurst(burst(), next({ target: { ...T1, pageIndex: 1 } }))).toBe(false);
    expect(joinsBurst(burst(), next({ target: { ...T1, pageId: 'p2' as never } }))).toBe(false);
    expect(joinsBurst(burst(), next({ target: { ...T1, source: 's2' as never } }))).toBe(false);
  });

  it('takes the stored overrides', () => {
    const limits = burstLimits({ burstPauseMs: 300, burstGapPt: 6 });
    expect(limits).toEqual({ pauseMs: 300, gapPt: 6, maxPaths: 64 });
    const near = box(144, 100);
    expect(joinsBurst(burst(), next({ bounds: near, downAt: 10_300 }), limits)).toBe(true);
    expect(joinsBurst(burst(), next({ bounds: near, downAt: 10_301 }), limits)).toBe(false);
    expect(joinsBurst(burst(), next({ bounds: box(146, 100), downAt: 10_200 }), limits)).toBe(true);
    expect(joinsBurst(burst(), next({ bounds: box(147, 100), downAt: 10_200 }), limits)).toBe(
      false,
    );
    expect(burstLimits({})).toEqual(DEFAULT_BURST_LIMITS);
  });
});

describe('burst labels', () => {
  const ink = (paths: number): Annotation => ({
    kind: 'ink',
    id: 'a',
    pageIndex: 0,
    rect: box(0, 0),
    strokeWidth: 1.5,
    paths: Array.from({ length: paths }, (_, i) => [
      { x: 0, y: i },
      { x: 10, y: i },
    ]),
  });

  it('names a burst with its stroke count in the Review row, a single stroke as before', () => {
    expect(capitalize(annotationName(ink(12)))).toBe('Pen · 12 strokes');
    expect(capitalize(annotationName(ink(1)))).toBe('Pen');
  });

  it('labels the history entry, the close announcement and a delete', () => {
    expect(burstLabel(1, 1)).toBe('Pen on page 1');
    expect(burstLabel(1, 5)).toBe('Pen on page 1 · 5 strokes');
    expect(burstClosedLabel(3, 5)).toBe('Pen: 5 strokes on page 3');
    expect(deleteLabel([ink(3)])).toBe('Delete 3 pen strokes');
    expect(deleteLabel([ink(1)])).toBe('Delete pen');
  });
});

// ---------------------------------------------------------------------------
// On the engine
// ---------------------------------------------------------------------------

const model = () => useWorkspaceStore.getState();

async function openSimple(): Promise<PageTarget[]> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  enterEditMode();
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace);
  return (doc?.pages ?? []).map((page, i) => {
    if (page.ref.kind !== 'source') throw new Error('no source page');
    return { source: page.ref.source, pageIndex: page.ref.index, pageId: page.id, position: i + 1 };
  });
}

/** A 40 pt horizontal stroke from (x, y), user space, pressed and released at the given times. */
function stroke(target: PageTarget, x: number, y: number, downAt: number, upAt = downAt + 300) {
  const path: Point[] = Array.from({ length: 5 }, (_, i) => ({ x: x + i * 10, y: y + (i % 2) }));
  return commitPenStroke({
    target,
    path,
    widths: path.map((_, i) => 1 + i * 0.25),
    style: useAnnotationStore.getState().styles.ink,
    downAt,
    upAt,
  });
}

async function inks(target: PageTarget): Promise<InkAnnotation[]> {
  return (await readAnnotations(target.source, target.pageIndex)).filter(
    (a): a is InkAnnotation => a.kind === 'ink',
  );
}

describe('bursts on the engine', () => {
  beforeEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    resetBursts();
    useToolStore.getState().setMode('ink');
  });
  afterEach(async () => {
    await whenIdle();
    resetBursts();
    resetToolStore();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetWorkspace();
  });

  it('three quick strokes: one Ink with three paths and their widths, one undo step', async () => {
    const [page1] = await openSimple();
    if (!page1) throw new Error('no page');
    const before = model().history.past.length;
    // Queued back to back, as fast writing does: the appends wait for the create.
    const saved = await Promise.all([
      stroke(page1, 100, 600, 1000),
      stroke(page1, 150, 600, 1500),
      stroke(page1, 200, 601, 2000),
    ]);
    expect(saved).toEqual([true, true, true]);
    const [ink, ...others] = await inks(page1);
    expect(others).toEqual([]);
    expect(ink?.paths).toHaveLength(3);
    expect(ink?.color?.toUpperCase()).toBe(INK.black);
    expect(ink?.strokeWidth).toBe(1.5);
    expect(model().history.past.length).toBe(before + 1);
    expect(model().history.present.label).toBe('Pen on page 1 · 3 strokes');
    // The widths went with every path (ADR-0018), parallel to the paths.
    const sent = model()
      .workspace.engineEdits.filter((e) => e.kind === 'annotation.update')
      .at(-1)?.payload as { annotation: { paths: unknown[][]; widths?: number[][] } };
    expect(sent.annotation.widths?.map((w) => w.length)).toEqual(
      sent.annotation.paths.map((p) => p.length),
    );
    expect(currentBurst()?.paths).toBe(3);

    model().undo();
    await whenIdle();
    expect(await inks(page1)).toEqual([]);
    expect(currentBurst()).toBeNull();
    model().redo();
    await whenIdle();
    expect((await inks(page1)).map((a) => a.paths.length)).toEqual([3]);
  });

  it('a stroke after N + 200 ms is a second annotation and a second undo step', async () => {
    const [page1] = await openSimple();
    if (!page1) throw new Error('no page');
    const before = model().history.past.length;
    await stroke(page1, 100, 600, 1000, 1200);
    await stroke(page1, 150, 600, 1200 + INK_BURST_PAUSE_MS + 200);
    expect((await inks(page1)).map((a) => a.paths.length)).toEqual([1, 1]);
    expect(model().history.past.length).toBe(before + 2);
  });

  it('a far stroke, another page or another preset starts a new annotation', async () => {
    const [page1, page2] = await openSimple();
    if (!page1 || !page2) throw new Error('no pages');
    await stroke(page1, 100, 600, 1000);
    // 200 pt below: too far.
    await stroke(page1, 100, 400, 1400);
    expect((await inks(page1)).map((a) => a.paths.length)).toEqual([1, 1]);
    await stroke(page2, 100, 400, 1800);
    expect((await inks(page2)).map((a) => a.paths.length)).toEqual([1]);
    // Back on page 1 next to the second stroke, but with the blue preset.
    useAnnotationStore.getState().armPreset(1);
    await stroke(page1, 150, 400, 2200);
    const page1Inks = await inks(page1);
    expect(page1Inks.map((a) => a.paths.length)).toEqual([1, 1, 1]);
    expect(page1Inks.at(-1)?.color?.toUpperCase()).toBe(INK.blue);
  });

  it('the next line of writing is a new burst, though within D', async () => {
    const [page1] = await openSimple();
    if (!page1) throw new Error('no page');
    await stroke(page1, 100, 600, 1000);
    await stroke(page1, 150, 600, 1400);
    // 18 pt lower, starting under the first stroke: a new line.
    await stroke(page1, 100, 582, 1800);
    expect((await inks(page1)).map((a) => a.paths.length)).toEqual([2, 1]);
  });

  it('Mod+Z inside an open burst removes the last stroke only; the burst stays open', async () => {
    const [page1] = await openSimple();
    if (!page1) throw new Error('no page');
    const before = model().history.past.length;
    await stroke(page1, 100, 600, 1000);
    await stroke(page1, 150, 600, 1400);
    await stroke(page1, 200, 600, 1800);
    expect((await inks(page1))[0]?.paths).toHaveLength(3);
    const undoKey = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        bubbles: true,
        cancelable: true,
        ...(currentPlatform === 'mac' ? { metaKey: true } : { ctrlKey: true }),
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(undoKey()).toBe(true);
    await whenIdle();
    let [ink] = await inks(page1);
    expect(ink?.paths.map((p) => p[0]?.x)).toEqual([100, 150]);
    expect(ink?.widths).toHaveLength(2);
    // The same history entry, one path fewer.
    expect(model().history.past.length).toBe(before + 1);
    expect(model().history.present.label).toBe('Pen on page 1 · 2 strokes');
    expect(currentBurst()?.paths).toBe(2);
    expect(useAnnouncer.getState().message).toBe('Undid 1 stroke');

    // A rewritten stroke joins the same burst.
    await stroke(page1, 210, 600, 2400);
    [ink] = await inks(page1);
    expect(ink?.paths.map((p) => p[0]?.x)).toEqual([100, 150, 210]);
    expect(model().history.past.length).toBe(before + 1);

    expect(undoKey()).toBe(true);
    expect(undoKey()).toBe(true);
    await whenIdle();
    expect((await inks(page1))[0]?.paths).toHaveLength(1);
    // One stroke left: the ordinary undo (not handled here) removes the Ink.
    expect(undoKey()).toBe(false);
    model().undo();
    await whenIdle();
    expect(await inks(page1)).toEqual([]);
    expect(currentBurst()).toBeNull();
  });

  it('an undo before a queued append runs: the stroke is not saved and does not come back', async () => {
    const [page1] = await openSimple();
    if (!page1) throw new Error('no page');
    expect(await stroke(page1, 100, 600, 1000)).toBe(true);
    // The append is queued; Mod+Z lands before it runs.
    const second = stroke(page1, 150, 600, 1400);
    model().undo();
    expect(await second).toBe(false);
    await whenIdle();
    expect(await inks(page1)).toEqual([]);
    expect(currentBurst()).toBeNull();
    // Redo brings back the first stroke only.
    model().redo();
    await whenIdle();
    expect((await inks(page1)).map((a) => a.paths.length)).toEqual([1]);
  });

  it('closes on Esc, a tool change, a selection, a preset edit, blur, undo and the pause', async () => {
    const [page1] = await openSimple();
    if (!page1) throw new Error('no page');
    let t = 1000;
    const open = async () => {
      t += 200;
      await stroke(page1, 100, 600, t, t + 100);
      t += 100;
      expect(currentBurst()).not.toBeNull();
    };

    await open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(currentBurst()).toBeNull();

    await open();
    useToolStore.getState().setMode('eraser');
    expect(currentBurst()).toBeNull();
    useToolStore.getState().setMode('ink');

    await open();
    useToolStore.getState().showGroup('markup');
    expect(currentBurst()).toBeNull();

    await open();
    const [first] = await inks(page1);
    useAnnotationStore.getState().select({ ...page1, ids: [first?.id ?? ''] });
    expect(currentBurst()).toBeNull();
    useAnnotationStore.getState().select(null);

    await open();
    useAnnotationStore.getState().editPreset(0, { width: 3 });
    expect(currentBurst()).toBeNull();

    await open();
    window.dispatchEvent(new Event('blur'));
    expect(currentBurst()).toBeNull();

    await open();
    model().undo();
    expect(currentBurst()).toBeNull();
    await whenIdle();

    // The pause passes (a stored 300 ms override): the burst closes and says so once.
    localStorage.setItem(
      PEN_PRESETS_STORAGE_KEY,
      JSON.stringify({ ...useAnnotationStore.getState().pen, burstPauseMs: 300 }),
    );
    resetAnnotationStore();
    await stroke(page1, 100, 600, (t += 200));
    await stroke(page1, 150, 600, (t += 200));
    expect(currentBurst()?.paths).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(currentBurst()).toBeNull();
    expect(useAnnouncer.getState().message).toBe('Pen: 2 strokes on page 1');
    closeBurst();
  });
});
