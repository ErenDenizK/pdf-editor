/**
 * Right panel "Properties" for selected annotations (spec §2): the contextual bar's
 * controls plus kind, author, dates and the comment text. Renders `fallback` when no
 * annotation is selected.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';

import { getLocale, m } from '../i18n';
import { updateAnnotations } from './actions';
import { selectedAnnotations, useAnnotationStore } from './annotation-store';
import { annotationName, capitalize } from './labels';
import styles from './AnnotationProperties.module.css';
import { StyleControls } from './StyleControls';

const dateFormat = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
        date,
      );
};

export function AnnotationProperties({ fallback }: { readonly fallback: ReactNode }) {
  const selection = useAnnotationStore((s) => s.selection);
  const pages = useAnnotationStore((s) => s.pages);
  const annotations = selectedAnnotations({ selection, pages });
  const first = annotations[0];
  if (!selection || !first) return <>{fallback}</>;
  const single = annotations.length === 1;
  const locked = annotations.every((a) => a.flags?.locked);
  return (
    <div className={styles.properties} data-annotation-keep="" data-testid="annotation-properties">
      <dl className={styles.facts}>
        <dt>{m.annot_kind()}</dt>
        <dd>
          {single
            ? capitalize(annotationName(first))
            : m.annot_count({ count: annotations.length })}
          {locked ? <span className={styles.locked}>{m.annot_locked_short()}</span> : null}
        </dd>
        {single ? (
          <>
            <dt>{m.annot_author()}</dt>
            <dd>{first.author && first.author !== '' ? first.author : m.annot_no_author()}</dd>
            <dt>{m.annot_modified()}</dt>
            <dd className={styles.numeric}>{first.modified ? dateFormat(first.modified) : '—'}</dd>
            <dt>{m.annot_page()}</dt>
            <dd className={styles.numeric}>{selection.position}</dd>
          </>
        ) : null}
      </dl>
      {locked ? (
        <p className={styles.note}>{m.annot_locked()}</p>
      ) : (
        <StyleControls target={selection} annotations={annotations} variant="panel" />
      )}
      {single ? (
        <ContentsField
          key={`${first.id}:${first.contents ?? ''}`}
          initial={first.kind === 'free-text' ? first.text : (first.contents ?? '')}
          disabled={first.flags?.locked === true}
          onCommit={(value) =>
            void updateAnnotations(
              selection,
              [first.id],
              (a) =>
                a.kind === 'free-text'
                  ? { ...a, text: value, contents: value }
                  : { ...a, contents: value },
              {
                action: first.kind === 'free-text' ? 'text' : 'comment',
                coalesceKey: `text:${first.id}`,
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

function ContentsField({
  initial,
  disabled,
  onCommit,
}: {
  readonly initial: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    if (value !== initial) onCommit(value);
  };
  return (
    <label className={styles.contents}>
      <span className={styles.label}>{m.annot_comment_text()}</span>
      <textarea
        value={value}
        rows={4}
        disabled={disabled}
        placeholder={m.annot_comment_placeholder()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}
