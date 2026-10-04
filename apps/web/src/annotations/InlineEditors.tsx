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

/** A rectangle in client (viewport) coordinates, CSS px. */
export interface ClientBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Space between a note's icon and its popup, CSS px. */
const NOTE_POPUP_GAP = 8;

/**
 * Where the note popup goes, in client coordinates: to the right of its anchor, top edges
 * aligned; to the left where the right side has no room; upward (bottom edges aligned) where
 * it would run off the bottom; and always inside `bounds` as far as it fits.
 */
export function placeNotePopup(
  anchor: ClientBox,
  size: { readonly width: number; readonly height: number },
  bounds: ClientBox,
  gap: number = NOTE_POPUP_GAP,
): { left: number; top: number } {
  let left = anchor.right + gap;
  if (left + size.width > bounds.right) {
    const flipped = anchor.left - gap - size.width;
    left = flipped >= bounds.left ? flipped : bounds.right - size.width;
  }
  left = Math.max(bounds.left, left);
  let top = anchor.top;
  if (top + size.height > bounds.bottom) top = Math.min(top, anchor.bottom - size.height);
  top = Math.min(top, bounds.bottom - size.height);
  top = Math.max(bounds.top, top);
  return { left, top };
}

/**
 * The part of the screen a popover on a page must stay inside: the Read view's unobscured
 * rectangle (its full-bleed viewport less the scroll padding the docked frame takes), within
 * the window.
 */
function visibleBounds(el: HTMLElement): ClientBox {
  const windowBox = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const viewport = el.closest<HTMLElement>('[data-read-viewport]');
  if (!viewport) return windowBox;
  const r = viewport.getBoundingClientRect();
  const cs = getComputedStyle(viewport);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return {
    left: Math.max(windowBox.left, r.left + px(cs.scrollPaddingLeft)),
    top: Math.max(windowBox.top, r.top + px(cs.scrollPaddingTop)),
    right: Math.min(windowBox.right, r.right - px(cs.scrollPaddingRight)),
    bottom: Math.min(windowBox.bottom, r.bottom - px(cs.scrollPaddingBottom)),
  };
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
  const popupRef = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  // A note's popup hangs off its drawn icon; other annotations' comments off their rect.
  const iconic = editor.id === undefined || existing?.kind === 'text';
  const box = rectToCss(frame, iconic ? noteIconRect(frame, editor.rect) : editor.rect);
  const [position, setPosition] = useState({ left: box.left + box.width + 8, top: box.top });

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // Inside the visible part of the screen: flipped to the left near the right edge, upward
  // near the bottom (review F6: a note by the right edge opened half off-screen).
  useLayoutEffect(() => {
    const el = popupRef.current;
    const parent = el?.offsetParent;
    if (!el || !(parent instanceof HTMLElement)) return;
    const origin = parent.getBoundingClientRect();
    const anchor: ClientBox = {
      left: origin.left + box.left,
      top: origin.top + box.top,
      right: origin.left + box.left + box.width,
      bottom: origin.top + box.top + box.height,
    };
    const placed = placeNotePopup(
      anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      visibleBounds(el),
    );
    const next = { left: placed.left - origin.left, top: placed.top - origin.top };
    setPosition((previous) =>
      Math.abs(previous.left - next.left) < 0.5 && Math.abs(previous.top - next.top) < 0.5
        ? previous
        : next,
    );
  }, [box.left, box.top, box.width, box.height]);

  const close = () => {
    done.current = true;
    useAnnotationStore.getState().setEditor(null);
  };
  /** Saves the text; a new note left empty is dropped (nothing was created yet). */
  const save = () => {
    if (done.current) return;
    const value = text.trim();
    close();
    if (editor.id === undefined) {
      if (value === '') return;
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

  useOpenCommit(save);

  // A press anywhere outside the popup saves it (review F6), after the press's own handlers:
  // a drawing press commits through `commitOpenEditor` first and goes on with the stroke.
  const latestSave = useRef(save);
  useLayoutEffect(() => {
    latestSave.current = save;
  });
  useEffect(() => {
    // Not the press that opened the popup, if its effects ran while it was dispatched.
    const openedAt = performance.now();
    const onPointerDown = (event: PointerEvent) => {
      if (event.timeStamp < openedAt) return;
      const target = event.target;
      if (target instanceof Node && popupRef.current?.contains(target)) return;
      latestSave.current();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc saves, as a click away does; Cancel is the one way to drop what was typed.
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  };

  // The author from settings, or nothing: a header that says "No author" tells nobody anything.
  const who = existing?.author ?? author;
  const when = existing?.modified;
  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-label={editor.id === undefined ? m.annot_new_note() : m.annot_edit_comment()}
      className={styles.notePopup}
      data-annotation-keep=""
      data-testid="note-popup"
      style={{ left: position.left, top: position.top }}
    >
      {who !== '' || when ? (
        <div className={styles.noteMeta}>
          {who !== '' ? <span>{who}</span> : <span />}
          {when ? <time dateTime={when}>{new Date(when).toLocaleString()}</time> : null}
        </div>
      ) : null}
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
