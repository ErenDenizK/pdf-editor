/**
 * The centre pane. Empty: the onboarding drop target. With a document: the Read / Arrange
 * mode switch over the active document (`stage/ReadView`, `stage/ArrangeView`), plus the
 * floating tool bar. Both views are keyed by document so switching tabs starts fresh. The
 * third view, Compare (`compare/CompareView`, loaded on first use), brings its own bar; its
 * segment in the mode switch shows only while a comparison is open (being set up, running
 * or kept after leaving the view; spec recognize-and-compare §2.2).
 */
import { type KeyboardEvent, lazy, Suspense, useRef } from 'react';

import { comparisonOpen, useCompareStore } from '../compare/compare-store';
import { m } from '../i18n';
import { ArrangeView } from '../stage/ArrangeView';
import { ReadView } from '../stage/ReadView';
import { useUiStore, type ViewMode } from '../state/ui-store';
import { useActiveDocument, useHasDocuments, useWorkspaceStore } from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import { LayoutSwitch } from '../viewer/LayoutSwitch';
import { EmptyNote } from './EmptyNote';
import { EmptyState } from './EmptyState';
import { FloatingToolbar } from './FloatingToolbar';
import styles from './Stage.module.css';
import { STAGE_ID, tabDomId } from './TabBar';
import { useCommandShortcut } from './use-command-shortcut';

// The Compare view (spec recognize-and-compare §2.2) loads with its first use.
const CompareView = lazy(() => import('../compare/CompareView'));

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
        {viewMode === 'read' && doc && doc.pages.length > 0 ? (
          <div className={styles.headerEnd}>
            <LayoutSwitch />
          </div>
        ) : null}
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
      {viewMode === 'compare' ? (
        <Suspense fallback={null}>
          <CompareView dragging={dragging} />
        </Suspense>
      ) : null}
      {viewMode === 'compare' ? null : <FloatingToolbar />}
      {/* In Arrange and Compare, the view outlines its own file-drop targets. */}
      {dragging && viewMode === 'read' ? (
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
  { id: 'compare', label: m.compare_mode, tooltip: m.compare_mode_long, command: 'mode.compare' },
];

/** Segmented control, APG radio group: arrows move and select. */
function ModeSwitch() {
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const compareOpen = useCompareStore((s) => comparisonOpen(viewMode === 'compare', s.status));
  // Compare is entered with its command (3, the palette); the segment returns to it.
  const modes = compareOpen ? MODES : MODES.filter((mode) => mode.id !== 'compare');
  const shortcuts = {
    read: useCommandShortcut('mode.read'),
    arrange: useCommandShortcut('mode.arrange'),
    compare: useCommandShortcut('mode.compare'),
  };
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const index = modes.findIndex((mode) => mode.id === viewMode);
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next: ViewMode = modes[(index + step + modes.length) % modes.length]?.id ?? 'read';
    setViewMode(next);
    ref.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };

  return (
    <div ref={ref} role="radiogroup" aria-label={m.view_mode_label()} className={styles.segmented}>
      {modes.map((mode) => {
        const checked = viewMode === mode.id;
        return (
          <Tooltip key={mode.id} label={mode.tooltip()} shortcut={shortcuts[mode.id]}>
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
