/**
 * The active Read-mode tool. Minimal API shared by the viewer (text selection) and the
 * annotation tools (spec §2): `mode` and `setMode`. Tools are sticky until Esc, which
 * returns to `select`.
 */
import { create } from 'zustand';

export type ToolMode =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'ink'
  | 'eraser'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text-box'
  | 'note'
  | 'stamp'
  | 'signature';

interface ToolState {
  readonly mode: ToolMode;
  setMode: (mode: ToolMode) => void;
}

export const useToolStore = create<ToolState>()((set) => ({
  mode: 'select',
  setMode: (mode) => set((s) => (s.mode === mode ? s : { mode })),
}));
