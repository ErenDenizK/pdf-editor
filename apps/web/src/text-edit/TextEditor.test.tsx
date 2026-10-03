/**
 * The inline editor's engine traffic (craft spec §4.8, beta.1 speed-ups): opening a run
 * analyses it once; typing does arithmetic on that analysis, with no engine call per
 * keystroke; one dry run follows a 300 ms pause. Double-click selects a word. Fixture:
 * text-edit-fonts.pdf, whose Helvetica line sits on the baseline y = 700 and whose
 * Identity-H Inter subset line on y = 650.
 */
import { getActiveDocument, type SourceId } from '@pdf-editor/document-model';
import type { LocatedRun, PdfTextEditor } from '@pdf-editor/engine';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import type { PageTarget } from '../annotations/annotation-store';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { getEngineService } from '../engine/engine-service';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import type { PageFrame } from '../viewer/geometry';
import { locatedRuns, pageRevision } from './runs';
import { TextEditor } from './TextEditor';

const FOX = 'The quick brown fox jumps over the lazy dog';
const model = () => useWorkspaceStore.getState();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(): Promise<{ source: SourceId; target: PageTarget }> {
  await model().openFiles([await fixtureFile(fontsUrl, 'text-edit-fonts.pdf')]);
  const doc = getActiveDocument(model().workspace);
  const first = doc?.pages[0];
  if (!doc || first?.ref.kind !== 'source') throw new Error('not opened');
  const source = first.ref.source;
  return { source, target: { source, pageIndex: 0, pageId: first.id, position: 1 } };
}

async function lineOn(source: SourceId, baseline: number): Promise<LocatedRun> {
  const runs = await locatedRuns(source, 0);
  const run = runs.find((r) => Math.abs((r.glyphs[0]?.origin.y ?? 0) - baseline) < 0.01);
  if (!run) throw new Error(`no line on y = ${baseline}`);
  return run;
}

const FRAME: PageFrame = {
  size: { width: 612, height: 792 },
  originX: 0,
  originY: 0,
  rotation: 0,
  scale: 1,
};

function renderEditor(
  target: PageTarget,
  run: LocatedRun,
  selection = { start: run.text.length, end: run.text.length },
) {
  const revision = pageRevision(target.source, 0);
  const { container, unmount } = render(
    <TextEditor session={{ target, run, revision, selection }} frame={FRAME} revision={revision} />,
  );
  const input = container.querySelector<HTMLInputElement>('[data-text-edit-input]');
  if (!input) throw new Error('no editor');
  return { input, unmount };
}

/** Types `keys` one by one, `gap` ms apart; resolves to the mean time between keystrokes. */
async function typeSlowly(keys: string, gap: number): Promise<number> {
  const times: number[] = [];
  for (const key of keys) {
    times.push(performance.now());
    await userEvent.keyboard(key);
    await sleep(gap);
  }
  const intervals = times.slice(1).map((t, k) => t - (times[k] ?? t));
  return intervals.reduce((sum, t) => sum + t, 0) / Math.max(1, intervals.length);
}

/** Counts the text editor's engine calls (the real ones still run). */
function countCalls(editor: PdfTextEditor) {
  const counts: Record<string, number> = { checkEditability: 0, analyzeRun: 0 };
  for (const name of Object.keys(counts)) {
    const target = editor as unknown as Record<string, unknown>;
    const original = target[name];
    if (typeof original !== 'function') continue;
    vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(
      (...args: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return (original as (...a: unknown[]) => unknown).apply(editor, args);
      },
    );
  }
  return counts;
}

describe('engine calls while typing', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await whenIdle();
    resetWorkspace();
  });

  it('analyses once on open, nothing per keystroke, one dry run after a pause', async () => {
    const { source, target } = await open();
    const run = await lineOn(source, 700);
    expect(run.text).toBe(FOX);
    const counts = countCalls(await getEngineService().textEditor());
    const { input } = renderEditor(target, run);
    await waitFor(() => expect(input).toHaveFocus());
    await waitFor(() =>
      expect(screen.getByTestId('text-edit-badge')).toHaveTextContent('Same font (not embedded)'),
    );
    await sleep(400);
    const atOpen = { ...counts };

    // Steady typing, under the 300 ms pause (and over the old 200 ms debounce when the
    // keystrokes themselves take long enough).
    const slowGap = await typeSlowly(' slow', 150);
    const slow = { ...counts };
    await sleep(450);
    const slowSettled = { ...counts };

    // Fast typing: 40 ms between keys.
    const fastGap = await typeSlowly(' fast', 40);
    const fast = { ...counts };
    await sleep(450);
    const fastSettled = { ...counts };
    expect(input).toHaveValue(`${FOX} slow fast`);

    const report = {
      gapsMs: { slow: Math.round(slowGap), fast: Math.round(fastGap) },
      atOpen,
      slowTyping5Keys: diff(slow, atOpen),
      slowAfterPause: diff(slowSettled, slow),
      fastTyping5Keys: diff(fast, slowSettled),
      fastAfterPause: diff(fastSettled, fast),
    };
    // Measurements for the report (warn: the only level the lint allows in tests).
    console.warn('text-edit engine calls', JSON.stringify(report));

    expect(atOpen).toEqual({ checkEditability: 0, analyzeRun: 1 });
    expect(report.slowTyping5Keys).toEqual({ checkEditability: 0, analyzeRun: 0 });
    expect(report.slowAfterPause).toEqual({ checkEditability: 1, analyzeRun: 0 });
    expect(report.fastTyping5Keys).toEqual({ checkEditability: 0, analyzeRun: 0 });
    expect(report.fastAfterPause).toEqual({ checkEditability: 1, analyzeRun: 0 });
  });
});

function diff(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(a).map((k) => [k, (a[k] ?? 0) - (b[k] ?? 0)]));
}

describe('the editor between engine checks', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await whenIdle();
    resetWorkspace();
  });

  it('the badge follows each keystroke from the analysis; the dry run confirms it', async () => {
    const { source, target } = await open();
    const run = await lineOn(source, 650);
    const counts = countCalls(await getEngineService().textEditor());
    const { input, unmount } = renderEditor(target, run, { start: 16, end: 16 }); // before "fox"
    const badge = screen.getByTestId('text-edit-badge');
    await waitFor(() => expect(badge).toHaveTextContent('Same font'));
    // "F" is not in the subset: the substitute, at once, before any engine check.
    await userEvent.keyboard('{Delete}F');
    expect(input).toHaveValue(FOX.replace('fox', 'Fox'));
    await waitFor(() => expect(badge).toHaveTextContent('Font substituted: Inter'));
    expect(counts.checkEditability).toBe(0);
    expect(badge).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('text-edit-fell-back')).toHaveTextContent('It has no glyph for “F”');
    // The dry run after the pause agrees.
    await waitFor(() => expect(badge).not.toHaveAttribute('aria-busy'));
    expect(counts.checkEditability).toBe(1);
    expect(badge).toHaveTextContent('Font substituted: Inter');
    // Reopening the run at the same revision reuses the analysis.
    const analyses = counts.analyzeRun;
    unmount();
    renderEditor(target, run);
    await waitFor(() =>
      expect(screen.getByTestId('text-edit-badge')).toHaveTextContent('Same font'),
    );
    expect(counts.analyzeRun).toBe(analyses);
  });

  it('double-click selects the word', async () => {
    const { source, target } = await open();
    const run = await lineOn(source, 700);
    const { input } = renderEditor(target, run, { start: 0, end: 0 });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.dblClick(input);
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const word = FOX.slice(start, end);
    expect(word).toMatch(/^\S+$/);
    expect(FOX.split(' ')).toContain(word);
  });
});
