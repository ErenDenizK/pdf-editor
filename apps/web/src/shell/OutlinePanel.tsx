/**
 * Left rail "Outline": the active document's bookmarks from the model (`doc.outline`),
 * browsed and edited in place.
 *
 * APG tree view with a flat DOM (rows carry level / set size / position), roving tabindex
 * and keyboard: Up/Down move, Right expands or enters, Left collapses or goes to the
 * parent, Home/End jump, Enter (or click) activates. Nodes start expanded as authored
 * (`open`). Rows are virtualized only past VIRTUALIZE_AFTER visible rows.
 *
 * Editing (no separate edit mode: the read-only tree stays uncluttered because every edit
 * lives on keys, the context menu and drag and drop, plus one "Add bookmark" button):
 * - F2 or double-click renames in place; Delete / Backspace deletes (undoable, announced);
 * - Alt+Up / Alt+Down move an item among its siblings, Alt+Right indents it (last child of
 *   the previous sibling), Alt+Left outdents it (right after its parent), as Alt+Arrows
 *   move pages (DESIGN.md §5);
 * - the context menu (right-click, Menu key, Shift+F10) lists every edit with its key;
 * - rows drag (pragmatic-drag-and-drop) with a before / into / after drop indicator.
 * Model edits go through `outline/outline-actions.ts`, one undo step each; expansion and
 * focus follow the edited items (`outline/outline-view-store.ts`).
 *
 * Activation: a page destination scrolls Read mode to the page, and to its /XYZ position
 * when it has one (and selects the page in Arrange); a link never navigates silently: it
 * opens an inline notice naming the target, and only its "Open link" button opens a new
 * tab (http, https and mailto only). An unresolved destination (its page was deleted,
 * light-table spec §6) shows a warning; the toolbar offers to remove such dead links.
 */
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import {
  countDeadOutlineLinks,
  type Destination,
  type DocumentId,
  effectiveLabel,
  outlineNodeAt,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import { BookmarkPlus, ChevronRight, ExternalLink, TriangleAlert } from 'lucide-react';
import {
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { m } from '../i18n';
import { revealFor } from '../outline/current-view';
import editStyles from '../outline/Outline.module.css';
import {
  addBookmark,
  deleteBookmark,
  displayTitle,
  dropBookmark,
  moveBookmark,
  removeDeadLinks,
} from '../outline/outline-actions';
import {
  canDropOn,
  type DropPosition,
  dropGap,
  dropPositionOf,
  isOutlineDrag,
  type OutlineDragData,
  withDropInstruction,
} from '../outline/outline-dnd';
import { OutlineMenu, type OutlineMenuRequest } from '../outline/OutlineMenu';
import { OutlineRenameField } from '../outline/OutlineRenameField';
import {
  expansionFor,
  pathOf,
  setFocusedKey,
  setItemExpanded,
  startRenaming,
  useOutlineViewStore,
} from '../outline/outline-view-store';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import { EmptyNote } from './EmptyNote';
import styles from './OutlinePanel.module.css';
import { flattenOutline, type OutlineRow, openableUrl } from './OutlinePanel.tree';

/** Plain rendering up to this many visible rows; TanStack Virtual beyond it. */
export const VIRTUALIZE_AFTER = 500;
const ROW_HEIGHT = 28;

export function OutlinePanel() {
  const doc = useActiveDocument();
  if (!doc) {
    return (
      <div className={styles.empty}>
        <EmptyNote title={m.no_document_title()} body={m.outline_empty_no_document_body()} />
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <OutlineToolbar doc={doc} />
      {doc.outline.length === 0 ? (
        <div className={styles.empty}>
          <EmptyNote title={m.outline_empty_title()} body={m.outline_empty_body()} />
        </div>
      ) : (
        <OutlineTree key={doc.id} doc={doc} />
      )}
    </div>
  );
}

/** "Add bookmark" and, when some targets were deleted, the dead-link notice. */
function OutlineToolbar({ doc }: { readonly doc: VirtualDocument }) {
  const dead = countDeadOutlineLinks(doc.outline);
  return (
    <>
      <div role="toolbar" aria-label={m.outline_toolbar_label()} className={editStyles.toolbar}>
        <Tooltip label={m.outline_add_tooltip()} side="bottom">
          <button
            type="button"
            className={editStyles.toolButton}
            disabled={doc.pages.length === 0}
            onClick={() => addBookmark(doc.id)}
          >
            <BookmarkPlus aria-hidden="true" />
            {m.outline_add()}
          </button>
        </Tooltip>
      </div>
      {dead > 0 ? (
        <div className={editStyles.dead} data-testid="outline-dead-links">
          <TriangleAlert aria-hidden="true" />
          <span className={editStyles.deadText}>{m.outline_dead_links({ count: dead })}</span>
          <button
            type="button"
            className={editStyles.toolButton}
            onClick={() => removeDeadLinks(doc.id)}
          >
            {m.outline_remove_dead()}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Goes to an outline target: Read scrolls to it (and its position); Arrange selects it. */
function goToDestination(destination: Extract<Destination, { kind: 'page' }>): void {
  const pageId = destination.page;
  if (useUiStore.getState().viewMode === 'arrange') {
    useSelectionStore.getState().apply({
      selected: new Set([pageId]),
      anchor: pageId,
      focused: pageId,
    });
    useViewStore.getState().scrollToPage(pageId);
    return;
  }
  const ws = useWorkspaceStore.getState().workspace;
  const page = Object.values(ws.documents)
    .flatMap((d) => d.pages)
    .find((p) => p.id === pageId);
  const reveal = page ? revealFor(ws, page, destination.view) : undefined;
  useViewStore.getState().scrollToPage(pageId, reveal ? { reveal } : undefined);
}

interface PendingLink {
  readonly key: string;
  readonly uri: string;
}

interface DropIndicator {
  readonly key: string;
  readonly position: DropPosition;
}

function OutlineTree({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const latestExpanded = useOutlineViewStore((s) => s.expanded[doc.id]);
  const focusedKey = useOutlineViewStore((s) => s.focused[doc.id]);
  const renamingKey = useOutlineViewStore((s) =>
    s.renaming?.documentId === doc.id ? s.renaming.key : null,
  );
  const expanded = expansionFor(doc.id, doc.outline, latestExpanded);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [menu, setMenu] = useState<OutlineMenuRequest | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const baseId = useId();
  // State, not a ref: the virtualizer needs the element on its first layout effect, which
  // runs before a parent's ref is attached.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollToIndexRef = useRef<((index: number) => void) | null>(null);
  /** Set by edits made from the keyboard or menu: put DOM focus back on the item. */
  const refocus = useRef(false);

  const rows = flattenOutline(doc.outline, expanded);
  const pageIndex = new Map(doc.pages.map((page, index) => [page.id, index]));
  const activeKey =
    focusedKey !== undefined && rows.some((r) => r.key === focusedKey) ? focusedKey : rows[0]?.key;

  // Keep DOM focus on the roving item while the tree has focus (or after an edit).
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || activeKey === undefined || renamingKey !== null || menu !== null) return;
    const wanted = refocus.current;
    if (!wanted && !tree.contains(document.activeElement)) return;
    refocus.current = false;
    const item = tree.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey)}"]`);
    if (item && document.activeElement !== item) item.focus({ preventScroll: true });
    item?.scrollIntoView?.({ block: 'nearest' });
  });

  // Auto-scroll the list while dragging near its edges.
  useEffect(() => {
    if (!scrollElement) return;
    return autoScrollForElements({
      element: scrollElement,
      canScroll: ({ source }) => isOutlineDrag(source.data) && source.data.documentId === doc.id,
    });
  }, [scrollElement, doc.id]);

  const setOpen = (key: string, open: boolean) => {
    setItemExpanded(doc.id, doc.outline, key, open);
  };

  const focusKey = (key: string) => setFocusedKey(doc.id, key);

  const moveTo = (index: number) => {
    const row = rows[index];
    if (!row) return;
    focusKey(row.key);
    scrollToIndexRef.current?.(index);
  };

  const activate = (row: OutlineRow) => {
    focusKey(row.key);
    const destination = row.node.destination;
    if (destination === undefined) {
      if (row.hasChildren) setOpen(row.key, !row.expanded);
      return;
    }
    switch (destination.kind) {
      case 'page':
        setPendingLink(null);
        goToDestination(destination);
        break;
      case 'uri':
        setPendingLink({ key: row.key, uri: destination.uri });
        break;
      case 'unresolved':
        setPendingLink(null);
        break;
    }
  };

  const openMenu = (row: OutlineRow, element: HTMLElement, point?: { x: number; y: number }) => {
    focusKey(row.key);
    setMenu({
      key: row.key,
      path: pathOf(row.key),
      node: row.node,
      element,
      ...(point === undefined ? {} : { point }),
    });
  };

  /** Edits keep keyboard focus in the tree, on the edited item. */
  const edit = (run: () => unknown) => {
    refocus.current = true;
    run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    // The focused item, which can differ from the roving one after a programmatic focus.
    const focusedItem = (event.target as Element).closest<HTMLElement>('[data-key]');
    const key = focusedItem?.dataset.key ?? activeKey;
    const index = rows.findIndex((r) => r.key === key);
    const row = rows[index];
    if (!row) return;
    const path = pathOf(row.key);
    let handled = true;
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const direction = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowRight: 'indent',
        ArrowLeft: 'outdent',
      } as const;
      const move = direction[event.key as keyof typeof direction];
      if (move === undefined) return;
      event.preventDefault();
      edit(() => moveBookmark(doc.id, path, move));
      return;
    }
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      if (focusedItem) openMenu(row, focusedItem);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(Math.min(rows.length - 1, index + 1));
        break;
      case 'ArrowUp':
        moveTo(Math.max(0, index - 1));
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.hasChildren && !row.expanded) setOpen(row.key, true);
        else if (row.expanded) moveTo(index + 1);
        break;
      case 'ArrowLeft':
        if (row.expanded) setOpen(row.key, false);
        else if (row.parentKey !== null) {
          moveTo(rows.findIndex((r) => r.key === row.parentKey));
        }
        break;
      case 'Enter':
        activate(row);
        break;
      case 'F2':
        startRenaming(doc.id, row.key);
        break;
      case 'Delete':
      case 'Backspace':
        edit(() => deleteBookmark(doc.id, path));
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  const rowFromEvent = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('input')) return undefined;
    const item = target.closest<HTMLElement>('[data-key]');
    const row = rows.find((r) => r.key === item?.dataset.key);
    return row && item ? { row, item, target } : undefined;
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const hit = rowFromEvent(event);
    if (!hit) return;
    if (hit.target.closest('[data-part="toggle"]')) {
      focusKey(hit.row.key);
      setOpen(hit.row.key, !hit.row.expanded);
      return;
    }
    activate(hit.row);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const hit = rowFromEvent(event);
    if (!hit || hit.target.closest('[data-part="toggle"]')) return;
    startRenaming(doc.id, hit.row.key);
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const hit = rowFromEvent(event);
    if (!hit) return;
    event.preventDefault();
    openMenu(hit.row, hit.item, { x: event.clientX, y: event.clientY });
  };

  const closeLink = (refocusItem: boolean) => {
    const key = pendingLink?.key;
    setPendingLink(null);
    if (refocusItem && key !== undefined) {
      focusKey(key);
      requestAnimationFrame(() =>
        treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus(),
      );
    }
  };

  const renderRow = (row: OutlineRow, style?: { transform: string }) => {
    const destination = row.node.destination;
    let meta: ReactNode = null;
    let description: string | undefined;
    let tooltip: string | undefined;
    if (destination?.kind === 'page') {
      const index = pageIndex.get(destination.page);
      if (index !== undefined) {
        const label = effectiveLabel(ws, doc, index);
        meta = (
          <span className={styles.meta} aria-hidden="true">
            {label}
          </span>
        );
        description = m.outline_page_label({ label });
      }
    } else if (destination?.kind === 'uri') {
      meta = <ExternalLink className={styles.icon} aria-hidden="true" />;
      description = m.outline_link_tooltip({ uri: destination.uri });
      tooltip = description;
    } else if (destination?.kind === 'unresolved') {
      meta = <TriangleAlert className={styles.warning} aria-hidden="true" />;
      description = m.outline_unresolved();
      tooltip = description;
    }
    const renaming = row.key === renamingKey;
    const item = (
      <OutlineItem
        key={row.key}
        documentId={doc.id}
        row={row}
        onIndicator={setIndicator}
        onDragging={setDraggingKey}
        refocusAfterDrop={refocus}
        role="treeitem"
        data-key={row.key}
        data-kind={destination?.kind ?? 'none'}
        data-drop={indicator?.key === row.key ? indicator.position : undefined}
        data-dragging={draggingKey === row.key ? '' : undefined}
        aria-level={row.level}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-selected={row.key === activeKey}
        aria-describedby={description === undefined ? undefined : `${baseId}-${row.key}-desc`}
        tabIndex={row.key === activeKey && !renaming ? 0 : -1}
        className={styles.row}
        style={{
          ...style,
          paddingInlineStart: `calc(var(--space-1) + ${row.level - 1} * 14px)`,
          ['--drop-indent' as string]: `${(row.level - 1) * 14}px`,
        }}
      >
        <span className={styles.toggle} data-part={row.hasChildren ? 'toggle' : undefined}>
          {row.hasChildren ? <ChevronRight aria-hidden="true" /> : null}
        </span>
        {renaming ? (
          <OutlineRenameField
            documentId={doc.id}
            path={pathOf(row.key)}
            title={row.node.title}
            onDone={() => {
              refocus.current = true;
            }}
          />
        ) : (
          <span className={styles.title}>{displayTitle(row.node)}</span>
        )}
        {meta}
        {description === undefined ? null : (
          <span id={`${baseId}-${row.key}-desc`} hidden>
            {description}
          </span>
        )}
      </OutlineItem>
    );
    return tooltip === undefined || renaming ? (
      item
    ) : (
      <Tooltip key={row.key} label={tooltip} side="right">
        {item}
      </Tooltip>
    );
  };

  return (
    <div className={styles.root}>
      <div ref={setScrollElement} className={styles.scroll}>
        {/* Keyboard and pointer input are delegated to the tree (APG tree view). */}
        <div
          ref={treeRef}
          role="tree"
          tabIndex={-1}
          aria-label={m.outline_tree_label({ title: doc.title })}
          className={styles.tree}
          onKeyDown={onKeyDown}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onFocus={(event) => {
            const key = (event.target as HTMLElement).dataset.key;
            if (key !== undefined && key !== activeKey) focusKey(key);
          }}
        >
          {rows.length > VIRTUALIZE_AFTER ? (
            scrollElement === null ? null : (
              <VirtualRows
                rows={rows}
                activeIndex={rows.findIndex((r) => r.key === activeKey)}
                scrollElement={scrollElement}
                scrollToIndexRef={scrollToIndexRef}
                renderRow={renderRow}
              />
            )
          ) : (
            rows.map((row) => renderRow(row))
          )}
        </div>
      </div>
      {pendingLink ? (
        <LinkNotice key={pendingLink.key} uri={pendingLink.uri} onClose={closeLink} />
      ) : null}
      <OutlineMenu
        documentId={doc.id}
        outline={doc.outline}
        request={menu}
        onClose={() => {
          setMenu(null);
          refocus.current = true;
        }}
      />
    </div>
  );
}

type ItemProps = Omit<ComponentPropsWithoutRef<'div'>, 'role'> & {
  readonly role: 'treeitem';
  /** Set by a wrapping tooltip (Base UI merges its ref into the trigger). */
  readonly ref?: Ref<HTMLDivElement> | undefined;
  readonly documentId: DocumentId;
  readonly row: OutlineRow;
  readonly onIndicator: (update: (previous: DropIndicator | null) => DropIndicator | null) => void;
  readonly onDragging: (key: string | null) => void;
  /** Set on drop so the tree puts focus on the moved item. */
  readonly refocusAfterDrop: RefObject<boolean>;
  readonly 'data-key': string;
  readonly 'data-kind': string;
  readonly 'data-drop'?: DropPosition | undefined;
  readonly 'data-dragging'?: string | undefined;
};

/** A tree row that is also a drag source and a drop target. */
function OutlineItem({
  ref: outerRef,
  documentId,
  row,
  onIndicator,
  onDragging,
  refocusAfterDrop,
  children,
  ...rest
}: ItemProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      ref.current = element;
      if (typeof outerRef === 'function') outerRef(element);
      else if (outerRef) outerRef.current = element;
    },
    [outerRef],
  );
  const { key, expanded, hasChildren } = row;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const path = pathOf(key);
    const clear = () => onIndicator((previous) => (previous?.key === key ? null : previous));
    return combine(
      draggable({
        element,
        // Not while an item is being renamed (the field selects text by dragging).
        canDrag: () => useOutlineViewStore.getState().renaming === null,
        getInitialData: (): OutlineDragData => ({ type: 'outline-item', documentId, key }),
        onDragStart: () => onDragging(key),
        onDrop: () => onDragging(null),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) =>
          isOutlineDrag(source.data) &&
          source.data.documentId === documentId &&
          canDropOn(pathOf(source.data.key), path),
        getData: ({ input }) =>
          withDropInstruction({ key }, input, element, expanded && hasChildren),
        onDrag: ({ self }) => {
          const position = dropPositionOf(self.data);
          onIndicator((previous) =>
            position === null
              ? previous?.key === key
                ? null
                : previous
              : previous?.key === key && previous.position === position
                ? previous
                : { key, position },
          );
        },
        onDragLeave: clear,
        onDrop: ({ source, self }) => {
          clear();
          const position = dropPositionOf(self.data);
          if (position === null || !isOutlineDrag(source.data)) return;
          const outline = useWorkspaceStore.getState().workspace.documents[documentId]?.outline;
          if (!outline || !outlineNodeAt(outline, path)) return;
          const gap = dropGap(outline, path, position, expanded);
          if (!gap) return;
          refocusAfterDrop.current = true;
          dropBookmark(documentId, pathOf(source.data.key), gap);
        },
      }),
    );
  }, [key, expanded, hasChildren, documentId, onIndicator, onDragging, refocusAfterDrop]);

  return (
    <div ref={setRef} {...rest}>
      {children}
    </div>
  );
}

function VirtualRows({
  rows,
  activeIndex,
  scrollElement,
  scrollToIndexRef,
  renderRow,
}: {
  readonly rows: readonly OutlineRow[];
  /** Always rendered, so the tree keeps its Tab stop when the row scrolls away. */
  readonly activeIndex: number;
  readonly scrollElement: HTMLDivElement;
  readonly scrollToIndexRef: RefObject<((index: number) => void) | null>;
  readonly renderRow: (row: OutlineRow, style: { transform: string }) => ReactNode;
}) {
  'use no memo'; // TanStack Virtual mutates its instance; the React Compiler must not cache it.
  // Opted out of the compiler above ('use no memo'), so the instance is read fresh.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
    rangeExtractor: (range: Range) => {
      const indices = defaultRangeExtractor(range);
      if (activeIndex < 0 || indices.includes(activeIndex)) return indices;
      return [...indices, activeIndex].sort((a, b) => a - b);
    },
  });
  useEffect(() => {
    scrollToIndexRef.current = (index) => virtualizer.scrollToIndex(index, { align: 'auto' });
    return () => {
      scrollToIndexRef.current = null;
    };
  });
  return (
    <div className={styles.virtual} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        return row ? renderRow(row, { transform: `translateY(${item.start}px)` }) : null;
      })}
    </div>
  );
}

/**
 * Inline confirmation for an outline link. Nothing leaves the app until "Open link" is
 * pressed; Escape or Cancel returns focus to the tree item.
 */
function LinkNotice({
  uri,
  onClose,
}: {
  readonly uri: string;
  readonly onClose: (refocus: boolean) => void;
}) {
  const url = openableUrl(uri);
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);
  const target = url ? (url.protocol === 'mailto:' ? url.pathname : url.host) : '';
  // Escape cancels from either button (the notice itself is not interactive).
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  };
  return (
    <div role="group" aria-labelledby={titleId} className={styles.notice}>
      <p id={titleId} className={styles.noticeTitle}>
        {url ? m.outline_link_confirm() : m.outline_link_unsupported({ uri })}
      </p>
      {url ? (
        <>
          <p className={styles.noticeUrl} title={uri}>
            {uri}
          </p>
          <p className={styles.noticeBody}>{m.outline_link_leaves({ host: target })}</p>
        </>
      ) : null}
      <div className={styles.noticeActions}>
        <button
          type="button"
          className={styles.secondary}
          ref={url ? undefined : primaryRef}
          onKeyDown={onKeyDown}
          onClick={() => onClose(true)}
        >
          {url ? m.common_cancel() : m.common_close()}
        </button>
        {url ? (
          <button
            type="button"
            ref={primaryRef}
            className={styles.primary}
            onKeyDown={onKeyDown}
            onClick={() => {
              window.open(url.href, '_blank', 'noopener,noreferrer');
              onClose(true);
            }}
          >
            {m.outline_link_open()}
          </button>
        ) : null}
      </div>
    </div>
  );
}
