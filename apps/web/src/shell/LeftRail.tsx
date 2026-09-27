/**
 * Left rail: an icon tab list (Pages / Outline / Files) and a collapsible, resizable panel.
 * Selecting the open view again collapses the panel (as in VS Code). State persists via
 * the UI store. Keyboard: Up/Down move between rail tabs, Enter/Space toggle.
 */
import { FileStack, Files, Keyboard, ListTree } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';

import { type SourceId, sourceReferences } from '@pdf-editor/document-model';

import { commandRegistry } from '../commands/registry';
import { formatBytes } from '../files/file-filters';
import { LEFT_PANEL_WIDTH, type LeftPanelView, useUiStore } from '../state/ui-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { ResizeHandle } from '../ui/ResizeHandle';
import { EmptyNote } from './EmptyNote';
import styles from './LeftRail.module.css';
import { PagesPanel } from './PagesPanel';
import { useCommandShortcut } from './use-command-shortcut';

const VIEWS: readonly { id: LeftPanelView; label: string; Icon: typeof FileStack }[] = [
  { id: 'pages', label: 'Pages', Icon: FileStack },
  { id: 'outline', label: 'Outline', Icon: ListTree },
  { id: 'files', label: 'Files', Icon: Files },
];

const PANEL_ID = 'left-panel';

export function LeftRail() {
  const open = useUiStore((s) => s.leftPanelOpen);
  const view = useUiStore((s) => s.leftPanelView);
  const width = useUiStore((s) => s.leftPanelWidth);
  const showView = useUiStore((s) => s.showLeftPanelView);
  const setWidth = useUiStore((s) => s.setLeftPanelWidth);
  const toggleShortcut = useCommandShortcut('view.toggleLeftPanel');
  const shortcutsShortcut = useCommandShortcut('help.shortcuts');
  const railRef = useRef<HTMLDivElement>(null);

  const onRailKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(railRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const index = tabs.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    tabs[next]?.focus();
  };

  const activeLabel = VIEWS.find((v) => v.id === view)?.label ?? '';

  return (
    <aside className={styles.left} aria-label="Navigator">
      <div className={styles.rail}>
        <div
          ref={railRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label="Navigator views"
          className={styles.railTabs}
        >
          {VIEWS.map(({ id, label, Icon }) => {
            const selected = open && view === id;
            return (
              <IconButton
                key={id}
                id={`rail-${id}`}
                role="tab"
                label={label}
                icon={<Icon />}
                tooltipSide="right"
                shortcut={selected ? toggleShortcut : undefined}
                aria-selected={selected}
                aria-controls={selected ? PANEL_ID : undefined}
                tabIndex={view === id ? 0 : -1}
                className={styles.railButton}
                onKeyDown={onRailKeyDown}
                onClick={() => showView(id)}
              />
            );
          })}
        </div>
        <div className={styles.railFooter}>
          <IconButton
            label="Keyboard shortcuts"
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
            {view === 'pages' ? <PagesView /> : null}
            {view === 'outline' ? <OutlineView /> : null}
            {view === 'files' ? <FilesView /> : null}
          </div>
          <ResizeHandle
            label="Resize navigator"
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

function PagesView() {
  const doc = useActiveDocument();
  if (!doc) {
    return (
      <div className={styles.pagesEmpty}>
        <EmptyNote title="No document open" body="Page thumbnails appear here." />
      </div>
    );
  }
  if (doc.pages.length === 0) {
    return (
      <div className={styles.pagesEmpty}>
        <EmptyNote title="No pages" body="This document has no pages left." />
      </div>
    );
  }
  return <PagesPanel doc={doc} />;
}

function OutlineView() {
  const doc = useActiveDocument();
  if (!doc)
    return (
      <EmptyNote title="No document open" body="Bookmarks of the open document appear here." />
    );
  return (
    <EmptyNote title="No outline" body="This document’s bookmarks appear here once it is parsed." />
  );
}

/** Opened files (sources). Clicking one activates the first document showing its pages. */
function FilesView() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const files = useWorkspaceStore((s) => s.files);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const sources = Object.keys(workspace.sources) as SourceId[];
  if (sources.length === 0) {
    return <EmptyNote title="No files open" body="Every file you open stays on this device." />;
  }
  return (
    <ul className={styles.fileList}>
      {sources.map((id) => {
        const info = files[id];
        const home = sourceReferences(workspace, id)[0]?.document;
        return (
          <li key={id}>
            <button
              type="button"
              className={styles.fileRow}
              aria-current={
                home !== undefined && home === workspace.activeDocument ? 'true' : undefined
              }
              disabled={home === undefined}
              onClick={() => {
                if (home !== undefined) setActive(home);
              }}
            >
              <span
                className={styles.fileTag}
                data-tag={info?.colorIndex ?? 0}
                aria-hidden="true"
              />
              <span className={styles.fileName}>{info?.name ?? workspace.sources[id]?.name}</span>
              <span className={styles.fileSize}>
                {formatBytes(info?.size ?? workspace.sources[id]?.byteLength ?? 0)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
