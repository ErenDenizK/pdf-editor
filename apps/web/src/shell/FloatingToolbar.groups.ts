/**
 * The tool bar's group model (experience-redesign spec §5.1–§5.2): six task groups, what
 * each holds, and the rules that keep the bar in step with the armed tool.
 *
 * - Arming a tool (its button, its shortcut or the palette) shows the tool's group.
 * - One-shot tools (stamp, signature image) return to the previous tool once their object
 *   is placed, and the placed object is not selected.
 *
 * The rules are store subscriptions, installed when this module is first imported (the
 * tool bar imports it), so they hold for shortcuts and the palette as well as the bar.
 */
import {
  BookOpen,
  EyeOff,
  FilePen,
  Files,
  Highlighter,
  type LucideIcon,
  PenLine,
} from 'lucide-react';

import { pageKey, useAnnotationStore } from '../annotations/annotation-store';
import { ANNOTATION_TOOLS, type ToolDefinition, toolsOfGroup } from '../annotations/tools';
import { m } from '../i18n';
import { type BarGroup, ONE_SHOT_MODES, type ToolMode, useToolStore } from '../viewer/tool-store';
import { announce } from './announcer';

export interface BarGroupDefinition {
  readonly id: BarGroup;
  readonly label: () => string;
  readonly Icon: LucideIcon;
}

/** The six groups, in bar order. */
export const BAR_GROUPS: readonly BarGroupDefinition[] = [
  { id: 'read', label: m.bar_group_read, Icon: BookOpen },
  { id: 'markup', label: m.bar_group_markup, Icon: Highlighter },
  { id: 'draw', label: m.bar_group_draw, Icon: PenLine },
  { id: 'fill', label: m.bar_group_fill, Icon: FilePen },
  { id: 'pages', label: m.bar_group_pages, Icon: Files },
  { id: 'redact', label: m.bar_group_redact, Icon: EyeOff },
];

export function barGroupDefinition(group: BarGroup): BarGroupDefinition {
  return BAR_GROUPS.find((g) => g.id === group) ?? (BAR_GROUPS[0] as BarGroupDefinition);
}

/**
 * One entry of a group's bar, in order. Tools come from the tool table (annotations/tools.ts),
 * so a tool added there with a group joins that group's bar.
 */
export type BarItem =
  | { readonly kind: 'tool'; readonly tool: ToolDefinition }
  /** The pen: one button, or the presets a plug-in provides (FloatingToolbar.slots.ts). */
  | { readonly kind: 'pen'; readonly tool: ToolDefinition }
  /** The shapes: one button with a menu. */
  | { readonly kind: 'shapes'; readonly tools: readonly ToolDefinition[] }
  /** Stamp: one button with a menu (an image or a built-in stamp). */
  | { readonly kind: 'stamp'; readonly tool: ToolDefinition }
  /** A command button (Find, Crop…, Sign with certificate…, …). */
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'layout' }
  | { readonly kind: 'fit' }
  | { readonly kind: 'fields' }
  /** Rotate and Delete page: the selected pages, else the current page. */
  | { readonly kind: 'page'; readonly action: 'rotate' | 'delete' }
  | { readonly kind: 'apply-redactions' };

/** The tools of a group as bar items: shapes share one button, pen and stamp have theirs. */
function toolItems(group: BarGroup): BarItem[] {
  const items: BarItem[] = [];
  const shapes = toolsOfGroup(group).filter((t) => t.shape);
  for (const tool of toolsOfGroup(group)) {
    if (tool.shape) {
      if (tool === shapes[0]) items.push({ kind: 'shapes', tools: shapes });
    } else if (tool.mode === 'ink') {
      items.push({ kind: 'pen', tool });
    } else if (tool.mode === 'stamp') {
      items.push({ kind: 'stamp', tool });
    } else {
      items.push({ kind: 'tool', tool });
    }
  }
  return items;
}

/** What each group's bar holds (spec §5.1), in order. */
export function barItems(group: BarGroup): readonly BarItem[] {
  switch (group) {
    case 'read':
      return [
        ...toolItems('read'),
        { kind: 'command', command: 'search.open' },
        { kind: 'layout' },
        { kind: 'fit' },
      ];
    case 'markup':
    case 'draw':
      return toolItems(group);
    case 'fill':
      return [
        { kind: 'command', command: 'forms.highlight' },
        { kind: 'fields' },
        ...toolItems('fill'),
        { kind: 'command', command: 'document.sign' },
      ];
    case 'pages':
      return [
        ...toolItems('pages'),
        { kind: 'command', command: 'pages.crop' },
        { kind: 'page', action: 'rotate' },
        { kind: 'page', action: 'delete' },
        { kind: 'command', command: 'mode.arrange' },
      ];
    case 'redact':
      return [
        ...toolItems('redact'),
        { kind: 'command', command: 'redaction.find' },
        { kind: 'command', command: 'redaction.markMatches' },
        { kind: 'apply-redactions' },
      ];
  }
}

/** Commands behind bar items other than tools, by group (for the overlay and palette). */
const COMMAND_GROUPS: Readonly<Record<string, BarGroup>> = {
  'search.open': 'read',
  'zoom.fit': 'read',
  'zoom.fitPage': 'read',
  'zoom.actual': 'read',
  'layout.continuous': 'read',
  'layout.single': 'read',
  'layout.two-up': 'read',
  'forms.highlight': 'fill',
  'document.sign': 'fill',
  'stamp.image': 'fill',
  'pages.crop': 'pages',
  'pages.rotateRight': 'pages',
  'pages.rotateLeft': 'pages',
  'pages.delete': 'pages',
  'mode.arrange': 'pages',
  'redaction.find': 'redact',
  'redaction.markMatches': 'redact',
};

/** The group a tool lives in. */
export function barGroupOfMode(mode: ToolMode): BarGroup {
  return ANNOTATION_TOOLS.find((t) => t.mode === mode)?.group ?? 'read';
}

/**
 * The tool bar group of a command, when the bar holds it: every tool command (`tool.*`),
 * the built-in stamps, the form fields, and the bar's other commands.
 */
export function barGroupOfCommand(id: string): BarGroup | undefined {
  if (id.startsWith('tool.')) {
    return ANNOTATION_TOOLS.find((t) => `tool.${t.mode}` === id)?.group;
  }
  if (id.startsWith('stamp.') || id.startsWith('forms.add.')) return 'fill';
  return COMMAND_GROUPS[id];
}

/** The group's name, for a command that the bar holds ("Draw"); else undefined. */
export function barGroupLabelOfCommand(id: string): string | undefined {
  const group = barGroupOfCommand(id);
  return group === undefined ? undefined : barGroupDefinition(group).label();
}

/** Picks a group (its button, or Enter on it) and says so ("Draw tools", spec §10). */
export function pickBarGroup(group: BarGroup): void {
  useToolStore.getState().showGroup(group);
  announce(m.bar_group_tools({ group: barGroupDefinition(group).label() }));
}

/** Back to the row of groups (the chip, or Esc on the bar with nothing armed). */
export function showBarGroups(): void {
  useToolStore.getState().showGroup(null);
}

/** Whether the placed selection is new: none of its ids is in the page cache yet. */
function isPlacement(): boolean {
  const { selection, pages } = useAnnotationStore.getState();
  if (!selection) return false;
  const known = pages[pageKey(selection.source, selection.pageIndex)]?.annotations ?? [];
  return selection.ids.every((id) => !known.some((a) => a.id === id));
}

let installed = false;

/** Installs the bar's rules once (spec §5.2). */
export function installBarGroupRules(): void {
  if (installed) return;
  installed = true;
  // Arming a tool shows its group. Select is the resting tool (V and Esc disarm), so it
  // leaves the bar where it is.
  useToolStore.subscribe((state, previous) => {
    if (state.mode === previous.mode || state.mode === 'select') return;
    state.showGroup(barGroupOfMode(state.mode));
  });
  // A one-shot tool placed its object (the layer selects what it places): nothing stays
  // selected and the previous tool comes back. A selection of existing annotations (a Review
  // row, Tab) is not a placement and is kept.
  useAnnotationStore.subscribe((state, previous) => {
    if (state.selection === null || state.selection === previous.selection) return;
    if (!ONE_SHOT_MODES.has(useToolStore.getState().mode) || !isPlacement()) return;
    state.select(null);
    useToolStore.getState().finishOneShot();
  });
}

installBarGroupRules();
