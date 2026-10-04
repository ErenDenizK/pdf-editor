/**
 * The centre pane. Empty: Home's empty variant, the onboarding drop target. Home
 * (`home/HomeView`, experience-redesign §3, ADR-0019 §1): the open files as cards, with no
 * mode control. With a document: the Read · Edit · Arrange control (ADR-0019 §2) over the
 * active document (`stage/ReadView`, `stage/ArrangeView`), plus the floating tool bar. Read
 * and Edit are the same page view with the document locked or not, so switching between
 * them never moves the page. The page view is keyed by document so switching tabs starts
 * fresh. The fourth view, Compare (`compare/CompareView`, loaded on first use), brings its
 * own bar; its segment shows only while a comparison is open (being set up, running or kept
 * after leaving the view; spec recognize-and-compare §2.2).
 *
 * The page view's focus ring shows only when the focus reached it by Tab or F6
 * (`watchStageFocusRing`, review finding 23): a click on the pages, or a key such as `2`
 * pressed while they have the focus, would otherwise turn on `:focus-visible` and frame the
 * whole stage as if the page were selected.
 */
import { Lock } from 'lucide-react';
import { type KeyboardEvent, lazy, Suspense, useEffect, useRef } from 'react';

import { commandRegistry } from '../commands/registry';
import { currentPlatform, type ParsedShortcut, toAriaKeyShortcut } from '../commands/shortcuts';
import { comparisonOpen, useCompareStore } from '../compare/compare-store';
import { HomeView } from '../home/HomeView';
import { m } from '../i18n';
import { ArrangeView } from '../stage/ArrangeView';
import { ReadView } from '../stage/ReadView';
import { documentModeOf, useUiStore, type ViewMode } from '../state/ui-store';
import { useActiveDocument, useHasDocuments, useWorkspaceStore } from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import { LayoutSwitch } from '../viewer/LayoutSwitch';
import { EmptyNote } from './EmptyNote';
import { FloatingToolbar } from './FloatingToolbar';
import styles from './Stage.module.css';
import { STAGE_ID, tabDomId } from './TabBar';
import { useCommandShortcut } from './use-command-shortcut';

// The Compare view (spec recognize-and-compare §2.2) loads with its first use.
const CompareView = lazy(() => import('../compare/CompareView'));

/** Keys after which the stage shows its focus ring: Tab (and Shift+Tab) and F6. */
const NAVIGATION_KEYS: ReadonlySet<string> = new Set(['Tab', 'F6']);
/** A focus change this soon after a navigation key came from it (ms). */
const NAVIGATION_FOCUS_MS = 500;
/** On the stage while the focus inside it arrived by Tab or F6 (ReadView.module.css). */
export const STAGE_FOCUS_RING_ATTR = 'data-focus-ring';

/**
 * Marks the stage with `data-focus-ring` while the focus in it arrived by Tab or F6, and
 * clears it on any other focus change and on a press, so the pages' ring shows only after
 * keyboard navigation (module header). Returns a disposer.
 */
export function watchStageFocusRing(doc: Document = document): () => void {
  let navigatedAt = Number.NEGATIVE_INFINITY;
  const stage = () => doc.getElementById(STAGE_ID);
  const onKeyDown = (event: globalThis.KeyboardEvent) => {
    navigatedAt = NAVIGATION_KEYS.has(event.key) ? performance.now() : Number.NEGATIVE_INFINITY;
  };
  const onFocusIn = (event: FocusEvent) => {
    const main = stage();
    if (!main || !(event.target instanceof Node) || !main.contains(event.target)) return;
    main.toggleAttribute(
      STAGE_FOCUS_RING_ATTR,
      performance.now() - navigatedAt <= NAVIGATION_FOCUS_MS,
    );
  };
  const onPointerDown = () => {
    navigatedAt = Number.NEGATIVE_INFINITY;
    stage()?.removeAttribute(STAGE_FOCUS_RING_ATTR);
  };
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
  };
}

export function Stage({ dragging }: { readonly dragging: boolean }) {
  useEffect(() => watchStageFocusRing(), []);
  const hasDocuments = useHasDocuments();
  const opening = useWorkspaceStore((s) => s.opening);
  const doc = useActiveDocument();
  const viewMode = useUiStore((s) => s.viewMode);
  const onHome = useUiStore((s) => s.destination === 'home');

  if (!hasDocuments) {
    return (
      <main
        id={STAGE_ID}
        className={styles.stage}
        aria-label={m.stage_start_label()}
        aria-busy={opening > 0}
      >
        <HomeView dragging={dragging} />
      </main>
    );
  }

  if (onHome) {
    // Home is a view of the open files, not of a document: no mode control (ADR-0019 §1).
    return (
      <main
        id={STAGE_ID}
        className={styles.stage}
        aria-label={m.home_label()}
        aria-busy={opening > 0}
      >
        <h1 className="visually-hidden">{m.home_long()}</h1>
        <HomeView dragging={dragging} />
      </main>
    );
  }

  return (
    // The main landmark, named by the active document's tab (which controls it). Not a
    // `tabpanel`: that role would take the landmark away (axe: landmark-one-main).
    <main
      id={STAGE_ID}
      aria-labelledby={doc ? tabDomId(doc.id) : undefined}
      aria-busy={opening > 0}
      className={styles.stage}
    >
      <h1 className="visually-hidden">{VIEW_HEADINGS[viewMode]()}</h1>
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

/** The stage's heading, for screen readers: the view's long name. */
const VIEW_HEADINGS: Readonly<Record<ViewMode, () => string>> = {
  read: m.mode_read_long,
  arrange: m.mode_arrange_long,
  compare: m.compare_mode_long,
};

/** A segment of the mode control: Read and Edit are the page view, locked or not. */
export type ModeSegment = 'read' | 'edit' | 'arrange' | 'compare';

const SEGMENTS: readonly {
  id: ModeSegment;
  label: () => string;
  /** The accessible name when the visible label alone would not say it (the lock). */
  name?: () => string;
  tooltip: () => string;
  command: string;
}[] = [
  {
    id: 'read',
    label: m.mode_read,
    name: m.mode_read_label,
    tooltip: m.mode_read_long,
    command: 'mode.read',
  },
  { id: 'edit', label: m.mode_edit, tooltip: m.mode_edit_long, command: 'mode.edit' },
  { id: 'arrange', label: m.mode_arrange, tooltip: m.mode_arrange_long, command: 'mode.arrange' },
  { id: 'compare', label: m.compare_mode, tooltip: m.compare_mode_long, command: 'mode.compare' },
];

/**
 * Read · Edit · Arrange (· Compare): a segmented control, APG radio group; arrows move and
 * select. Each segment runs its command (1–4), which also announces the change; the checked
 * segment does nothing.
 */
export function ModeSwitch() {
  const active = useWorkspaceStore((s) => s.workspace.activeDocument);
  const segment = useUiStore(
    (s): ModeSegment => (s.viewMode === 'read' ? documentModeOf(s, active) : s.viewMode),
  );
  const compareOpen = useCompareStore((s) => comparisonOpen(segment === 'compare', s.status));
  // Compare is entered with its command (4, the palette); the segment returns to it.
  const segments = SEGMENTS.filter((item) => item.id !== 'compare' || compareOpen);
  const shortcuts: Readonly<Record<ModeSegment, ParsedShortcut | undefined>> = {
    read: useCommandShortcut('mode.read'),
    edit: useCommandShortcut('mode.edit'),
    arrange: useCommandShortcut('mode.arrange'),
    compare: useCommandShortcut('mode.compare'),
  };
  const ref = useRef<HTMLDivElement>(null);

  const choose = (id: ModeSegment) => {
    // The checked segment again changes nothing, so it says nothing (craft spec §9).
    if (id === segment) return;
    const command = SEGMENTS.find((item) => item.id === id)?.command;
    if (command !== undefined) void commandRegistry.execute(command);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const index = segments.findIndex((item) => item.id === segment);
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = segments[(index + step + segments.length) % segments.length]?.id ?? 'read';
    choose(next);
    ref.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };

  return (
    <div ref={ref} role="radiogroup" aria-label={m.view_mode_label()} className={styles.segmented}>
      {segments.map((item) => {
        const checked = segment === item.id;
        const shortcut = shortcuts[item.id];
        return (
          <Tooltip key={item.id} label={item.tooltip()} shortcut={shortcut}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={item.name?.()}
              aria-keyshortcuts={
                shortcut ? toAriaKeyShortcut(shortcut, currentPlatform) : undefined
              }
              tabIndex={checked ? 0 : -1}
              data-mode={item.id}
              className={styles.segment}
              onKeyDown={onKeyDown}
              onClick={() => choose(item.id)}
            >
              {item.id === 'read' ? (
                <Lock className={styles.segmentIcon} aria-hidden="true" data-testid="read-lock" />
              ) : null}
              {item.label()}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
