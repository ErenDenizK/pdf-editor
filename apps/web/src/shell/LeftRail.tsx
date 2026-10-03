/**
 * The navigator (experience-redesign §4.1): four labelled tabs with live counts, Pages
 * (thumbnails, or the outline under "Bookmarks"), Find, Review (comments, redaction marks
 * and form fields in one list) and Files, plus Compare's Changes, shown only in the Compare
 * view and last so the other four never move. A collapsible, resizable panel shows the
 * chosen tab; choosing the open tab again collapses it (as in VS Code). State persists via
 * the UI store (`ui:v2`). With no file open the panel stays collapsed, since every tab would
 * only say "No document open" (M6 review A1); the stored state is kept, so it reopens as it
 * was when a file opens, and a tab picked meanwhile opens it.
 *
 * Keyboard: a vertical tablist with roving tabindex; Up / Down (Home / End) move between
 * tabs, Enter / Space open; Tab moves into the panel. The accessible name carries the
 * count ("Review, 3 items"). F6 / Shift+F6 cycle the app's regions (`LeftRail.regions.ts`,
 * installed by the app shell).
 */
import { FileDiff, FileStack, Files, Keyboard, MessageSquareText, Search } from 'lucide-react';
import { type KeyboardEvent, lazy, Suspense, useRef, useState } from 'react';

import { commandRegistry } from '../commands/registry';
import { currentPlatform, toAriaKeyShortcut } from '../commands/shortcuts';
import { formatNumber, m } from '../i18n';
import { LEFT_PANEL_WIDTH, type LeftPanelView, stageView, useUiStore } from '../state/ui-store';
import { useActiveDocument, useHasDocuments, useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { ResizeHandle } from '../ui/ResizeHandle';
import { useSearchStore } from '../viewer/search';
import { FilesList } from './files/FilesList';
import styles from './LeftRail.module.css';
import { PagesTab } from './panels/PagesTab';
import { ReviewPanel } from './review/ReviewPanel';
import { countItems, useReadReviewData, useReviewData } from './review/review-items';
import { SearchPanel } from './SearchPanel';
import { useCommandShortcut } from './use-command-shortcut';

interface Tab {
  readonly id: LeftPanelView;
  readonly label: () => string;
  readonly Icon: typeof FileStack;
}

const TABS: readonly Tab[] = [
  { id: 'pages', label: m.nav_tab_pages, Icon: FileStack },
  { id: 'find', label: m.nav_tab_find, Icon: Search },
  { id: 'review', label: m.nav_tab_review, Icon: MessageSquareText },
  { id: 'files', label: m.nav_tab_files, Icon: Files },
];

/** Shown only in the Compare view, after the four (spec recognize-and-compare §2.2). */
const CHANGES_TAB: Tab = { id: 'changes', label: m.compare_changes, Icon: FileDiff };

// The Changes list loads with the Compare view.
const ChangesPanel = lazy(() => import('../compare/ChangesPanel'));

const PANEL_ID = 'left-panel';

const TABBABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], summary, [tabindex]';

/** The panel's first control in the Tab order, if any. */
function firstTabbable(panel: HTMLElement | null): HTMLElement | undefined {
  return Array.from(panel?.querySelectorAll<HTMLElement>(TABBABLE) ?? []).find(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/** Badge text: hidden at 0, "99+" above 99. */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? `${formatNumber(99)}+` : formatNumber(count);
}

/** Live counts per tab: pages, matches of the current search, review items, open files. */
function useTabCounts(): Readonly<Partial<Record<LeftPanelView, number>>> {
  const doc = useActiveDocument();
  const files = useWorkspaceStore((s) => s.workspace.documentOrder.length);
  const matches = useSearchStore((s) => (s.documentId === doc?.id ? s.hits.length : 0));
  useReadReviewData();
  const review = countItems(useReviewData().items).all;
  return { pages: doc?.pages.length ?? 0, find: matches, review, files };
}

export function LeftRail() {
  const stored = useUiStore((s) => s.leftPanelOpen);
  const view = useUiStore((s) => s.leftPanelView);
  const hasDocuments = useHasDocuments();
  // Collapsed while no file is open, unless a tab was picked since (`peek`).
  const [peek, setPeek] = useState(false);
  if (hasDocuments && peek) setPeek(false);
  const open = stored && (hasDocuments || peek);
  const width = useUiStore((s) => s.leftPanelWidth);
  const showView = useUiStore((s) => s.showLeftPanelView);
  const setWidth = useUiStore((s) => s.setLeftPanelWidth);
  const toggleShortcut = useCommandShortcut('view.toggleLeftPanel');
  const shortcutsShortcut = useCommandShortcut('help.shortcuts');
  const railRef = useRef<HTMLDivElement>(null);
  const comparing = useUiStore((s) => stageView(s) === 'compare');
  const tabs = comparing ? [...TABS, CHANGES_TAB] : TABS;
  const counts = useTabCounts();

  // Roving tabindex: the tab last moved to with the arrows, else the shown view's tab.
  const [roving, setRoving] = useState<LeftPanelView | null>(null);
  const stop = [roving, view].find((id) => tabs.some((t) => t.id === id)) ?? 'pages';
  const onRailKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Tab from a tab goes into the open panel (APG tabs), past the rail's footer button.
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey) {
      const first = firstTabbable(document.getElementById(PANEL_ID));
      if (!first) return;
      event.preventDefault();
      first.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const index = tabs.findIndex((t) => `rail-${t.id}` === event.currentTarget.id);
    if (index < 0) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    const id = tabs[next]?.id;
    if (id === undefined) return;
    setRoving(id);
    railRef.current?.querySelector<HTMLElement>(`#rail-${id}`)?.focus();
  };

  const activeLabel = tabs.find((t) => t.id === view)?.label() ?? '';
  const keys = toggleShortcut ? toAriaKeyShortcut(toggleShortcut, currentPlatform) : undefined;

  return (
    <aside className={styles.left} aria-label={m.nav_label()} data-region="navigator">
      <div className={styles.rail}>
        <div
          ref={railRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label={m.nav_views_label()}
          className={styles.railTabs}
        >
          {tabs.map(({ id, label, Icon }) => {
            const selected = open && view === id;
            const count = counts[id] ?? 0;
            const badge = badgeText(count);
            return (
              <button
                key={id}
                type="button"
                id={`rail-${id}`}
                role="tab"
                aria-label={count > 0 ? m.nav_count_name({ label: label(), count }) : label()}
                aria-selected={selected}
                aria-controls={selected ? PANEL_ID : undefined}
                aria-keyshortcuts={selected ? keys : undefined}
                tabIndex={stop === id ? 0 : -1}
                className={styles.tab}
                data-tab={id}
                onKeyDown={onRailKeyDown}
                onClick={() => {
                  setRoving(null);
                  if (!open && !hasDocuments) {
                    // Collapsed only because no file is open: the picked tab opens it.
                    setPeek(true);
                    if (stored && view === id) return;
                  }
                  showView(id);
                }}
              >
                <span className={styles.tabIcon} aria-hidden="true">
                  <Icon />
                  {badge !== '' ? (
                    <span className={styles.badge} data-testid={`rail-count-${id}`}>
                      {badge}
                    </span>
                  ) : null}
                </span>
                <span className={styles.tabLabel} aria-hidden="true">
                  {label()}
                </span>
              </button>
            );
          })}
        </div>
        <div className={styles.railFooter}>
          <IconButton
            label={m.keyboard_shortcuts()}
            icon={<Keyboard />}
            tooltipSide="right"
            shortcut={shortcutsShortcut}
            aria-haspopup="dialog"
            onClick={() => void commandRegistry.execute('help.shortcuts')}
          />
        </div>
      </div>

      {open ? (
        <section
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={`rail-${view}`}
          className={styles.panel}
          style={{ width }}
        >
          <h2 className={styles.panelTitle}>{activeLabel}</h2>
          <div className={styles.panelBody} data-view={view}>
            {view === 'pages' ? <PagesTab /> : null}
            {view === 'find' ? <SearchPanel /> : null}
            {view === 'review' ? <ReviewPanel /> : null}
            {view === 'files' ? <FilesList /> : null}
            {view === 'changes' && comparing ? (
              <Suspense fallback={null}>
                <ChangesPanel />
              </Suspense>
            ) : null}
          </div>
          <ResizeHandle
            label={m.nav_resize()}
            controls={PANEL_ID}
            value={width}
            min={LEFT_PANEL_WIDTH.min}
            max={LEFT_PANEL_WIDTH.max}
            direction={1}
            onChange={setWidth}
          />
        </section>
      ) : null}
    </aside>
  );
}
