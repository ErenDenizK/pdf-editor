/**
 * Left rail "Comments" (spec §9): every annotation of the active document as a navigable
 * list grouped by page, with kind, author and text. Activating one shows its page in Read
 * mode and selects it. The author name new annotations get (a local setting, persisted in
 * localStorage) is asked once, inline, above the list when the first comment appears
 * (experience-redesign §4.1); "Set comment author name…" in the palette asks again.
 */
import type { PageId, SourceId, VirtualDocument } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { useAnnotationStore, visibleAnnotations } from '../annotations/annotation-store';
import { annotationIcon } from '../annotations/icons';
import { annotationName, capitalize } from '../annotations/labels';
import { getLocale, m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useActiveDocument } from '../state/workspace-store';
import { announce } from './announcer';
import { useAuthorPrompt } from './comment-author';
import styles from './CommentsPanel.module.css';
import { EmptyNote } from './EmptyNote';

interface PageGroup {
  readonly pageId: PageId;
  readonly source: SourceId;
  readonly sourceIndex: number;
  /** 1-based position in the document. */
  readonly position: number;
  readonly annotations: readonly Annotation[];
}

const dateFormat = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
        date,
      );
};

export function CommentsPanel() {
  const doc = useActiveDocument();
  const editing = useAuthorPrompt((s) => s.editing);
  return (
    <div className={styles.panel} data-comments-panel="">
      {editing ? <AuthorPrompt focusOnMount /> : null}
      {doc ? (
        <CommentList doc={doc} />
      ) : (
        <div className={styles.empty}>
          <EmptyNote title={m.no_document_title()} body={m.comments_no_document_body()} />
        </div>
      )}
    </div>
  );
}

/** "Name on your comments [______] Save · Skip": either answer marks the name as asked. */
function AuthorPrompt({ focusOnMount = false }: { readonly focusOnMount?: boolean }) {
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

function CommentList({ doc }: { readonly doc: VirtualDocument }) {
  const pages = useAnnotationStore((s) => s.pages);
  const ensurePage = useAnnotationStore((s) => s.ensurePage);
  const selection = useAnnotationStore((s) => s.selection);
  const ask = useAuthorPrompt((s) => !s.asked && !s.editing);

  useEffect(() => {
    for (const page of doc.pages) {
      if (page.ref.kind === 'source') ensurePage(page.ref.source, page.ref.index);
    }
  }, [doc, ensurePage]);

  const groups: PageGroup[] = [];
  let loading = false;
  doc.pages.forEach((page, i) => {
    if (page.ref.kind !== 'source') return;
    const entry = pages[`${page.ref.source}:${page.ref.index}`];
    if (!entry) {
      loading = true;
      return;
    }
    const annotations = visibleAnnotations(entry);
    if (annotations.length === 0) return;
    groups.push({
      pageId: page.id,
      source: page.ref.source,
      sourceIndex: page.ref.index,
      position: i + 1,
      annotations,
    });
  });

  if (groups.length === 0) {
    return (
      <div className={styles.empty} aria-busy={loading}>
        {loading ? (
          <EmptyNote title={m.comments_loading()} />
        ) : (
          <EmptyNote title={m.comments_empty_title()} body={m.comments_empty_body()} />
        )}
      </div>
    );
  }

  const open = (group: PageGroup, a: Annotation) => {
    useUiStore.getState().setViewMode('read');
    useViewStore.getState().scrollToPage(group.pageId);
    useAnnotationStore.getState().select({
      source: group.source,
      pageIndex: group.sourceIndex,
      pageId: group.pageId,
      position: group.position,
      ids: [a.id],
    });
  };

  return (
    <>
      {ask ? <AuthorPrompt /> : null}
      <div className={styles.scroll} aria-busy={loading}>
        {groups.map((group) => (
          <section
            key={group.pageId}
            className={styles.group}
            aria-label={m.comments_page({ page: group.position })}
          >
            <h3 className={styles.pageTitle}>{m.comments_page({ page: group.position })}</h3>
            <ul className={styles.list}>
              {group.annotations.map((a) => {
                const Icon = annotationIcon(a);
                const text = a.kind === 'free-text' ? a.text : (a.contents ?? '');
                const selected = selection?.pageId === group.pageId && selection.ids.includes(a.id);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={styles.item}
                      aria-current={selected ? 'true' : undefined}
                      data-annotation-row={a.id}
                      onClick={() => open(group, a)}
                    >
                      <span
                        className={styles.icon}
                        style={{ color: a.color ?? undefined }}
                        aria-hidden="true"
                      >
                        <Icon />
                      </span>
                      <span className={styles.body}>
                        <span className={styles.meta}>
                          <span className={styles.kind}>{capitalize(annotationName(a))}</span>
                          <span className={styles.who}>
                            {a.author && a.author !== '' ? a.author : m.annot_no_author()}
                          </span>
                          {a.modified ? (
                            <time className={styles.when} dateTime={a.modified}>
                              {dateFormat(a.modified)}
                            </time>
                          ) : null}
                        </span>
                        {text !== '' ? (
                          <span className={styles.text}>{text}</span>
                        ) : (
                          <span className={styles.noText}>{m.comments_no_text()}</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
