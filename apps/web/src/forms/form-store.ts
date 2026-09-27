/**
 * Form fields of open sources (spec document-tools §1), read from the engine, plus the UI
 * state of the forms tools: the field whose editor is open, "Highlight fields" and
 * "Flatten on export".
 *
 * Content lives in the engine; this is a cache per source. It reloads after every engine
 * edit touching a cached source (edit-runner `onPagesChanged`: fills, undo, redo), and a
 * field whose value changed has every widget page re-rendered, since a field can have
 * widgets on several pages while an edit names only its first page.
 *
 * Widget rects come from the engine in unrotated user space; the PDFium adapter reads them
 * like annotation rects (`annotationRectToUser`), rotated pages included, so the layer
 * maps them through the page frame with no correction.
 */
import type { PageId, SourceId, VirtualDocument } from '@pdf-editor/document-model';
import type { FormField, FormFieldWidget } from '@pdf-editor/engine';
import { create } from 'zustand';

import { engineContext, onPagesChanged } from '../annotations/edit-runner';
import { getEngineService } from '../engine/engine-service';

interface SourceEntry {
  readonly fields: readonly FormField[];
  readonly loaded: boolean;
}

/** One widget of a field, placed in the active document. */
export interface FieldStop {
  readonly source: SourceId;
  readonly name: string;
  /** Index into `field.widgets`. */
  readonly widget: number;
  readonly pageId: PageId;
  /** 0-based document position of the page. */
  readonly position: number;
  readonly field: FormField;
}

/** The field widget whose editor (or focus) is active. */
export interface ActiveField {
  readonly source: SourceId;
  readonly name: string;
  readonly widget: number;
  readonly pageId: PageId;
  /** Opened from the keyboard (Tab): the editor selects the value, as form fillers do. */
  readonly selectAll?: boolean;
}

interface FormState {
  readonly sources: Readonly<Record<SourceId, SourceEntry>>;
  readonly active: ActiveField | null;
  readonly highlight: boolean;
  readonly flattenOnExport: boolean;
  ensureSource: (source: SourceId) => void;
  reloadSource: (source: SourceId) => Promise<void>;
  setActive: (active: ActiveField | null) => void;
  setHighlight: (on: boolean) => void;
  setFlattenOnExport: (on: boolean) => void;
}

const loads = new Map<SourceId, number>();

/** Widgets of a field (a field listed without `widgets` has one, at its rect). */
export function widgetsOf(field: FormField): readonly FormFieldWidget[] {
  return field.widgets ?? [{ pageIndex: field.pageIndex, rect: field.rect }];
}

function sameValue(a: FormField['value'], b: FormField['value']): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export const useFormStore = create<FormState>()((set, get) => ({
  sources: {},
  active: null,
  highlight: false,
  flattenOnExport: false,

  ensureSource: (source) => {
    if (get().sources[source] !== undefined || loads.has(source)) return;
    void get().reloadSource(source);
  },

  reloadSource: async (source) => {
    const token = (loads.get(source) ?? 0) + 1;
    loads.set(source, token);
    let fields: readonly FormField[];
    try {
      const { editor } = await engineContext();
      fields = await editor.listFormFields(source);
    } catch (error) {
      console.warn('Reading form fields failed', error);
      fields = [];
    }
    if (loads.get(source) !== token) return;
    const previous = get().sources[source]?.fields;
    set((s) => ({ sources: { ...s.sources, [source]: { fields, loaded: true } } }));
    if (!previous) return;
    // Re-render every page showing a widget of a field whose value changed.
    const pages = new Set<number>();
    for (const field of fields) {
      const before = previous.find((f) => f.name === field.name);
      if (before && sameValue(before.value, field.value)) continue;
      for (const w of widgetsOf(field)) pages.add(w.pageIndex);
    }
    const service = getEngineService();
    for (const page of pages) service.invalidatePage(source, page);
  },

  setActive: (active) => set({ active }),
  setHighlight: (highlight) => set({ highlight }),
  setFlattenOnExport: (flattenOnExport) => set({ flattenOnExport }),
}));

const EMPTY: readonly FormField[] = [];

/** Fields of a source (empty until loaded). */
export function useSourceFields(source: SourceId | undefined): readonly FormField[] {
  return useFormStore((s) => (source === undefined ? EMPTY : (s.sources[source]?.fields ?? EMPTY)));
}

/** Sources shown by a document, in page order. */
export function documentSources(doc: VirtualDocument): SourceId[] {
  const out: SourceId[] = [];
  for (const page of doc.pages) {
    if (page.ref.kind === 'source' && !out.includes(page.ref.source)) out.push(page.ref.source);
  }
  return out;
}

/**
 * Every widget shown by the document, in document order: page by page, and within a page
 * top to bottom, then left to right (reading order of the form). Pages shown twice list
 * their widgets twice.
 */
export function fieldStops(
  doc: VirtualDocument,
  sources: Readonly<Record<SourceId, SourceEntry>>,
): FieldStop[] {
  const stops: FieldStop[] = [];
  doc.pages.forEach((page, position) => {
    if (page.ref.kind !== 'source') return;
    const { source, index } = page.ref;
    const onPage: (FieldStop & { top: number; left: number })[] = [];
    for (const field of sources[source]?.fields ?? []) {
      widgetsOf(field).forEach((w, widget) => {
        if (w.pageIndex !== index) return;
        onPage.push({
          source,
          name: field.name,
          widget,
          pageId: page.id,
          position,
          field,
          top: w.rect.y + w.rect.height,
          left: w.rect.x,
        });
      });
    }
    // Rows: widgets whose tops are within 4 pt read left to right.
    onPage.sort((a, b) => (Math.abs(a.top - b.top) > 4 ? b.top - a.top : a.left - b.left));
    for (const { top: _top, left: _left, ...stop } of onPage) stops.push(stop);
  });
  return stops;
}

/** Stops that take part in Tab navigation (buttons and signatures only show notices). */
export function isFillable(field: FormField): boolean {
  return (
    !field.readOnly &&
    (field.kind === 'text' ||
      field.kind === 'checkbox' ||
      field.kind === 'radio' ||
      field.kind === 'combobox' ||
      field.kind === 'listbox')
  );
}

/** Tests: forget cached fields and UI state. */
export function resetFormStore(): void {
  loads.clear();
  useFormStore.setState({ sources: {}, active: null, highlight: false, flattenOnExport: false });
}

// A closed source's fields go (and the editor on them).
getEngineService().onSourceClosed((source) => {
  loads.delete(source);
  useFormStore.setState((s) => {
    if (s.sources[source] === undefined && s.active?.source !== source) return s;
    const { [source]: _gone, ...rest } = s.sources;
    return { sources: rest, ...(s.active?.source === source ? { active: null } : {}) };
  });
});

// Engine edits (fills, undo, redo, replays) may change the fields of the sources they touch.
onPagesChanged((pages) => {
  const state = useFormStore.getState();
  for (const source of new Set(pages.map((p) => p.source))) {
    if (state.sources[source] !== undefined || loads.has(source)) void state.reloadSource(source);
  }
});
