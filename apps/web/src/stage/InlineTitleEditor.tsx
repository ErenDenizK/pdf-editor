/**
 * Renames a document in place (tab or light-table section header): Enter or leaving the
 * field commits, Escape cancels. An unacceptable title (empty, too long, control
 * characters) keeps the field open with the reason below it; leaving the field with an
 * invalid title cancels instead of committing.
 */
import type { DocumentId } from '@pdf-editor/document-model';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import styles from './InlineTitleEditor.module.css';
import { validateTitle } from './operation-plans';
import { renameDocumentTo, titleProblemMessage } from './section-operations';

const FOCUS_RETURN_GRACE_MS = 400;

export function InlineTitleEditor({
  documentId,
  title,
  className,
  onDone,
}: {
  readonly documentId: DocumentId;
  readonly title: string;
  readonly className?: string | undefined;
  /** Called after commit or cancel; `committed` tells which. Restore focus here. */
  readonly onDone?: (committed: boolean) => void;
}) {
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
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

  const finish = (committed: boolean) => {
    if (finished.current) return;
    finished.current = true;
    useUiStore.getState().setRenaming(null);
    onDone?.(committed);
  };

  const commit = (): boolean => {
    const result = renameDocumentTo(documentId, value);
    if (!result.ok) {
      setError(titleProblemMessage(result.problem));
      return false;
    }
    finish(true);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };

  return (
    <span className={`${styles.wrap} ${className ?? ''}`}>
      <input
        ref={ref}
        className={styles.input}
        value={value}
        aria-label={m.rename_label()}
        aria-invalid={error !== null || undefined}
        aria-describedby={error === null ? undefined : errorId}
        spellCheck={false}
        autoComplete="off"
        data-testid="rename-input"
        onChange={(event) => {
          setValue(event.target.value);
          const checked = validateTitle(event.target.value);
          setError(
            checked.ok ? null : error === null ? null : titleProblemMessage(checked.problem),
          );
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // A menu that started the rename returns focus to its trigger as it closes;
          // take focus back instead of ending the edit right away.
          if (performance.now() - mountedAt.current < FOCUS_RETURN_GRACE_MS) {
            requestAnimationFrame(() => ref.current?.focus());
            return;
          }
          if (!validateTitle(value).ok) finish(false);
          else commit();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
      {error === null ? null : (
        <span id={errorId} role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </span>
  );
}
