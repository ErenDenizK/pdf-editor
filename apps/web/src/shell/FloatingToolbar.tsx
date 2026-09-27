/**
 * The floating tool bar: the one translucent surface (DESIGN.md §2–3). Roving tabindex:
 * one Tab stop, Left/Right/Home/End move between buttons (DESIGN.md §5).
 *
 * Tools are inert placeholders that only set `ui.tool`. Page actions run the page
 * commands on the selection and stay disabled (but focusable) while nothing is selected.
 */
import {
  FileOutput,
  Highlighter,
  MousePointer2,
  PenLine,
  RotateCw,
  Shapes,
  StickyNote,
  Trash2,
  Type,
} from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';

import { TOOLS } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { useCommands } from '../commands/use-commands';
import { m } from '../i18n';
import { useSelectionStore } from '../state/selection-store';
import { type ToolId, useUiStore } from '../state/ui-store';
import { IconButton } from '../ui/IconButton';
import styles from './FloatingToolbar.module.css';

const TOOL_ICONS: Record<ToolId, typeof Type> = {
  select: MousePointer2,
  highlight: Highlighter,
  ink: PenLine,
  text: Type,
  shapes: Shapes,
  note: StickyNote,
};

/** Page actions; `command: null` marks one that is not built yet. */
const PAGE_ACTIONS = [
  { key: 'rotate', label: m.action_rotate_pages, Icon: RotateCw, command: 'pages.rotateRight' },
  { key: 'delete', label: m.action_delete_pages, Icon: Trash2, command: 'pages.delete' },
  { key: 'extract', label: m.action_extract_pages, Icon: FileOutput, command: null },
] as const;

export function FloatingToolbar() {
  const tool = useUiStore((s) => s.tool);
  const setTool = useUiStore((s) => s.setTool);
  const commands = useCommands();
  const toolCommands = commands.filter((c) => c.id.startsWith('tool.'));
  // Re-render on selection changes so enablement follows it.
  const selectionSize = useSelectionStore((s) => s.selected.size);
  const focused = useSelectionStore((s) => s.focused);
  const viewMode = useUiStore((s) => s.viewMode);
  const hasTargets = selectionSize > 0 || (viewMode === 'arrange' && focused !== null);
  const ref = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    buttons[next]?.focus();
  };

  const tabIndexFor = (position: number) => (position === focusIndex ? 0 : -1);

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.toolbar_label()}
      aria-orientation="horizontal"
      className={styles.toolbar}
      onKeyDown={onKeyDown}
    >
      {toolCommands.map((command, position) => {
        const id = command.id.slice('tool.'.length) as ToolId;
        const Icon = TOOL_ICONS[id];
        return (
          <IconButton
            key={command.id}
            size="toolbar"
            tooltipSide="top"
            label={TOOLS.find((t) => t.id === id)?.title() ?? command.title}
            icon={<Icon />}
            shortcut={command.shortcuts[0]}
            aria-pressed={tool === id}
            tabIndex={tabIndexFor(position)}
            onClick={() => setTool(id)}
          />
        );
      })}
      <div role="separator" aria-orientation="vertical" className={styles.divider} />
      {PAGE_ACTIONS.map(({ key, label, Icon, command }, position) => {
        const registered = command === null ? undefined : commands.find((c) => c.id === command);
        const enabled = registered !== undefined && hasTargets;
        return (
          <IconButton
            key={key}
            size="toolbar"
            tooltipSide="top"
            label={label()}
            tooltip={
              command === null ? m.action_coming_soon_tooltip({ label: label() }) : undefined
            }
            icon={<Icon />}
            shortcut={registered?.shortcuts[0]}
            aria-disabled={enabled ? undefined : 'true'}
            aria-description={
              command === null
                ? m.action_coming_soon()
                : enabled
                  ? undefined
                  : m.action_select_pages_first()
            }
            tabIndex={tabIndexFor(toolCommands.length + position)}
            onClick={() => {
              if (enabled && command !== null) void commandRegistry.execute(command);
            }}
          />
        );
      })}
    </div>
  );
}
