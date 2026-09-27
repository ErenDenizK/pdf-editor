/**
 * Form filling through the real engine (Vitest browser mode, PDFium): the form layer's
 * mapping of widgets (rotated page included), the inline editors (text, checkbox,
 * dropdown) with one history entry per fill and undo, Tab navigation, and the Forms
 * panel (list, Clear all as one entry).
 */
import { degrees, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import {
  getActiveDocument,
  historyEntries,
  type PageId,
  type Rotation,
  type SourceId,
} from '@pdf-editor/document-model';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import formsAUrl from '../../../../test/fixtures/forms-a.pdf?url';
import xfaUrl from '../../../../test/fixtures/xfa-stub.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { engineContext, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { FormsPanel } from '../shell/FormsPanel';
import type { PageOverlayProps } from '../stage/page-overlays';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { resetFormStore, useFormStore } from './form-store';
import { FormLayer } from './FormLayer';
import './index';

const model = () => useWorkspaceStore.getState();

async function openFile(file: File): Promise<{ source: SourceId; pages: PageId[] }> {
  const report = await model().openFiles([file]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace);
  const first = doc?.pages[0];
  if (!doc || first?.ref.kind !== 'source') throw new Error('no source page');
  return { source: first.ref.source, pages: doc.pages.map((p) => p.id) };
}

function overlayProps(
  source: SourceId,
  pages: PageId[],
  index: number,
  size: { width: number; height: number },
  rotation: Rotation = 0,
): PageOverlayProps {
  const doc = getActiveDocument(model().workspace);
  const page = doc?.pages[index];
  if (!page) throw new Error('no page');
  return {
    page,
    pageId: pages[index] as PageId,
    pageIndex: index,
    sourceId: source,
    sourceIndex: index,
    sizePt: size,
    cssScale: 1,
    rotation,
    visible: true,
  };
}

async function engineValue(source: SourceId, name: string) {
  const { editor } = await engineContext();
  return (await editor.listFormFields(source)).find((f) => f.name === name)?.value;
}

function labels(): string[] {
  return historyEntries(model().history).map((e) => e.label);
}

async function settle(): Promise<void> {
  await act(async () => {
    await whenIdle();
    // The form store reloads after the edit (one more engine read).
    await new Promise((resolve) => setTimeout(resolve, 50));
    await whenIdle();
  });
}

beforeEach(() => {
  resetWorkspace();
  resetEditRunner();
  resetAnnotationStore();
  resetFormStore();
  useToolStore.getState().setMode('select');
});

afterEach(async () => {
  await whenIdle();
  resetWorkspace();
});

describe('form layer', () => {
  it('maps widgets of a /Rotate 90 page through the page frame', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 200]);
    page.setRotation(degrees(90));
    const field = pdf.getForm().createTextField('rotated');
    field.addToPage(page, { x: 20, y: 100, width: 150, height: 24 });
    const bytes = await pdf.save();
    const { source, pages } = await openFile(
      new File([bytes.slice()], 'rotated-form.pdf', { type: 'application/pdf' }),
    );
    // Displayed 200 × 300 pt; user (20, 100, 150 × 24) shows at left 100, top 20, 24 × 150.
    render(<FormLayer {...overlayProps(source, pages, 0, { width: 200, height: 300 }, 90)} />);
    const target = await screen.findByRole('button', { name: 'rotated' });
    const style = target.style;
    const near = (value: string, expected: number) =>
      Math.abs(Number.parseFloat(value) - expected) <= 1;
    expect(near(style.left, 100), style.left).toBe(true);
    expect(near(style.top, 20), style.top).toBe(true);
    expect(near(style.width, 24), style.width).toBe(true);
    expect(near(style.height, 150), style.height).toBe(true);
  });

  it('fills a text field in place: Enter commits one "Fill name" entry; undo restores', async () => {
    const { source, pages } = await openFile(await fixtureFile(formsAUrl, 'forms-a.pdf'));
    render(<FormLayer {...overlayProps(source, pages, 0, { width: 612, height: 792 })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'name' }));
    const editor = await screen.findByRole('textbox', { name: 'name' });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue('Alice Example');
    await userEvent.fill(editor, 'Grace Hopper');
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(screen.queryByRole('textbox', { name: 'name' })).toBeNull();
    expect(await engineValue(source, 'name')).toBe('Grace Hopper');
    expect(labels().at(-1)).toBe('Fill name');

    act(() => {
      model().undo();
    });
    await settle();
    expect(await engineValue(source, 'name')).toBe('Alice Example');
  });

  it('Esc reverts the editor without a history entry', async () => {
    const { source, pages } = await openFile(await fixtureFile(formsAUrl, 'forms-a.pdf'));
    render(<FormLayer {...overlayProps(source, pages, 0, { width: 612, height: 792 })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'name' }));
    const editor = await screen.findByRole('textbox', { name: 'name' });
    await userEvent.fill(editor, 'Nobody');
    await userEvent.keyboard('{Escape}');
    await settle();
    expect(await engineValue(source, 'name')).toBe('Alice Example');
    expect(labels().some((l) => l.startsWith('Fill'))).toBe(false);
  });

  it('toggles a checkbox and chooses a dropdown option; undo restores each', async () => {
    const { source, pages } = await openFile(await fixtureFile(formsAUrl, 'forms-a.pdf'));
    render(<FormLayer {...overlayProps(source, pages, 0, { width: 612, height: 792 })} />);
    const agree = await screen.findByRole('checkbox', { name: 'agree' });
    expect(agree).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(agree);
    await settle();
    expect(await engineValue(source, 'agree')).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'agree' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    await userEvent.click(screen.getByRole('radio', { name: 'choice: optionB' }));
    await settle();
    expect(await engineValue(source, 'choice')).toBe('optionB');

    await userEvent.click(screen.getByRole('button', { name: 'country' }));
    const select = await screen.findByRole('combobox', { name: 'country' });
    await userEvent.selectOptions(select, 'Japan');
    await settle();
    expect(await engineValue(source, 'country')).toBe('Japan');
    expect(labels().slice(-3)).toEqual(['Fill agree', 'Fill choice', 'Fill country']);

    act(() => {
      model().undo();
      model().undo();
      model().undo();
    });
    await settle();
    expect(await engineValue(source, 'country')).toBe('France');
    expect(await engineValue(source, 'choice')).toBe('optionA');
    expect(await engineValue(source, 'agree')).toBe(true);
  });

  it('Tab commits and moves to the next field in document order', async () => {
    const { source, pages } = await openFile(await fixtureFile(formsAUrl, 'forms-a.pdf'));
    render(<FormLayer {...overlayProps(source, pages, 0, { width: 612, height: 792 })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'name' }));
    const editor = await screen.findByRole('textbox', { name: 'name' });
    await userEvent.fill(editor, 'Tabbed');
    await userEvent.keyboard('{Tab}');
    await settle();
    expect(useFormStore.getState().active?.name).toBe('agree');
    expect(screen.getByRole('checkbox', { name: 'agree' })).toHaveFocus();
    expect(await engineValue(source, 'name')).toBe('Tabbed');
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(useFormStore.getState().active?.name).toBe('name');
    expect(await screen.findByRole('textbox', { name: 'name' })).toHaveFocus();
  });

  it('is inert with a drawing tool', async () => {
    const { source, pages } = await openFile(await fixtureFile(formsAUrl, 'forms-a.pdf'));
    const { container } = render(
      <FormLayer {...overlayProps(source, pages, 0, { width: 612, height: 792 })} />,
    );
    await screen.findByRole('button', { name: 'name' });
    act(() => useToolStore.getState().setMode('ink'));
    const layer = container.querySelector('[data-form-layer]');
    expect(layer).not.toHaveAttribute('data-live');
    expect(getComputedStyle(screen.getByRole('button', { name: 'name' })).pointerEvents).toBe(
      'none',
    );
  });
});

describe('Forms panel', () => {
  it('lists fields by page with values; Clear all is one history entry', async () => {
    const { source } = await openFile(await fixtureFile(formsAUrl, 'forms-a.pdf'));
    render(<FormsPanel />);
    const page1 = await screen.findByRole('region', { name: 'Page 1' });
    expect(within(page1).getByText('Alice Example')).toBeVisible();
    expect(within(page1).getByText('Checked')).toBeVisible();
    expect(within(page1).getByText('France')).toBeVisible();
    const page2 = screen.getByRole('region', { name: 'Page 2' });
    expect(within(page2).getByText('Paris')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Highlight fields' }));
    expect(useFormStore.getState().highlight).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Flatten on export' }));
    expect(useFormStore.getState().flattenOnExport).toBe(true);

    const before = labels().length;
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await settle();
    expect(labels()).toHaveLength(before + 1);
    expect(labels().at(-1)).toBe('Clear all fields');
    expect(await engineValue(source, 'name')).toBe('');
    expect(await engineValue(source, 'agree')).toBe(false);
    expect(await engineValue(source, 'address.city')).toBe('');
    // A non-editable dropdown and a radio group cannot be emptied; they keep their values.
    expect(await engineValue(source, 'country')).toBe('France');
    expect(await engineValue(source, 'choice')).toBe('optionA');
    expect(
      within(screen.getByRole('region', { name: 'Page 1' })).getByText('Unchecked'),
    ).toBeVisible();

    act(() => {
      model().undo();
    });
    await settle();
    expect(await engineValue(source, 'name')).toBe('Alice Example');
    expect(await engineValue(source, 'agree')).toBe(true);
  });

  it('shows the empty state for a document without fields', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    await openFile(
      new File([(await pdf.save()).slice()], 'plain.pdf', { type: 'application/pdf' }),
    );
    render(<FormsPanel />);
    expect(await screen.findByText('No form fields')).toBeVisible();
  });

  it('XFA with AcroForm widgets: fields listed, badge explains export removes XFA', async () => {
    await openFile(await fixtureFile(xfaUrl, 'xfa-stub.pdf'));
    render(<FormsPanel />);
    expect(await screen.findByText('Alice Example')).toBeVisible();
    expect(screen.getByRole('button', { name: /export removes the XFA part/ })).toBeVisible();
  });

  it('pure XFA (no widgets): says no browser engine can edit it', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const xdp = pdf.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>');
    pdf.catalog.set(
      PDFName.of('AcroForm'),
      pdf.context.obj({ Fields: [], XFA: pdf.context.register(xdp) }),
    );
    await openFile(
      new File([(await pdf.save({ useObjectStreams: false })).slice()], 'xfa-only.pdf', {
        type: 'application/pdf',
      }),
    );
    render(<FormsPanel />);
    expect(
      await screen.findByText('This form uses XFA, which no browser engine can edit'),
    ).toBeVisible();
    expect(screen.queryByText('No form fields')).toBeNull();
  });
});
