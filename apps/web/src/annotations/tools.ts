/**
 * The page tools (spec §2): names, shortcuts, icons and Edit bar groups, in bar order (ADR-0019
 * §4, craft spec §3.4). The text markups (Highlight, Underline, Strikeout, Squiggly) have no
 * place in the bar: they are offered by the contextual bar of a text selection and keep their
 * shortcuts and palette entries.
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
   * The Edit bar group that holds the tool (craft spec §3.4): its one home, shown in the bar,
   * the shortcut overlay and the palette. None for the text markups, which the selection's
   * contextual bar offers instead.
   */
  readonly group?: BarGroup;
  /** Shapes share one button with a menu in their group. */
  readonly shape?: true;
}

/** Bar order within each group (craft spec §3.4); `select` stays first (the fallback). */
export const ANNOTATION_TOOLS: readonly ToolDefinition[] = [
  // Select: the idle tool, the first chip of the group row.
  { mode: 'select', title: m.tool_select, shortcut: 'V', Icon: MousePointer2, group: 'select' },
  // Write: the pen (its presets and the Highlighter plug in, FloatingToolbar.slots.ts),
  // eraser, lasso, shapes.
  { mode: 'ink', title: m.tool_ink, shortcut: 'P', Icon: PenLine, group: 'write' },
  // Shift+E: E is Edit text (spec §2.2).
  { mode: 'eraser', title: m.tool_eraser, shortcut: 'Shift+E', Icon: Eraser, group: 'write' },
  // The lasso selects pen strokes to recolour, resize, move or delete (spec §6.5).
  {
    mode: 'lasso',
    title: m.lasso_tool,
    tooltip: m.lasso_tool_tooltip,
    shortcut: 'Q',
    Icon: LassoSelect,
    group: 'write',
    keywords: ['lasso', 'select', 'strokes'],
  },
  {
    mode: 'rectangle',
    title: m.tool_rectangle,
    shortcut: 'R',
    Icon: Square,
    group: 'write',
    shape: true,
  },
  {
    mode: 'ellipse',
    title: m.tool_ellipse,
    shortcut: 'O',
    Icon: Circle,
    group: 'write',
    shape: true,
  },
  { mode: 'line', title: m.tool_line, shortcut: 'L', Icon: Minus, group: 'write', shape: true },
  {
    mode: 'arrow',
    title: m.tool_arrow,
    shortcut: 'A',
    Icon: ArrowUpRight,
    group: 'write',
    shape: true,
  },
  // Text: the page's text, and the objects that carry text or replace it.
  {
    mode: 'edit-text',
    title: m.tool_edit_text,
    tooltip: m.tool_edit_text_tooltip,
    shortcut: 'E',
    Icon: TextCursorInput,
    group: 'text',
    keywords: ['edit', 'text', 'replace', 'change', 'typo', 'word', 'font'],
  },
  { mode: 'text-box', title: m.tool_text_box, shortcut: 'T', Icon: Type, group: 'text' },
  { mode: 'note', title: m.tool_note, shortcut: 'N', Icon: StickyNote, group: 'text' },
  {
    mode: 'image',
    title: m.tool_image,
    tooltip: m.tool_image_tooltip,
    shortcut: 'I',
    Icon: Image,
    group: 'text',
    keywords: ['image', 'picture', 'photo', 'move', 'resize', 'replace', 'extract', 'logo'],
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
  // Text markups: no bar entry (the selection's contextual bar offers them); keys and the
  // palette arm them. H arms the Highlighter preset instead (craft spec §5.4,
  // `tool.highlighter`), so the Highlight tool has no key.
  { mode: 'highlight', title: m.tool_highlight, Icon: Highlighter },
  { mode: 'underline', title: m.tool_underline, shortcut: 'U', Icon: Underline },
  { mode: 'strikeout', title: m.tool_strikeout, shortcut: 'S', Icon: Strikethrough },
  { mode: 'squiggly', title: m.tool_squiggly, Icon: Waves },
];

export function toolDefinition(mode: ToolMode): ToolDefinition {
  return ANNOTATION_TOOLS.find((t) => t.mode === mode) ?? (ANNOTATION_TOOLS[0] as ToolDefinition);
}

export const MARKUP_MODES = ['highlight', 'underline', 'strikeout', 'squiggly'] as const;
export type MarkupMode = (typeof MARKUP_MODES)[number];

export function isMarkupMode(mode: ToolMode): mode is MarkupMode {
  return (MARKUP_MODES as readonly string[]).includes(mode);
}

/** The tools of an Edit bar group, in bar order. */
export function toolsOfGroup(group: BarGroup): readonly ToolDefinition[] {
  return ANNOTATION_TOOLS.filter((t) => t.group === group);
}
