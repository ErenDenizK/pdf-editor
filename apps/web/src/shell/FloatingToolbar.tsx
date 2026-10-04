/**
 * The floating tool bar (experience-redesign spec §5, craft spec §3.4): a glass capsule over
 * the document.
 *
 * In Edit it shows five labelled groups: Select, Write, Text, Fill & sign and Redact
 * (FloatingToolbar.groups.ts). Select is the idle tool: its chip arms it and the row stays.
 * Picking another group morphs the capsule in place: the group's button becomes a chip with
 * a chevron at the left end and the group's tools slide in beside it (one 160 ms movement,
 * none under reduced motion); the chip returns to the row. The bar keeps its height, anchor
 * and glass; arming a tool by its shortcut or the palette shows its group.
 *
 * While a tool with a style is armed, its options sit in a second tier attached to the top
 * of the bar: the controls of the inspector's tool style, through `applyStyle` (a selection
 * wins, else the tool). The tier opens only on request, when the armed tool is pressed again
 * (its button or its key), never on arming (`optionsOpen`, review finding 5). The pen plugs
 * its presets in through FloatingToolbar.slots.ts.
 *
 * While a stroke is in progress on a page, and for a second after, the bar and the tier fade
 * to 20 % and take no pointer (FloatingToolbar.stroke.ts), so writing near the bottom of the
 * view never lands on a preset; under reduced motion the change is instant.
 *
 * Both are toolbars with a roving tabindex. The Esc ladder (craft spec §3.5): the first Esc
 * disarms the tool to Select and clears the selection (the global Escape command, or the bar
 * itself when it has the focus); the next returns the bar to the row. The armed tool's
 * tooltip says so ("Esc: Select").
 * Arrange shows only its own selection bar, so this bar is Read-only.
 *
 * A document in Read (ADR-0019 §3) shows the same capsule with one Edit button (`2`):
 * nothing can be armed from it; pressing it enters Edit and shows the row of groups.
 *
 * The page context menu (stage/PageContextMenu.tsx) mounts with the bar: both belong to the
 * page view.
 */
import { Menu } from '@base-ui/react/menu';
import type { CreatedFieldKind } from '@pdf-editor/document-model';
import {
  BadgeCheck,
  ChevronLeft,
  ChevronUp,
  ImagePlus,
  type LucideIcon,
  Pencil,
  RectangleEllipsis,
  ScanSearch,
  ShieldCheck,
  SquarePlus,
  TextSearch,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  activateTool,
  clearAnnotationTools,
  hasAnnotationToolState,
  pickImageStamp,
  type ToolDefinition,
} from '../annotations';
import { useAnnotationStore } from '../annotations/annotation-store';
import { toolStyleGroup } from '../annotations/drafts';
import { SignatureDialog } from '../annotations/SignatureDialog';
import { BUILTIN_STAMPS, builtinPendingStamp } from '../annotations/stamps';
import { StyleControls } from '../annotations/StyleControls';
import { toolDefinition } from '../annotations/tools';
import { commandRegistry } from '../commands/registry';
import { isEditableTarget } from '../commands/use-shortcuts';
import { useCommands } from '../commands/use-commands';
import { FIELD_KINDS, kindName } from '../forms/create';
import { useFormStore } from '../forms/form-store';
import { m } from '../i18n';
import { useApplyDialogStore } from '../redaction/apply-store';
import { showRedactionsPanel } from '../redaction/commands';
import { PageContextMenu } from '../stage/PageContextMenu';
import { canEditActive, useCanEdit, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import iconButtonStyles from '../ui/IconButton.module.css';
import menuStyles from '../ui/Menu.module.css';
import { Tooltip } from '../ui/Tooltip';
import { useFocusRescue } from '../ui/use-focus-rescue';
import { showDocumentMode } from '../home/home-actions';
import { useSearchStore } from '../viewer/search';
import { type BarGroup, type ToolMode, useToolStore } from '../viewer/tool-store';
import {
  BAR_GROUPS,
  type BarGroupDefinition,
  type BarItem,
  barGroupDefinition,
  barItems,
  pickBarGroup,
  showBarGroups,
} from './FloatingToolbar.groups';
import styles from './FloatingToolbar.module.css';
import { useRovingTabindex } from './FloatingToolbar.roving';
import { usePenSlots } from './FloatingToolbar.slots';
import { useStrokeInProgress } from './FloatingToolbar.stroke';

/** The morph (spec §5.2): one movement. */
const MORPH_MS = 160;
const MORPH_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function FloatingToolbar() {
  const viewMode = useUiStore((s) => s.viewMode);
  const editable = useCanEdit();
  return (
    <>
      {viewMode === 'read' ? editable ? <Dock /> : <ReadDock /> : null}
      {viewMode === 'read' ? <PageContextMenu /> : null}
      <SignatureDialog />
    </>
  );
}

/** Set by the Read bar's Edit button: the bar that replaces it takes the focus. */
let focusBarOnMount = false;

/** Read (ADR-0019 §3, spec §3.2): the capsule holds one Edit button, the way into Edit. */
function ReadDock() {
  return (
    <div className={styles.dock}>
      <div
        role="toolbar"
        aria-label={m.toolbar_label()}
        aria-orientation="horizontal"
        className={styles.toolbar}
        data-annotation-keep=""
        data-region="toolbar"
        data-bar-view="read"
      >
        <Tooltip label={m.cmd_mode_edit()} shortcut={shortcutOf('mode.edit')} side="top">
          <button
            type="button"
            className={`${styles.group} ${styles.readEdit}`}
            data-read-edit=""
            aria-keyshortcuts="2"
            onClick={(event) => {
              focusBarOnMount = event.currentTarget.contains(document.activeElement);
              showBarGroups();
              showDocumentMode('edit');
            }}
          >
            <Pencil aria-hidden="true" className={styles.groupIcon} />
            <span className={styles.groupLabel}>{m.mode_edit_button()}</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function Dock() {
  // Faded and out of the pointer's way while a stroke is in progress (module header).
  const stroking = useStrokeInProgress();
  return (
    // The bar first, so Tab goes from the bar to its options (spec §10); the dock stacks
    // them bottom-up, so the tier still sits on top of the bar.
    <div className={styles.dock} data-stroking={stroking ? '' : undefined}>
      <Bar />
      <OptionsTier />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

function Bar() {
  const group = useToolStore((s) => s.barGroup);
  const lastGroup = useToolStore((s) => s.lastGroup);
  // Re-render when commands register or their availability may change.
  useCommands();
  const ref = useRef<HTMLDivElement>(null);
  const roving = useRovingTabindex(
    ref,
    group === null
      ? `[data-bar-group="${lastGroup ?? 'select'}"]`
      : // The armed tool (or pen preset); else the first control, the group's chip.
        '[data-tool][aria-pressed="true"], [data-pen-preset][data-armed]',
  );
  const refocus = useRef<BarGroup | null>(null);
  useBarMorph(ref, group);

  // Entered from the Read bar's Edit button: the focus moves on to the row of groups.
  useLayoutEffect(() => {
    if (!focusBarOnMount) return;
    focusBarOnMount = false;
    ref.current?.querySelector<HTMLElement>('[tabindex="0"], [data-bar-group]')?.focus();
  }, []);

  // Esc back to the row: the focus stays on that group's button.
  useLayoutEffect(() => {
    const target = refocus.current;
    if (target === null || group !== null) return;
    refocus.current = null;
    ref.current?.querySelector<HTMLElement>(`[data-bar-group="${target}"]`)?.focus();
  }, [group]);

  // Esc on the bar (spec §5.2): disarm the tool and clear the selection, as the global Escape
  // does; with nothing armed, back to the row. In the capture phase, so the focused button's
  // tooltip (which claims Esc) cannot take it; keys from the bar's menus (portals) are theirs.
  // The ladder's second step from anywhere (craft spec §3.5): with nothing armed or selected
  // (the global Escape disarmed it), Esc returns the bar to the row. In the bubble phase on
  // the document, so a widget that takes Esc (an editor, a menu, the lasso, a dialog) claims
  // it first, and before the window's shortcut listener, which disarms on the first Esc.
  useEffect(() => {
    if (group === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (isEditableTarget(target)) return;
      if (target instanceof Element && target.closest('[aria-modal="true"]')) return;
      if (target instanceof Node && ref.current?.contains(target)) return;
      if (hasAnnotationToolState() || !canEditActive()) return;
      showBarGroups();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [group]);

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) return;
    if (hasAnnotationToolState()) {
      event.preventDefault();
      clearAnnotationTools();
    } else if (group !== null) {
      event.preventDefault();
      refocus.current = group;
      showBarGroups();
    }
  };

  const children: ReactElement[] =
    group === null
      ? BAR_GROUPS.map((g) => <GroupButton key={`group:${g.id}`} group={g} chip={false} />)
      : [
          <GroupButton key={`group:${group}`} group={barGroupDefinition(group)} chip />,
          <div
            key="divider"
            role="separator"
            aria-orientation="vertical"
            className={styles.divider}
          />,
          ...barItems(group).map((item, index) => (
            <BarItemView key={itemKey(item, index)} item={item} />
          )),
        ];

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.toolbar_label()}
      aria-orientation="horizontal"
      className={styles.toolbar}
      data-annotation-keep=""
      data-region="toolbar"
      data-bar-view={group ?? 'groups'}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {children}
    </div>
  );
}

function itemKey(item: BarItem, index: number): string {
  switch (item.kind) {
    case 'tool':
    case 'pen':
    case 'stamp':
      return item.tool.mode;
    case 'command':
      return item.command;
    default:
      return `${item.kind}:${index}`;
  }
}

/**
 * The morph (spec §5.2, §7.5): the picked group's button and the chip are one element, so it
 * keeps the focus; it slides between its place in the row and the left end while the other
 * items fade in beside it and the capsule's width follows. Layout is measured after every
 * render, so the movement starts from where things were drawn last.
 */
function useBarMorph(ref: RefObject<HTMLDivElement | null>, group: BarGroup | null) {
  const last = useRef<{
    group: BarGroup | null;
    width: number;
    lefts: Map<string, number>;
  } | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const lefts = new Map<string, number>();
    for (const el of bar.querySelectorAll<HTMLElement>('[data-bar-group]')) {
      lefts.set(el.dataset.barGroup ?? '', el.getBoundingClientRect().left);
    }
    const now = { group, width: bar.getBoundingClientRect().width, lefts };
    const before = last.current;
    last.current = now;
    if (!before || before.group === group || reducedMotion() || !('animate' in bar)) return;
    const timing = { duration: MORPH_MS, easing: MORPH_EASING };
    // The capsule's width follows, clipped while it moves.
    if (Math.abs(before.width - now.width) > 0.5) {
      bar.dataset.morphing = '';
      const resize = bar.animate(
        [{ width: `${before.width}px` }, { width: `${now.width}px` }],
        timing,
      );
      const done = () => {
        delete bar.dataset.morphing;
      };
      resize.onfinish = done;
      resize.oncancel = done;
    }
    // The shared element slides from where it was.
    const key = group ?? before.group;
    if (key === null) return;
    const moving = bar.querySelector<HTMLElement>(`[data-bar-group="${key}"]`);
    const from = before.lefts.get(key);
    const to = now.lefts.get(key);
    if (moving && from !== undefined && to !== undefined && Math.abs(from - to) > 0.5) {
      moving.animate(
        [{ transform: `translateX(${from - to}px)` }, { transform: 'translateX(0)' }],
        timing,
      );
    }
    // Everything else slides in beside it.
    for (const el of bar.children) {
      if (el === moving || !(el instanceof HTMLElement)) continue;
      el.animate(
        [
          { opacity: 0, transform: `translateX(${group === null ? 0 : -8}px)` },
          { opacity: 1, transform: 'translateX(0)' },
        ],
        timing,
      );
    }
  }, [ref, group]);
}

function GroupButton({
  group,
  chip,
}: {
  readonly group: BarGroupDefinition;
  readonly chip: boolean;
}) {
  const lastGroup = useToolStore((s) => s.lastGroup);
  // Select is the idle tool (craft spec §3.4): its chip is on while nothing else is armed.
  const selectOn = useToolStore((s) => group.id === 'select' && s.mode === 'select');
  const label = group.label();
  const { Icon } = group;
  const select = group.id === 'select';
  return (
    <Tooltip
      label={
        chip
          ? m.bar_back_tooltip()
          : select
            ? m.cmd_tool({ tool: m.tool_select() })
            : m.bar_group_tools({ group: label })
      }
      shortcut={select ? shortcutOf('tool.select') : undefined}
      side="top"
    >
      <button
        type="button"
        className={styles.group}
        data-bar-group={group.id}
        data-bar-chip={chip ? '' : undefined}
        data-last={!chip && lastGroup === group.id ? '' : undefined}
        aria-label={chip ? m.bar_group_back({ group: label }) : undefined}
        aria-pressed={select ? selectOn : undefined}
        aria-keyshortcuts={select ? 'V' : undefined}
        onClick={() => {
          if (chip) showBarGroups();
          else pickBarGroup(group.id);
        }}
      >
        {chip ? <ChevronLeft className={styles.chipChevron} aria-hidden="true" /> : null}
        <Icon aria-hidden="true" className={styles.groupIcon} />
        <span className={styles.groupLabel}>{label}</span>
      </button>
    </Tooltip>
  );
}

function BarItemView({ item }: { readonly item: BarItem }): ReactNode {
  switch (item.kind) {
    case 'tool':
      return <ToolButton tool={item.tool} />;
    case 'pen':
      return <PenEntry tool={item.tool} />;
    case 'shapes':
      return <ShapesMenu shapes={item.tools} />;
    case 'stamp':
      return <StampMenu />;
    case 'command':
      return <CommandButton id={item.command} />;
    case 'fields':
      return <FieldsMenu />;
    case 'apply-redactions':
      return (
        <IconButton
          size="toolbar"
          tooltipSide="top"
          label={m.bar_apply_redactions()}
          icon={<ShieldCheck />}
          aria-haspopup="dialog"
          onClick={() => {
            showRedactionsPanel();
            useApplyDialogStore.getState().setOpen(true);
          }}
        />
      );
  }
}

const shortcutOf = (id: string) => commandRegistry.get(id)?.shortcuts[0];

/** Whether a tool has an options tier, which pressing it again while armed opens. */
function hasOptionsTier(mode: ToolMode): boolean {
  return mode === 'eraser' || toolStyleGroup(mode) !== undefined;
}

/** The armed tool's tooltip says how to leave it (craft spec §3.5): "Eraser · Esc: Select". */
function armedTooltip(text: string, armed: boolean): string {
  return armed ? m.bar_tool_escape({ tool: text }) : text;
}

function ToolButton({ tool }: { readonly tool: ToolDefinition }) {
  const armed = useToolStore((s) => s.mode === tool.mode);
  const label = tool.barTitle?.() ?? tool.title();
  return (
    <IconButton
      size="toolbar"
      tooltipSide="top"
      label={label}
      tooltip={armedTooltip(tool.tooltip?.() ?? label, armed)}
      icon={<tool.Icon />}
      shortcut={shortcutOf(`tool.${tool.mode}`)}
      aria-pressed={armed}
      aria-description={armed && hasOptionsTier(tool.mode) ? m.bar_options_hint() : undefined}
      data-tool={tool.mode}
      onClick={() => void activateTool(tool)}
    />
  );
}

/** The pen: the presets when they are plugged in (spec §6.2), else one Pen button. */
function PenEntry({ tool }: { readonly tool: ToolDefinition }) {
  const { Bar: PenBar } = usePenSlots();
  const armed = useToolStore((s) => s.mode === tool.mode);
  if (PenBar) return <PenBar armed={armed} arm={() => void activateTool(tool)} />;
  return <ToolButton tool={tool} />;
}

/** A bar menu button: icon, a small chevron, and a menu rising from it. */
function MenuButton({
  label,
  tooltip,
  icon,
  pressed,
  tool,
  children,
}: {
  readonly label: string;
  /** The tooltip when it says more than the name (the armed shape's "Esc: Select"). */
  readonly tooltip?: string;
  readonly icon: ReactNode;
  readonly pressed?: boolean;
  /** `data-tool` when the menu arms a tool (the armed look). */
  readonly tool?: string;
  readonly children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Tooltip label={tooltip ?? label} side="top">
        <Menu.Trigger
          className={`${iconButtonStyles.button} ${styles.menuTrigger}`}
          data-size="toolbar"
          aria-label={label}
          aria-pressed={pressed}
          data-tool={tool}
        >
          {icon}
          <ChevronUp className={styles.chevron} aria-hidden="true" />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="top" align="center" sideOffset={8} collisionPadding={8}>
          <Menu.Popup className={menuStyles.popup}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The shape last picked this session, shown on the Shapes button. */
let lastShape: ToolMode | null = null;

function ShapesMenu({ shapes }: { readonly shapes: readonly ToolDefinition[] }) {
  const mode = useToolStore((s) => s.mode);
  const [, setShown] = useState(lastShape);
  const shown =
    shapes.find((t) => t.mode === mode) ?? shapes.find((t) => t.mode === lastShape) ?? shapes[0];
  if (!shown) return null;
  const label = m.tool_shapes_menu({ shape: shown.title() });
  const armed = shapes.some((t) => t.mode === mode);
  return (
    <MenuButton
      label={label}
      tooltip={armedTooltip(label, armed)}
      icon={<shown.Icon />}
      pressed={armed}
      tool="shapes"
    >
      {shapes.map((tool) => (
        <Menu.Item
          key={tool.mode}
          className={menuStyles.item}
          data-tool={tool.mode}
          onClick={() => {
            lastShape = tool.mode;
            setShown(tool.mode);
            void activateTool(tool);
          }}
        >
          <tool.Icon aria-hidden="true" className={styles.menuIcon} />
          <span className={menuStyles.label}>{tool.title()}</span>
          {tool.shortcut ? <kbd className={styles.menuKey}>{tool.shortcut}</kbd> : null}
        </Menu.Item>
      ))}
    </MenuButton>
  );
}

function StampMenu() {
  const stamp = toolDefinition('stamp');
  const active = useToolStore((s) => s.mode === 'stamp');
  const pending = useAnnotationStore((s) => s.pendingStamp);
  const arm = (name: (typeof BUILTIN_STAMPS)[number]['name']) => {
    useAnnotationStore.getState().setPendingStamp(builtinPendingStamp(name));
    useAnnotationStore.getState().select(null);
    useToolStore.getState().setMode('stamp');
  };
  return (
    <MenuButton label={stamp.title()} icon={<stamp.Icon />} pressed={active} tool="stamp">
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
    </MenuButton>
  );
}

function FieldsMenu() {
  return (
    <MenuButton label={m.forms_add_field()} icon={<SquarePlus />}>
      {FIELD_KINDS.map((kind: CreatedFieldKind) => (
        <Menu.Item
          key={kind}
          className={menuStyles.item}
          onClick={() => void commandRegistry.execute(`forms.add.${kind}`)}
        >
          <span className={menuStyles.label}>{kindName(kind)}</span>
        </Menu.Item>
      ))}
    </MenuButton>
  );
}

/** Command buttons: icon and the bar's name for them. */
const COMMAND_BUTTONS: Readonly<
  Record<string, { readonly Icon: LucideIcon; readonly label?: () => string }>
> = {
  'forms.highlight': { Icon: RectangleEllipsis },
  'document.sign': { Icon: BadgeCheck },
  'redaction.find': { Icon: ScanSearch },
  'redaction.markMatches': { Icon: TextSearch, label: m.bar_mark_matches },
};

function CommandButton({ id }: { readonly id: string }) {
  const command = commandRegistry.get(id);
  const highlightOn = useFormStore((s) => s.highlight);
  // Availability follows the document, the search and the dialogs.
  useWorkspaceStore((s) => s.workspace);
  useSearchStore((s) => s.hits.length);
  const spec = COMMAND_BUTTONS[id];
  if (!command || !spec) return null;
  const enabled = commandRegistry.isEnabled(command);
  const label = spec.label?.() ?? command.title;
  return (
    <IconButton
      size="toolbar"
      tooltipSide="top"
      label={label}
      icon={<spec.Icon />}
      shortcut={command.shortcuts[0]}
      aria-pressed={id === 'forms.highlight' ? highlightOn : undefined}
      aria-disabled={enabled ? undefined : 'true'}
      aria-description={
        enabled ? undefined : id === 'redaction.markMatches' ? m.bar_mark_matches_none() : undefined
      }
      data-command={id}
      onClick={() => {
        if (enabled) void commandRegistry.execute(id);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// The options tier
// ---------------------------------------------------------------------------

/**
 * The armed tool's options, attached to the top of the bar (spec §5.2), shown only on
 * request: the armed tool pressed again (`optionsOpen`).
 */
function OptionsTier() {
  const mode = useToolStore((s) => s.mode);
  const open = useToolStore((s) => s.optionsOpen);
  const { EraserTier } = usePenSlots();
  const group = toolStyleGroup(mode);
  if (!open) return null;
  if (mode === 'eraser' && EraserTier) return <Tier mode={mode} content={<EraserTier />} />;
  if (group === undefined) return null;
  return <Tier mode={mode} group={group} />;
}

/** Esc disarms the tool and the tier goes: focus moves to the bar's Tab stop. */
const barTabStop = (tier: HTMLElement) =>
  tier.parentElement?.querySelector<HTMLElement>('[data-region="toolbar"] [tabindex="0"]');

function Tier({
  mode,
  group,
  content,
}: {
  readonly mode: ToolMode;
  readonly group?: NonNullable<ReturnType<typeof toolStyleGroup>>;
  /** A plug-in's tier (the eraser's) instead of the tool style. */
  readonly content?: ReactNode;
}) {
  const { Tier: PenTier } = usePenSlots();
  const ref = useRef<HTMLDivElement>(null);
  const roving = useRovingTabindex(ref, '[aria-checked="true"]');
  useFocusRescue(ref, barTabStop);
  const tool = toolDefinition(mode);
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.bar_options({ tool: tool.title() })}
      aria-orientation="horizontal"
      className={styles.tier}
      data-annotation-keep=""
      data-testid="options-tier"
      data-tier-tool={mode}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {content ??
        (mode === 'ink' && PenTier ? (
          <PenTier />
        ) : group ? (
          <StyleControls variant="tool" group={group} placement="tier" />
        ) : null)}
    </div>
  );
}
