/**
 * The Read-mode tools (spec §2): names, shortcuts, icons and tool bar groups, in tool bar
 * order (experience-redesign spec §5.1).
 */
import {
  ArrowUpRight,
  Circle,
  Eraser,
  EyeOff,
  Highlighter,
  Image,
  LassoSelect,
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
import type { BarGroup, ToolMode } from '../viewer/tool-store';

export interface ToolDefinition {
  readonly mode: ToolMode;
  readonly title: () => string;
  /** Tooltip when it must say more than the name. */
  readonly tooltip?: () => string;
  /** Name on the tool bar when it differs from the tool's name ("Mark" in Redact). */
  readonly barTitle?: () => string;
  readonly shortcut?: string;
  readonly Icon: LucideIcon;
  /** Extra command palette keywords. */
  readonly keywords?: readonly string[];
  /**
   * The tool bar group that holds the tool (experience-redesign spec §5.1): every tool has
   * one home, shown in the bar, the shortcut overlay and the palette.
   */
  readonly group: BarGroup;
  /** Shapes share one button with a menu in their group. */
  readonly shape?: true;
}

/** Tool bar order within each group (spec §5.1); `select` stays first (the fallback). */
export const ANNOTATION_TOOLS: readonly ToolDefinition[] = [
  // Read
  { mode: 'select', title: m.tool_select, shortcut: 'V', Icon: MousePointer2, group: 'read' },
  // Mark up
  // H arms the Highlighter preset instead (craft spec §5.4, `tool.highlighter`).
  { mode: 'highlight', title: m.tool_highlight, Icon: Highlighter, group: 'markup' },
  { mode: 'underline', title: m.tool_underline, shortcut: 'U', Icon: Underline, group: 'markup' },
  {
    mode: 'strikeout',
    title: m.tool_strikeout,
    shortcut: 'S',
    Icon: Strikethrough,
    group: 'markup',
  },
  { mode: 'squiggly', title: m.tool_squiggly, Icon: Waves, group: 'markup' },
  { mode: 'note', title: m.tool_note, shortcut: 'N', Icon: StickyNote, group: 'markup' },
  { mode: 'text-box', title: m.tool_text_box, shortcut: 'T', Icon: Type, group: 'markup' },
  // Draw: the pen (its presets plug in, FloatingToolbar.slots.ts), eraser, lasso, shapes.
  { mode: 'ink', title: m.tool_ink, shortcut: 'P', Icon: PenLine, group: 'draw' },
  // Shift+E: E is Edit text (spec §2.2).
  { mode: 'eraser', title: m.tool_eraser, shortcut: 'Shift+E', Icon: Eraser, group: 'draw' },
  // The lasso selects pen strokes to recolour, resize, move or delete (spec §6.5).
  {
    mode: 'lasso',
    title: m.lasso_tool,
    tooltip: m.lasso_tool_tooltip,
    shortcut: 'Q',
    Icon: LassoSelect,
    group: 'draw',
    keywords: ['lasso', 'select', 'strokes'],
  },
  {
    mode: 'rectangle',
    title: m.tool_rectangle,
    shortcut: 'R',
    Icon: Square,
    group: 'draw',
    shape: true,
  },
  {
    mode: 'ellipse',
    title: m.tool_ellipse,
    shortcut: 'O',
    Icon: Circle,
    group: 'draw',
    shape: true,
  },
  { mode: 'line', title: m.tool_line, shortcut: 'L', Icon: Minus, group: 'draw', shape: true },
  {
    mode: 'arrow',
    title: m.tool_arrow,
    shortcut: 'A',
    Icon: ArrowUpRight,
    group: 'draw',
    shape: true,
  },
  // Fill & sign: one-shot tools (spec §5.2).
  {
    mode: 'signature',
    title: m.tool_signature,
    tooltip: m.tool_signature_tooltip,
    shortcut: 'G',
    Icon: Signature,
    group: 'fill',
  },
  // Shift+I: I is the Image tool (M4 §3).
  { mode: 'stamp', title: m.tool_stamp, shortcut: 'Shift+I', Icon: Stamp, group: 'fill' },
  // Pages: tools that change the page itself (spec §13 decision 5).
  {
    mode: 'edit-text',
    title: m.tool_edit_text,
    tooltip: m.tool_edit_text_tooltip,
    shortcut: 'E',
    Icon: TextCursorInput,
    group: 'pages',
    keywords: ['edit', 'text', 'replace', 'change', 'typo', 'word', 'font'],
  },
  {
    mode: 'image',
    title: m.tool_image,
    tooltip: m.tool_image_tooltip,
    shortcut: 'I',
    Icon: Image,
    group: 'pages',
    keywords: ['image', 'picture', 'photo', 'move', 'resize', 'replace', 'extract', 'logo'],
  },
  // Redact
  {
    mode: 'redact',
    title: m.tool_redact,
    tooltip: m.tool_redact_tooltip,
    barTitle: m.bar_redact_mark,
    shortcut: 'X',
    Icon: EyeOff,
    group: 'redact',
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

/** The tools of a tool bar group, in bar order. */
export function toolsOfGroup(group: BarGroup): readonly ToolDefinition[] {
  return ANNOTATION_TOOLS.filter((t) => t.group === group);
}
