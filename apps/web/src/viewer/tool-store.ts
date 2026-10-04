/**
 * The active Read-mode tool. Minimal API shared by the viewer (text selection) and the
 * annotation tools (spec §2): `mode` and `setMode`. Tools are sticky until Esc, which
 * returns to `select`.
 *
 * It also holds the tool bar's group state (experience-redesign spec §5.1–§5.2, craft spec
 * §3.4): the group whose tools the bar shows (`barGroup`, null for the row of five groups),
 * the group used last in this session (`lastGroup`), and the tool a one-shot tool (stamp,
 * signature image) returns to once it has placed its object (`previousMode`).
 *
 * Arming is guarded by the Read lock (ADR-0019 §3): a tool other than Select arms only for a
 * document in Edit, and the tool goes back to Select whenever the active document is not in
 * Edit (`1`, another tab in Read). Callers that arm from Read switch to Edit first
 * (`activateTool`).
 *
 * The armed tool's options tier opens only on request (`optionsOpen`): pressing the armed tool
 * again (its button or its key) toggles it, and arming another tool closes it, so nothing
 * rises over the page on its own (craft spec §3.5, review finding 5).
 *
 * The eraser's options (craft spec §5.6) live here too: Stroke or Partial (`eraserMode`) and
 * the eraser's diameter on screen (`eraserSize`), persisted per device beside the pen
 * presets (`ERASER_STORAGE_KEY`).
 */
import { create } from 'zustand';

import { readJson, writeJson } from '../state/safe-storage';
import { canEdit, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';

export type ToolMode =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'ink'
  | 'eraser'
  /** Lasso (experience-redesign spec §6.5): selects pen strokes by drawing around them. */
  | 'lasso'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text-box'
  | 'note'
  | 'stamp'
  | 'signature'
  /** Redaction marks (redaction spec §1.1): by text or by area. */
  | 'redact'
  /** In-place text editing (redaction-and-text-editing spec §2.2): one line at a time. */
  | 'edit-text'
  /** Image objects (M4 §3): select, move, resize, replace, extract, delete. */
  | 'image';

/**
 * The Edit bar's groups (ADR-0019 §4, craft spec §3.4), in bar order. Select is the idle
 * tool: its chip in the row arms it and shows no tool row.
 */
export const BAR_GROUP_IDS = ['select', 'write', 'text', 'fill', 'redact'] as const;
export type BarGroup = (typeof BAR_GROUP_IDS)[number];

/**
 * What the eraser takes (craft spec §5.6): whole strokes, or only the parts of pen strokes
 * under its circle.
 */
export type EraserMode = 'stroke' | 'partial';

/** The eraser's diameters (CSS px on screen), smallest first. */
export const ERASER_SIZES = [6, 12, 24, 48] as const;
export type EraserSize = (typeof ERASER_SIZES)[number];
/** 12 px: the reach of the eraser before it had a size (6 px either side of the pointer). */
export const DEFAULT_ERASER_SIZE: EraserSize = 12;

/** Where the eraser's options persist per device, with the pen's settings. */
export const ERASER_STORAGE_KEY = 'pdf-editor:ui:eraser:v1';

interface EraserSettings {
  readonly eraserMode: EraserMode;
  readonly eraserSize: EraserSize;
}

/** The stored eraser options; anything unknown falls back to the defaults. */
function readEraserSettings(): EraserSettings {
  const raw = readJson(ERASER_STORAGE_KEY);
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const size = ERASER_SIZES.find((s) => s === value.size);
  return {
    eraserMode: value.mode === 'partial' ? 'partial' : 'stroke',
    eraserSize: size ?? DEFAULT_ERASER_SIZE,
  };
}

function writeEraserSettings(settings: EraserSettings): void {
  writeJson(ERASER_STORAGE_KEY, { v: 1, mode: settings.eraserMode, size: settings.eraserSize });
}

/** Tools that place one object and give the pointer back (spec §5.2). */
export const ONE_SHOT_MODES: ReadonlySet<ToolMode> = new Set<ToolMode>(['stamp', 'signature']);

interface ToolState {
  readonly mode: ToolMode;
  /** The tool before the current one-shot tool, else the tool before the current one. */
  readonly previousMode: ToolMode;
  /** The group whose tools the bar shows; null shows the row of groups. */
  readonly barGroup: BarGroup | null;
  /** The group shown last in this session (kept while the row is shown). */
  readonly lastGroup: BarGroup | null;
  readonly eraserMode: EraserMode;
  readonly eraserSize: EraserSize;
  /** Whether the armed tool's options tier is shown (only on request; closed on arming). */
  readonly optionsOpen: boolean;
  setMode: (mode: ToolMode) => void;
  /** Shows or hides the armed tool's options tier. */
  setOptionsOpen: (open: boolean) => void;
  /** Stroke or Partial; remembered per device. */
  setEraserMode: (mode: EraserMode) => void;
  /** The eraser's diameter on screen; remembered per device. */
  setEraserSize: (size: EraserSize) => void;
  /** Shows a group's tools, or the row of groups (null). */
  showGroup: (group: BarGroup | null) => void;
  /** After a one-shot tool placed its object: back to the tool used before it. */
  finishOneShot: () => void;
}

/**
 * Whether the active document is in Read, so no tool but Select may arm. With no document
 * open there is no page to change, and the tool state is only remembered.
 */
function locked(): boolean {
  const id = useWorkspaceStore.getState().workspace.activeDocument;
  return id !== undefined && !canEdit(id);
}

export const useToolStore = create<ToolState>()((set, get) => ({
  mode: 'select',
  previousMode: 'select',
  barGroup: null,
  lastGroup: null,
  optionsOpen: false,
  ...readEraserSettings(),
  setMode: (mode) =>
    set((s) =>
      s.mode === mode || (mode !== 'select' && locked())
        ? s
        : {
            mode,
            previousMode: ONE_SHOT_MODES.has(s.mode) ? s.previousMode : s.mode,
            optionsOpen: false,
          },
    ),
  setOptionsOpen: (optionsOpen) =>
    set((s) => (s.optionsOpen === optionsOpen ? s : { optionsOpen })),
  showGroup: (group) =>
    set((s) => (s.barGroup === group ? s : { barGroup: group, lastGroup: group ?? s.lastGroup })),
  setEraserMode: (eraserMode) => {
    if (get().eraserMode === eraserMode) return;
    set({ eraserMode });
    writeEraserSettings(get());
  },
  setEraserSize: (eraserSize) => {
    if (get().eraserSize === eraserSize) return;
    set({ eraserSize });
    writeEraserSettings(get());
  },
  finishOneShot: () => {
    const { mode, previousMode } = get();
    if (!ONE_SHOT_MODES.has(mode)) return;
    get().setMode(ONE_SHOT_MODES.has(previousMode) ? 'select' : previousMode);
  },
}));

// The Read lock: nothing stays armed for a document that is not in Edit.
const disarmWhenLocked = () => {
  if (useToolStore.getState().mode !== 'select' && locked()) {
    useToolStore.getState().setMode('select');
  }
};
useUiStore.subscribe((state, previous) => {
  if (state.documentMode !== previous.documentMode) disarmWhenLocked();
});
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspace.activeDocument !== previous.workspace.activeDocument) disarmWhenLocked();
});

/** Tests: the state of a fresh session (the eraser's options read back from storage). */
export function resetToolStore(): void {
  useToolStore.setState({
    mode: 'select',
    previousMode: 'select',
    barGroup: null,
    lastGroup: null,
    optionsOpen: false,
    ...readEraserSettings(),
  });
}
