/**
 * Left rail "Outline": the active document's bookmarks from the model (`doc.outline`).
 *
 * APG tree view with a flat DOM (rows carry level / set size / position), roving tabindex
 * and keyboard: Up/Down move, Right expands or enters, Left collapses or goes to the
 * parent, Home/End jump, Enter (or click) activates. Nodes start expanded as authored
 * (`open`). Rows are virtualized only past VIRTUALIZE_AFTER visible rows.
 *
 * Activation: a page destination scrolls Read mode to the page (and selects it in
 * Arrange); a link never navigates silently: it opens an inline notice naming the target,
 * and only its "Open link" button opens a new tab (http, https and mailto only). An
 * unresolved destination (its page was deleted, light-table spec §6) shows a warning.
 */
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import { effectiveLabel, type PageId, type VirtualDocument } from '@pdf-editor/document-model';
import { ChevronRight, ExternalLink, TriangleAlert } from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { m } from '../i18n';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import { EmptyNote } from './EmptyNote';
import styles from './OutlinePanel.module.css';
import {
  flattenOutline,
  initiallyExpanded,
  type OutlineRow,
  openableUrl,
} from './OutlinePanel.tree';

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
  if (doc.outline.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyNote title={m.outline_empty_title()} body={m.outline_empty_body()} />
      </div>
    );
  }
  return <OutlineTree key={doc.id} doc={doc} />;
}

/** Page commands for an outline target: Read scrolls to it; Arrange also selects it. */
function goToPage(pageId: PageId): void {
  if (useUiStore.getState().viewMode === 'arrange') {
    useSelectionStore.getState().apply({
      selected: new Set([pageId]),
      anchor: pageId,
      focused: pageId,
    });
  }
  useViewStore.getState().scrollToPage(pageId);
}

interface PendingLink {
  readonly key: string;
  readonly uri: string;
}

function OutlineTree({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const [expanded, setExpanded] = useState(() => initiallyExpanded(doc.outline));
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const baseId = useId();
  // State, not a ref: the virtualizer needs the element on its first layout effect, which
  // runs before a parent's ref is attached.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollToIndexRef = useRef<((index: number) => void) | null>(null);

  const rows = flattenOutline(doc.outline, expanded);
  const pageIndex = new Map(doc.pages.map((page, index) => [page.id, index]));
  const activeKey =
    focusedKey !== null && rows.some((r) => r.key === focusedKey) ? focusedKey : rows[0]?.key;

  // Keep DOM focus on the roving item while the tree has focus.
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || activeKey === undefined || !tree.contains(document.activeElement)) return;
    const item = tree.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey)}"]`);
    if (item && document.activeElement !== item) item.focus({ preventScroll: true });
    item?.scrollIntoView?.({ block: 'nearest' });
  });

  const setOpen = (key: string, open: boolean) => {
    setExpanded((previous) => {
      if (previous.has(key) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const moveTo = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setFocusedKey(row.key);
    scrollToIndexRef.current?.(index);
  };

  const activate = (row: OutlineRow) => {
    setFocusedKey(row.key);
    const destination = row.node.destination;
    if (destination === undefined) {
      if (row.hasChildren) setOpen(row.key, !row.expanded);
      return;
    }
    switch (destination.kind) {
      case 'page':
        setPendingLink(null);
        goToPage(destination.page);
        break;
      case 'uri':
        setPendingLink({ key: row.key, uri: destination.uri });
        break;
      case 'unresolved':
        setPendingLink(null);
        break;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // The focused item, which can differ from the roving one after a programmatic focus.
    const focusedItem = (event.target as Element).closest<HTMLElement>('[data-key]');
    const key = focusedItem?.dataset.key ?? activeKey;
    const index = rows.findIndex((r) => r.key === key);
    const row = rows[index];
    if (!row) return;
    let handled = true;
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
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const item = target.closest<HTMLElement>('[data-key]');
    const row = rows.find((r) => r.key === item?.dataset.key);
    if (!row) return;
    if (target.closest('[data-part="toggle"]')) {
      setFocusedKey(row.key);
      setOpen(row.key, !row.expanded);
      return;
    }
    activate(row);
  };

  const closeLink = (refocus: boolean) => {
    const key = pendingLink?.key;
    setPendingLink(null);
    if (refocus && key !== undefined) {
      setFocusedKey(key);
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
    const item = (
      <div
        key={row.key}
        role="treeitem"
        data-key={row.key}
        data-kind={destination?.kind ?? 'none'}
        aria-level={row.level}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-selected={row.key === activeKey}
        aria-describedby={description === undefined ? undefined : `${baseId}-${row.key}-desc`}
        tabIndex={row.key === activeKey ? 0 : -1}
        className={styles.row}
        style={{ ...style, paddingInlineStart: `calc(var(--space-1) + ${row.level - 1} * 14px)` }}
      >
        <span className={styles.toggle} data-part={row.hasChildren ? 'toggle' : undefined}>
          {row.hasChildren ? <ChevronRight aria-hidden="true" /> : null}
        </span>
        <span className={styles.title}>{row.node.title}</span>
        {meta}
        {description === undefined ? null : (
          <span id={`${baseId}-${row.key}-desc`} hidden>
            {description}
          </span>
        )}
      </div>
    );
    return tooltip === undefined ? (
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
          onFocus={(event) => {
            const key = (event.target as HTMLElement).dataset.key;
            if (key !== undefined && key !== activeKey) setFocusedKey(key);
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
