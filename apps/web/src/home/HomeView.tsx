/**
 * Home (experience-redesign §3): the open files as cards, in tab order, and what to do
 * with several of them. Select cards (click, Shift, Mod, or the keyboard), then Combine,
 * Arrange, Compare or Close; Enter or a double click opens one in Read. A card dropped on
 * another opens the merge dialog with [target, dragged]. With no file open, Home is the
 * empty state (`shell/EmptyState.tsx`). The whole view takes file drops (AppShell).
 *
 * Keyboard (§10): the cards are a multi-select listbox with a roving tabindex. Arrows move,
 * Shift+arrows extend from the anchor, Space toggles, Mod+A selects all, Enter opens, Esc
 * clears the selection.
 */
import type { DocumentId, VirtualPage, Workspace } from '@pdf-editor/document-model';
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useMemo,
  useRef,
  useState,
} from 'react';

import { openFilesFromPicker } from '../commands/app-commands';
import { currentPlatform } from '../commands/shortcuts';
import { RENDER_PRIORITY } from '../engine/engine-service';
import { formatNumber, m, useLocale } from '../i18n';
import { PageCanvas } from '../pages/PageCanvas';
import { displaySize, fitInBox } from '../pages/page-geometry';
import { EmptyState } from '../shell/EmptyState';
import { contentFrame, ResizedContent } from '../stage/ResizedContent';
import { useUiStore } from '../state/ui-store';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import {
  arrangeOnHome,
  closeOnHome,
  combine,
  compareOnHome,
  openInRead,
  selectOnHome,
} from './home-actions';
import {
  clickSelection,
  combineScope,
  dropOrder,
  formatFileSize,
  gridStep,
  type HomeCardData,
  homeCards,
  liveSelection,
  middleTruncate,
  rangeBetween,
  toggleSelection,
} from './home-model';
import styles from './HomeView.module.css';

/** Drag type of a card, so only cards (not files or text) can be dropped on a card. */
export const HOME_CARD_TYPE = 'application/x-pdf-editor-document';
/** Thumbnail box of a card, in CSS pixels (§3: 160 px wide). */
const THUMB = { width: 160, height: 200 } as const;
const NAME_LENGTH = 34;

function useHomeCards(): HomeCardData[] {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const files = useWorkspaceStore((s) => s.files);
  const colors = useWorkspaceStore((s) => s.documentColors);
  return useMemo(() => homeCards(workspace, files, colors), [workspace, files, colors]);
}

export function HomeView({ dragging }: { readonly dragging: boolean }) {
  const cards = useHomeCards();
  if (cards.length === 0) {
    return (
      <section
        className={styles.home}
        data-testid="home"
        data-variant="empty"
        data-dragging={dragging || undefined}
      >
        <EmptyState dragging={dragging} />
      </section>
    );
  }
  return <HomeCards cards={cards} dragging={dragging} />;
}

function HomeCards({
  cards,
  dragging,
}: {
  readonly cards: readonly HomeCardData[];
  readonly dragging: boolean;
}) {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const rawSelection = useUiStore((s) => s.homeSelection);
  const anchor = useUiStore((s) => s.homeAnchor);
  const order = useMemo(() => cards.map((c) => c.id), [cards]);
  const selection = useMemo(() => liveSelection(order, rawSelection), [order, rawSelection]);
  const [focused, setFocused] = useState<DocumentId | null>(null);
  const [dropTarget, setDropTarget] = useState<DocumentId | null>(null);
  /** The card being dragged; `dragover` cannot read the drag data, only its types. */
  const dragged = useRef<DocumentId | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const scope = combineScope(order, selection);
  const totalPages = cards.reduce((sum, c) => sum + c.pageCount, 0);
  const tabbable =
    (focused !== null && order.includes(focused) ? focused : undefined) ?? selection[0] ?? order[0];

  const focusCard = (id: DocumentId) => {
    setFocused(id);
    gridRef.current?.querySelector<HTMLElement>(`[data-document-id="${id}"]`)?.focus();
  };

  /** Cards per row, read from the layout (the grid wraps to the stage width). */
  const columns = (): number => {
    const items = gridRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [];
    const top = items[0]?.offsetTop;
    let count = 0;
    for (const item of items) {
      if (item.offsetTop !== top) break;
      count += 1;
    }
    return Math.max(1, count);
  };

  const onCardClick = (event: MouseEvent, id: DocumentId) => {
    event.stopPropagation();
    const mod = currentPlatform === 'mac' ? event.metaKey : event.ctrlKey;
    const next = clickSelection(order, { selection, anchor }, id, { shift: event.shiftKey, mod });
    // Said as from the keyboard ("2 files selected", spec §10).
    selectOnHome(next.selection, next.anchor);
    setFocused(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from =
      event.target instanceof Element
        ? event.target.closest('[data-document-id]')?.getAttribute('data-document-id')
        : undefined;
    const current = order.find((id) => id === from) ?? tabbable;
    if (current === undefined) return;
    const index = order.indexOf(current);
    const mod = currentPlatform === 'mac' ? event.metaKey : event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectOnHome(order, current);
      return;
    }
    if (mod || event.altKey) return;
    const step = gridStep(index, event.key, order.length, columns());
    if (step !== null) {
      event.preventDefault();
      const next = order[step];
      if (next === undefined) return;
      focusCard(next);
      if (event.shiftKey) {
        const from = anchor !== null && order.includes(anchor) ? anchor : current;
        selectOnHome(rangeBetween(order, from, next), from);
      }
      return;
    }
    switch (event.key) {
      case ' ': {
        event.preventDefault();
        const next = toggleSelection(order, { selection, anchor }, current);
        selectOnHome(next.selection, next.anchor);
        return;
      }
      case 'Enter':
        event.preventDefault();
        openInRead(current);
        return;
      case 'Escape':
        if (selection.length === 0) return;
        event.preventDefault();
        selectOnHome([], null);
        return;
    }
  };

  const onDragStart = (event: DragEvent, id: DocumentId) => {
    dragged.current = id;
    event.dataTransfer.setData(HOME_CARD_TYPE, id);
    event.dataTransfer.effectAllowed = 'link';
  };
  const isCardDrag = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes(HOME_CARD_TYPE);
  const onDragOver = (event: DragEvent, id: DocumentId) => {
    if (!isCardDrag(event) || dragged.current === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'link';
    if (dropTarget !== id) setDropTarget(id);
  };
  const onDragLeave = (event: DragEvent, id: DocumentId) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (dropTarget === id) setDropTarget(null);
  };
  const onDrop = (event: DragEvent, id: DocumentId) => {
    if (!isCardDrag(event)) return;
    event.preventDefault();
    const source = (event.dataTransfer.getData(HOME_CARD_TYPE) ||
      dragged.current) as DocumentId | null;
    dragged.current = null;
    setDropTarget(null);
    if (source === null || source === id || !order.includes(source)) return;
    combine(dropOrder(id, source));
  };
  const onDragEnd = () => {
    dragged.current = null;
    setDropTarget(null);
  };

  const [a, b] = selection;
  const combineLabel =
    scope === null
      ? ''
      : scope.all
        ? m.home_combine_all({ count: scope.ids.length })
        : m.home_combine_count({ count: scope.ids.length });

  return (
    <section
      className={styles.home}
      data-testid="home"
      data-dragging={dragging || undefined}
      aria-label={m.home_label()}
    >
      <div className={styles.toolbar}>
        <p className={styles.summary}>
          <span>
            {m.files_count({ count: cards.length })} · {pagesPhrase(totalPages)}
          </span>
          {selection.length > 0 ? (
            <span className={styles.selected}>
              {m.home_selected_summary({ count: formatNumber(selection.length) })}
            </span>
          ) : null}
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void openFilesFromPicker()}
          >
            {m.cmd_open_files()}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => arrangeOnHome(selection)}
          >
            {m.mode_arrange_long()}
          </button>
          {/* Shown only when they apply, never disabled (§3); the palette reaches them too. */}
          {a !== undefined && b !== undefined && selection.length === 2 ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void compareOnHome(a, b)}
            >
              {m.compare_mode()}
            </button>
          ) : null}
          {selection.length > 0 ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => closeOnHome(selection)}
            >
              {m.common_close()}
            </button>
          ) : null}
          {scope !== null ? (
            <button
              type="button"
              className={styles.primary}
              data-testid="home-combine"
              onClick={() => combine(scope.ids)}
            >
              {combineLabel}
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.scroller}>
        {/* A click between the cards clears the selection (Esc does it from the keyboard). */}
        <div
          ref={gridRef}
          role="listbox"
          aria-multiselectable="true"
          aria-label={m.home_grid_label()}
          tabIndex={-1}
          className={styles.grid}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            if (event.target === event.currentTarget && selection.length > 0) {
              selectOnHome([], null);
            }
          }}
        >
          {cards.map((card) => (
            <HomeCard
              key={card.id}
              card={card}
              workspace={workspace}
              selected={selection.includes(card.id)}
              tabbable={card.id === tabbable}
              dropTarget={dropTarget === card.id}
              onClick={(event) => onCardClick(event, card.id)}
              onDoubleClick={() => openInRead(card.id)}
              onFocus={() => setFocused(card.id)}
              onDragStart={(event) => onDragStart(event, card.id)}
              onDragOver={(event) => onDragOver(event, card.id)}
              onDragLeave={(event) => onDragLeave(event, card.id)}
              onDrop={(event) => onDrop(event, card.id)}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

interface HomeCardProps {
  readonly card: HomeCardData;
  readonly workspace: Workspace;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly dropTarget: boolean;
  readonly onClick: (event: MouseEvent) => void;
  readonly onDoubleClick: () => void;
  readonly onFocus: () => void;
  readonly onDragStart: (event: DragEvent) => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDragLeave: (event: DragEvent) => void;
  readonly onDrop: (event: DragEvent) => void;
  readonly onDragEnd: () => void;
}

function HomeCard({ card, workspace, selected, tabbable, dropTarget, ...handlers }: HomeCardProps) {
  const locale = useLocale();
  const size = card.size === undefined ? undefined : formatFileSize(card.size, locale);
  const details = [pagesPhrase(card.pageCount), size].filter(Boolean).join(' · ');
  const modified =
    card.modified === undefined
      ? undefined
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(card.modified);
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={`${card.title}, ${details}`}
      tabIndex={tabbable ? 0 : -1}
      draggable
      data-document-id={card.id}
      data-drop-target={dropTarget || undefined}
      className={styles.card}
      {...handlers}
    >
      <div className={styles.thumbBox}>
        {card.firstPage ? <HomeThumb workspace={workspace} page={card.firstPage} /> : null}
      </div>
      <div className={styles.meta} aria-hidden="true">
        <span className={styles.name} title={card.title}>
          <span className={styles.tag} data-tag={card.colorIndex} />
          <span className={styles.nameText}>{middleTruncate(card.title, NAME_LENGTH)}</span>
        </span>
        <span className={styles.details}>{details}</span>
        {modified === undefined ? null : (
          <span className={styles.modified}>{m.home_modified({ date: modified })}</span>
        )}
      </div>
      {dropTarget ? (
        <span className={styles.dropLabel} data-testid="home-drop-label">
          {m.home_drop_combine({ title: card.title })}
        </span>
      ) : null}
    </div>
  );
}

/** The first page through the shared thumbnail renderer, fitted into the card's box. */
function HomeThumb({
  workspace,
  page,
}: {
  readonly workspace: Workspace;
  readonly page: VirtualPage;
}) {
  const size = displaySize(workspace, page);
  const box = fitInBox(size, THUMB.width, THUMB.height);
  const frame = contentFrame(workspace, page);
  return (
    <div className={styles.sheet} style={{ width: box.width, height: box.height }}>
      <ResizedContent frame={frame}>
        <PageCanvas
          sourceId={page.ref.kind === 'source' ? page.ref.source : undefined}
          blobId={page.ref.kind === 'image' ? page.ref.blob : undefined}
          index={page.ref.kind === 'source' ? page.ref.index : 0}
          rotation={page.rotation}
          widthPt={frame?.widthPt ?? size.width}
          heightPt={frame?.heightPt ?? size.height}
          cssWidth={box.width * (frame?.width ?? 1)}
          priority={RENDER_PRIORITY.visible}
        />
      </ResizedContent>
    </div>
  );
}
