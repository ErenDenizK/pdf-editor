/**
 * The centre pane. Empty: the onboarding drop target. With a document: the Read / Arrange
 * mode switch over a placeholder surface, plus the floating tool bar.
 *
 * TODO(engine): replace the placeholder sheets with the virtualized page canvas (Read) and
 * the light table grid (Arrange, `role="grid"`, DESIGN.md §5).
 */
import { type KeyboardEvent, useEffect, useRef } from 'react';

import { formatBytes } from '../files/file-filters';
import { useUiStore, type ViewMode } from '../state/ui-store';
import {
  useActiveDocument,
  useWorkspaceStore,
  type WorkspaceDocument,
} from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import { EmptyState } from './EmptyState';
import { FloatingToolbar } from './FloatingToolbar';
import styles from './Stage.module.css';
import { STAGE_ID, tabDomId } from './TabBar';
import { useCommandShortcut } from './use-command-shortcut';

/** US Letter at 96 CSS px per inch; the placeholder page size until real pages exist. */
export const PLACEHOLDER_PAGE = { width: 816, height: 1056 } as const;
const READ_PADDING = 48;

export function Stage({ dragging }: { readonly dragging: boolean }) {
  const hasDocuments = useWorkspaceStore((s) => s.documents.length > 0);
  const activeTabId = useUiStore((s) => s.activeTabId);
  const viewMode = useUiStore((s) => s.viewMode);

  if (!hasDocuments) {
    return (
      <main id={STAGE_ID} className={styles.stage} aria-label="Start">
        <EmptyState dragging={dragging} />
      </main>
    );
  }

  return (
    <main
      id={STAGE_ID}
      role="tabpanel"
      aria-labelledby={activeTabId ? tabDomId(activeTabId) : undefined}
      className={styles.stage}
    >
      <div className={styles.header}>
        <ModeSwitch />
      </div>
      {viewMode === 'read' ? <ReadSurface /> : <ArrangeSurface />}
      <FloatingToolbar />
      {dragging ? (
        <div className={styles.dropOverlay} aria-hidden="true">
          <span className={styles.dropLabel}>Drop to open in new tabs</span>
        </div>
      ) : null}
    </main>
  );
}

const MODES: readonly { id: ViewMode; label: string; command: string }[] = [
  { id: 'read', label: 'Read', command: 'mode.read' },
  { id: 'arrange', label: 'Arrange', command: 'mode.arrange' },
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
    <div ref={ref} role="radiogroup" aria-label="View mode" className={styles.segmented}>
      {MODES.map((mode) => {
        const checked = viewMode === mode.id;
        return (
          <Tooltip
            key={mode.id}
            label={`${mode.label} mode`}
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
              {mode.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ReadSurface() {
  const doc = useActiveDocument();
  const zoom = useUiStore((s) => s.zoom);
  const zoomToFit = useUiStore((s) => s.zoomToFit);
  const applyFitZoom = useUiStore((s) => s.applyFitZoom);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !zoomToFit) return;
    const fit = () => applyFitZoom((el.clientWidth - READ_PADDING * 2) / PLACEHOLDER_PAGE.width);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [zoomToFit, applyFitZoom]);

  if (!doc) return null;
  return (
    <div ref={viewportRef} className={styles.viewport}>
      <div className={styles.readColumn}>
        <div
          role="img"
          aria-label={`Page 1 of ${doc.name}, not rendered yet`}
          className={styles.page}
          style={{ width: PLACEHOLDER_PAGE.width * zoom, height: PLACEHOLDER_PAGE.height * zoom }}
        />
        <p
          className={styles.caption}
          style={{ maxWidth: Math.max(PLACEHOLDER_PAGE.width * zoom, 240) }}
        >
          <span className={styles.captionName}>{doc.name}</span>
          <span aria-hidden="true">·</span>
          <span className={styles.numeric}>{formatBytes(doc.size)}</span>
        </p>
      </div>
    </div>
  );
}

function ArrangeSurface() {
  const documents = useWorkspaceStore((s) => s.documents);
  const activeTabId = useUiStore((s) => s.activeTabId);
  return (
    <div className={styles.viewport}>
      <ul className={styles.grid} aria-label="Documents on the light table">
        {documents.map((doc) => (
          <ArrangeCard key={doc.id} doc={doc} active={doc.id === activeTabId} />
        ))}
      </ul>
    </div>
  );
}

function ArrangeCard({
  doc,
  active,
}: {
  readonly doc: WorkspaceDocument;
  readonly active: boolean;
}) {
  return (
    <li className={styles.card} data-active={active || undefined}>
      <div
        className={styles.thumb}
        role="img"
        aria-label={`First page of ${doc.name}, not rendered yet`}
      />
      <div className={styles.cardMeta}>
        <span className={styles.cardTag} data-tag={doc.colorIndex} aria-hidden="true" />
        <span className={styles.cardName}>{doc.name}</span>
      </div>
    </li>
  );
}
