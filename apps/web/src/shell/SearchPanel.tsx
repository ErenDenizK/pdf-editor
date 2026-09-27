/**
 * Left rail "Search" (spec §1, Mod+F): query, match case, whole word, results grouped by
 * page with context. Enter / Shift+Enter (and F3 / Shift+F3 anywhere) step through hits;
 * Esc clears the search and closes the panel. Typing restarts the search after a short
 * pause and cancels the running one; results stream in as the engine reports them.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualDocument } from '@pdf-editor/document-model';
import { CaseSensitive, ChevronDown, ChevronUp, WholeWord } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { formatNumber, m } from '../i18n';
import { useViewStore } from '../state/view-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { documentLabels, hasCustomLabels } from '../viewer/navigation';
import {
  closeSearchPanel,
  type DocumentHit,
  groupHitsByPage,
  revealHit,
  runSearch,
  searchStep,
  selectHit,
  setSearchOptions,
  setSearchQuery,
  splitContext,
  useSearchStore,
} from '../viewer/search';
import { EmptyNote } from './EmptyNote';
import styles from './SearchPanel.module.css';
import { useCommandShortcut } from './use-command-shortcut';

/** Pause after typing before the search restarts. */
const TYPING_DELAY_MS = 150;
const HEADER_HEIGHT = 28;
const HIT_HEIGHT = 44;

export function SearchPanel() {
  const doc = useActiveDocument();
  if (!doc) {
    return (
      <div className={styles.empty}>
        <EmptyNote title={m.no_document_title()} body={m.search_empty_no_document_body()} />
      </div>
    );
  }
  return <SearchView doc={doc} />;
}

function SearchView({ doc }: { readonly doc: VirtualDocument }) {
  const query = useSearchStore((s) => s.query);
  const matchCase = useSearchStore((s) => s.matchCase);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const status = useSearchStore((s) => s.status);
  const hits = useSearchStore((s) => s.hits);
  const current = useSearchStore((s) => s.current);
  const focusSerial = useSearchStore((s) => s.focusSerial);
  const timing = useSearchStore((s) => s.timing);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextShortcut = useCommandShortcut('search.next');
  const previousShortcut = useCommandShortcut('search.previous');
  const statusId = useId();

  // Mod+F: focus and select the field (also when the panel was already open).
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusSerial]);

  // Restart after typing (debounced), on option changes and when the document changes.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runSearch(doc, useViewStore.getState().currentPage);
    }, TYPING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [doc, query, matchCase, wholeWord]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchStep(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSearchPanel();
      document.querySelector<HTMLElement>('[data-read-viewport]')?.focus();
    }
  };

  let summary = '';
  if (query.trim() !== '') {
    if (hits.length > 0) {
      summary = m.search_count({
        current: formatNumber(Math.max(0, current) + 1),
        total: formatNumber(hits.length),
      });
      if (status === 'searching') summary = `${summary} · ${m.search_searching()}`;
    } else if (status === 'searching') summary = m.search_searching();
    else if (status === 'error') summary = m.search_failed();
    else if (status === 'done') summary = m.search_no_results();
  }

  return (
    <div className={styles.root}>
      <div className={styles.controls}>
        <input
          ref={inputRef}
          type="search"
          className={styles.input}
          placeholder={m.search_placeholder()}
          aria-label={m.search_label()}
          aria-describedby={statusId}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.row}>
          <IconButton
            label={m.search_match_case()}
            icon={<CaseSensitive />}
            aria-pressed={matchCase}
            className={styles.toggle}
            onClick={() => setSearchOptions({ matchCase: !matchCase })}
          />
          <IconButton
            label={m.search_whole_word()}
            icon={<WholeWord />}
            aria-pressed={wholeWord}
            className={styles.toggle}
            onClick={() => setSearchOptions({ wholeWord: !wholeWord })}
          />
          <span
            id={statusId}
            className={styles.status}
            role="status"
            data-testid="search-status"
            data-state={status}
            data-first-ms={timing.first === undefined ? undefined : Math.round(timing.first)}
            data-total-ms={timing.total === undefined ? undefined : Math.round(timing.total)}
          >
            {summary}
          </span>
          <IconButton
            label={m.search_previous()}
            icon={<ChevronUp />}
            shortcut={previousShortcut}
            disabled={hits.length === 0}
            className={styles.toggle}
            onClick={() => searchStep(-1)}
          />
          <IconButton
            label={m.search_next()}
            icon={<ChevronDown />}
            shortcut={nextShortcut}
            disabled={hits.length === 0}
            className={styles.toggle}
            onClick={() => searchStep(1)}
          />
        </div>
      </div>
      {hits.length > 0 ? <ResultList doc={doc} hits={hits} current={current} /> : null}
    </div>
  );
}

type Row =
  | {
      readonly kind: 'page';
      readonly key: string;
      readonly pageIndex: number;
      readonly count: number;
    }
  | {
      readonly kind: 'hit';
      readonly key: string;
      readonly index: number;
      readonly hit: DocumentHit;
    };

function ResultList({
  doc,
  hits,
  current,
}: {
  readonly doc: VirtualDocument;
  readonly hits: readonly DocumentHit[];
  readonly current: number;
}) {
  'use no memo'; // TanStack Virtual mutates its instance; the React Compiler must not cache it.
  const ws = useWorkspaceStore((s) => s.workspace);
  const query = useSearchStore((s) => s.query);
  const matchCase = useSearchStore((s) => s.matchCase);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const labels = documentLabels(ws, doc);
  const showLabels = hasCustomLabels(labels);

  const rows: Row[] = [];
  for (const group of groupHitsByPage(hits)) {
    rows.push({
      kind: 'page',
      key: `p${group.pageIndex}`,
      pageIndex: group.pageIndex,
      count: group.hits.length,
    });
    for (const { index, hit } of group.hits)
      rows.push({ kind: 'hit', key: `h${hit.seq}`, index, hit });
  }
  const currentRow = rows.findIndex((row) => row.kind === 'hit' && row.index === current);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: (i) => (rows[i]?.kind === 'page' ? HEADER_HEIGHT : HIT_HEIGHT),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
  });

  // Keep the current hit in view as it moves.
  useEffect(() => {
    if (currentRow >= 0) virtualizer.scrollToIndex(currentRow, { align: 'auto' });
  }, [currentRow, virtualizer]);

  return (
    <div ref={setScrollElement} className={styles.scroll}>
      <ul
        className={styles.list}
        aria-label={m.search_results_label()}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const style = { transform: `translateY(${item.start}px)` };
          if (row.kind === 'page') {
            const label = labels[row.pageIndex] ?? String(row.pageIndex + 1);
            return (
              <li key={row.key} className={styles.pageHeader} style={style}>
                <span>
                  {showLabels
                    ? m.search_page_label({ label, number: row.pageIndex + 1 })
                    : m.search_page({ number: row.pageIndex + 1 })}
                </span>
                <span className={styles.pageCount}>{formatNumber(row.count)}</span>
              </li>
            );
          }
          const parts = splitContext(row.hit, query, matchCase);
          return (
            <li key={row.key} className={styles.hitItem} style={style}>
              <button
                type="button"
                className={styles.hit}
                aria-current={row.index === current ? 'true' : undefined}
                data-testid="search-hit"
                onClick={() => revealHit(selectHit(row.index))}
              >
                <span className={styles.context}>
                  {parts.before}
                  {parts.match ? <mark className={styles.mark}>{parts.match}</mark> : null}
                  {parts.after}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
