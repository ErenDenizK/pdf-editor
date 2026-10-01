/**
 * The navigator's Review tab (experience-redesign §4.1): one list of the comments and other
 * annotations, the redaction marks and the form fields, grouped by page, with filter chips
 * All · Comments · Marks · Fields and their counts. Rows keep their kind's actions: a
 * comment selects its annotation; a mark reveals, deletes and (in Marks) ticks for "Apply
 * redactions", with J / K review; a field opens its editor (or, in "Edit fields", selects
 * a created field). Settings show where they apply: the author name is asked once above
 * the first comment; the redaction header in Marks; the field tools in Fields.
 */
import { formatNumber, m } from '../../i18n';
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
      chips={FILTERS.map((value) => ({
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

function ReviewList({
  items,
  filter,
  loading,
}: {
  readonly items: readonly ReviewItem[];
  readonly filter: ReviewFilter;
  readonly loading: boolean;
}) {
  const groups = groupItems(items);
  return (
    <div className={styles.scroll} aria-busy={loading}>
      {groups.map((group) => (
        <Group key={group.key} group={group} checkable={filter === 'redactions'} />
      ))}
    </div>
  );
}

function Group({ group, checkable }: { readonly group: ReviewGroup; readonly checkable: boolean }) {
  const page = m.comments_page({ page: group.position });
  let mark = 0;
  let field = 0;
  const created = group.items.flatMap((item) =>
    item.kind === 'field' && item.stop.fieldId !== undefined ? [item.stop] : [],
  );
  return (
    <section className={styles.group} aria-label={page} data-review-page={group.position}>
      {group.showDocument ? <h3 className={styles.documentTitle}>{group.documentTitle}</h3> : null}
      <h4 className={styles.pageTitle}>{page}</h4>
      <ul className={styles.list}>
        {group.items.map((item) => {
          switch (item.kind) {
            case 'comment':
              return <CommentRow key={item.key} item={item} />;
            case 'mark':
              mark++;
              return (
                <MarkRow key={item.key} entry={item.entry} index={mark} checkable={checkable} />
              );
            case 'field':
              field++;
              return (
                <FieldRow
                  key={item.key}
                  row={item.stop}
                  index={field - 1}
                  createdOnPage={created}
                />
              );
          }
        })}
      </ul>
    </section>
  );
}
