/**
 * Comments in the Review tab (spec §9, experience-redesign §4.1): each annotation of the
 * active document is a row of the Review list with its kind, and its author, date and text
 * when it has them; an absent author or empty text is simply left out. Activating a row
 * shows its page in Read mode and selects it. The author name new annotations get (a local
 * setting, persisted in localStorage) is asked once, inline, above the list when the first
 * comment appears; "Set comment author name…" in the palette asks again.
 */
import type { Annotation } from '@pdf-editor/engine';
import { createElement, type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { useAnnotationStore } from '../annotations/annotation-store';
import { annotationIcon } from '../annotations/icons';
import { annotationName, capitalize } from '../annotations/labels';
import { getLocale, m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { announce } from './announcer';
import { useAuthorPrompt } from './comment-author';
import styles from './CommentsPanel.module.css';
import type { CommentItem } from './review/review-items';

const dateFormat = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
        date,
      );
};

/** The text a row quotes: a text box's text, otherwise the comment (/Contents). */
export function commentText(a: Annotation): string {
  return (a.kind === 'free-text' ? a.text : (a.contents ?? '')).trim();
}

/** "Name on your comments [______] Save · Skip": either answer marks the name as asked. */
export function AuthorPrompt({ focusOnMount = false }: { readonly focusOnMount?: boolean }) {
  const author = useAnnotationStore((s) => s.author);
  const [value, setValue] = useState(author);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    // Asked from the palette: the person is waiting to type. Never on the first comment.
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount]);
  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    const name = value.trim();
    useAnnotationStore.getState().setAuthor(name);
    useAuthorPrompt.getState().answer();
    if (name !== '') announce(m.comments_author_saved({ name }));
  };
  return (
    <form className={styles.author} data-author-prompt="" onSubmit={save}>
      <label htmlFor={id} className={styles.authorLabel}>
        {m.comments_author_prompt()}
      </label>
      <div className={styles.authorRow}>
        <input
          ref={input}
          id={id}
          className={styles.authorInput}
          value={value}
          placeholder={m.comments_author_placeholder()}
          autoComplete="name"
          spellCheck={false}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className={styles.authorButton}>
          {m.comments_author_save()}
        </button>
        <button
          type="button"
          className={styles.authorButton}
          onClick={() => useAuthorPrompt.getState().answer()}
        >
          {m.comments_author_skip()}
        </button>
      </div>
    </form>
  );
}

/** Shows the annotation's page in Read mode and selects it (an explicit select). */
function openComment(item: CommentItem): void {
  const workspace = useWorkspaceStore.getState();
  if (workspace.workspace.activeDocument !== item.documentId) workspace.setActive(item.documentId);
  useUiStore.getState().setViewMode('read');
  useViewStore.getState().scrollToPage(item.pageId);
  useAnnotationStore.getState().select({
    source: item.source,
    pageIndex: item.sourceIndex,
    pageId: item.pageId,
    position: item.position,
    ids: [item.annotation.id],
  });
}

/** One annotation: kind glyph and name; author, date and text only when it has them. */
export function CommentRow({ item }: { readonly item: CommentItem }) {
  const a = item.annotation;
  const selected = useAnnotationStore(
    (s) => s.selection?.pageId === item.pageId && s.selection.ids.includes(a.id),
  );
  const text = commentText(a);
  const author = a.author?.trim() ?? '';
  const when = a.modified ? dateFormat(a.modified) : '';
  return (
    <li data-review-kind="comment">
      <button
        type="button"
        className={styles.item}
        aria-current={selected ? 'true' : undefined}
        data-annotation-row={a.id}
        onClick={() => openComment(item)}
      >
        <span className={styles.icon} style={{ color: a.color ?? undefined }} aria-hidden="true">
          {createElement(annotationIcon(a))}
        </span>
        <span className={styles.body}>
          <span className={styles.meta}>
            <span className={styles.kind}>{capitalize(annotationName(a))}</span>
            {author !== '' ? <span className={styles.who}>{author}</span> : null}
            {when !== '' ? (
              <time className={styles.when} dateTime={a.modified}>
                {when}
              </time>
            ) : null}
          </span>
          {text !== '' ? <span className={styles.text}>{text}</span> : null}
        </span>
      </button>
    </li>
  );
}
