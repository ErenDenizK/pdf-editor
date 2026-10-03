/**
 * The active Read-mode tool. Minimal API shared by the viewer (text selection) and the
 * annotation tools (spec §2): `mode` and `setMode`. Tools are sticky until Esc, which
 * returns to `select`.
 *
 * It also holds the tool bar's group state (experience-redesign spec §5.1–§5.2): the group
 * whose tools the bar shows (`barGroup`, null for the row of six groups), the group used
 * last in this session (`lastGroup`), and the tool a one-shot tool (stamp, signature image)
 * returns to once it has placed its object (`previousMode`).
 *
 * Arming is guarded by the Read lock (ADR-0019 §3): a tool other than Select arms only for a
 * document in Edit, and the tool goes back to Select whenever the active document is not in
 * Edit (`1`, another tab in Read). Callers that arm from Read switch to Edit first
 * (`activateTool`).
 */
import { create } from 'zustand';

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

/** The tool bar's task groups (experience-redesign spec §5.1), in bar order. */
export const BAR_GROUP_IDS = ['read', 'markup', 'draw', 'fill', 'pages', 'redact'] as const;
export type BarGroup = (typeof BAR_GROUP_IDS)[number];

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
  setMode: (mode: ToolMode) => void;
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
  setMode: (mode) =>
    set((s) =>
      s.mode === mode || (mode !== 'select' && locked())
        ? s
        : { mode, previousMode: ONE_SHOT_MODES.has(s.mode) ? s.previousMode : s.mode },
    ),
  showGroup: (group) =>
    set((s) => (s.barGroup === group ? s : { barGroup: group, lastGroup: group ?? s.lastGroup })),
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

/** Tests: the state of a fresh session. */
export function resetToolStore(): void {
  useToolStore.setState({
    mode: 'select',
    previousMode: 'select',
    barGroup: null,
    lastGroup: null,
  });
}
