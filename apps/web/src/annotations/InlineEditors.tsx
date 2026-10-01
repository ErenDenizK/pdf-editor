/**
 * In-place editors (spec §3): the free-text box (auto-growing, font size from the style)
 * and the note popup (also used to edit any annotation's comment). They commit one history
 * entry: create on first commit, update when editing an existing annotation.
 *
 * The open editor registers its commit (`commitOpenEditor`): a press on the page with a
 * drawing tool commits the editor and goes on with the press (experience-redesign §6.1).
 * Neither commit selects what it created: creating does not select (§6.1, amendment A2).
 */
import type { Rect } from '@pdf-editor/document-model';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { m } from '../i18n';
import { createAnnotations, updateAnnotations } from './actions';
import { type InlineEditor, useAnnotationStore } from './annotation-store';
import { noteIconRect, type PageFrame, rectToCss, roundRect } from './geometry';
import styles from './AnnotationLayer.module.css';

/** The open editor's commit (at most one editor is open at a time). */
let openCommit: (() => void) | null = null;

/**
 * Commits the open inline editor: the text box creates or updates its annotation, the note
 * saves its comment (a new note with no text is dropped, as an empty text box is). Returns
 * whether an editor was open.
 */
export function commitOpenEditor(): boolean {
  const commit = openCommit;
  if (!commit) return false;
  commit();
  return true;
}

/** Registers the mounted editor's latest `commit` for `commitOpenEditor`. */
function useOpenCommit(commit: () => void): void {
  const latest = useRef(commit);
  useLayoutEffect(() => {
    latest.current = commit;
  });
  useEffect(() => {
    const run = () => {
      latest.current();
    };
    openCommit = run;
    return () => {
      if (openCommit === run) openCommit = null;
    };
  }, []);
}

export function InlineEditorView({
  editor,
  frame,
}: {
  readonly editor: InlineEditor;
  readonly frame: PageFrame;
}) {
  return editor.kind === 'free-text' ? (
    <FreeTextEditor editor={editor} frame={frame} />
  ) : (
    <NoteEditor editor={editor} frame={frame} />
  );
}

/** Minimum height of a text box: one line at the font size. */
function lineHeight(fontSize: number): number {
  return fontSize * 1.25;
}

function FreeTextEditor({
  editor,
  frame,
}: {
  readonly editor: Extract<InlineEditor, { kind: 'free-text' }>;
  readonly frame: PageFrame;
}) {
  const style = useAnnotationStore((s) => s.styles.text);
  const existing = useAnnotationStore((s) =>
    editor.id === undefined
      ? undefined
      : s.pages[`${editor.target.source}:${editor.target.pageIndex}`]?.annotations.find(
          (a) => a.id === editor.id,
        ),
  );
  const fontSize = existing?.kind === 'free-text' ? existing.fontSize : style.fontSize;
  const color = existing?.kind === 'free-text' ? (existing.textColor ?? '#000000') : style.color;
  const [text, setText] = useState(editor.text);
  const [heightPt, setHeightPt] = useState(Math.max(editor.rect.height, lineHeight(fontSize) + 4));
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const s = frame.scale;
  // The box keeps its top edge; it grows downward in user space (y decreases).
  const top = editor.rect.y + editor.rect.height;
  const widthPt = Math.max(40, editor.rect.width);
  const rect: Rect = { x: editor.rect.x, y: top - heightPt, width: widthPt, height: heightPt };
  const box = rectToCss(frame, rect);
  const quarter = frame.rotation === 90 || frame.rotation === 270;
  const w = quarter ? box.height : box.width;
  const h = quarter ? box.width : box.height;

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    const needed = el.scrollHeight / s + 2;
    el.style.height = '';
    if (Math.abs(needed - heightPt) > 0.5 && needed > lineHeight(fontSize)) setHeightPt(needed);
  }, [text, s, fontSize, heightPt]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const store = useAnnotationStore.getState();
    store.setEditor(null);
    const value = text.replace(/\s+$/, '');
    const final = roundRect(rect);
    if (editor.id === undefined) {
      if (value === '') return;
      void createAnnotations(editor.target, [
        {
          kind: 'free-text',
          pageIndex: editor.target.pageIndex,
          rect: final,
          text: value,
          fontSize,
          textColor: color,
          opacity: style.opacity,
        },
      ]);
      return;
    }
    if (value === editor.text) return;
    void updateAnnotations(
      editor.target,
      [editor.id],
      (a) =>
        a.kind === 'free-text' ? { ...a, text: value, contents: value, rect: final } : undefined,
      { action: 'text' },
    );
  };

  useOpenCommit(commit);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      event.stopPropagation();
      commit();
    }
  };

  return (
    <textarea
      ref={ref}
      className={styles.freeText}
      aria-label={m.annot_text_box_editor()}
      data-annotation-keep=""
      value={text}
      spellCheck
      style={{
        left: box.left + box.width / 2 - w / 2,
        top: box.top + box.height / 2 - h / 2,
        width: w,
        height: h,
        fontSize: fontSize * s,
        lineHeight: 1.25,
        color,
        transform: frame.rotation === 0 ? undefined : `rotate(${frame.rotation}deg)`,
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

function NoteEditor({
  editor,
  frame,
}: {
  readonly editor: Extract<InlineEditor, { kind: 'note' }>;
  readonly frame: PageFrame;
}) {
  const style = useAnnotationStore((s) => s.styles.note);
  const author = useAnnotationStore((s) => s.author);
  const existing = useAnnotationStore((s) =>
    editor.id === undefined
      ? undefined
      : s.pages[`${editor.target.source}:${editor.target.pageIndex}`]?.annotations.find(
          (a) => a.id === editor.id,
        ),
  );
  const [text, setText] = useState(editor.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  // A note's popup hangs off its drawn icon; other annotations' comments off their rect.
  const iconic = editor.id === undefined || existing?.kind === 'text';
  const box = rectToCss(frame, iconic ? noteIconRect(frame, editor.rect) : editor.rect);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const close = () => useAnnotationStore.getState().setEditor(null);
  const save = () => {
    close();
    const value = text.trim();
    if (editor.id === undefined) {
      void createAnnotations(editor.target, [
        {
          kind: 'text',
          pageIndex: editor.target.pageIndex,
          rect: editor.rect,
          contents: value,
          color: style.color,
          opacity: style.opacity,
          icon: 'Comment',
        },
      ]);
      return;
    }
    if (value === (existing?.contents ?? '')) return;
    void updateAnnotations(editor.target, [editor.id], (a) => ({ ...a, contents: value }), {
      action: 'comment',
    });
  };

  useOpenCommit(() => {
    if (editor.id === undefined && text.trim() === '') close();
    else save();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };

  const who = existing?.author ?? author;
  const when = existing?.modified;
  return (
    <div
      role="dialog"
      aria-label={editor.id === undefined ? m.annot_new_note() : m.annot_edit_comment()}
      className={styles.notePopup}
      data-annotation-keep=""
      style={{ left: box.left + box.width + 8, top: box.top }}
    >
      <div className={styles.noteMeta}>
        <span>{who === '' ? m.annot_no_author() : who}</span>
        {when ? <time dateTime={when}>{new Date(when).toLocaleString()}</time> : null}
      </div>
      <textarea
        ref={ref}
        className={styles.noteText}
        aria-label={m.annot_comment_text()}
        value={text}
        rows={4}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.noteActions}>
        <button type="button" className={styles.secondary} onClick={close}>
          {m.annot_cancel()}
        </button>
        <button type="button" className={styles.primary} onClick={save}>
          {m.annot_save()}
        </button>
      </div>
    </div>
  );
}
