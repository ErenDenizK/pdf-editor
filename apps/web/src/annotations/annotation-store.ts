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
 *
 * The pen draws with its armed preset (spec §6.2, `pen/presets.ts`): `styles.ink` is always
 * the armed preset's style. Arming a preset sets it; editing the armed preset, or changing the
 * pen's style through `applyStyle`, changes both, and the presets persist per device
 * (`PEN_PRESETS_STORAGE_KEY`).
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
import { styleLassoSelection } from './lasso/edits';
import { restyleInk } from './lasso/split';
import {
  DEFAULT_PRESETS,
  parsePenSettings,
  PEN_PRESETS_STORAGE_KEY,
  type PenPreset,
  type PenSettings,
  presetPatch,
  presetStyle,
  type PresetIndex,
  samePreset,
  validPreset,
  withPreset,
} from './pen/presets';

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
  // The first pen preset (spec §6.2); the pen draws with its armed preset (`pen`).
  ink: { ...base, color: '#1F1F1F', strokeWidth: 1.5 },
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

function readPenSettings(): PenSettings {
  return parsePenSettings(readJson(PEN_PRESETS_STORAGE_KEY));
}

/** Stored tool styles, the pen's being its armed preset's. */
function readToolStyles(
  pen: PenSettings = readPenSettings(),
): Readonly<Record<StyleGroup, ToolStyle>> {
  const styles = parseToolStyles(readJson(TOOL_STYLES_STORAGE_KEY));
  return { ...styles, ink: validStyle(styles.ink, presetStyle(pen.presets[pen.active])) };
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

/**
 * Pen paths taken by the lasso (experience-redesign spec §6.5): the selection's Ink ids, each
 * with the indices of its taken paths. Edits through the contextual bar and `applyStyle` act
 * on those paths only (`lasso/edits.ts`), splitting an Ink when only some of its paths are
 * taken (`lasso/split.ts`). It lives beside `selection`, which holds the same ids, and only
 * counts while the two agree (`activePathSelection`).
 */
export interface PathSelection {
  readonly pageId: PageId;
  /** One lasso selection: its edits coalesce under it, across the split that renames ids. */
  readonly key: string;
  readonly paths: Readonly<Record<string, readonly number[]>>;
  /**
   * Where an edit put the taken paths (a split moves them to a new Ink): the selection
   * follows when the page next loads with those ids, so it never points at an Ink the page
   * cache does not hold yet. Queued edits already act on it.
   */
  readonly next?: Readonly<Record<string, readonly number[]>>;
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
  /** Paths taken by the lasso within `selection` (spec §6.5); null for whole annotations. */
  readonly pathSelection: PathSelection | null;
  readonly editor: InlineEditor | null;
  readonly styles: Readonly<Record<StyleGroup, ToolStyle>>;
  readonly author: string;
  readonly pendingStamp: PendingStamp | null;
  readonly signatureDialogOpen: boolean;
  /** The pen presets and the armed one (spec §6.2). */
  readonly pen: PenSettings;

  ensurePage: (source: SourceId, pageIndex: number) => void;
  reloadPage: (source: SourceId, pageIndex: number) => Promise<void>;
  select: (selection: AnnotationSelection | null) => void;
  /**
   * Selects Ink paths (the lasso, spec §6.5): `paths` maps ids to path indices. `key` keeps
   * the identity of a selection whose ids changed by an edit (a split); else a new one.
   */
  selectPaths: (
    target: PageTarget,
    paths: Readonly<Record<string, readonly number[]>>,
    key?: string,
  ) => void;
  /** The lasso selection `key` follows its paths to `next` at the page's next load. */
  followPaths: (key: string, next: Readonly<Record<string, readonly number[]>> | undefined) => void;
  setEditor: (editor: InlineEditor | null) => void;
  /**
   * Changes the style new annotations of `group` get, and remembers it on this device. The
   * pen's style is its armed preset, which changes with it.
   */
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
  /** Arms preset `index`: the pen draws with it from the next stroke (through `setStyle`). */
  armPreset: (index: PresetIndex) => void;
  /** Changes preset `index` and remembers it on this device; the armed one restyles the pen. */
  editPreset: (index: PresetIndex, patch: Partial<PenPreset>) => void;
  /** Puts preset `index` back to its default. */
  resetPreset: (index: PresetIndex) => void;
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

const initialPen = readPenSettings();

export const useAnnotationStore = create<AnnotationState>()((set, get) => ({
  pages: {},
  selection: null,
  pathSelection: null,
  editor: null,
  styles: readToolStyles(initialPen),
  author: readAuthor(),
  pendingStamp: null,
  signatureDialogOpen: false,
  pen: initialPen,

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
        // A lasso edit's result takes over once the page shows it (a split's new Ink).
        const next = s.pathSelection?.next;
        if (
          s.pathSelection &&
          next &&
          Object.keys(next).every((id) => annotations.some((a) => a.id === id))
        ) {
          const nextIds = Object.keys(next);
          const { next: _done, ...current } = s.pathSelection;
          const followed = livePaths({ ...current, paths: next }, nextIds, annotations);
          return {
            pages,
            selection: followed ? { ...sel, ids: nextIds } : null,
            pathSelection: followed,
          };
        }
        // Lasso paths keep only the ids and path indices that still exist.
        const pathSelection = s.pathSelection && livePaths(s.pathSelection, ids, annotations);
        return {
          pages,
          selection: ids.length === 0 ? null : { ...sel, ids },
          pathSelection: ids.length === 0 ? null : pathSelection,
        };
      }
      return { pages };
    });
  },

  select: (selection) =>
    set({
      selection: selection && selection.ids.length > 0 ? selection : null,
      pathSelection: null,
    }),
  selectPaths: (target, paths, key) => {
    const entries = Object.entries(paths).filter(([, indices]) => indices.length > 0);
    if (entries.length === 0) {
      set({ selection: null, pathSelection: null });
      return;
    }
    set({
      selection: { ...target, ids: entries.map(([id]) => id) },
      pathSelection: {
        pageId: target.pageId,
        key: key ?? globalThis.crypto.randomUUID(),
        paths: Object.fromEntries(entries),
      },
    });
  },
  followPaths: (key, next) =>
    set((s) => {
      if (s.pathSelection?.key !== key) return s;
      const { next: _old, ...current } = s.pathSelection;
      return { pathSelection: next ? { ...current, next } : current };
    }),
  setEditor: (editor) => set({ editor }),
  setStyle: (group, patch) => {
    const current = get().styles;
    let next = validStyle(current[group], { ...current[group], ...patch });
    let pen: PenSettings | undefined;
    if (group === 'ink') {
      // The pen's style is its armed preset (spec §6.3): the preset follows, and the style
      // takes the preset's rounding.
      const { active, presets } = get().pen;
      const preset = validPreset(presets[active], presetPatch(next));
      if (!samePreset(preset, presets[active])) pen = withPreset(get().pen, active, preset);
      next = { ...next, ...presetStyle(preset) };
    }
    const styles = { ...current, [group]: next };
    writeJson(TOOL_STYLES_STORAGE_KEY, { v: 1, styles });
    if (pen) writeJson(PEN_PRESETS_STORAGE_KEY, pen);
    set(pen ? { styles, pen } : { styles });
  },
  applyStyle: (patch) => {
    const { selection } = get();
    if (selection && activePathSelection(get())) {
      styleLassoSelection(patch);
      return;
    }
    if (selection) {
      styleSelection(selection, patch);
      return;
    }
    const group = toolStyleGroup(useToolStore.getState().mode);
    // For the pen this edits the armed preset too (`setStyle`).
    if (group) get().setStyle(group, patch);
  },
  setAuthor: (author) => {
    const value = author.slice(0, 200);
    writeJson(AUTHOR_STORAGE_KEY, value);
    set({ author: value });
  },
  setPendingStamp: (pendingStamp) => set({ pendingStamp }),
  setSignatureDialogOpen: (signatureDialogOpen) => set({ signatureDialogOpen }),
  armPreset: (index) => {
    const pen = get().pen;
    if (pen.active !== index) {
      const next = { ...pen, active: index };
      writeJson(PEN_PRESETS_STORAGE_KEY, next);
      set({ pen: next });
    }
    get().setStyle('ink', presetStyle(get().pen.presets[index]));
  },
  editPreset: (index, patch) => {
    const pen = get().pen;
    const current = pen.presets[index];
    const preset = validPreset(current, { ...current, ...patch });
    if (!samePreset(preset, current)) {
      const next = withPreset(pen, index, preset);
      writeJson(PEN_PRESETS_STORAGE_KEY, next);
      set({ pen: next });
    }
    if (get().pen.active === index) get().setStyle('ink', presetStyle(preset));
  },
  resetPreset: (index) => get().editPreset(index, DEFAULT_PRESETS[index]),
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
    // Ink scales its per-point widths with the nominal one (restyleInk), as the lasso does:
    // the stored widths, not /BS /W, are what the appearance draws.
    send('stroke', { strokeWidth: patch.strokeWidth }, (a, v) => {
      if (!hasStrokeWidth(a) || v.strokeWidth === undefined) return undefined;
      if (a.kind === 'ink') return restyleInk(a, { strokeWidth: v.strokeWidth });
      return { ...a, strokeWidth: v.strokeWidth };
    });
  }
  if (patch.fontSize !== undefined) {
    send('font', { fontSize: patch.fontSize }, (a, v) =>
      a.kind === 'free-text' && v.fontSize !== undefined
        ? { ...a, fontSize: v.fontSize }
        : undefined,
    );
  }
}

/**
 * The lasso's paths when they describe the current selection (same page, same ids), else
 * null: a selection set any other way is of whole annotations.
 */
export function activePathSelection(
  state: Pick<AnnotationState, 'selection' | 'pathSelection'>,
): PathSelection | null {
  const { selection, pathSelection } = state;
  if (!selection || selection.pageId !== pathSelection?.pageId) return null;
  const ids = Object.keys(pathSelection.paths);
  if (ids.length !== selection.ids.length) return null;
  return selection.ids.every((id) => (pathSelection.paths[id]?.length ?? 0) > 0)
    ? pathSelection
    : null;
}

/** The lasso's paths that still exist among `ids` and `annotations`, or null for none. */
function livePaths(
  current: PathSelection,
  ids: readonly string[],
  annotations: readonly Annotation[],
): PathSelection | null {
  const paths: Record<string, readonly number[]> = {};
  for (const id of ids) {
    const a = annotations.find((x) => x.id === id);
    const count = a?.kind === 'ink' ? a.paths.length : 0;
    const indices = (current.paths[id] ?? []).filter((i) => i < count);
    if (indices.length > 0) paths[id] = indices;
  }
  return Object.keys(paths).length === ids.length ? { ...current, paths } : null;
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
 * Tests: forget cached pages and UI state. Tool styles and pen presets are read again from
 * storage, as a reload would; tests that change them remove `TOOL_STYLES_STORAGE_KEY` and
 * `PEN_PRESETS_STORAGE_KEY` afterwards.
 */
export function resetAnnotationStore(): void {
  loads.clear();
  pendingStyle.clear();
  const pen = readPenSettings();
  useAnnotationStore.setState({
    pages: {},
    selection: null,
    pathSelection: null,
    editor: null,
    pen,
    styles: readToolStyles(pen),
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
