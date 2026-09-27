/**
 * The floating tool bar: the one translucent surface (DESIGN.md §2–3). Roving tabindex:
 * one Tab stop, Left/Right/Home/End move between buttons (DESIGN.md §5).
 *
 * Tools are inert placeholders that only set `ui.tool`. Page actions stay disabled until
 * the document model provides a selection.
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

import { parseShortcut } from '../commands/shortcuts';
import { useCommands } from '../commands/use-commands';
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

// TODO(document-model): register these as commands once page selection exists.
const PAGE_ACTIONS = [
  { key: 'rotate', label: 'Rotate pages', Icon: RotateCw, shortcut: parseShortcut('R') },
  { key: 'delete', label: 'Delete pages', Icon: Trash2, shortcut: parseShortcut('Delete') },
  { key: 'extract', label: 'Extract pages', Icon: FileOutput, shortcut: parseShortcut('E') },
] as const;

export function FloatingToolbar() {
  const tool = useUiStore((s) => s.tool);
  const setTool = useUiStore((s) => s.setTool);
  const commands = useCommands();
  const toolCommands = commands.filter((c) => c.id.startsWith('tool.'));
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
      aria-label="Tools"
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
            label={command.title.replace(/ tool$/, '')}
            icon={<Icon />}
            shortcut={command.shortcuts[0]}
            aria-pressed={tool === id}
            tabIndex={tabIndexFor(position)}
            onClick={() => setTool(id)}
          />
        );
      })}
      <div role="separator" aria-orientation="vertical" className={styles.divider} />
      {PAGE_ACTIONS.map(({ key, label, Icon, shortcut }, position) => (
        <IconButton
          key={key}
          size="toolbar"
          tooltipSide="top"
          label={label}
          icon={<Icon />}
          shortcut={shortcut}
          aria-disabled="true"
          aria-description="Select pages first"
          tabIndex={tabIndexFor(toolCommands.length + position)}
        />
      ))}
    </div>
  );
}
