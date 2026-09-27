/**
 * The floating tool bar: the one translucent surface (DESIGN.md §2–3). Roving tabindex:
 * one Tab stop, Left/Right/Home/End move between buttons (DESIGN.md §5).
 *
 * Read mode shows the annotation tools (spec §2): Select, text markup, ink and eraser,
 * shapes (one button with a menu), text box, note, stamp (menu: image or a built-in
 * stamp) and signature. Page actions follow in both modes; they run the page commands on
 * the selection and stay disabled (but focusable) while nothing is selected.
 */
import { Menu } from '@base-ui/react/menu';
import { ChevronUp, FileOutput, ImagePlus, RotateCw, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';

import {
  activateTool,
  ANNOTATION_TOOLS,
  pickImageStamp,
  type ToolDefinition,
} from '../annotations';
import { useAnnotationStore } from '../annotations/annotation-store';
import { SignatureDialog } from '../annotations/SignatureDialog';
import { BUILTIN_STAMPS, builtinPendingStamp } from '../annotations/stamps';
import { commandRegistry } from '../commands/registry';
import { useCommands } from '../commands/use-commands';
import { m } from '../i18n';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { IconButton } from '../ui/IconButton';
import iconButtonStyles from '../ui/IconButton.module.css';
import menuStyles from '../ui/Menu.module.css';
import { Tooltip } from '../ui/Tooltip';
import { useToolStore } from '../viewer/tool-store';
import styles from './FloatingToolbar.module.css';

/** Page actions; `command: null` marks one that is not built yet. */
const PAGE_ACTIONS = [
  { key: 'rotate', label: m.action_rotate_pages, Icon: RotateCw, command: 'pages.rotateRight' },
  { key: 'delete', label: m.action_delete_pages, Icon: Trash2, command: 'pages.delete' },
  { key: 'extract', label: m.action_extract_pages, Icon: FileOutput, command: null },
] as const;

const SHAPES = ANNOTATION_TOOLS.filter((t) => t.group === 'shape');

export function FloatingToolbar() {
  const mode = useToolStore((s) => s.mode);
  const commands = useCommands();
  // Re-render on selection changes so enablement follows it.
  const selectionSize = useSelectionStore((s) => s.selected.size);
  const focused = useSelectionStore((s) => s.focused);
  const viewMode = useUiStore((s) => s.viewMode);
  const hasTargets = selectionSize > 0 || (viewMode === 'arrange' && focused !== null);
  const ref = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [lastShape, setLastShape] = useState<ToolDefinition>(SHAPES[0] as ToolDefinition);
  const shownShape = SHAPES.find((t) => t.mode === mode) ?? lastShape;
  const reading = viewMode === 'read';

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

  // Roving tabindex over the buttons in DOM order.
  const order: string[] = [];
  if (reading) {
    for (const t of ANNOTATION_TOOLS) {
      if (t.group === 'shape') {
        if (!order.includes('shapes')) order.push('shapes');
      } else {
        order.push(t.mode);
      }
    }
  }
  for (const action of PAGE_ACTIONS) order.push(action.key);
  const tabFor = (key: string) => (order.indexOf(key) === focusIndex ? 0 : -1);
  const shortcutOf = (tool: ToolDefinition) =>
    commands.find((c) => c.id === `tool.${tool.mode}`)?.shortcuts[0];

  const toolButton = (tool: ToolDefinition) => (
    <IconButton
      key={tool.mode}
      size="toolbar"
      tooltipSide="top"
      label={tool.title()}
      tooltip={tool.tooltip?.()}
      icon={<tool.Icon />}
      shortcut={shortcutOf(tool)}
      aria-pressed={mode === tool.mode}
      data-tool={tool.mode}
      tabIndex={tabFor(tool.mode)}
      onClick={() => void activateTool(tool)}
    />
  );

  const tools = reading ? (
    <>
      {ANNOTATION_TOOLS.filter((t) => t.group === 'select' || t.group === 'markup').map(toolButton)}
      <div role="separator" aria-orientation="vertical" className={styles.divider} />
      {ANNOTATION_TOOLS.filter((t) => t.group === 'draw').map(toolButton)}
      <Menu.Root>
        <Tooltip label={m.tool_shapes_menu({ shape: shownShape.title() })} side="top">
          <Menu.Trigger
            className={`${iconButtonStyles.button} ${styles.menuTrigger}`}
            data-size="toolbar"
            aria-label={m.tool_shapes_menu({ shape: shownShape.title() })}
            aria-pressed={SHAPES.some((t) => t.mode === mode)}
            data-tool="shapes"
            tabIndex={tabFor('shapes')}
          >
            <shownShape.Icon />
            <ChevronUp className={styles.chevron} aria-hidden="true" />
          </Menu.Trigger>
        </Tooltip>
        <Menu.Portal>
          <Menu.Positioner side="top" align="center" sideOffset={8} collisionPadding={8}>
            <Menu.Popup className={menuStyles.popup}>
              {SHAPES.map((tool) => (
                <Menu.Item
                  key={tool.mode}
                  className={menuStyles.item}
                  data-tool={tool.mode}
                  onClick={() => {
                    setLastShape(tool);
                    void activateTool(tool);
                  }}
                >
                  <tool.Icon aria-hidden="true" className={styles.menuIcon} />
                  <span className={menuStyles.label}>{tool.title()}</span>
                  {tool.shortcut ? <kbd className={styles.menuKey}>{tool.shortcut}</kbd> : null}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <div role="separator" aria-orientation="vertical" className={styles.divider} />
      {ANNOTATION_TOOLS.filter(
        (t) => t.group === 'insert' && t.mode !== 'stamp' && t.mode !== 'signature',
      ).map(toolButton)}
      <StampMenu active={mode === 'stamp'} tabIndex={tabFor('stamp')} />
      {ANNOTATION_TOOLS.filter((t) => t.mode === 'signature').map(toolButton)}
      <div role="separator" aria-orientation="vertical" className={styles.divider} />
    </>
  ) : null;

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.toolbar_label()}
      aria-orientation="horizontal"
      className={styles.toolbar}
      data-annotation-keep=""
      onKeyDown={onKeyDown}
    >
      {tools}
      {PAGE_ACTIONS.map(({ key, label, Icon, command }) => {
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
            tabIndex={tabFor(key)}
            onClick={() => {
              if (enabled && command !== null) void commandRegistry.execute(command);
            }}
          />
        );
      })}
      <SignatureDialog />
    </div>
  );
}

function StampMenu({ active, tabIndex }: { readonly active: boolean; readonly tabIndex: number }) {
  const stamp = ANNOTATION_TOOLS.find((t) => t.mode === 'stamp') as ToolDefinition;
  const pending = useAnnotationStore((s) => s.pendingStamp);
  const arm = (name: (typeof BUILTIN_STAMPS)[number]['name']) => {
    useAnnotationStore.getState().setPendingStamp(builtinPendingStamp(name));
    useAnnotationStore.getState().select(null);
    useToolStore.getState().setMode('stamp');
  };
  return (
    <Menu.Root>
      <Tooltip label={stamp.title()} side="top">
        <Menu.Trigger
          className={`${iconButtonStyles.button} ${styles.menuTrigger}`}
          data-size="toolbar"
          aria-label={stamp.title()}
          aria-pressed={active}
          data-tool="stamp"
          tabIndex={tabIndex}
        >
          <stamp.Icon />
          <ChevronUp className={styles.chevron} aria-hidden="true" />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="top" align="center" sideOffset={8} collisionPadding={8}>
          <Menu.Popup className={menuStyles.popup}>
            <Menu.Item className={menuStyles.item} onClick={() => void pickImageStamp('image')}>
              <ImagePlus aria-hidden="true" className={styles.menuIcon} />
              <span className={menuStyles.label}>{m.stamp_image()}</span>
            </Menu.Item>
            {BUILTIN_STAMPS.map((s) => (
              <Menu.Item
                key={s.name}
                className={menuStyles.item}
                data-checked={
                  active && pending?.kind === 'builtin' && pending.name === s.name ? '' : undefined
                }
                onClick={() => arm(s.name)}
              >
                <span className={styles.stampChip} style={{ color: s.color }}>
                  {s.label()}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
