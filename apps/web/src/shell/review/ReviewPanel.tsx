/**
 * The navigator's Review tab (experience-redesign §4.1): one list of the comments and other
 * annotations, the redaction marks and the form fields, grouped by page, with filter chips
 * All · Comments · Marks · Fields and their counts. Rows keep their kind's actions: a
 * comment selects its annotation; a mark reveals, deletes and (in Marks) ticks for "Apply
 * redactions", with J / K review; a field opens its editor (or, in "Edit fields", selects
 * a created field). Settings show where they apply: the author name is asked once above
 * the first comment; the redaction header in Marks; the field tools in Fields.
 *
 * Chips show only for kinds the document has (All, then each present kind, plus the chosen
 * one); "Find sensitive data" and the Marks header stay reachable through the tool bar's
 * Redact group. The list is virtualized (TanStack Virtual, as the thumbnails and search
 * results): a page heading and each row are one entry, rendered in flow between two spacers
 * so the page sections, headings and lists keep their structure.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAnnotationStore } from '../../annotations/annotation-store';
import type { FieldStop } from '../../forms/form-store';
import { formatNumber, m } from '../../i18n';
import { useRedactionStore } from '../../redaction/redaction-store';
import { type ReviewFilter, useUiStore } from '../../state/ui-store';
import { useActiveDocument } from '../../state/workspace-store';
import { announce } from '../announcer';
import { useAuthorPrompt } from '../comment-author';
import { AuthorPrompt, CommentRow } from '../CommentsPanel';
import { EmptyNote } from '../EmptyNote';
import { FieldRow, FormTools, useXfa } from '../FormsPanel';
import { MarkRow, RedactionTools } from '../panels/RedactionsPanel';
import { RadioChips } from '../panels/RadioChips';
import {
  countItems,
  filterItems,
  groupItems,
  type MarkItem,
  type ReviewCounts,
  type ReviewGroup,
  type ReviewItem,
  useReadReviewData,
  useReviewData,
} from './review-items';
import styles from './ReviewPanel.module.css';

export const FILTER_LABELS: Readonly<Record<ReviewFilter, () => string>> = {
  all: m.review_filter_all,
  comments: m.review_filter_comments,
  redactions: m.review_filter_marks,
  fields: m.review_filter_fields,
};

const FILTERS: readonly ReviewFilter[] = ['all', 'comments', 'redactions', 'fields'];

/** The chips to show: All, every kind present, and the chosen filter (even when empty). */
export function shownFilters(counts: ReviewCounts, chosen: ReviewFilter): ReviewFilter[] {
  return FILTERS.filter((value) => value === 'all' || value === chosen || counts[value] > 0);
}

/** `filter` pins the list to one filter and hides the chips (an embedded, single-kind list). */
export function ReviewPanel({ filter: pinned }: { readonly filter?: ReviewFilter } = {}) {
  const chosen = useUiStore((s) => s.reviewFilter);
  const filter = pinned ?? chosen;
  const doc = useActiveDocument();
  useReadReviewData();
  const { items, loading } = useReviewData();
  const counts = countItems(items);
  const shown = filterItems(items, filter);
  const editing = useAuthorPrompt((s) => s.editing);
  const ask = useAuthorPrompt((s) => !s.asked && !s.editing);
  const marks = items.filter((item): item is MarkItem => item.kind === 'mark');

  return (
    <div
      className={styles.panel}
      data-review-panel=""
      data-filter={filter}
      // Clicks in the list keep the annotation selection the rows make.
      data-annotation-keep=""
    >
      {pinned === undefined ? <FilterChips filter={filter} counts={counts} /> : null}
      {editing ? <AuthorPrompt focusOnMount /> : null}
      {!editing && ask && counts.comments > 0 && (filter === 'all' || filter === 'comments') ? (
        <AuthorPrompt />
      ) : null}
      {filter === 'redactions' ? (
        <RedactionTools entries={marks.map((item) => item.entry)} />
      ) : null}
      {filter === 'fields' && doc ? (
        <FormTools
          doc={doc}
          rows={shown.flatMap((item) => (item.kind === 'field' ? [item.stop] : []))}
        />
      ) : null}
      {shown.length === 0 ? (
        <div className={styles.empty} aria-busy={loading}>
          <Empty filter={filter} loading={loading} />
        </div>
      ) : (
        <ReviewList items={shown} filter={filter} loading={loading} />
      )}
    </div>
  );
}

function FilterChips({
  filter,
  counts,
}: {
  readonly filter: ReviewFilter;
  readonly counts: ReviewCounts;
}) {
  const setFilter = useUiStore((s) => s.setReviewFilter);
  return (
    <RadioChips
      label={m.review_filter_label()}
      className={styles.chips}
      value={filter}
      onChange={(next) => {
        setFilter(next);
        announce(m.review_announce_filter({ label: FILTER_LABELS[next](), count: counts[next] }));
      }}
      chips={shownFilters(counts, filter).map((value) => ({
        value,
        label: FILTER_LABELS[value](),
        count: formatNumber(counts[value]),
        name: m.nav_count_name({ label: FILTER_LABELS[value](), count: counts[value] }),
      }))}
    />
  );
}

function Empty({ filter, loading }: { readonly filter: ReviewFilter; readonly loading: boolean }) {
  const doc = useActiveDocument();
  const xfaOnly = useXfa(doc).only;
  if (!doc) {
    const body =
      filter === 'redactions' ? m.redaction_no_document_body() : m.review_no_document_body();
    return <EmptyNote title={m.no_document_title()} body={body} />;
  }
  switch (filter) {
    case 'comments':
      return loading ? (
        <EmptyNote title={m.comments_loading()} />
      ) : (
        <EmptyNote title={m.comments_empty_title()} body={m.comments_empty_body()} />
      );
    case 'redactions':
      return loading ? (
        <EmptyNote title={m.redaction_loading()} />
      ) : (
        <EmptyNote title={m.redaction_empty_title()} body={m.redaction_empty_body()} />
      );
    case 'fields':
      if (loading) return <EmptyNote title={m.forms_loading()} />;
      // A pure XFA form says why above; "no form fields" would contradict it.
      return xfaOnly ? null : (
        <EmptyNote title={m.forms_empty_title()} body={m.forms_empty_body()} />
      );
    default:
      return loading ? (
        <EmptyNote title={m.review_loading()} />
      ) : (
        <EmptyNote title={m.review_empty_title()} body={m.review_empty_body()} />
      );
  }
}

/** Estimated heights (px) until an entry is measured; spacing as in ReviewPanel.module.css. */
const HEAD_ESTIMATE = 32;
const ROW_ESTIMATE = 44;
const ROW_GAP = 2;
const GROUP_GAP = 12;

/** One entry of the virtual list: a page's headings, or one row with its number on the page. */
type Entry =
  | { readonly kind: 'head'; readonly key: string; readonly group: number }
  | {
      readonly kind: 'row';
      readonly key: string;
      readonly group: number;
      readonly item: ReviewItem;
      /** Marks: 1-based on the page; fields: 0-based on the page. */
      readonly number: number;
      /** The page's created fields (field rows only). */
      readonly created: readonly FieldStop[];
    };

/** Flattens the page groups: each group's headings, then its rows. Exported for tests. */
export function reviewEntries(groups: readonly ReviewGroup[]): Entry[] {
  const entries: Entry[] = [];
  groups.forEach((group, g) => {
    entries.push({ kind: 'head', key: `head:${group.key}`, group: g });
    let mark = 0;
    let field = 0;
    const created = group.items.flatMap((item) =>
      item.kind === 'field' && item.stop.fieldId !== undefined ? [item.stop] : [],
    );
    for (const item of group.items) {
      const number = item.kind === 'mark' ? ++mark : item.kind === 'field' ? field++ : 0;
      entries.push({ kind: 'row', key: item.key, group: g, item, number, created });
    }
  });
  return entries;
}

function ReviewList({
  items,
  filter,
  loading,
}: {
  readonly items: readonly ReviewItem[];
  readonly filter: ReviewFilter;
  readonly loading: boolean;
}) {
  'use no memo'; // TanStack Virtual mutates its instance; the React Compiler must not cache it.
  // Stable while only the scroll position changes, so rendered rows are not rendered again.
  const groups = useMemo(() => groupItems(items), [items]);
  const entries = useMemo(() => reviewEntries(groups), [groups]);
  // Under the panel's h2: page headings are h3, or h4 below documents' h3 when there are several.
  const nested = groups.some((group) => group.showDocument);
  const checkable = filter === 'redactions';
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);

  // Opted out of the compiler above ('use no memo'), so the instance is read fresh.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller,
    estimateSize: (i) => (entries[i]?.kind === 'head' ? HEAD_ESTIMATE : ROW_ESTIMATE),
    getItemKey: (i) => entries[i]?.key ?? i,
    overscan: 4,
  });
  // Entries sit in flow, so a measured size never moves what is on screen.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const shown = virtualizer.getVirtualItems();

  // Measure what is rendered: an entry's size runs from its top to the next entry's top, so
  // the gaps between rows and pages are part of it and the spacers stay exact.
  useLayoutEffect(() => {
    const root = content.current;
    if (!root) return;
    const elements = root.querySelectorAll<HTMLElement>(
      '[data-review-entry], [data-review-rows] > li',
    );
    if (elements.length !== shown.length) return;
    const boxes = [...elements].map((el) => el.getBoundingClientRect());
    shown.forEach((item, k) => {
      const box = boxes[k];
      const entry = entries[item.index];
      if (!box || !entry) return;
      const next = boxes[k + 1];
      const after = entries[item.index + 1];
      const trailing =
        after === undefined
          ? 0
          : after.group !== entry.group
            ? GROUP_GAP
            : entry.kind === 'head'
              ? 0
              : ROW_GAP;
      const size = next ? next.top - box.top : box.height + trailing;
      if (Math.abs(size - item.size) > 0.5) virtualizer.resizeItem(item.index, size);
    });
  });

  // J / K and a selection on the page bring their row into the list's view.
  const currentMark = useRedactionStore((s) => s.current);
  const selection = useAnnotationStore((s) => s.selection);
  const target = entries.findIndex((entry) => {
    if (entry.kind !== 'row') return false;
    const { item } = entry;
    if (item.kind === 'mark' && item.entry.key === currentMark) return true;
    if (item.kind === 'field' || selection?.pageId !== item.pageId) return false;
    const id = item.kind === 'mark' ? item.entry.mark.id : item.annotation.id;
    return selection.ids.includes(id);
  });
  useEffect(() => {
    if (target >= 0) virtualizer.scrollToIndex(target, { align: 'auto' });
  }, [target, virtualizer]);

  // Consecutive rendered entries of one page form a slice: one section, one list.
  const slices: { group: number; head: boolean; rows: Extract<Entry, { kind: 'row' }>[] }[] = [];
  for (const item of shown) {
    const entry = entries[item.index];
    if (!entry) continue;
    let slice = slices[slices.length - 1];
    if (slice?.group !== entry.group) {
      slice = { group: entry.group, head: false, rows: [] };
      slices.push(slice);
    }
    if (entry.kind === 'head') slice.head = true;
    else slice.rows.push(entry);
  }
  const first = shown[0];
  const last = shown[shown.length - 1];

  return (
    <div ref={setScroller} className={styles.scroll} aria-busy={loading} data-review-scroll="">
      <div
        ref={content}
        style={{
          paddingTop: first?.start ?? 0,
          paddingBottom: last ? Math.max(0, virtualizer.getTotalSize() - last.end) : 0,
        }}
      >
        {slices.map((slice) => {
          const group = groups[slice.group];
          if (!group) return null;
          return (
            <Group
              key={group.key}
              group={group}
              head={slice.head}
              rows={slice.rows}
              nested={nested}
              checkable={checkable}
            />
          );
        })}
      </div>
    </div>
  );
}

function Group({
  group,
  head,
  rows,
  nested,
  checkable,
}: {
  readonly group: ReviewGroup;
  /** The page's headings are in the rendered range. */
  readonly head: boolean;
  readonly rows: readonly Extract<Entry, { kind: 'row' }>[];
  readonly nested: boolean;
  readonly checkable: boolean;
}) {
  const PageTitle = nested ? 'h4' : 'h3';
  const page = m.comments_page({ page: group.position });
  return (
    <section className={styles.group} aria-label={page} data-review-page={group.position}>
      {head ? (
        <div data-review-entry="">
          {group.showDocument ? (
            <h3 className={styles.documentTitle}>{group.documentTitle}</h3>
          ) : null}
          <PageTitle className={styles.pageTitle}>{page}</PageTitle>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <ul className={styles.list} data-review-rows="">
          {rows.map((row) => (
            <ReviewRow key={row.key} row={row} checkable={checkable} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One row; memoized on its entry, which stays the same object while the list scrolls. */
const ReviewRow = memo(function ReviewRow({
  row: { item, number, created },
  checkable,
}: {
  readonly row: Extract<Entry, { kind: 'row' }>;
  readonly checkable: boolean;
}) {
  switch (item.kind) {
    case 'comment':
      return <CommentRow item={item} />;
    case 'mark':
      return <MarkRow entry={item.entry} index={number} checkable={checkable} />;
    case 'field':
      return <FieldRow row={item.stop} index={number} createdOnPage={created} />;
  }
});
