/**
 * Right panel "Properties" for selected annotations (spec §2): the contextual bar's
 * controls plus kind, author, dates and the comment text. With nothing selected and a
 * drawing tool armed it shows that tool's style, so colour and width can be chosen before
 * drawing (experience-redesign spec §6.3; the tool bar's options tier takes this over in
 * T1). Renders `fallback` otherwise.
 */
import type { ReactNode } from 'react';
import { useId, useState } from 'react';

import { getLocale, m } from '../i18n';
import { useToolStore } from '../viewer/tool-store';
import { updateAnnotations } from './actions';
import { selectedAnnotations, useAnnotationStore } from './annotation-store';
import { toolStyleGroup } from './drafts';
import { annotationName, capitalize } from './labels';
import styles from './AnnotationProperties.module.css';
import { StyleControls } from './StyleControls';
import { toolDefinition } from './tools';

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
  const mode = useToolStore((s) => s.mode);
  const titleId = useId();
  const annotations = selectedAnnotations({ selection, pages });
  const first = annotations[0];
  if (!selection || !first) {
    const group = toolStyleGroup(mode);
    if (group === undefined) return <>{fallback}</>;
    const title = m.annot_tool_style({ tool: toolDefinition(mode).title() });
    return (
      <section
        className={styles.properties}
        aria-labelledby={titleId}
        data-annotation-keep=""
        data-testid="tool-style"
      >
        <p id={titleId} className={styles.label}>
          {title}
        </p>
        <p className={styles.note}>{m.annot_tool_style_hint()}</p>
        <StyleControls variant="tool" group={group} />
      </section>
    );
  }
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
