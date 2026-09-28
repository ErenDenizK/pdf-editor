/**
 * Renames an outline item in place (F2, double-click, context menu, and right after "Add
 * bookmark"): Enter or leaving the field commits, Escape cancels. A blank title keeps the
 * field open with the reason below it; leaving the field with a blank title cancels.
 */
import type { DocumentId, OutlinePath } from '@pdf-editor/document-model';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { m } from '../i18n';
import styles from './Outline.module.css';
import { renameBookmark } from './outline-actions';
import { stopRenaming } from './outline-view-store';

/** A menu that started the rename returns focus to where it came from as it closes. */
const FOCUS_RETURN_GRACE_MS = 400;

export function OutlineRenameField({
  documentId,
  path,
  title,
  onDone,
}: {
  readonly documentId: DocumentId;
  readonly path: OutlinePath;
  readonly title: string;
  /** Called after commit or cancel; restores focus to the item. */
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(title);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const mountedAt = useRef(0);
  const errorId = useId();

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    mountedAt.current = performance.now();
    input.focus();
    input.select();
  }, []);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    stopRenaming();
    onDone();
  };

  const commit = () => {
    if (renameBookmark(documentId, path, value) === 'empty') {
      setError(true);
      return;
    }
    finish();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys typed here are text, never tree navigation or global shortcuts.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish();
    }
  };

  return (
    <span className={styles.renameWrap}>
      <input
        ref={ref}
        className={styles.renameInput}
        value={value}
        aria-label={m.outline_rename_label()}
        aria-invalid={error || undefined}
        aria-describedby={error ? errorId : undefined}
        spellCheck={false}
        autoComplete="off"
        data-testid="outline-rename-input"
        onChange={(event) => {
          setValue(event.target.value);
          if (error && event.target.value.trim() !== '') setError(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (finished.current) return;
          if (performance.now() - mountedAt.current < FOCUS_RETURN_GRACE_MS) {
            requestAnimationFrame(() => ref.current?.focus());
            return;
          }
          if (value.trim() === '') finish();
          else commit();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onDragStart={(event) => event.preventDefault()}
      />
      {error ? (
        <span id={errorId} role="alert" className={styles.renameError}>
          {m.outline_title_empty()}
        </span>
      ) : null}
    </span>
  );
}
