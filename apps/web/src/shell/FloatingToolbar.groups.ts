/**
 * The Edit bar's group model (ADR-0019 §4, craft spec §3.4): five groups, what each holds,
 * and the rules that keep the bar in step with the armed tool.
 *
 * - Select is the idle tool: its chip in the row arms it and shows no tool row.
 * - Arming a tool (its button, its shortcut or the palette) shows the tool's group; a tool
 *   without one (the text markups, armed by U, S or the palette) shows the row.
 * - Picking Write arms the pen with its active preset (`pickBarGroup`).
 * - One-shot tools (stamp, signature image) return to the previous tool once their object
 *   is placed, and the placed object is not selected.
 *
 * Find, layout and fit live in the title bar and the palette; the page operations in
 * Arrange, the page context menu (stage/PageContextMenu.tsx) and the Document menu.
 *
 * The rules are store subscriptions, installed when this module is first imported (the
 * tool bar imports it), so they hold for shortcuts and the palette as well as the bar.
 */
import { EyeOff, FilePen, type LucideIcon, MousePointer2, PenLine, Type } from 'lucide-react';

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

/** The five groups, in bar order. */
export const BAR_GROUPS: readonly BarGroupDefinition[] = [
  { id: 'select', label: m.bar_group_select, Icon: MousePointer2 },
  { id: 'write', label: m.bar_group_write, Icon: PenLine },
  { id: 'text', label: m.bar_group_text, Icon: Type },
  { id: 'fill', label: m.bar_group_fill, Icon: FilePen },
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
  /** A command button (Sign with certificate…, Find sensitive data…, …). */
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'fields' }
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

/** What each group's bar holds (craft spec §3.4), in order. Select has no tool row. */
export function barItems(group: BarGroup): readonly BarItem[] {
  switch (group) {
    case 'select':
      return [];
    case 'write':
    case 'text':
      return toolItems(group);
    case 'fill':
      return [
        { kind: 'command', command: 'forms.highlight' },
        { kind: 'fields' },
        ...toolItems('fill'),
        { kind: 'command', command: 'document.sign' },
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
  // The Highlighter is the fourth pen preset (craft spec §5.4).
  'tool.highlighter': 'write',
  'forms.highlight': 'fill',
  'document.sign': 'fill',
  'stamp.image': 'fill',
  'redaction.find': 'redact',
  'redaction.markMatches': 'redact',
};

/** The group a tool lives in; none for the text markups. */
export function barGroupOfMode(mode: ToolMode): BarGroup | undefined {
  return ANNOTATION_TOOLS.find((t) => t.mode === mode)?.group;
}

/**
 * The tool bar group of a command, when the bar holds it: the tool commands of tools with a
 * group, the Highlighter, the built-in stamps, the form fields, and the bar's other commands.
 */
export function barGroupOfCommand(id: string): BarGroup | undefined {
  if (COMMAND_GROUPS[id] !== undefined) return COMMAND_GROUPS[id];
  if (id.startsWith('tool.')) {
    return ANNOTATION_TOOLS.find((t) => `tool.${t.mode}` === id)?.group;
  }
  if (id.startsWith('stamp.') || id.startsWith('forms.add.')) return 'fill';
  return undefined;
}

/** The group's name, for a command that the bar holds ("Write"); else undefined. */
export function barGroupLabelOfCommand(id: string): string | undefined {
  const group = barGroupOfCommand(id);
  return group === undefined ? undefined : barGroupDefinition(group).label();
}

/**
 * Picks a group (its button, or Enter on it) and says so ("Write tools", spec §10). Select
 * arms the idle tool and keeps the row ("Select tool"). Write arms the pen with its active
 * preset unless one of its tools is armed already, so the first stroke after picking it
 * draws (spec §6.2); Esc then disarms as for any tool.
 */
export function pickBarGroup(group: BarGroup): void {
  const tools = useToolStore.getState();
  if (group === 'select') {
    tools.showGroup(null);
    tools.setMode('select');
    announce(m.announce_tool({ tool: m.tool_select() }), { key: 'tool' });
    return;
  }
  tools.showGroup(group);
  if (group === 'write' && barGroupOfMode(tools.mode) !== 'write') {
    const annotations = useAnnotationStore.getState();
    annotations.armPreset(annotations.pen.active);
    useToolStore.getState().setMode('ink');
  }
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
  // Arming a tool shows its group; a tool without one (U, S, Squiggly) shows the row. Select
  // is the resting tool (V and Esc disarm), so it leaves the bar where it is.
  useToolStore.subscribe((state, previous) => {
    if (state.mode === previous.mode || state.mode === 'select') return;
    state.showGroup(barGroupOfMode(state.mode) ?? null);
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
