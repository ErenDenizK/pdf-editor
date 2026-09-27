/**
 * UI state: panels, view mode, zoom, active tab, overlays, recents. Document content is
 * not here; see `workspace-store.ts`.
 *
 * Panel layout is persisted to localStorage (see `safe-storage.ts`); everything else is
 * per session.
 */
import { create } from 'zustand';

import { readJson, writeJson } from './safe-storage';

export type ViewMode = 'read' | 'arrange';
export type LeftPanelView = 'pages' | 'outline' | 'files';
/** Placeholder tool ids; the tool state machine (ARCHITECTURE.md §6) will own these. */
export type ToolId = 'select' | 'highlight' | 'ink' | 'text' | 'shapes' | 'note';

export const LEFT_PANEL_WIDTH = { min: 200, max: 420, default: 248 } as const;
export const RIGHT_PANEL_WIDTH = { min: 240, max: 440, default: 280 } as const;

/** Discrete zoom steps, as in most viewers. 1 = 100%. */
export const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;
export const MIN_ZOOM = ZOOM_LEVELS[0];
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 5;
const MAX_RECENTS = 5;
const STORAGE_KEY = 'pdf-editor:ui:v1';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function nextZoomLevel(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((z) => z > current + 1e-3) ?? MAX_ZOOM;
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 1e-3) ?? MIN_ZOOM;
}

interface PersistedLayout {
  leftPanelOpen: boolean;
  leftPanelView: LeftPanelView;
  leftPanelWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}

const DEFAULT_LAYOUT: PersistedLayout = {
  leftPanelOpen: true,
  leftPanelView: 'pages',
  leftPanelWidth: LEFT_PANEL_WIDTH.default,
  rightPanelOpen: true,
  rightPanelWidth: RIGHT_PANEL_WIDTH.default,
};

/** Validates persisted data field by field; anything unexpected falls back to defaults. */
export function parseLayout(value: unknown): PersistedLayout {
  if (typeof value !== 'object' || value === null) return DEFAULT_LAYOUT;
  const v = value as Record<string, unknown>;
  const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
  const width = (x: unknown, range: { min: number; max: number; default: number }) =>
    typeof x === 'number' && Number.isFinite(x) ? clamp(x, range.min, range.max) : range.default;
  const views: readonly LeftPanelView[] = ['pages', 'outline', 'files'];
  return {
    leftPanelOpen: bool(v.leftPanelOpen, DEFAULT_LAYOUT.leftPanelOpen),
    leftPanelView: views.includes(v.leftPanelView as LeftPanelView)
      ? (v.leftPanelView as LeftPanelView)
      : DEFAULT_LAYOUT.leftPanelView,
    leftPanelWidth: width(v.leftPanelWidth, LEFT_PANEL_WIDTH),
    rightPanelOpen: bool(v.rightPanelOpen, DEFAULT_LAYOUT.rightPanelOpen),
    rightPanelWidth: width(v.rightPanelWidth, RIGHT_PANEL_WIDTH),
  };
}

export interface UiState extends PersistedLayout {
  viewMode: ViewMode;
  zoom: number;
  /** When true the stage keeps zoom fitted to its width as it resizes. */
  zoomToFit: boolean;
  activeTabId: string | null;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** Command ids, most recent first. In memory only. */
  recents: readonly string[];
  tool: ToolId;

  toggleLeftPanel: () => void;
  /** Opens the left panel on a view; selecting the open view again collapses it. */
  showLeftPanelView: (view: LeftPanelView) => void;
  setLeftPanelWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  /** Used by the stage while `zoomToFit` is on; does not clear the flag. */
  applyFitZoom: (zoom: number) => void;
  setActiveTab: (id: string | null) => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  pushRecent: (commandId: string) => void;
  setTool: (tool: ToolId) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  ...parseLayout(readJson(STORAGE_KEY)),
  viewMode: 'read',
  zoom: 1,
  zoomToFit: true,
  activeTabId: null,
  paletteOpen: false,
  shortcutsOpen: false,
  recents: [],
  tool: 'select',

  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  showLeftPanelView: (view) =>
    set((s) =>
      s.leftPanelOpen && s.leftPanelView === view
        ? { leftPanelOpen: false }
        : { leftPanelOpen: true, leftPanelView: view },
    ),
  setLeftPanelWidth: (width) =>
    set({ leftPanelWidth: clamp(Math.round(width), LEFT_PANEL_WIDTH.min, LEFT_PANEL_WIDTH.max) }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanelWidth: (width) =>
    set({
      rightPanelWidth: clamp(Math.round(width), RIGHT_PANEL_WIDTH.min, RIGHT_PANEL_WIDTH.max),
    }),
  setViewMode: (viewMode) => set({ viewMode }),
  setZoom: (zoom) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), zoomToFit: false }),
  zoomIn: () => set((s) => ({ zoom: nextZoomLevel(s.zoom, 1), zoomToFit: false })),
  zoomOut: () => set((s) => ({ zoom: nextZoomLevel(s.zoom, -1), zoomToFit: false })),
  zoomFit: () => set({ zoomToFit: true }),
  applyFitZoom: (zoom) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) }),
  setActiveTab: (activeTabId) => set({ activeTabId }),
  setPaletteOpen: (paletteOpen) =>
    set(paletteOpen ? { paletteOpen, shortcutsOpen: false } : { paletteOpen }),
  setShortcutsOpen: (shortcutsOpen) =>
    set(shortcutsOpen ? { shortcutsOpen, paletteOpen: false } : { shortcutsOpen }),
  pushRecent: (id) =>
    set((s) => ({ recents: [id, ...s.recents.filter((r) => r !== id)].slice(0, MAX_RECENTS) })),
  setTool: (tool) => set({ tool }),
}));

// Persist layout changes only; the comparison avoids a write on every zoom or keystroke.
useUiStore.subscribe((state, previous) => {
  if (
    state.leftPanelOpen !== previous.leftPanelOpen ||
    state.leftPanelView !== previous.leftPanelView ||
    state.leftPanelWidth !== previous.leftPanelWidth ||
    state.rightPanelOpen !== previous.rightPanelOpen ||
    state.rightPanelWidth !== previous.rightPanelWidth
  ) {
    const layout: PersistedLayout = {
      leftPanelOpen: state.leftPanelOpen,
      leftPanelView: state.leftPanelView,
      leftPanelWidth: state.leftPanelWidth,
      rightPanelOpen: state.rightPanelOpen,
      rightPanelWidth: state.rightPanelWidth,
    };
    writeJson(STORAGE_KEY, layout);
  }
});
