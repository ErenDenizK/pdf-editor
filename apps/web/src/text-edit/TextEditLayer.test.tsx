/**
 * The Edit text layer's keyboard targets (craft spec §9: "with Edit text armed, Tab moves
 * between paragraphs, Enter opens"; DESIGN §5: targets ≥ 24 × 24). The plan on synthetic
 * runs, then the mounted layer on the tagged Chromium export `word-tagged.pdf`, which prints
 * one text object per glyph: one focusable target per detected paragraph, the glyph runs
 * pointer targets only (out of the tab order, hidden from assistive technology), Enter opens
 * the paragraph editor at the paragraph's start and Esc brings the focus back to the target.
 * Vitest browser mode, PDFium.
 */
import { getActiveDocument, type VirtualDocument } from '@pdf-editor/document-model';
import type { LocatedRun, ParagraphBlock } from '@pdf-editor/engine';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import wordTaggedUrl from '../../../../test/fixtures/text-edit-corpus/word-tagged.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { registerAppCommands } from '../commands/app-commands';
import { useShortcuts } from '../commands/use-shortcuts';
import { ReadView } from '../stage/ReadView';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { resetToolStore, useToolStore } from '../viewer/tool-store';
import { keyboardPlan, MIN_TARGET_PX, paragraphTargetLabel } from './TextEditLayer';
import { pageParagraphs, useTextEditStore } from './text-edit-store';

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** A located run with the fields the plan reads (`objectPath`, `charStart`, the blockers). */
function run(object: number, text: string, blocked = false): LocatedRun {
  return {
    source: 's',
    pageIndex: 0,
    objectPath: [object],
    charStart: object * 10,
    charCount: text.length,
    text,
    font: { kind: blocked ? 'type3' : 'truetype' },
    renderMode: 0,
    vertical: false,
  } as unknown as LocatedRun;
}

function block(index: number, runs: readonly LocatedRun[], refusal?: string): ParagraphBlock {
  return {
    ref: { source: 's', pageIndex: 0, index, runs },
    text: runs.map((r) => r.text).join(' '),
    ...(refusal ? { refusal } : {}),
  } as unknown as ParagraphBlock;
}

describe('keyboardPlan', () => {
  it('one target per paragraph; runs in no paragraph, or in a refused one, keep their own', () => {
    const runs = [
      run(0, 'Heading'),
      run(1, 'Body'),
      run(2, 'text'),
      run(3, 'Caption'),
      run(4, 'Drop'),
      run(5, 'Type3', true),
    ];
    const [heading, body, text, caption, drop, type3] = runs;
    const blocks = [
      block(0, [heading!]),
      block(1, [body!, text!]),
      block(2, [drop!], 'drop-cap'),
      block(3, [type3!], 'type3'),
    ];
    const plan = keyboardPlan(runs, blocks);
    expect(
      plan.items.map((item) =>
        item.kind === 'paragraph' ? `p${item.target.block.ref.index}` : item.run.text,
      ),
    ).toEqual(['p0', 'p1', 'Caption', 'Drop']);
    expect([...plan.covered].map((r) => r.text)).toEqual(['Heading', 'Body', 'text']);
    expect(plan.covered.has(caption!)).toBe(false);
    const second = plan.items[1];
    expect(second?.kind === 'paragraph' ? second.target.runs : []).toEqual([body, text]);
  });

  it('keeps the analysis order of paragraphs and slots stray runs by run order', () => {
    // Two columns: the analysis reads the left column (runs 0, 2) before the right (1, 3).
    const runs = [run(0, 'L1'), run(1, 'R1'), run(2, 'L2'), run(3, 'R2'), run(4, 'Footer')];
    const [l1, r1, l2, r2] = runs;
    const plan = keyboardPlan(runs, [block(0, [l1!, l2!]), block(1, [r1!, r2!])]);
    expect(
      plan.items.map((item) =>
        item.kind === 'paragraph' ? `p${item.target.block.ref.index}` : item.run.text,
      ),
    ).toEqual(['p0', 'p1', 'Footer']);
  });

  it('without paragraphs every editable run is its own target', () => {
    const runs = [run(0, 'One'), run(1, 'Two'), run(2, 'Three', true)];
    const plan = keyboardPlan(runs, []);
    expect(plan.items.map((item) => (item.kind === 'run' ? item.run.text : ''))).toEqual([
      'One',
      'Two',
    ]);
    expect(plan.covered.size).toBe(0);
  });

  it('names a target by its opening words', () => {
    expect(paragraphTargetLabel({ text: 'Short one.' })).toBe('Edit paragraph “Short one.”');
    const long = paragraphTargetLabel({
      text: 'The ferry left the quay at dawn, and the gulls followed it out past the breakwater.',
    });
    expect(long).toBe(
      'Edit paragraph “The ferry left the quay at dawn, and the gulls followed it…”',
    );
  });
});

// ---------------------------------------------------------------------------
// Mounted
// ---------------------------------------------------------------------------

function Harness({ doc }: { readonly doc: VirtualDocument }) {
  useShortcuts();
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 800 }}>
      <ReadView doc={doc} />
    </div>
  );
}

async function mount() {
  await useWorkspaceStore.getState().openFiles([await fixtureFile(wordTaggedUrl, 'word.pdf')]);
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace) as VirtualDocument;
  const first = doc.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  useUiStore.getState().setZoom(1);
  useViewStore.getState().setCurrentPage(0);
  useUiStore.getState().setDocumentMode(doc.id, 'edit');
  const { container } = render(<Harness doc={doc} />);
  await waitFor(
    () => {
      if (!container.querySelector('[data-page-index="0"] canvas[data-state="rendered"]')) {
        throw new Error('page not rendered');
      }
    },
    { timeout: 10_000 },
  );
  return { container, source: first.ref.source };
}

/** Focusable elements of the layer that Tab reaches. */
function tabbable(layer: Element): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>('button, [tabindex]')].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
}

describe('the Edit text layer by keyboard (mounted)', () => {
  let disposeCommands: () => void = () => undefined;
  beforeAll(() => {
    disposeCommands = registerAppCommands();
  });
  afterAll(() => {
    disposeCommands();
  });
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    useTextEditStore.getState().close();
    useUiStore.setState({ destination: 'document', viewMode: 'read', documentMode: {} });
  });
  afterEach(async () => {
    cleanup();
    useTextEditStore.getState().close();
    await whenIdle();
    resetWorkspace();
    resetToolStore();
  });

  it('Tab moves between paragraphs, Enter opens one, Esc returns to it', async () => {
    const { container, source } = await mount();
    useToolStore.getState().setMode('edit-text');
    const layer = await waitFor(
      () => {
        const l = container.querySelector<HTMLElement>('[data-text-edit-layer="0"]');
        if (!l?.querySelector('[data-text-paragraph]')) throw new Error('no paragraph targets');
        return l;
      },
      { timeout: 20_000 },
    );
    const blocks = await pageParagraphs(source, 0);
    const offered = blocks.filter((b) => !b.refusal);
    expect(offered.length).toBeGreaterThanOrEqual(4);

    // One target per paragraph, in reading order, and nothing else Tab can reach.
    const targets = [...layer.querySelectorAll<HTMLElement>('[data-text-paragraph]')];
    expect(targets).toHaveLength(offered.length);
    expect(tabbable(layer)).toEqual(targets);
    expect(targets.map((t) => t.getAttribute('aria-label'))).toEqual(
      offered.map((b) => paragraphTargetLabel(b)),
    );
    // The glyph runs stay pointer targets: many, never focusable, hidden from AT.
    const runs = [...layer.querySelectorAll<HTMLElement>('[data-text-run][data-editable]')];
    expect(runs.length).toBeGreaterThan(100);
    expect(runs.every((r) => r.tabIndex < 0 && r.getAttribute('aria-hidden') === 'true')).toBe(
      true,
    );
    expect(runs.every((r) => getComputedStyle(r).pointerEvents === 'auto')).toBe(true);
    // Targets of at least 24 × 24 px that take no pointer.
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET_PX);
      expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
      expect(getComputedStyle(target).pointerEvents).toBe('none');
    }

    const ferry = targets.find((t) => t.getAttribute('aria-label')?.includes('The ferry'));
    if (!ferry) throw new Error('no ferry paragraph');
    const at = targets.indexOf(ferry);
    ferry.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(targets[at + 1]);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(ferry);

    await userEvent.keyboard('{Enter}');
    const mirror = await waitFor(
      () => {
        const field = container.querySelector<HTMLElement>('[data-paragraph-mirror]');
        if (!field || document.activeElement !== field) throw new Error('no paragraph editor');
        return field;
      },
      { timeout: 20_000 },
    );
    expect(mirror).toHaveAttribute('role', 'textbox');
    expect(mirror).toHaveAccessibleName('Paragraph on page 1');
    expect(mirror.textContent).toMatch(/^The ferry left the quay/);
    expect(window.getSelection()?.anchorOffset).toBe(0);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(container.querySelector('[data-paragraph-mirror]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(ferry), { timeout: 10_000 });
    expect(useToolStore.getState().mode).toBe('edit-text');
  });
});
