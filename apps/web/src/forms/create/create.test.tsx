/**
 * Field creation in the app (spec redaction-and-text-editing §3), Vitest browser mode with
 * the real stores and engine: placing by drag and by click, Edit fields (keyboard nudge,
 * drag, delete, undo), filling created fields ("Fill Name", values in the model), the
 * properties popover (rename with validation), the Forms panel rows and tab order, and a
 * blank page.
 */
import {
  getActiveDocument,
  historyEntries,
  insertBlankPage,
  type PageId,
  type SourceId,
} from '@pdf-editor/document-model';
import { degrees, PDFDocument } from '@cantoo/pdf-lib';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import formsAUrl from '../../../../../test/fixtures/forms-a.pdf?url';
import simpleUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import { enterEditMode, fixtureFile } from '../../../test/store-harness';
import { resetAnnotationStore } from '../../annotations/annotation-store';
import { engineContext, resetEditRunner, whenIdle } from '../../annotations/edit-runner';
import { FormsPanel } from '../../shell/FormsPanel';
import type { PageOverlayProps } from '../../stage/page-overlays';
import { useUiStore } from '../../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { useToolStore } from '../../viewer/tool-store';
import { resetFormStore } from '../form-store';
import { clearActiveForm } from '../index';
import { resetCreateStore, useCreateStore } from './create-store';
import { CreatedFieldLayer } from './CreatedFieldLayer';
import { setDesign, startPlacing } from './index';

const model = () => useWorkspaceStore.getState();
const fields = () => getActiveDocument(model().workspace)?.fields ?? [];
const labels = () => historyEntries(model().history).map((e) => e.label);

async function openSimple(): Promise<{ source: SourceId; pages: PageId[] }> {
  const report = await model().openFiles([await fixtureFile(simpleUrl, 'simple-text.pdf')]);
  enterEditMode();
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace);
  const first = doc?.pages[0];
  if (!doc || first?.ref.kind !== 'source') throw new Error('no source page');
  return { source: first.ref.source, pages: doc.pages.map((p) => p.id) };
}

function overlayProps(index: number): PageOverlayProps {
  const doc = getActiveDocument(model().workspace);
  const page = doc?.pages[index];
  if (!page) throw new Error('no page');
  const size = page.ref.kind === 'source' ? { width: 612, height: 792 } : page.ref.size;
  return {
    page,
    pageId: page.id,
    pageIndex: index,
    sourceId: page.ref.kind === 'source' ? page.ref.source : undefined,
    sourceIndex: page.ref.kind === 'source' ? page.ref.index : 0,
    sizePt: size,
    cssScale: 1,
    rotation: 0,
    visible: true,
  };
}

/** Renders the layer for page `index` inside a page-sized box. */
function renderLayer(index: number) {
  const props = overlayProps(index);
  return render(
    <div style={{ position: 'relative', width: props.sizePt.width, height: props.sizePt.height }}>
      <CreatedFieldLayer {...props} />
    </div>,
  );
}

function layerOf(index: number): HTMLElement {
  const layer = document.querySelector<HTMLElement>(`[data-created-field-layer="${index}"]`);
  if (!layer) throw new Error('no layer');
  return layer;
}

/** A press at (x, y) CSS px of the page, released at (toX, toY). */
function drag(target: HTMLElement, x: number, y: number, toX = x, toY = y): void {
  const r = layerOf(
    Number(
      target.closest('[data-created-field-layer]')?.getAttribute('data-created-field-layer') ?? 0,
    ),
  ).getBoundingClientRect();
  act(() => {
    fireEvent.pointerDown(target, { button: 0, clientX: r.left + x, clientY: r.top + y });
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: r.left + toX, clientY: r.top + toY }),
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: r.left + toX, clientY: r.top + toY }),
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

beforeEach(() => {
  resetWorkspace();
  resetEditRunner();
  resetAnnotationStore();
  resetFormStore();
  resetCreateStore();
  useToolStore.getState().setMode('select');
  useUiStore.getState().setViewMode('read');
});

afterEach(async () => {
  await whenIdle();
  resetCreateStore();
  resetWorkspace();
});

describe('placing fields', () => {
  it('a drag draws a text field; a click places a checkbox at its default size', async () => {
    await openSimple();
    renderLayer(0);
    act(() => startPlacing('text'));
    expect(layerOf(0)).toHaveAttribute('data-placing');
    drag(layerOf(0), 100, 100, 300, 130);
    expect(fields().map((f) => [f.kind, f.name])).toEqual([['text', 'Text1']]);
    expect(fields()[0]?.widgets[0]?.rect).toEqual({ x: 100, y: 662, width: 200, height: 30 });
    expect(labels().at(-1)).toBe('Add Text1');
    expect(useCreateStore.getState()).toMatchObject({ placing: null, design: true });
    expect(useCreateStore.getState().selected?.fieldId).toBe(fields()[0]?.id);

    act(() => startPlacing('checkbox'));
    drag(layerOf(0), 400, 200);
    expect(fields()[1]).toMatchObject({ kind: 'checkbox', name: 'CheckBox1', value: false });
    expect(fields()[1]?.widgets[0]?.rect).toEqual({ x: 393, y: 585, width: 14, height: 14 });
  });

  it('a click near the edge keeps the field inside the page; Esc cancels placing', async () => {
    await openSimple();
    renderLayer(0);
    act(() => startPlacing('text'));
    drag(layerOf(0), 605, 5);
    const rect = fields()[0]?.widgets[0]?.rect;
    expect(rect?.x).toBeCloseTo(612 - 160, 1);
    expect(rect?.y).toBeCloseTo(792 - 22, 1);
    act(() => startPlacing('radio'));
    await userEvent.keyboard('{Escape}');
    expect(useCreateStore.getState().placing).toBeNull();
  });

  it('from the keyboard: the layer takes the focus, arrows move the field, Enter places it', async () => {
    await openSimple();
    renderLayer(0);
    const invoker = document.createElement('button');
    invoker.textContent = 'Add field';
    document.body.append(invoker);
    try {
      invoker.focus();
      act(() => startPlacing('text'));
      const layer = layerOf(0);
      await vi.waitFor(() => expect(document.activeElement).toBe(layer));
      expect(layer).toHaveAccessibleName('Place the Text field on page 1');
      expect(layer).toHaveAccessibleDescription(/Enter or Space places it/);
      // Default size in the centre of the page (612 × 792 at 1 px/pt): (226, 385) from the
      // top left, so y = 792 - 385 - 22 = 385; Shift+Right 10 pt, Down 1 pt.
      await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}{ArrowDown}');
      expect(layer.querySelector('[data-created-pending]')).not.toBeNull();
      await userEvent.keyboard('{Enter}');
      await settle();
      const [field] = fields();
      expect(field?.kind).toBe('text');
      expect(field?.widgets[0]?.rect).toEqual({ x: 236, y: 384, width: 160, height: 22 });
      expect(useCreateStore.getState()).toMatchObject({ placing: null, design: true });
      // The new field has the focus, selected in Edit fields.
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute('data-created-field-id')).toBe(field?.id),
      );

      // Esc cancels and gives the focus back to the control that armed placing.
      invoker.focus();
      act(() => startPlacing('checkbox'));
      await vi.waitFor(() => expect(document.activeElement).toBe(layerOf(0)));
      await userEvent.keyboard(' ');
      expect(fields()[1]?.widgets[0]?.rect).toEqual({ x: 299, y: 389, width: 14, height: 14 });
      invoker.focus();
      act(() => startPlacing('radio'));
      await vi.waitFor(() => expect(document.activeElement).toBe(layerOf(0)));
      await userEvent.keyboard('{Escape}');
      expect(useCreateStore.getState().placing).toBeNull();
      expect(document.activeElement).toBe(invoker);
      expect(fields()).toHaveLength(2);
    } finally {
      invoker.remove();
    }
  });

  it('on a /Rotate 90 page a click places the field upright (user-space size swapped)', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 200]).setRotation(degrees(90));
    const report = await model().openFiles([
      new File([(await pdf.save()).slice()], 'rotated.pdf', { type: 'application/pdf' }),
    ]);
    enterEditMode();
    expect(report.skipped).toEqual([]);
    const props = {
      ...overlayProps(0),
      sizePt: { width: 200, height: 300 },
      rotation: 90 as const,
    };
    render(
      <div style={{ position: 'relative', width: 200, height: 300 }}>
        <CreatedFieldLayer {...props} />
      </div>,
    );
    act(() => startPlacing('text'));
    drag(layerOf(0), 100, 150);
    // 160 × 22 as seen upright is 22 × 160 in the page's unrotated user space.
    const rect = fields()[0]?.widgets[0]?.rect;
    expect(rect?.width).toBeCloseTo(22, 1);
    expect(rect?.height).toBeCloseTo(160, 1);
    expect(document.querySelector('[data-created-look="Text1"]')).toHaveStyle({
      width: '160px',
      height: '22px',
    });
  });

  it('places on a blank page', async () => {
    await openSimple();
    act(() => {
      model().applyOperation(
        (ws, ids) =>
          insertBlankPage(
            ws,
            {
              document: getActiveDocument(ws)?.id ?? ('' as never),
              index: 1,
              size: { width: 300, height: 400 },
            },
            ids,
          ),
        'Insert blank page',
      );
    });
    renderLayer(1);
    act(() => startPlacing('dropdown'));
    drag(layerOf(1), 150, 200);
    expect(fields()[0]).toMatchObject({ kind: 'dropdown', name: 'Dropdown1' });
    expect(fields()[0]?.widgets[0]?.page).toBe(getActiveDocument(model().workspace)?.pages[1]?.id);
  });
});

describe('Edit fields', () => {
  async function withTextField() {
    await openSimple();
    renderLayer(0);
    act(() => startPlacing('text'));
    drag(layerOf(0), 100, 100, 300, 130);
    return screen.getByRole('button', { name: /^Text1, Text field/ });
  }

  it('arrows nudge (one entry per run), a drag moves, Delete removes, undo restores', async () => {
    const widget = await withTextField();
    widget.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowDown}{/Shift}');
    expect(fields()[0]?.widgets[0]?.rect).toEqual({ x: 102, y: 652, width: 200, height: 30 });
    expect(labels().filter((l) => l === 'Move Text1')).toHaveLength(1);

    drag(screen.getByRole('button', { name: /^Text1/ }), 150, 125, 200, 175);
    expect(fields()[0]?.widgets[0]?.rect).toEqual({ x: 152, y: 602, width: 200, height: 30 });

    screen.getByRole('button', { name: /^Text1/ }).focus();
    await userEvent.keyboard('{Delete}');
    expect(fields()).toEqual([]);
    expect(labels().at(-1)).toBe('Delete Text1');
    act(() => {
      model().undo();
    });
    expect(fields().map((f) => f.name)).toEqual(['Text1']);
  });

  it('the properties popover renames with validation', async () => {
    await withTextField();
    act(() => startPlacing('checkbox'));
    drag(layerOf(0), 400, 200);
    // Placing hides the design targets: find the text field's target again.
    screen.getByRole('button', { name: /^Text1, Text field/ }).focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByText('Text field properties');
    const popup = dialog.closest('[data-field-properties]') as HTMLElement;
    const name = within(popup).getByRole('textbox', { name: 'Name' });
    await userEvent.fill(name, 'CheckBox1');
    await userEvent.keyboard('{Enter}');
    expect(within(popup).getByRole('alert')).toHaveTextContent('Another added field has this name');
    await userEvent.fill(name, 'a.b');
    await userEvent.keyboard('{Enter}');
    expect(within(popup).getByRole('alert')).toHaveTextContent('Names cannot contain periods');
    await userEvent.fill(name, 'FullName');
    await userEvent.keyboard('{Enter}');
    expect(fields()[0]?.name).toBe('FullName');
    expect(labels().at(-1)).toBe('Rename Text1 to FullName');
    await userEvent.click(within(popup).getByRole('checkbox', { name: 'Required' }));
    expect(fields()[0]?.required).toBe(true);
  });
});

describe('filling created fields', () => {
  it('types into a text field and toggles a checkbox; values live in the model', async () => {
    await openSimple();
    renderLayer(0);
    act(() => startPlacing('text'));
    drag(layerOf(0), 100, 100, 300, 130);
    act(() => startPlacing('checkbox'));
    drag(layerOf(0), 400, 200);
    act(() => setDesign(false));

    await userEvent.click(screen.getByRole('button', { name: 'Text1' }));
    const editor = await screen.findByRole('textbox', { name: 'Text1' });
    await userEvent.fill(editor, 'Ada Lovelace');
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(fields()[0]?.value).toBe('Ada Lovelace');
    expect(labels().at(-1)).toBe('Fill Text1');
    expect(document.querySelector('[data-created-look="Text1"]')).toHaveTextContent('Ada Lovelace');

    await userEvent.click(screen.getByRole('checkbox', { name: 'CheckBox1' }));
    expect(fields()[1]?.value).toBe(true);
    act(() => {
      model().undo();
    });
    expect(fields()[1]?.value).toBe(false);
  });
});

describe('Clear all', () => {
  it('empties source and created fields as one history entry; undo restores both', async () => {
    const report = await model().openFiles([await fixtureFile(formsAUrl, 'forms-a.pdf')]);
    enterEditMode();
    expect(report.skipped).toEqual([]);
    renderLayer(0);
    act(() => startPlacing('text'));
    drag(layerOf(0), 100, 600, 300, 630);
    act(() => setDesign(false));
    await userEvent.click(screen.getByRole('button', { name: 'Text1' }));
    await userEvent.fill(await screen.findByRole('textbox', { name: 'Text1' }), 'Created');
    await userEvent.keyboard('{Enter}');
    await settle();
    const before = labels().length;
    await act(async () => {
      await clearActiveForm();
    });
    await settle();
    expect(labels().length).toBe(before + 1);
    expect(labels().at(-1)).toBe('Clear all fields');
    expect(fields()[0]?.value).toBe('');
    const { editor } = await engineContext();
    const source = getActiveDocument(model().workspace)?.pages[0]?.ref;
    if (source?.kind !== 'source') throw new Error('no source');
    const name = async () =>
      (await editor.listFormFields(source.source)).find((f) => f.name === 'name')?.value;
    expect(await name()).toBe('');
    act(() => {
      model().undo();
    });
    await settle();
    expect(fields()[0]?.value).toBe('Created');
    expect(await name()).toBe('Alice Example');
  });
});

describe('Forms panel', () => {
  it('lists created fields tagged, adds from the menu, and reorders them in Edit fields', async () => {
    await openSimple();
    render(<FormsPanel />);
    renderLayer(0);
    await userEvent.click(await screen.findByRole('button', { name: /Add field/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Text field' }));
    expect(useCreateStore.getState().placing).toBe('text');
    drag(layerOf(0), 100, 100, 300, 130);
    act(() => startPlacing('text'));
    drag(layerOf(0), 100, 200, 300, 230);
    const rows = () =>
      [...document.querySelectorAll('[data-created-row]')].map((r) =>
        r.getAttribute('data-created-row'),
      );
    expect(rows()).toEqual(['Text1', 'Text2']);
    expect(screen.getAllByText('Added')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Move Text2 earlier in tab order' }));
    expect(fields().map((f) => f.name)).toEqual(['Text2', 'Text1']);
    expect(rows()).toEqual(['Text2', 'Text1']);
    expect(labels().at(-1)).toBe('Change tab order');
    await userEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    expect(useCreateStore.getState().design).toBe(false);
  });
});
