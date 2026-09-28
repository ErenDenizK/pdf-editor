/** The Read-mode tools (spec §2): names, shortcuts and icons, in tool bar order. */
import {
  ArrowUpRight,
  Circle,
  Eraser,
  EyeOff,
  Highlighter,
  type LucideIcon,
  Minus,
  MousePointer2,
  PenLine,
  Signature,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
  Waves,
} from 'lucide-react';

import { m } from '../i18n';
import type { ToolMode } from '../viewer/tool-store';

export interface ToolDefinition {
  readonly mode: ToolMode;
  readonly title: () => string;
  /** Tooltip when it must say more than the name. */
  readonly tooltip?: () => string;
  readonly shortcut?: string;
  readonly Icon: LucideIcon;
  /** Extra command palette keywords. */
  readonly keywords?: readonly string[];
  /** Tool bar group; shapes share one button with a menu. */
  readonly group: 'select' | 'markup' | 'draw' | 'shape' | 'insert';
}

export const ANNOTATION_TOOLS: readonly ToolDefinition[] = [
  { mode: 'select', title: m.tool_select, shortcut: 'V', Icon: MousePointer2, group: 'select' },
  // Edits the page's own text (redaction-and-text-editing spec §2.2), next to Select.
  {
    mode: 'edit-text',
    title: m.tool_edit_text,
    tooltip: m.tool_edit_text_tooltip,
    shortcut: 'E',
    Icon: TextCursorInput,
    group: 'select',
    keywords: ['edit', 'text', 'replace', 'change', 'typo', 'word', 'font'],
  },
  { mode: 'highlight', title: m.tool_highlight, shortcut: 'H', Icon: Highlighter, group: 'markup' },
  { mode: 'underline', title: m.tool_underline, shortcut: 'U', Icon: Underline, group: 'markup' },
  {
    mode: 'strikeout',
    title: m.tool_strikeout,
    shortcut: 'S',
    Icon: Strikethrough,
    group: 'markup',
  },
  { mode: 'squiggly', title: m.tool_squiggly, Icon: Waves, group: 'markup' },
  {
    mode: 'redact',
    title: m.tool_redact,
    tooltip: m.tool_redact_tooltip,
    shortcut: 'X',
    Icon: EyeOff,
    group: 'markup',
  },
  { mode: 'ink', title: m.tool_ink, shortcut: 'P', Icon: PenLine, group: 'draw' },
  // Shift+E: E is Edit text (spec §2.2).
  { mode: 'eraser', title: m.tool_eraser, shortcut: 'Shift+E', Icon: Eraser, group: 'draw' },
  { mode: 'rectangle', title: m.tool_rectangle, shortcut: 'R', Icon: Square, group: 'shape' },
  { mode: 'ellipse', title: m.tool_ellipse, shortcut: 'O', Icon: Circle, group: 'shape' },
  { mode: 'line', title: m.tool_line, shortcut: 'L', Icon: Minus, group: 'shape' },
  { mode: 'arrow', title: m.tool_arrow, shortcut: 'A', Icon: ArrowUpRight, group: 'shape' },
  { mode: 'text-box', title: m.tool_text_box, shortcut: 'T', Icon: Type, group: 'insert' },
  { mode: 'note', title: m.tool_note, shortcut: 'N', Icon: StickyNote, group: 'insert' },
  { mode: 'stamp', title: m.tool_stamp, shortcut: 'I', Icon: Stamp, group: 'insert' },
  {
    mode: 'signature',
    title: m.tool_signature,
    tooltip: m.tool_signature_tooltip,
    shortcut: 'G',
    Icon: Signature,
    group: 'insert',
  },
];

export function toolDefinition(mode: ToolMode): ToolDefinition {
  return ANNOTATION_TOOLS.find((t) => t.mode === mode) ?? (ANNOTATION_TOOLS[0] as ToolDefinition);
}

export const MARKUP_MODES = ['highlight', 'underline', 'strikeout', 'squiggly'] as const;
export type MarkupMode = (typeof MARKUP_MODES)[number];

export function isMarkupMode(mode: ToolMode): mode is MarkupMode {
  return (MARKUP_MODES as readonly string[]).includes(mode);
}
