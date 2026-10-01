/**
 * UI state of the annotation tools: the annotations of loaded pages (read from the engine,
 * with the ids the edit log uses), the selected annotations, in-place editors, the styles
 * new annotations get, the pending stamp and the author name.
 *
 * Content lives in the engine; this is a cache. Pages reload after every engine edit that
 * touches them (edit-runner `onPagesChanged`).
 *
 * Tool styles follow one rule (experience-redesign spec §6.3): `applyStyle` edits the
 * selection when there is one, else the armed tool's style (`setStyle`), which persists
 * per device (`TOOL_STYLES_STORAGE_KEY`). Recolouring a selection never changes a tool.
 */
import type { PageId, Rect, SourceId } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { create } from 'zustand';

import { getEngineService } from '../engine/engine-service';
import { readJson, writeJson } from '../state/safe-storage';
import { useToolStore } from '../viewer/tool-store';
// actions.ts imports this module too; both only use each other inside functions.
import { updateAnnotations } from './actions';
import { hasStrokeWidth, normalizeHex, withColor } from './colors';
import { toolStyleGroup } from './drafts';
import { onPagesChanged, readAnnotations } from './edit-runner';

export const AUTHOR_STORAGE_KEY = 'pdf-editor:annotations:author:v1';
/**
 * Tool styles, per device (spec §6.3, §9). Under the `ui:` namespace with its own version:
 * a change of shape gets a new key, and anything unreadable falls back to the defaults.
 */
export const TOOL_STYLES_STORAGE_KEY = 'pdf-editor:ui:tool-styles:v1';

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

/** Accepted ranges of stored style values (the pen range of spec §6.2 for widths). */
export const STYLE_LIMITS = {
  opacity: { min: 0.1, max: 1 },
  strokeWidth: { min: 0.25, max: 24 },
  fontSize: { min: 4, max: 144 },
} as const;

const STYLE_GROUPS = Object.keys(DEFAULT_STYLES) as StyleGroup[];

/** The style with only valid fields of `patch` applied (colours as #RRGGBB, numbers clamped). */
function validStyle(current: ToolStyle, patch: unknown): ToolStyle {
  if (typeof patch !== 'object' || patch === null) return current;
  const p = patch as Record<string, unknown>;
  const number = (x: unknown, range: { min: number; max: number }, fallback: number) =>
    typeof x === 'number' && Number.isFinite(x)
      ? Math.min(range.max, Math.max(range.min, x))
      : fallback;
  return {
    color:
      typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)
        ? p.color.toUpperCase()
        : current.color,
    opacity: number(p.opacity, STYLE_LIMITS.opacity, current.opacity),
    strokeWidth: number(p.strokeWidth, STYLE_LIMITS.strokeWidth, current.strokeWidth),
    fontSize: number(p.fontSize, STYLE_LIMITS.fontSize, current.fontSize),
  };
}

/**
 * Reads stored tool styles, field by field (like `parseLayout`): an unknown version, group
 * or value keeps the default for that field only.
 */
export function parseToolStyles(value: unknown): Readonly<Record<StyleGroup, ToolStyle>> {
  if (typeof value !== 'object' || value === null) return DEFAULT_STYLES;
  const v = value as { v?: unknown; styles?: unknown };
  if (v.v !== 1 || typeof v.styles !== 'object' || v.styles === null) return DEFAULT_STYLES;
  const stored = v.styles as Record<string, unknown>;
  return Object.fromEntries(
    STYLE_GROUPS.map((group) => [group, validStyle(DEFAULT_STYLES[group], stored[group])]),
  ) as Record<StyleGroup, ToolStyle>;
}

function readToolStyles(): Readonly<Record<StyleGroup, ToolStyle>> {
  return parseToolStyles(readJson(TOOL_STYLES_STORAGE_KEY));
}

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
  /** Changes the style new annotations of `group` get, and remembers it on this device. */
  setStyle: (group: StyleGroup, patch: Partial<ToolStyle>) => void;
  /**
   * The one entry point of the style controls (spec §6.3): with a selection it edits the
   * selected annotations (one coalesced history entry per control); without one it changes
   * the armed tool's style through `setStyle`. With neither it does nothing.
   */
  applyStyle: (patch: Partial<ToolStyle>) => void;
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
  styles: readToolStyles(),
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
  setStyle: (group, patch) => {
    const current = get().styles;
    const next = validStyle(current[group], { ...current[group], ...patch });
    const styles = { ...current, [group]: next };
    writeJson(TOOL_STYLES_STORAGE_KEY, { v: 1, styles });
    set({ styles });
  },
  applyStyle: (patch) => {
    const { selection } = get();
    if (selection) {
      styleSelection(selection, patch);
      return;
    }
    const group = toolStyleGroup(useToolStore.getState().mode);
    if (group) get().setStyle(group, patch);
  },
  setAuthor: (author) => {
    const value = author.slice(0, 200);
    writeJson(AUTHOR_STORAGE_KEY, value);
    set({ author: value });
  },
  setPendingStamp: (pendingStamp) => set({ pendingStamp }),
  setSignatureDialogOpen: (signatureDialogOpen) => set({ signatureDialogOpen }),
}));

/** Latest-value slots per coalescing key: a burst of slider events sends one update. */
const pendingStyle = new Map<string, { value: Partial<ToolStyle> }>();

/**
 * Edits the selected annotations' style: colour, opacity, stroke width or font size, each
 * coalesced into one history entry per control and selection (800 ms window, edit-runner).
 * While an update waits in the edit queue, newer values of the same control replace its
 * value, so a slider drag sends only the latest one.
 */
function styleSelection(selection: AnnotationSelection, patch: Partial<ToolStyle>): void {
  const idsKey = [...selection.ids].sort().join(',');
  const send = (
    control: 'color' | 'opacity' | 'stroke' | 'font',
    value: Partial<ToolStyle>,
    change: (a: Annotation, value: Partial<ToolStyle>) => Annotation | undefined,
  ) => {
    const key = `${control}:${idsKey}`;
    const slot = pendingStyle.get(key);
    if (slot) {
      slot.value = value;
      return;
    }
    const fresh = { value };
    pendingStyle.set(key, fresh);
    void updateAnnotations(
      selection,
      selection.ids,
      (a) => {
        pendingStyle.delete(key);
        return change(a, fresh.value);
      },
      { action: control, coalesceKey: key },
    ).finally(() => {
      if (pendingStyle.get(key) === fresh) pendingStyle.delete(key);
    });
  };
  if (patch.color !== undefined) {
    const color = normalizeHex(patch.color);
    send('color', { color }, (a) =>
      a.kind === 'stamp' || a.kind === 'link' ? undefined : withColor(a, color),
    );
  }
  if (patch.opacity !== undefined) {
    send('opacity', { opacity: patch.opacity }, (a, v) => ({
      ...a,
      opacity: Math.round((v.opacity ?? 1) * 100) / 100,
    }));
  }
  if (patch.strokeWidth !== undefined) {
    send('stroke', { strokeWidth: patch.strokeWidth }, (a, v) =>
      hasStrokeWidth(a) && v.strokeWidth !== undefined
        ? { ...a, strokeWidth: v.strokeWidth }
        : undefined,
    );
  }
  if (patch.fontSize !== undefined) {
    send('font', { fontSize: patch.fontSize }, (a, v) =>
      a.kind === 'free-text' && v.fontSize !== undefined
        ? { ...a, fontSize: v.fontSize }
        : undefined,
    );
  }
}

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

/**
 * Tests: forget cached pages and UI state. Tool styles are read again from storage, as a
 * reload would; tests that change them remove `TOOL_STYLES_STORAGE_KEY` afterwards.
 */
export function resetAnnotationStore(): void {
  loads.clear();
  pendingStyle.clear();
  useAnnotationStore.setState({
    pages: {},
    selection: null,
    editor: null,
    styles: readToolStyles(),
    pendingStamp: null,
    signatureDialogOpen: false,
  });
}

// A closed source's pages go (and the selection or editor on them).
getEngineService().onSourceClosed((source) => {
  const prefix = `${source}:`;
  for (const key of [...loads.keys()]) if (key.startsWith(prefix)) loads.delete(key);
  useAnnotationStore.setState((s) => {
    const keys = Object.keys(s.pages).filter((key) => key.startsWith(prefix));
    const selectionGone = s.selection?.source === source;
    const editorGone = s.editor?.target.source === source;
    if (keys.length === 0 && !selectionGone && !editorGone) return s;
    const gone = new Set(keys);
    const pages = Object.fromEntries(Object.entries(s.pages).filter(([key]) => !gone.has(key)));
    return {
      pages,
      ...(selectionGone ? { selection: null } : {}),
      ...(editorGone ? { editor: null } : {}),
    };
  });
});

// Pages touched by engine edits (created, undone, redone) reload when they are cached.
onPagesChanged((pages) => {
  const state = useAnnotationStore.getState();
  for (const { source, pageIndex } of pages) {
    const key = pageKey(source, pageIndex);
    if (state.pages[key] !== undefined || loads.has(key)) void state.reloadPage(source, pageIndex);
  }
});
