/**
 * "Crop pages…" on real PDFs (Vitest browser mode, Chromium, the PDFium worker):
 *
 * - the dialog from the palette command: margins in points, the summary, one history
 *   entry; the page shows cropped in Read mode (sheet size and bitmap placement); the
 *   export writes the /CropBox and passes its verification; the dialog opens again with the
 *   crop as its margins, and "Reset crop" clears it;
 * - a page with /Rotate 90: the displayed top margin is stored as the unrotated left edge;
 * - crop and discard (`cropPages` with discard): one history entry holding the redaction
 *   and the crop, the text outside the crop is gone from the page while the text inside
 *   stays, undo brings both back, and the export passes its self-check;
 * - a page another page still shows in full keeps its content (nothing is discarded);
 * - pending redaction marks: the dialog warns about marks reaching outside the crop, the
 *   removal deletes them (not recreated on removed content) and keeps the ones inside, and
 *   the export then passes; Esc does not close the dialog while it removes;
 * - a resized page: the summary names the original-page crop and the new page size.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { PDFDocument } from '@cantoo/pdf-lib';
import {
  type DocumentId,
  duplicatePages,
  historyEntries,
  PAPER_SIZES,
  pageDisplaySize,
  resizePages,
  type SourceId,
  type Workspace,
} from '@pdf-editor/document-model';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { deleteAnnotations } from '../annotations/actions';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { pageText } from '../annotations/page-text';
import { App } from '../app';
import { openDocuments } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { prepareExport } from '../export/export-service';
import { resetRedactionApply } from '../redaction/apply';
import { createMarks, isRedactMark } from '../redaction/marks';
import { indexPageText, quadsForTextRange } from '../redaction/text-index';
import { closeOperationDialog } from '../stage/operation-dialogs-store';
import { runSectionCommand } from '../stage/section-menu';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { cropPages, planCrops, planDiscard, stopCropDrawingListener } from './actions';
import { resetCropStore } from './crop-store';
import type { Margins } from './geometry';

const model = () => useWorkspaceStore.getState();
const ws = (): Workspace => model().workspace;
const lastLabel = () => model().history.present.label;
/** 1.5 in at the top (the "PAGE n OF" header sits at y 700–718), 1 in elsewhere. */
const MARGINS: Margins = { top: 108, right: 72, bottom: 72, left: 72 };
const CROPPED = { x: 72, y: 72, width: 468, height: 612 };

async function openInApp(url: string, name: string): Promise<DocumentId> {
  render(<App />);
  await openDocuments([await fixtureFile(url, name)]);
  const id = ws().documentOrder[0];
  if (id === undefined) throw new Error('not opened');
  return id;
}

function pageAt(id: DocumentId, index: number) {
  const found = ws().documents[id]?.pages[index];
  if (found === undefined) throw new Error(`no page ${index}`);
  return found;
}

function select(...ids: string[]) {
  const set = new Set(ids) as Set<never>;
  useSelectionStore
    .getState()
    .apply({ selected: set, anchor: ids[0] as never, focused: ids[0] as never });
}

async function typeMargin(dialog: HTMLElement, side: keyof Margins, value: string) {
  const input = within(dialog).getByTestId(`crop-${side}`);
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

async function sourceText(source: SourceId, index: number): Promise<string> {
  return (await pageText(source, index)).map((run) => run.text).join('\n');
}

/** Quads of the first occurrence of `needle` on a source page. */
async function quadsOf(source: SourceId, index: number, needle: string) {
  const runs = await pageText(source, index);
  const text = indexPageText(runs);
  const at = text.text.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle}`);
  return quadsForTextRange(runs, text, at, at + needle.length);
}

/** Page 1 of `id` with a mark on its header (outside MARGINS) and one on the body text. */
async function markHeaderAndBody(id: DocumentId) {
  const first = pageAt(id, 0);
  if (first.ref.kind !== 'source') throw new Error('not a source page');
  const source = first.ref.source;
  const target = { source, pageIndex: 0, pageId: first.id, position: 1 };
  await createMarks([
    { target, marks: [await quadsOf(source, 0, 'PAGE 1'), await quadsOf(source, 0, 'quick')] },
  ]);
  const marks = (await readAnnotations(source, 0)).filter(isRedactMark);
  expect(marks).toHaveLength(2);
  const [header, body] = [...marks].sort((a, b) => (b.quads[0]?.y ?? 0) - (a.quads[0]?.y ?? 0));
  return { source, target, header, body };
}

function reset() {
  closeOperationDialog();
  stopCropDrawingListener();
  resetCropStore();
  resetWorkspace();
  resetEditRunner();
  resetAnnotationStore();
  resetRedactionApply();
  useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
  useUiStore.setState({
    viewMode: 'read',
    arrangePinned: [],
    arrangeCollapsed: [],
    paletteOpen: false,
    renaming: null,
  });
}

describe('crop pages dialog', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900);
    reset();
  });
  afterEach(async () => {
    await whenIdle();
    reset();
  });

  it('crops the selected page, shows it cropped, exports the CropBox, reopens and resets', async () => {
    const id = await openInApp(simpleUrl, 'simple-text.pdf');
    const first = pageAt(id, 0);
    select(first.id);
    await commandRegistry.execute('pages.crop');
    const dialog = await screen.findByTestId('crop-dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('heading', { name: 'Crop pages' })).toBeVisible();
    });
    expect(within(dialog).getByRole('radio', { name: 'Selected pages (1)' })).toBeChecked();
    expect(within(dialog).getByTestId('crop-summary')).toHaveTextContent(
      'Set the margins, drag the edges of the preview or draw a crop area on the page.',
    );
    expect(within(dialog).getByRole('button', { name: 'Reset crop' })).toBeDisabled();
    // Honesty: a crop hides; removing is a separate, explained choice (off by default).
    expect(dialog).toHaveTextContent('any PDF viewer can show it again');
    const discard = within(dialog).getByRole('checkbox', {
      name: /Also remove the content outside the crop \(irreversible after export\)/,
    });
    expect(discard).not.toBeChecked();

    await userEvent.selectOptions(within(dialog).getByTestId('crop-unit'), 'pt');
    await typeMargin(dialog, 'top', '108');
    await typeMargin(dialog, 'right', '72');
    await typeMargin(dialog, 'bottom', '72');
    await typeMargin(dialog, 'left', '72');
    expect(within(dialog).getByTestId('crop-summary')).toHaveTextContent(
      '1 page will be cropped, the first to 468 × 612 pt',
    );
    // The preview's crop rectangle sits at the margins (display space, scaled).
    const sheet = within(dialog).getByTestId('crop-preview-sheet').getBoundingClientRect();
    const rect = within(dialog).getByTestId('crop-rect').getBoundingClientRect();
    const scale = sheet.width / 612;
    expect(rect.left - sheet.left).toBeCloseTo(72 * scale, 0);
    expect(rect.top - sheet.top).toBeCloseTo(108 * scale, 0);
    expect(rect.width).toBeCloseTo(468 * scale, 0);
    // Keyboard: the top edge is a slider; ArrowDown moves it down 1 pt, ArrowUp back.
    const topEdge = within(dialog).getByRole('slider', { name: 'Top edge of the crop' });
    topEdge.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(dialog).getByTestId('crop-top')).toHaveValue('109');
    await userEvent.keyboard('{ArrowUp}');
    expect(within(dialog).getByTestId('crop-top')).toHaveValue('108');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Crop' }));
    await waitFor(() => expect(screen.queryByTestId('crop-dialog')).toBeNull());
    expect(lastLabel()).toBe('Crop 1 page');
    expect(pageAt(id, 0).cropBox).toEqual(CROPPED);
    expect(pageAt(id, 1).cropBox).toBeUndefined();
    const shown = pageDisplaySize(ws(), pageAt(id, 0));
    expect([shown.width, shown.height]).toEqual([468, 612]);

    // Read mode: the sheet has the cropped size; the bitmap (the whole page) is placed so
    // the crop fills the sheet, and the sheet clips the rest.
    const sheetEl = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-page-index="0"]');
      if (!el?.querySelector('[data-resized]')) throw new Error('not cropped yet');
      return el;
    });
    const box = sheetEl.getBoundingClientRect();
    expect(box.width / box.height).toBeCloseTo(468 / 612, 2);
    const content = sheetEl.querySelector<HTMLElement>('[data-resized]')?.getBoundingClientRect();
    const cssScale = box.width / 468;
    expect((content?.left ?? 0) - box.left).toBeCloseTo(-72 * cssScale, 0);
    expect((content?.top ?? 0) - box.top).toBeCloseTo(-108 * cssScale, 0);
    expect(content?.width).toBeCloseTo(612 * cssScale, 0);

    // Export: /CropBox written, verification passes (page sizes compared).
    const result = await prepareExport(id);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification.ok).toBe(true);
    const out = await PDFDocument.load(result.value.bytes, { updateMetadata: false });
    const crop = out.getPage(0).getCropBox();
    expect([crop.x, crop.y, crop.width, crop.height]).toEqual([72, 72, 468, 612]);
    expect(out.getPage(0).getMediaBox()).toMatchObject({ width: 612, height: 792 });
    expect(out.getPage(1).getCropBox()).toMatchObject({ x: 0, y: 0, width: 612, height: 792 });

    // The dialog opens again with the crop as its margins (millimetres by default).
    select(pageAt(id, 0).id);
    await commandRegistry.execute('pages.crop');
    const again = await screen.findByTestId('crop-dialog');
    expect(within(again).getByTestId('crop-top')).toHaveValue('38.1');
    expect(within(again).getByTestId('crop-left')).toHaveValue('25.4');
    await userEvent.click(within(again).getByTestId('crop-reset'));
    expect(within(again).getByTestId('crop-summary')).toHaveTextContent(
      '1 page will show their whole page again',
    );
    await userEvent.click(within(again).getByRole('button', { name: 'Remove crop' }));
    await waitFor(() => expect(screen.queryByTestId('crop-dialog')).toBeNull());
    expect(lastLabel()).toBe('Reset the crop of 1 page');
    expect(pageAt(id, 0).cropBox).toBeUndefined();
    model().undo();
    expect(pageAt(id, 0).cropBox).toEqual(CROPPED);
  }, 60_000);

  it('opens from the section menu for every page of the document', async () => {
    const id = await openInApp(simpleUrl, 'simple-text.pdf');
    useUiStore.getState().pinToArrange([id]);
    useUiStore.getState().setViewMode('arrange');
    expect(await screen.findAllByRole('grid')).toHaveLength(1);
    await runSectionCommand('section.crop', id);
    const dialog = await screen.findByTestId('crop-dialog');
    expect(
      within(dialog).getByRole('radio', { name: 'All pages of simple-text (3)' }),
    ).toBeChecked();
    await userEvent.selectOptions(within(dialog).getByTestId('crop-unit'), 'in');
    await typeMargin(dialog, 'bottom', '1');
    expect(within(dialog).getByTestId('crop-summary')).toHaveTextContent(
      '3 pages will be cropped, the first to 8.5 × 10 in',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crop' }));
    await waitFor(() => expect(screen.queryByTestId('crop-dialog')).toBeNull());
    expect(lastLabel()).toBe('Crop 3 pages');
    for (let i = 0; i < 3; i++) {
      expect(pageAt(id, i).cropBox).toEqual({ x: 0, y: 72, width: 612, height: 720 });
    }
    // The light-table cell shows the cropped page (its sheet has the cropped shape).
    const cell = document.querySelector(`[data-page-id="${pageAt(id, 0).id}"] [data-thumb]`);
    await waitFor(() => expect(cell?.querySelector('[data-resized]')).not.toBeNull());
    const thumb = cell?.getBoundingClientRect();
    expect((thumb?.width ?? 0) / (thumb?.height ?? 1)).toBeCloseTo(612 / 720, 1);
  }, 40_000);

  it('stores the displayed top margin of a /Rotate 90 page as its unrotated left edge', async () => {
    const id = await openInApp(rotatedUrl, 'rotated-pages.pdf');
    const second = pageAt(id, 1);
    select(second.id);
    await commandRegistry.execute('pages.crop');
    const dialog = await screen.findByTestId('crop-dialog');
    await userEvent.selectOptions(within(dialog).getByTestId('crop-unit'), 'pt');
    await typeMargin(dialog, 'top', '72');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crop' }));
    await waitFor(() => expect(screen.queryByTestId('crop-dialog')).toBeNull());
    const crop = pageAt(id, 1).cropBox;
    expect(crop?.x).toBeCloseTo(72, 6);
    expect(crop?.y).toBeCloseTo(0, 6);
    expect(crop?.width).toBeCloseTo(595.28 - 72, 1);
    expect(crop?.height).toBeCloseTo(841.89, 1);
    // Displayed landscape (841.89 wide), 72 pt shorter.
    const shown = pageDisplaySize(ws(), pageAt(id, 1));
    expect(shown.width).toBeCloseTo(841.89, 1);
    expect(shown.height).toBeCloseTo(595.28 - 72, 1);

    const result = await prepareExport(id);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification.ok).toBe(true);
    const out = await PDFDocument.load(result.value.bytes, { updateMetadata: false });
    expect(out.getPage(1).getRotation().angle).toBe(90);
    expect(out.getPage(1).getCropBox().x).toBeCloseTo(72, 1);
  }, 60_000);
});

describe('crop pages dialog: removal and resized pages', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900);
    reset();
  });
  afterEach(async () => {
    await whenIdle();
    reset();
  });

  it('warns about marks outside the crop, ignores Esc while removing, then shows the sheet', async () => {
    const id = await openInApp(simpleUrl, 'simple-text.pdf');
    const { source, body } = await markHeaderAndBody(id);
    select(pageAt(id, 0).id);
    await commandRegistry.execute('pages.crop');
    const dialog = await screen.findByTestId('crop-dialog');
    await waitFor(() => expect(within(dialog).getByTestId('crop-unit')).toBeVisible());
    await userEvent.selectOptions(within(dialog).getByTestId('crop-unit'), 'pt');
    await typeMargin(dialog, 'top', '108');
    await typeMargin(dialog, 'right', '72');
    await typeMargin(dialog, 'bottom', '72');
    await typeMargin(dialog, 'left', '72');
    expect(within(dialog).queryByTestId('crop-discard-marks')).toBeNull();
    await userEvent.click(within(dialog).getByTestId('crop-discard'));
    // The header mark reaches into the removed band: deleted, not applied. Said first.
    await waitFor(() => {
      expect(within(dialog).getByTestId('crop-discard-marks')).toHaveTextContent(
        '1 redaction mark reaches outside the crop',
      );
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Crop and remove' }));
    await waitFor(() => expect(dialog).toHaveTextContent('Removing the content outside the crop'));
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('crop-dialog')).toBeVisible();

    const sheet = await screen.findByTestId('crop-result', {}, { timeout: 30_000 });
    expect(within(sheet).getByTestId('redaction-removed-marks')).toHaveTextContent(
      '1 mark that was not applied reached into a removed area',
    );
    const left = (await readAnnotations(source, 0)).filter(isRedactMark);
    expect(left.map((a) => a.id)).toEqual([body?.id]);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('crop-dialog')).toBeNull());

    // Opened again: the form, not the old sheet.
    await commandRegistry.execute('pages.crop');
    const again = await screen.findByTestId('crop-dialog');
    await waitFor(() => expect(within(again).getByTestId('crop-summary')).toBeVisible());
    expect(within(again).queryByTestId('crop-result')).toBeNull();
  }, 90_000);

  it('on a resized page, names the crop of the original page and the new page size', async () => {
    const id = await openInApp(simpleUrl, 'simple-text.pdf');
    const first = pageAt(id, 0);
    // Letter resized to A5 (fit): shown and exported as 419.53 × 595.28 pt.
    model().applyOperation(
      (w) => resizePages(w, [first.id], { ...PAPER_SIZES.a5, mode: 'fit', anchor: 'center' }),
      'Resize',
    );
    const size = pageDisplaySize(ws(), pageAt(id, 0));
    expect(size.width).toBeCloseTo(419.53, 1);
    select(first.id);
    await commandRegistry.execute('pages.crop');
    const dialog = await screen.findByTestId('crop-dialog');
    await waitFor(() => expect(within(dialog).getByTestId('crop-unit')).toBeVisible());
    expect(within(dialog).getByTestId('crop-resized-notice')).toHaveTextContent(
      'the margins are measured on the original page',
    );
    await userEvent.selectOptions(within(dialog).getByTestId('crop-unit'), 'pt');
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      await typeMargin(dialog, side, '72');
    }
    const summary = within(dialog).getByTestId('crop-summary');
    expect(summary).toHaveTextContent('468 × 648 pt of its original page');
    expect(summary).toHaveTextContent('419');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Crop$/ }));
    await whenIdle();
    // The export writes the resized page size; the crop is of the original content.
    expect(pageAt(id, 0).cropBox).toEqual({ x: 72, y: 72, width: 468, height: 648 });
    const shown = pageDisplaySize(ws(), pageAt(id, 0));
    expect(shown.width).toBeCloseTo(419.53, 1);
    expect(shown.height).toBeCloseTo(595.28, 1);
  }, 60_000);
});

describe('crop and discard', () => {
  beforeEach(reset);
  afterEach(async () => {
    await whenIdle();
    reset();
  });

  async function open(): Promise<{ id: DocumentId; source: SourceId }> {
    const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple-text.pdf')]);
    expect(report.skipped).toEqual([]);
    const id = ws().documentOrder[0];
    if (id === undefined) throw new Error('not opened');
    const ref = pageAt(id, 0).ref;
    if (ref.kind !== 'source') throw new Error('not a source page');
    return { id, source: ref.source };
  }

  it('removes the content outside the crop in the same history entry; undo restores both', async () => {
    const { id, source } = await open();
    const before = historyEntries(model().history).length;
    const outcome = await cropPages([pageAt(id, 0).id], MARGINS, { discard: true });
    expect(outcome.kind).toBe('discarded');
    if (outcome.kind !== 'discarded' || outcome.outcome.kind !== 'applied') {
      throw new Error(`not applied: ${JSON.stringify(outcome).slice(0, 400)}`);
    }
    expect(outcome.committed).toBe(true);
    const [report] = outcome.outcome.sources;
    expect(report?.result.forensic.ok).toBe(true);
    expect(report?.result.gate.ok).toBe(true);
    expect(report?.result.plan.strings).toEqual([]); // area only
    expect(report?.result.plan.fillColor).toBe('#ffffff');
    expect(report?.result.plan.areas).toHaveLength(4);

    // One entry: the redaction and the crop together.
    expect(historyEntries(model().history)).toHaveLength(before + 1);
    expect(lastLabel()).toBe('Crop 1 page and remove the content outside');
    expect(pageAt(id, 0).cropBox).toEqual(CROPPED);
    expect(ws().engineEdits.filter((e) => e.kind === 'redaction.apply')).toHaveLength(1);

    // The header (in the top band) is gone from the file; the body text stays; page 2 too.
    let text = await sourceText(source, 0);
    expect(text).not.toContain('PAGE 1 OF');
    expect(text).toContain('quick brown fox');
    expect(await sourceText(source, 1)).toContain('PAGE 2 OF simple-text');

    // Undo: the crop and the removal come back together.
    model().undo();
    await whenIdle();
    expect(pageAt(id, 0).cropBox).toBeUndefined();
    expect(ws().engineEdits.some((e) => e.kind === 'redaction.apply')).toBe(false);
    text = await sourceText(source, 0);
    expect(text).toContain('PAGE 1 OF simple-text');

    // Redo, then export: CropBox written, the self-check passes on the final file.
    model().redo();
    await whenIdle();
    expect(pageAt(id, 0).cropBox).toEqual(CROPPED);
    const result = await prepareExport(id);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification.ok).toBe(true);
    const out = await PDFDocument.load(result.value.bytes, { updateMetadata: false });
    const crop = out.getPage(0).getCropBox();
    expect([crop.x, crop.y, crop.width, crop.height]).toEqual([72, 72, 468, 612]);
  }, 90_000);

  it('deletes pending marks reaching outside the crop, keeps the others; the export passes', async () => {
    const { id } = await open();
    const { source, target, header, body } = await markHeaderAndBody(id);
    const outcome = await cropPages([pageAt(id, 0).id], MARGINS, { discard: true });
    if (outcome.kind !== 'discarded' || outcome.outcome.kind !== 'applied') {
      throw new Error(`not applied: ${JSON.stringify(outcome).slice(0, 400)}`);
    }
    const [report] = outcome.outcome.sources;
    expect(report?.removedMarks).toBe(1);
    expect(report?.keptMarks).toBe(1);
    await whenIdle();
    const left = (await readAnnotations(source, 0)).filter(isRedactMark);
    expect(left.map((a) => a.id)).toEqual([body?.id]);
    expect(left.map((a) => a.id)).not.toContain(header?.id);

    // The kept mark is still pending (the export says so); once deleted, the export passes.
    const pending = await prepareExport(id, { compression: null });
    if (!pending.ok) throw new Error(pending.error.message);
    expect(pending.value.verification.problems[0]).toMatch(/marks that were not applied/);
    await deleteAnnotations(target, [body?.id ?? '']);
    const prepared = await prepareExport(id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification).toEqual({ ok: true, problems: [] });

    // Undo brings back both marks with the content.
    model().undo();
    model().undo();
    await whenIdle();
    const back = (await readAnnotations(source, 0)).filter(isRedactMark).map((a) => a.id);
    expect(back.sort()).toEqual([header?.id, body?.id].sort());
  }, 90_000);

  it('keeps what another page still shows', async () => {
    const { id } = await open();
    const first = pageAt(id, 0);
    // A duplicate of page 1 shows the whole page: cropping the original removes nothing.
    model().applyOperation((w, ids) => duplicatePages(w, [first.id], ids), 'Duplicate');
    const { crops } = planCrops(ws(), [first.id], MARGINS);
    expect(crops).toEqual([{ pageId: first.id, crop: CROPPED }]);
    const plan = planDiscard(ws(), crops);
    expect(plan.shared).toBe(1);
    expect(plan.plans).toEqual([]);
    // Both copies cropped alike: all four bands go.
    const both = planCrops(ws(), [first.id, pageAt(id, 1).id], MARGINS).crops;
    const again = planDiscard(ws(), both);
    expect(again.shared).toBe(0);
    expect(again.plans[0]?.plan.areas).toHaveLength(4);

    const outcome = await cropPages([first.id], MARGINS, { discard: true });
    expect(outcome).toEqual({ kind: 'cropped', committed: true });
    expect(ws().engineEdits.some((e) => e.kind === 'redaction.apply')).toBe(false);
    expect(lastLabel()).toBe('Crop 1 page');
  }, 60_000);
});
