/**
 * The centre pane. Empty: the onboarding drop target. With a document: the Read / Arrange
 * mode switch over the active document (`stage/ReadView`, `stage/ArrangeView`), plus the
 * floating tool bar. Both views are keyed by document so switching tabs starts fresh.
 */
import { type KeyboardEvent, useRef } from 'react';

import { m } from '../i18n';
import { ArrangeView } from '../stage/ArrangeView';
import { ReadView } from '../stage/ReadView';
import { useUiStore, type ViewMode } from '../state/ui-store';
import { useActiveDocument, useHasDocuments, useWorkspaceStore } from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import { EmptyNote } from './EmptyNote';
import { EmptyState } from './EmptyState';
import { FloatingToolbar } from './FloatingToolbar';
import styles from './Stage.module.css';
import { STAGE_ID, tabDomId } from './TabBar';
import { useCommandShortcut } from './use-command-shortcut';

export function Stage({ dragging }: { readonly dragging: boolean }) {
  const hasDocuments = useHasDocuments();
  const opening = useWorkspaceStore((s) => s.opening);
  const doc = useActiveDocument();
  const viewMode = useUiStore((s) => s.viewMode);

  if (!hasDocuments) {
    return (
      <main
        id={STAGE_ID}
        className={styles.stage}
        aria-label={m.stage_start_label()}
        aria-busy={opening > 0}
      >
        <EmptyState dragging={dragging} />
      </main>
    );
  }

  return (
    <main
      id={STAGE_ID}
      role="tabpanel"
      aria-labelledby={doc ? tabDomId(doc.id) : undefined}
      aria-busy={opening > 0}
      className={styles.stage}
    >
      <div className={styles.header}>
        <ModeSwitch />
      </div>
      {doc?.pages.length === 0 && viewMode === 'read' ? (
        <div className={styles.emptyDocument}>
          <EmptyNote title={m.stage_no_pages_title()} body={m.stage_no_pages_body()} />
        </div>
      ) : null}
      {/* Arrange is not keyed: it shows several documents (sections) and keeps its scroll. */}
      {viewMode === 'arrange' ? <ArrangeView /> : null}
      {doc && doc.pages.length > 0 && viewMode === 'read' ? (
        <ReadView key={doc.id} doc={doc} />
      ) : null}
      <FloatingToolbar />
      {/* In Arrange, the light table outlines its own file-drop targets. */}
      {dragging && viewMode !== 'arrange' ? (
        <div className={styles.dropOverlay} aria-hidden="true">
          <span className={styles.dropLabel}>{m.stage_drop_overlay()}</span>
        </div>
      ) : null}
    </main>
  );
}

const MODES: readonly {
  id: ViewMode;
  label: () => string;
  tooltip: () => string;
  command: string;
}[] = [
  { id: 'read', label: m.mode_read, tooltip: m.mode_read_long, command: 'mode.read' },
  { id: 'arrange', label: m.mode_arrange, tooltip: m.mode_arrange_long, command: 'mode.arrange' },
];

/** Segmented control, APG radio group: arrows move and select. */
function ModeSwitch() {
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const readShortcut = useCommandShortcut('mode.read');
  const arrangeShortcut = useCommandShortcut('mode.arrange');
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next: ViewMode = viewMode === 'read' ? 'arrange' : 'read';
    setViewMode(next);
    ref.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };

  return (
    <div ref={ref} role="radiogroup" aria-label={m.view_mode_label()} className={styles.segmented}>
      {MODES.map((mode) => {
        const checked = viewMode === mode.id;
        return (
          <Tooltip
            key={mode.id}
            label={mode.tooltip()}
            shortcut={mode.id === 'read' ? readShortcut : arrangeShortcut}
          >
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              data-mode={mode.id}
              className={styles.segment}
              onKeyDown={onKeyDown}
              onClick={() => setViewMode(mode.id)}
            >
              {mode.label()}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
