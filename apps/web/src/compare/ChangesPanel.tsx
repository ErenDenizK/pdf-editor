/**
 * The Changes panel (left rail, Compare view; spec recognize-and-compare §2.2): what the
 * comparison found, per page-map row, with a +/−/~ glyph on every row (never colour alone):
 * inserted and deleted pages, changed areas (count and share of the page), changed words
 * (old → new, added, removed) and facts (metadata, sizes, rotation, annotations, fields,
 * attachments, signatures). A row brings its change into view; J / K step through them.
 *
 * The header carries the summary, the honesty lines (from the result's notes: a pixel diff
 * at N dpi cannot tell intent, …) and the two exports. While the run is in progress the
 * list fills in from the page map and the visual diffs as they land. Once a compared
 * document changes, the header says the list is out of date (Run again) and the report,
 * which annotates the second document as compared, is not offered.
 */
import { useMemo } from 'react';

import { m } from '../i18n';
import { EmptyNote } from '../shell/EmptyNote';
import { changeLabel, honestyLines, rowLabel, signGlyph, signLabel } from './change-labels';
import {
  buildChangeList,
  buildPartialChangeList,
  type ChangeItem,
  type ChangeList,
} from './changes';
import { selectChange } from './compare-commands';
import { exportComparisonReport, startCompare } from './compare-runner';
import { useCompareStore } from './compare-store';
import { exportChangesText } from './changes-export';
import styles from './ChangesPanel.module.css';

export default function ChangesPanel() {
  const status = useCompareStore((s) => s.status);
  const result = useCompareStore((s) => s.result);
  const pairs = useCompareStore((s) => s.pairs);
  const visuals = useCompareStore((s) => s.visuals);
  const sides = useCompareStore((s) => s.sides);
  const stale = useCompareStore((s) => s.stale);
  const list = useMemo<ChangeList | null>(
    () =>
      result ? buildChangeList(result) : pairs ? buildPartialChangeList(pairs, visuals) : null,
    [result, pairs, visuals],
  );

  if (!list) {
    return (
      <div className={styles.empty}>
        <EmptyNote
          title={
            status === 'preparing' || status === 'running'
              ? m.compare_changes_running()
              : m.compare_changes_empty_title()
          }
          body={m.compare_changes_empty_body()}
        />
      </div>
    );
  }

  const assembled = sides ? [sides.a, sides.b].filter((s) => s.assembled).map((s) => s.name) : [];
  const notes = result ? honestyLines(result, assembled) : [];

  return (
    <div className={styles.panel} data-testid="changes-panel">
      <div className={styles.header}>
        {result ? (
          <p className={styles.summary} data-testid="changes-summary">
            {m.compare_summary({
              changed: result.counts.changed,
              inserted: result.counts.inserted,
              deleted: result.counts.deleted,
              identical: result.counts.identical,
            })}
          </p>
        ) : (
          <p className={styles.summary}>{m.compare_changes_running()}</p>
        )}
        {stale ? (
          <div className={styles.stale} role="status" data-testid="changes-stale">
            <span>{m.compare_stale()}</span>
            <button type="button" className={styles.action} onClick={() => void startCompare()}>
              {m.compare_run_again()}
            </button>
          </div>
        ) : null}
        {notes.length > 0 ? (
          <details className={styles.notice} data-testid="changes-honesty">
            <summary className={styles.noticeSummary}>{notes[0]}</summary>
            <ul className={styles.noticeList}>
              {notes.slice(1).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            disabled={!result || stale}
            onClick={() => void exportComparisonReport()}
          >
            {m.compare_export_report()}
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={!result}
            onClick={() => void exportChangesText()}
          >
            {m.compare_export_changes()}
          </button>
        </div>
      </div>
      <div className={styles.scroll}>
        {result && list.flat.length === 0 ? (
          <p className={styles.none}>{m.compare_no_changes()}</p>
        ) : null}
        {list.document.length > 0 ? (
          <section className={styles.group} aria-label={m.compare_group_document()}>
            <h3 className={styles.groupTitle}>{m.compare_group_document()}</h3>
            <ItemList items={list.document} />
          </section>
        ) : null}
        {list.groups.map((group) => (
          <section key={group.row} className={styles.group} aria-label={rowLabel(group.pair)}>
            <h3 className={styles.groupTitle}>{rowLabel(group.pair)}</h3>
            <ItemList items={group.items} />
          </section>
        ))}
      </div>
    </div>
  );
}

function ItemList({ items }: { readonly items: readonly ChangeItem[] }) {
  const current = useCompareStore((s) => s.current);
  return (
    <ul className={styles.list}>
      {items.map((item) => {
        const { title, detail } = changeLabel(item);
        return (
          <li key={item.id}>
            <button
              type="button"
              className={styles.item}
              data-kind={item.kind}
              data-change={item.id}
              aria-current={current === item.id ? 'true' : undefined}
              onClick={() => selectChange(item)}
            >
              <span className={styles.glyph} aria-hidden="true">
                {signGlyph(item.sign)}
              </span>
              <span className="visually-hidden">{signLabel(item.sign)}: </span>
              <span className={styles.text}>
                <span className={styles.title}>{title}</span>
                {detail ? <span className={styles.detail}>{detail}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
