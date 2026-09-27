/**
 * UI state of the annotation tools: the annotations of loaded pages (read from the engine,
 * with the ids the edit log uses), the selected annotations, in-place editors, the styles
 * new annotations get, the pending stamp and the author name.
 *
 * Content lives in the engine; this is a cache. Pages reload after every engine edit that
 * touches them (edit-runner `onPagesChanged`).
 */
import type { PageId, Rect, SourceId } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { create } from 'zustand';

import { readJson, writeJson } from '../state/safe-storage';
import { onPagesChanged, readAnnotations } from './edit-runner';

export const AUTHOR_STORAGE_KEY = 'pdf-editor:annotations:author:v1';

/** The fixed palette (spec §2); a custom colour is available next to it. */
export const SWATCHES = [
  '#FFEB3B',
  '#FB8C00',
  '#E53935',
  '#D81B60',
  '#8E24AA',
  '#1E88E5',
  '#43A047',
  '#000000',
] as const;

export type StyleGroup =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'ink'
  | 'shape'
  | 'text'
  | 'note';

export interface ToolStyle {
  readonly color: string;
  readonly opacity: number;
  readonly strokeWidth: number;
  readonly fontSize: number;
}

const base: ToolStyle = { color: '#E53935', opacity: 1, strokeWidth: 2, fontSize: 12 };

export const DEFAULT_STYLES: Readonly<Record<StyleGroup, ToolStyle>> = {
  highlight: { ...base, color: '#FFEB3B' },
  underline: { ...base, color: '#1E88E5' },
  strikeout: { ...base, color: '#E53935' },
  squiggly: { ...base, color: '#43A047' },
  ink: { ...base, color: '#E53935' },
  shape: { ...base, color: '#E53935' },
  text: { ...base, color: '#000000' },
  note: { ...base, color: '#FFEB3B' },
};

/** Where an annotation lives: the source page, and the document page showing it. */
export interface PageTarget {
  readonly source: SourceId;
  readonly pageIndex: number;
  readonly pageId: PageId;
  /** 1-based position in the active document (history labels). */
  readonly position: number;
}

export interface AnnotationSelection extends PageTarget {
  readonly ids: readonly string[];
}

/** A stamp chosen in the picker, placed by the next click or drag. */
export interface PendingStamp {
  readonly kind: 'image' | 'builtin' | 'signature';
  /** PNG or JPEG (image, signature, and builtin fallbacks). */
  readonly blob?: Blob;
  /** Named stamp (/Name): Draft, Approved, Confidential. */
  readonly name?: string;
  /** Aspect ratio source: pixel size of the image, or the stamp's natural size in points. */
  readonly width: number;
  readonly height: number;
}

export type InlineEditor =
  | {
      readonly kind: 'free-text';
      readonly target: PageTarget;
      /** Existing annotation being edited; undefined while creating. */
      readonly id?: string;
      /** User-space rect of the box (height grows with the text). */
      readonly rect: Rect;
      readonly text: string;
      /** A dragged box keeps its width; a click box grows to the text. */
      readonly fixedWidth: boolean;
    }
  | {
      readonly kind: 'note';
      readonly target: PageTarget;
      readonly id?: string;
      readonly rect: Rect;
      readonly text: string;
    };

interface PageEntry {
  readonly annotations: readonly Annotation[];
  readonly loaded: boolean;
}

interface AnnotationState {
  readonly pages: Readonly<Record<string, PageEntry>>;
  readonly selection: AnnotationSelection | null;
  readonly editor: InlineEditor | null;
  readonly styles: Readonly<Record<StyleGroup, ToolStyle>>;
  readonly author: string;
  readonly pendingStamp: PendingStamp | null;
  readonly signatureDialogOpen: boolean;

  ensurePage: (source: SourceId, pageIndex: number) => void;
  reloadPage: (source: SourceId, pageIndex: number) => Promise<void>;
  select: (selection: AnnotationSelection | null) => void;
  setEditor: (editor: InlineEditor | null) => void;
  setStyle: (group: StyleGroup, patch: Partial<ToolStyle>) => void;
  setAuthor: (author: string) => void;
  setPendingStamp: (stamp: PendingStamp | null) => void;
  setSignatureDialogOpen: (open: boolean) => void;
}

export function pageKey(source: SourceId, pageIndex: number): string {
  return `${source}:${pageIndex}`;
}

function readAuthor(): string {
  const value = readJson(AUTHOR_STORAGE_KEY);
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

/** Load tokens: a slower, older load never overwrites a newer one. */
const loads = new Map<string, number>();

export const useAnnotationStore = create<AnnotationState>()((set, get) => ({
  pages: {},
  selection: null,
  editor: null,
  styles: DEFAULT_STYLES,
  author: readAuthor(),
  pendingStamp: null,
  signatureDialogOpen: false,

  ensurePage: (source, pageIndex) => {
    const key = pageKey(source, pageIndex);
    if (get().pages[key] !== undefined || loads.has(key)) return;
    void get().reloadPage(source, pageIndex);
  },

  reloadPage: async (source, pageIndex) => {
    const key = pageKey(source, pageIndex);
    const token = (loads.get(key) ?? 0) + 1;
    loads.set(key, token);
    let annotations: readonly Annotation[];
    try {
      annotations = await readAnnotations(source, pageIndex);
    } catch (error) {
      console.warn('Reading annotations failed', error);
      annotations = [];
    }
    if (loads.get(key) !== token) return;
    set((s) => {
      const pages = { ...s.pages, [key]: { annotations, loaded: true } };
      // Drop selected ids that no longer exist on that page (undo of a create).
      const sel = s.selection;
      if (sel && pageKey(sel.source, sel.pageIndex) === key) {
        const ids = sel.ids.filter((id) =>
          annotations.some((a) => a.id === id && !a.flags?.hidden),
        );
        return { pages, selection: ids.length === 0 ? null : { ...sel, ids } };
      }
      return { pages };
    });
  },

  select: (selection) =>
    set({ selection: selection && selection.ids.length > 0 ? selection : null }),
  setEditor: (editor) => set({ editor }),
  setStyle: (group, patch) =>
    set((s) => ({ styles: { ...s.styles, [group]: { ...s.styles[group], ...patch } } })),
  setAuthor: (author) => {
    const value = author.slice(0, 200);
    writeJson(AUTHOR_STORAGE_KEY, value);
    set({ author: value });
  },
  setPendingStamp: (pendingStamp) => set({ pendingStamp }),
  setSignatureDialogOpen: (signatureDialogOpen) => set({ signatureDialogOpen }),
}));

/** Visible annotations of a page (hidden ones are not shown or listed). */
export function visibleAnnotations(entry: PageEntry | undefined): readonly Annotation[] {
  return (entry?.annotations ?? []).filter((a) => !a.flags?.hidden && a.kind !== 'link');
}

const EMPTY: readonly Annotation[] = [];
const visibleCache = new WeakMap<PageEntry, readonly Annotation[]>();

export function usePageAnnotations(
  source: SourceId | undefined,
  pageIndex: number,
): readonly Annotation[] {
  return useAnnotationStore((s) => {
    if (source === undefined) return EMPTY;
    const entry = s.pages[pageKey(source, pageIndex)];
    if (!entry) return EMPTY;
    let visible = visibleCache.get(entry);
    if (!visible) {
      visible = visibleAnnotations(entry);
      visibleCache.set(entry, visible);
    }
    return visible;
  });
}

/** The selected annotations, resolved from the page cache. */
export function selectedAnnotations(
  state: Pick<AnnotationState, 'pages' | 'selection'>,
): Annotation[] {
  const sel = state.selection;
  if (!sel) return [];
  const list = state.pages[pageKey(sel.source, sel.pageIndex)]?.annotations ?? [];
  return sel.ids.flatMap((id) => list.filter((a) => a.id === id));
}

/** Tests: forget cached pages and UI state. */
export function resetAnnotationStore(): void {
  loads.clear();
  useAnnotationStore.setState({
    pages: {},
    selection: null,
    editor: null,
    styles: DEFAULT_STYLES,
    pendingStamp: null,
    signatureDialogOpen: false,
  });
}

// Pages touched by engine edits (created, undone, redone) reload when they are cached.
onPagesChanged((pages) => {
  const state = useAnnotationStore.getState();
  for (const { source, pageIndex } of pages) {
    const key = pageKey(source, pageIndex);
    if (state.pages[key] !== undefined || loads.has(key)) void state.reloadPage(source, pageIndex);
  }
});
