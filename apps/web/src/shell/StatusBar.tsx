/**
 * Status bar: selection summary and the privacy indicator on the left; zoom and view mode
 * on the right. Numerals are tabular so counts never jitter (DESIGN.md §3).
 */
import { Menu } from '@base-ui/react/menu';
import { BookOpen, LayoutGrid, Minus, Plus } from 'lucide-react';

import { formatPercent, m } from '../i18n';
import { PrivacyIndicator } from '../privacy/PrivacyIndicator';
import { useShownSections } from '../stage/arrange-data';
import { useSelectionStore } from '../state/selection-store';
import { MAX_ZOOM, MIN_ZOOM, useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useActiveDocument, useHasDocuments, useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { Keycaps } from '../ui/Keycaps';
import menuStyles from '../ui/Menu.module.css';
import styles from './StatusBar.module.css';
import { useCommandShortcut } from './use-command-shortcut';

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** "N selected" or "N selected in M documents" (light-table spec §2). */
function useSelectionSummary(): string | null {
  const selected = useSelectionStore((s) => s.selected);
  const workspace = useWorkspaceStore((s) => s.workspace);
  if (selected.size === 0) return null;
  const documents = new Set<string>();
  for (const id of workspace.documentOrder) {
    if (workspace.documents[id]?.pages.some((p) => selected.has(p.id))) documents.add(id);
  }
  return documents.size > 1
    ? m.status_selected_in_documents({ count: selected.size, documents: documents.size })
    : m.status_selected({ count: selected.size });
}

/** "· N documents shown" when the light table shows more than one section (spec §6). */
function ArrangeShown() {
  const shown = useShownSections().length;
  if (shown < 2) return null;
  return (
    <>
      <span className={styles.dot} aria-hidden="true">
        ·
      </span>
      <span className={styles.item} data-testid="status-shown">
        {m.status_documents_shown({ count: shown })}
      </span>
    </>
  );
}

export function StatusBar() {
  const hasDocuments = useHasDocuments();
  const doc = useActiveDocument();
  const opening = useWorkspaceStore((s) => s.opening);
  const viewMode = useUiStore((s) => s.viewMode);
  const currentPage = useViewStore((s) => s.currentPage);
  const selection = useSelectionSummary();
  const pageCount = doc?.pages.length ?? 0;
  let summary: string;
  if (!doc) {
    summary = opening > 0 ? m.status_opening({ count: opening }) : m.documents_count({ count: 0 });
  } else if (viewMode === 'read' && pageCount > 0) {
    summary = m.status_page_of({
      current: Math.min(currentPage, pageCount - 1) + 1,
      total: pageCount,
    });
  } else summary = m.pages_count({ count: pageCount });

  return (
    <footer className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.item} data-testid="status-pages">
          {summary}
        </span>
        {viewMode === 'arrange' ? <ArrangeShown /> : null}
        {selection ? (
          <>
            <span className={styles.dot} aria-hidden="true">
              ·
            </span>
            <span className={styles.item}>{selection}</span>
          </>
        ) : null}
        {doc && opening > 0 ? (
          <>
            <span className={styles.dot} aria-hidden="true">
              ·
            </span>
            <span className={styles.item}>{m.status_opening({ count: opening })}</span>
          </>
        ) : null}
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <PrivacyIndicator />
      </div>
      {hasDocuments ? (
        <div className={styles.right}>
          <ZoomControls />
          <span className={styles.divider} aria-hidden="true" />
          <ModeToggles />
        </div>
      ) : null}
    </footer>
  );
}

function ZoomControls() {
  const zoom = useUiStore((s) => s.zoom);
  const fitMode = useUiStore((s) => s.fitMode);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const zoomFit = useUiStore((s) => s.zoomFit);
  const zoomFitPage = useUiStore((s) => s.zoomFitPage);
  const setZoom = useUiStore((s) => s.setZoom);
  const inShortcut = useCommandShortcut('zoom.in');
  const outShortcut = useCommandShortcut('zoom.out');
  const fitShortcut = useCommandShortcut('zoom.fit');
  const percent = formatPercent(zoom);

  return (
    <div className={styles.zoom}>
      <IconButton
        label={m.zoom_out()}
        icon={<Minus />}
        shortcut={outShortcut}
        tooltipSide="top"
        className={styles.small}
        disabled={zoom <= MIN_ZOOM}
        onClick={zoomOut}
      />
      <Menu.Root>
        <Menu.Trigger className={styles.zoomValue} aria-label={m.zoom_value_label({ percent })}>
          {percent}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="center" sideOffset={8} collisionPadding={8}>
            <Menu.Popup className={menuStyles.popup}>
              <Menu.RadioGroup
                value={fitMode === null ? String(zoom) : `fit-${fitMode}`}
                onValueChange={(value: string) => {
                  if (value === 'fit-width') zoomFit();
                  else if (value === 'fit-page') zoomFitPage();
                  else setZoom(Number(value));
                }}
              >
                <Menu.RadioItem className={menuStyles.item} value="fit-width" closeOnClick>
                  <span className={menuStyles.check} aria-hidden="true" />
                  <span className={menuStyles.label}>{m.zoom_fit_width()}</span>
                  {fitShortcut ? <Keycaps shortcut={fitShortcut} tone="quiet" /> : null}
                </Menu.RadioItem>
                <Menu.RadioItem className={menuStyles.item} value="fit-page" closeOnClick>
                  <span className={menuStyles.check} aria-hidden="true" />
                  <span className={menuStyles.label}>{m.zoom_fit_page()}</span>
                </Menu.RadioItem>
                <Menu.Separator className={menuStyles.separator} />
                {ZOOM_PRESETS.map((preset) => (
                  <Menu.RadioItem
                    key={preset}
                    className={menuStyles.item}
                    value={String(preset)}
                    closeOnClick
                  >
                    <span className={menuStyles.check} aria-hidden="true" />
                    <span className={`${menuStyles.label} ${styles.numeric}`}>
                      {formatPercent(preset)}
                    </span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <IconButton
        label={m.zoom_in()}
        icon={<Plus />}
        shortcut={inShortcut}
        tooltipSide="top"
        className={styles.small}
        disabled={zoom >= MAX_ZOOM}
        onClick={zoomIn}
      />
    </div>
  );
}

function ModeToggles() {
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const readShortcut = useCommandShortcut('mode.read');
  const arrangeShortcut = useCommandShortcut('mode.arrange');
  return (
    <div className={styles.modes}>
      <IconButton
        label={m.mode_read_long()}
        icon={<BookOpen />}
        shortcut={readShortcut}
        tooltipSide="top"
        className={styles.small}
        aria-pressed={viewMode === 'read'}
        onClick={() => setViewMode('read')}
      />
      <IconButton
        label={m.mode_arrange_long()}
        icon={<LayoutGrid />}
        shortcut={arrangeShortcut}
        tooltipSide="top"
        className={styles.small}
        aria-pressed={viewMode === 'arrange'}
        onClick={() => setViewMode('arrange')}
      />
    </div>
  );
}
