/**
 * Contextual floating bar above the selection (spec §4): rotate, delete, duplicate,
 * move to a new document ("Extract"), insert blank, move to another document,
 * properties. Hidden while dragging or drawing a marquee. Positioned from table geometry (not the DOM), so it works when the
 * selected cells are virtualized away: it then sticks to the top of the viewport.
 *
 * One Tab stop; arrows move between buttons (DESIGN.md §5 roving tabindex).
 */
import { Menu } from '@base-ui/react/menu';
import type { DocumentId, PageId } from '@pdf-editor/document-model';
import {
  Copy,
  FileOutput,
  FilePlus2,
  FolderInput,
  PanelRight,
  RotateCcw,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useRef, useState } from 'react';

import { commandRegistry } from '../commands/registry';
import { useDragSession } from '../dnd/drag-store';
import { type ArrangeLayout, cellRect, GRID, type GridMetrics } from '../dnd/geometry';
import { m } from '../i18n';
import { useCommandShortcut } from '../shell/use-command-shortcut';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { pagesPhrase, useTabItems } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import iconButtonStyles from '../ui/IconButton.module.css';
import menuStyles from '../ui/Menu.module.css';
import { Tooltip } from '../ui/Tooltip';
import { movePagesToDocument } from './arrange-actions';
import { pageIndexes, type ShownSection } from './arrange-data';
import styles from './ArrangeView.module.css';

const BAR_HEIGHT = 38;
const BAR_HALF_WIDTH = 190;
/** Keep clear of the floating tool bar at the bottom of the stage. */
const BOTTOM_CLEARANCE = 88;

interface ContextualBarProps {
  readonly sections: readonly ShownSection[];
  readonly layout: ArrangeLayout<DocumentId>;
  readonly metrics: GridMetrics;
  readonly width: number;
  readonly viewTop: number;
  readonly viewBottom: number;
  readonly suppressed: boolean;
}

/** Where the bar goes: above the first selected row, centred on its selected cells. */
export function contextualBarPosition(
  sections: readonly ShownSection[],
  layout: ArrangeLayout<DocumentId>,
  metrics: GridMetrics,
  selected: ReadonlySet<PageId>,
  view: { width: number; top: number; bottom: number },
): { left: number; top: number } | null {
  let best: { top: number; bottom: number; left: number; right: number } | null = null;
  sections.forEach((section, i) => {
    const sectionLayout = layout.sections[i];
    if (!sectionLayout) return;
    const indexes = pageIndexes(section.doc);
    for (const id of selected) {
      const index = indexes.get(id);
      if (index === undefined) continue;
      const rect = section.collapsed
        ? {
            top: sectionLayout.top,
            bottom: sectionLayout.top + GRID.headerHeight,
            left: metrics.padX,
            right: metrics.padX + 160,
          }
        : cellRect(sectionLayout, metrics, index);
      if (best === null || rect.top < best.top) {
        best = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      } else if (rect.top === best.top) {
        best = {
          top: best.top,
          bottom: best.bottom,
          left: Math.min(best.left, rect.left),
          right: Math.max(best.right, rect.right),
        };
      }
    }
  });
  if (best === null) return null;
  const found: { top: number; bottom: number; left: number; right: number } = best;
  // Never cover the sticky section header: without room above the first selected row,
  // the bar goes just under it (over the row gap and the next row's top edge).
  const minTop = view.top + GRID.headerHeight + 4;
  const maxTop = Math.max(minTop, view.bottom - BAR_HEIGHT - BOTTOM_CLEARANCE);
  const above = found.top - BAR_HEIGHT - 10;
  const preferred = above >= minTop ? above : found.bottom + 6;
  const top = Math.min(maxTop, Math.max(minTop, preferred));
  const centre = (found.left + found.right) / 2;
  const left = Math.min(
    Math.max(centre, BAR_HALF_WIDTH + 8),
    Math.max(BAR_HALF_WIDTH + 8, view.width - BAR_HALF_WIDTH - 8),
  );
  return { left, top };
}

export function ContextualBar({
  sections,
  layout,
  metrics,
  width,
  viewTop,
  viewBottom,
  suppressed,
}: ContextualBarProps) {
  const selected = useSelectionStore((s) => s.selected);
  const dragging = useDragSession((s) => s.session !== null);
  const ref = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const rotateLeft = useCommandShortcut('pages.rotateLeft');
  const rotateRight = useCommandShortcut('pages.rotateRight');
  const deleteKey = useCommandShortcut('pages.delete');
  const duplicateKey = useCommandShortcut('pages.duplicate');
  const extractKey = useCommandShortcut('pages.extract');
  const tabs = useTabItems();

  if (suppressed || dragging || selected.size === 0) return null;
  const position = contextualBarPosition(sections, layout, metrics, selected, {
    width,
    top: viewTop,
    bottom: viewBottom,
  });
  if (position === null) return null;

  const run = (command: string) => () => void commandRegistry.execute(command);
  const buttons: { key: string; element: (tabIndex: number) => ReactElement }[] = [
    {
      key: 'rotate-left',
      element: (tabIndex) => (
        <IconButton
          label={m.action_rotate_left()}
          icon={<RotateCcw />}
          shortcut={rotateLeft}
          tabIndex={tabIndex}
          onClick={run('pages.rotateLeft')}
        />
      ),
    },
    {
      key: 'rotate-right',
      element: (tabIndex) => (
        <IconButton
          label={m.action_rotate_right()}
          icon={<RotateCw />}
          shortcut={rotateRight}
          tabIndex={tabIndex}
          onClick={run('pages.rotateRight')}
        />
      ),
    },
    {
      key: 'delete',
      element: (tabIndex) => (
        <IconButton
          label={m.action_delete()}
          icon={<Trash2 />}
          shortcut={deleteKey}
          tabIndex={tabIndex}
          onClick={run('pages.delete')}
        />
      ),
    },
    {
      key: 'duplicate',
      element: (tabIndex) => (
        <IconButton
          label={m.action_duplicate()}
          icon={<Copy />}
          shortcut={duplicateKey}
          tabIndex={tabIndex}
          onClick={run('pages.duplicate')}
        />
      ),
    },
    {
      key: 'extract',
      element: (tabIndex) => (
        <IconButton
          label={m.action_move_to_new_document()}
          icon={<FileOutput />}
          shortcut={extractKey}
          tabIndex={tabIndex}
          onClick={run('pages.extract')}
        />
      ),
    },
    {
      key: 'blank',
      element: (tabIndex) => (
        <IconButton
          label={m.action_insert_blank_after()}
          icon={<FilePlus2 />}
          tabIndex={tabIndex}
          onClick={run('pages.insertBlank')}
        />
      ),
    },
    {
      key: 'move',
      element: (tabIndex) => (
        <Menu.Root>
          <Tooltip label={m.action_move_to()}>
            <Menu.Trigger
              className={iconButtonStyles.button}
              data-size="chrome"
              aria-label={m.action_move_to()}
              tabIndex={tabIndex}
            >
              <FolderInput />
            </Menu.Trigger>
          </Tooltip>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="center" sideOffset={6} collisionPadding={8}>
              <Menu.Popup className={menuStyles.popup}>
                {tabs.map((tab) => (
                  <Menu.Item
                    key={tab.id}
                    className={menuStyles.item}
                    onClick={() => movePagesToDocument(tab.id)}
                  >
                    <span className={styles.sectionTag} data-tag={tab.colorIndex} />
                    <span className={menuStyles.label}>{tab.title}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ),
    },
    {
      key: 'properties',
      element: (tabIndex) => (
        <IconButton
          label={m.action_properties()}
          icon={<PanelRight />}
          tabIndex={tabIndex}
          onClick={() => useUiStore.setState({ rightPanelOpen: true })}
        />
      ),
    },
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const index = all.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % all.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + all.length) % all.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = all.length - 1;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    all[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={m.context_bar_label({ pages: pagesPhrase(selected.size) })}
      className={styles.contextBar}
      data-testid="contextual-bar"
      data-context-bar=""
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
    >
      <span className={styles.contextCount} aria-hidden="true">
        {m.status_selected({ count: selected.size })}
      </span>
      <span className={styles.contextDivider} aria-hidden="true" />
      {buttons.map((button, i) => (
        <span key={button.key} style={{ display: 'contents' }}>
          {button.element(i === focusIndex ? 0 : -1)}
        </span>
      ))}
    </div>
  );
}
