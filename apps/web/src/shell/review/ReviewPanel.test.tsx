/**
 * The Review tab (experience-redesign §4.1): one list merging comments, redaction marks and
 * form fields, with filter chips and counts; rows leave out what an annotation does not
 * have (never "No author" or "No comment text"); the author name is asked once, inline, at
 * the first comment, and again from the palette.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import annotationsUrl from '../../../../../test/fixtures/annotations.pdf?url';
import formsAUrl from '../../../../../test/fixtures/forms-a.pdf?url';
import { fixtureFile } from '../../../test/store-harness';
import {
  AUTHOR_STORAGE_KEY,
  pageKey,
  resetAnnotationStore,
  useAnnotationStore,
} from '../../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../../annotations/edit-runner';
import { registerAppCommands } from '../../commands/app-commands';
import { commandRegistry } from '../../commands/registry';
import { resetFormStore, useFormStore } from '../../forms/form-store';
import { resetRedactionStore } from '../../redaction/redaction-store';
import { DEFAULT_LAYOUT, useUiStore } from '../../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { useAnnouncer } from '../announcer';
import { AUTHOR_ASKED_STORAGE_KEY, resetAuthorPrompt, useAuthorPrompt } from '../comment-author';
import { ReviewPanel } from './ReviewPanel';
import '../../forms/index';

const openFixture = async (url: string, name: string) => {
  const report = await useWorkspaceStore.getState().openFiles([await fixtureFile(url, name)]);
  expect(report.skipped).toEqual([]);
};

/** Source pages of the active document, in order. */
function sourcePages(): { source: SourceId; index: number }[] {
  const ws = useWorkspaceStore.getState().workspace;
  const doc = ws.activeDocument ? ws.documents[ws.activeDocument] : undefined;
  return (doc?.pages ?? []).flatMap((p) =>
    p.ref.kind === 'source' ? [{ source: p.ref.source, index: p.ref.index }] : [],
  );
}

/** Puts annotations in the store for every page (pages not listed get none). */
function setAnnotations(byPage: Readonly<Record<number, readonly Annotation[]>>): void {
  const pages: Record<string, { annotations: readonly Annotation[]; loaded: boolean }> = {};
  sourcePages().forEach(({ source, index }, i) => {
    pages[pageKey(source, index)] = { annotations: byPage[i] ?? [], loaded: true };
  });
  useAnnotationStore.setState({ pages });
}

const rect = { x: 72, y: 600, width: 120, height: 14 };
const pen: Annotation = {
  id: 'pen-1',
  kind: 'ink',
  pageIndex: 0,
  rect,
  paths: [
    [
      { x: 72, y: 600 },
      { x: 140, y: 610 },
    ],
  ],
  strokeWidth: 1.5,
  color: '#3366ff',
};
const note: Annotation = {
  id: 'note-1',
  kind: 'text',
  pageIndex: 0,
  rect,
  author: 'Ada',
  contents: 'Check this name',
};
const mark: Annotation = { id: 'mark-1', kind: 'redact', pageIndex: 0, rect, quads: [rect] };

const radio = (name: RegExp) => screen.getByRole('radio', { name });
const kinds = () =>
  [...document.querySelectorAll('[data-review-kind]')].map((row) =>
    row.getAttribute('data-review-kind'),
  );

beforeEach(() => {
  localStorage.removeItem(AUTHOR_STORAGE_KEY);
  localStorage.removeItem(AUTHOR_ASKED_STORAGE_KEY);
  resetWorkspace();
  resetEditRunner();
  resetAnnotationStore();
  resetFormStore();
  resetRedactionStore();
  useAnnotationStore.getState().setAuthor('');
  resetAuthorPrompt();
  useUiStore.setState({ ...DEFAULT_LAYOUT, leftPanelView: 'review' });
});
afterEach(async () => {
  await whenIdle();
  localStorage.removeItem(AUTHOR_STORAGE_KEY);
  localStorage.removeItem(AUTHOR_ASKED_STORAGE_KEY);
  resetWorkspace();
  useUiStore.setState({ ...DEFAULT_LAYOUT });
});

describe('Review list', () => {
  it('merges comments, redaction marks and form fields by page, with counts per filter', async () => {
    await openFixture(formsAUrl, 'forms-a.pdf');
    setAnnotations({ 0: [note, mark, pen] });
    // The list is virtualized: give it a viewport tall enough for every row of this short
    // list, so what is rendered does not depend on the test page's size or on when the
    // virtualizer first measured its scroller.
    render(
      <div style={{ display: 'flex', flexDirection: 'column', height: 1600 }}>
        <ReviewPanel />
      </div>,
    );
    const page1 = await screen.findByRole('region', { name: 'Page 1' });
    // Fields come from the form store once read; every row is rendered (a short list).
    await expect.poll(() => kinds().filter((k) => k === 'field').length).toBeGreaterThan(1);
    // The list done loading, and the rendered rows and the All count read together on each
    // try: both settle (fields read, virtualizer measured) before the order and counts below.
    await vi.waitFor(
      () => {
        expect(document.querySelector('[data-review-scroll]')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        expect(radio(/^All/).textContent).toBe(`All${kinds().length}`);
      },
      { timeout: 10_000 },
    );
    const fields = kinds().filter((k) => k === 'field').length;
    const fieldsOnPage1 = within(page1)
      .getAllByRole('listitem')
      .filter((li) => li.dataset.reviewKind === 'field').length;
    // Engine order for the annotations of a page, then its fields.
    expect(kinds().slice(0, 3 + fieldsOnPage1)).toEqual([
      'comment',
      'mark',
      'comment',
      ...Array<string>(fieldsOnPage1).fill('field'),
    ]);
    expect(within(page1).getByText('Check this name')).toBeVisible();
    expect(within(page1).getByText('Alice Example')).toBeVisible();

    const group = screen.getByRole('radiogroup', { name: 'Show' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual([`All${fields + 3}`, 'Comments2', 'Marks1', `Fields${fields}`]);
    expect(radio(/^All/)).toHaveAccessibleName(`All, ${fields + 3} items`);
    expect(radio(/^Marks/)).toHaveAccessibleName('Marks, 1 item');
    expect(radio(/^All/)).toHaveAttribute('aria-checked', 'true');
  });

  it('filters with the chips: a radio group, remembered, announced', async () => {
    await openFixture(formsAUrl, 'forms-a.pdf');
    setAnnotations({ 0: [note, mark] });
    render(<ReviewPanel />);
    await screen.findByRole('region', { name: 'Page 1' });
    await expect.poll(() => kinds().includes('field')).toBe(true);

    await userEvent.click(radio(/^Comments/));
    expect(useUiStore.getState().reviewFilter).toBe('comments');
    expect(kinds()).toEqual(['comment']);
    expect(useAnnouncer.getState().message).toBe('Comments: 1 item');

    await userEvent.click(radio(/^Marks/));
    expect(kinds()).toEqual(['mark']);
    // The Marks filter holds the redaction header and the ticks for "Apply redactions".
    expect(screen.getByTestId('redaction-summary')).toHaveTextContent('1 mark · 1 selected');
    expect(screen.getByRole('checkbox', { name: /Include mark 1 on page 1/ })).toBeVisible();
    expect(screen.getByTestId('redaction-honesty')).toBeVisible();

    // Arrow keys move along the radio group and choose.
    await userEvent.keyboard('{ArrowRight}');
    expect(useUiStore.getState().reviewFilter).toBe('fields');
    expect(radio(/^Fields/)).toHaveFocus();
    expect(kinds().every((k) => k === 'field')).toBe(true);
    expect(screen.getByRole('button', { name: 'Highlight fields' })).toBeVisible();
    expect(screen.queryByTestId('redaction-summary')).toBeNull();

    await userEvent.keyboard('{ArrowRight}');
    expect(useUiStore.getState().reviewFilter).toBe('all');
    // All lists marks without their ticks; settings stay in their own filter.
    expect(screen.queryByRole('checkbox', { name: /Include mark/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Highlight fields' })).toBeNull();
    expect(kinds()).toContain('mark');
  });

  it('never prints "No author" or "No comment text": absent parts are left out', async () => {
    await openFixture(annotationsUrl, 'annotations.pdf');
    setAnnotations({ 0: [pen, note] });
    const { container } = render(<ReviewPanel />);
    const page1 = await screen.findByRole('region', { name: 'Page 1' });
    const penRow = within(page1)
      .getAllByRole('button')
      .find((b) => b.dataset.annotationRow === 'pen-1');
    expect(penRow?.textContent).toMatch(/^(Ink|Pen)$/);
    expect(within(page1).getByText('Ada')).toBeVisible();
    for (const filter of ['all', 'comments'] as const) {
      act(() => useUiStore.getState().setReviewFilter(filter));
      expect(container.textContent).not.toMatch(/No author|No comment text/);
    }
  });

  it('says what to open without a document, with the All chip alone', () => {
    render(<ReviewPanel />);
    expect(screen.getByText('No document open')).toBeVisible();
    expect(
      screen.getByText('Open a PDF to review its comments, redaction marks and form fields.'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('radiogroup'))
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['All0']);
  });

  it('shows chips only for the kinds present, and the chosen one', async () => {
    await openFixture(annotationsUrl, 'annotations.pdf');
    setAnnotations({ 0: [note, pen] });
    render(<ReviewPanel />);
    await screen.findByRole('region', { name: 'Page 1' });
    const chips = () =>
      within(screen.getByRole('radiogroup', { name: 'Show' }))
        .getAllByRole('radio')
        .map((r) => r.textContent);
    expect(chips()).toEqual(['All2', 'Comments2']);
    // A mark appears: so does its chip.
    act(() => setAnnotations({ 0: [note, pen, mark] }));
    expect(chips()).toEqual(['All3', 'Comments2', 'Marks1']);
    // The chosen filter keeps its chip when it empties (the Redact group opens it too).
    await userEvent.click(radio(/^Marks/));
    act(() => setAnnotations({ 0: [note, pen] }));
    expect(chips()).toEqual(['All2', 'Comments2', 'Marks0']);
    await userEvent.click(radio(/^All/));
    expect(chips()).toEqual(['All2', 'Comments2']);
  });
});

describe('Review: a long list', () => {
  /** 500 items on the first two pages: notes, pen strokes and redaction marks. */
  function fiveHundred(): { first: Annotation[]; second: Annotation[] } {
    const make = (page: number, i: number): Annotation => {
      const id = `a-${page}-${i}`;
      const at = { ...rect, y: 700 - (i % 40) * 15 };
      if (i % 3 === 0) return { ...note, id, pageIndex: page, rect: at, contents: `Note ${i}` };
      if (i % 3 === 1) return { ...pen, id, pageIndex: page, rect: at };
      return { id, kind: 'redact', pageIndex: page, rect: at, quads: [at] };
    };
    return {
      first: Array.from({ length: 250 }, (_, i) => make(0, i)),
      second: Array.from({ length: 250 }, (_, i) => make(1, i)),
    };
  }

  // The time budgets (first row < 100 ms, no long task > 50 ms) are measured on the production
  // build in e2e/viewer.spec.ts; here, in a development build, what keeps them is checked: the
  // list renders the rows in view, not the 500.
  it('renders only the rows in view of 500, reaches the end and follows a selection', async () => {
    await openFixture(annotationsUrl, 'annotations.pdf');
    const { first, second } = fiveHundred();
    setAnnotations({ 0: first, 1: second });
    render(
      <div style={{ display: 'flex', flexDirection: 'column', height: 600 }}>
        <ReviewPanel />
      </div>,
    );
    await expect.poll(() => kinds().length).toBeGreaterThan(5);
    expect(radio(/^All/)).toHaveTextContent('All500');
    expect(kinds().length).toBeLessThan(40);
    expect(screen.getByRole('heading', { name: 'Page 1' })).toBeVisible();

    // The end of the list is reachable by scrolling, page 2's heading with it.
    const scroller = document.querySelector<HTMLElement>('[data-review-scroll]');
    if (!scroller) throw new Error('no scroller');
    for (let i = 0; i < 4; i++) {
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20)));
    }
    expect(screen.getByRole('region', { name: 'Page 2' })).toBeVisible();
    expect(screen.getByText('Note 249')).toBeVisible();
    expect(screen.queryByText('Note 0')).toBeNull();
    expect(kinds().length).toBeLessThan(40);

    // A selection on the page brings its row into view.
    const target = first[30];
    const [{ source, index } = { source: '' as SourceId, index: 0 }] = sourcePages();
    const ws = useWorkspaceStore.getState().workspace;
    const pageId = ws.documents[ws.activeDocument ?? ('' as never)]?.pages[0]?.id;
    if (!target || !pageId) throw new Error('no target');
    act(() => {
      useAnnotationStore.setState({
        selection: { source, pageIndex: index, pageId, position: 1, ids: [target.id] },
      });
    });
    await expect
      .poll(() => document.querySelector(`[data-annotation-row="${target.id}"]`))
      .not.toBeNull();
  });
});

describe('Review: comments', () => {
  it('lists the document’s annotations grouped by page, with author and text', async () => {
    await openFixture(annotationsUrl, 'annotations.pdf');
    render(<ReviewPanel />);
    const page2 = await screen.findByRole('region', { name: 'Page 2' });
    expect(within(page2).getByText('Sticky note text on page 2')).toBeVisible();
    expect(within(page2).getAllByText('Fixture Author').length).toBeGreaterThan(0);
    const page1 = screen.getByRole('region', { name: 'Page 1' });
    expect(within(page1).getByText('Highlighted sentence')).toBeVisible();

    // Activating a row selects the annotation.
    await userEvent.click(within(page2).getByText('Sticky note text on page 2'));
    expect(useAnnotationStore.getState().selection?.ids).toEqual(['fixture-annot-text-1']);
  });

  it('has no standing author field: nothing is asked before the first comment', () => {
    render(<ReviewPanel />);
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });

  it('asks for the name once, at the first comment, and keeps it in localStorage', async () => {
    await openFixture(annotationsUrl, 'annotations.pdf');
    render(<ReviewPanel />);
    const field = await screen.findByLabelText('Name on your comments');
    // Never steals focus from the comment being written.
    expect(field).not.toHaveFocus();
    await userEvent.fill(field, '  Ada ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useAnnotationStore.getState().author).toBe('Ada');
    expect(JSON.parse(localStorage.getItem(AUTHOR_STORAGE_KEY) ?? '""')).toBe('Ada');
    expect(JSON.parse(localStorage.getItem(AUTHOR_ASKED_STORAGE_KEY) ?? 'false')).toBe(true);
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
  });

  it('Skip answers too: the prompt does not come back', async () => {
    await openFixture(annotationsUrl, 'annotations.pdf');
    const { unmount } = render(<ReviewPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
    expect(useAnnotationStore.getState().author).toBe('');
    unmount();
    resetAuthorPrompt();
    render(<ReviewPanel />);
    await screen.findByRole('region', { name: 'Page 2' });
    expect(screen.queryByLabelText('Name on your comments')).toBeNull();
  });

  it('asks again from the palette ("Set comment author name…"), focused and prefilled', async () => {
    useAnnotationStore.getState().setAuthor('Ada');
    useAuthorPrompt.getState().answer();
    const dispose = registerAppCommands();
    try {
      render(<ReviewPanel />);
      expect(screen.queryByLabelText('Name on your comments')).toBeNull();
      expect(commandRegistry.get('comments.setAuthor')?.title).toBe('Set comment author name…');
      await act(() => commandRegistry.execute('comments.setAuthor'));
      expect(useUiStore.getState()).toMatchObject({
        leftPanelView: 'review',
        reviewFilter: 'comments',
      });
      const field = await screen.findByLabelText('Name on your comments');
      expect(field).toHaveValue('Ada');
      expect(field).toHaveFocus();
      await userEvent.fill(field, 'Grace');
      await userEvent.keyboard('{Enter}');
      expect(useAnnotationStore.getState().author).toBe('Grace');
      expect(screen.queryByLabelText('Name on your comments')).toBeNull();
    } finally {
      dispose();
    }
  });
});

describe('Review: marks across documents', () => {
  it('names the documents when marks of several are listed', async () => {
    await openFixture(formsAUrl, 'forms-a.pdf');
    await openFixture(annotationsUrl, 'annotations.pdf');
    const ws = useWorkspaceStore.getState().workspace;
    const pages: Record<string, { annotations: readonly Annotation[]; loaded: boolean }> = {};
    for (const id of ws.documentOrder) {
      for (const p of ws.documents[id]?.pages ?? []) {
        if (p.ref.kind !== 'source') continue;
        pages[pageKey(p.ref.source, p.ref.index)] = {
          annotations: p.ref.index === 0 ? [{ ...mark, id: `mark-${id}` }] : [],
          loaded: true,
        };
      }
    }
    useAnnotationStore.setState({ pages });
    useUiStore.getState().setReviewFilter('redactions');
    render(<ReviewPanel />);
    expect(await screen.findByRole('heading', { name: 'forms-a' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'annotations' })).toBeVisible();
    expect(screen.getByTestId('redaction-summary')).toHaveTextContent('2 marks · 2 selected');
    expect(useFormStore.getState().active).toBeNull();
  });
});
