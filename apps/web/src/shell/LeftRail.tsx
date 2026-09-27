/**
 * Left rail: an icon tab list (Pages / Outline / Files) and a collapsible, resizable panel.
 * Selecting the open view again collapses the panel (as in VS Code). State persists via
 * the UI store. Keyboard: Up/Down move between rail tabs, Enter/Space toggle.
 */
import { FileStack, Files, Keyboard, ListTree } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';

import { commandRegistry } from '../commands/registry';
import { formatBytes } from '../files/file-filters';
import { LEFT_PANEL_WIDTH, type LeftPanelView, useUiStore } from '../state/ui-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { ResizeHandle } from '../ui/ResizeHandle';
import { EmptyNote } from './EmptyNote';
import styles from './LeftRail.module.css';
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
          <div className={styles.panelBody}>
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
  if (!doc) return <EmptyNote title="No document open" body="Page thumbnails appear here." />;
  return (
    <EmptyNote
      title="Thumbnails not rendered yet"
      body="Page thumbnails appear once the rendering engine is connected."
    />
  );
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

function FilesView() {
  const documents = useWorkspaceStore((s) => s.documents);
  const activeTabId = useUiStore((s) => s.activeTabId);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  if (documents.length === 0) {
    return <EmptyNote title="No files open" body="Every file you open stays on this device." />;
  }
  return (
    <ul className={styles.fileList}>
      {documents.map((doc) => (
        <li key={doc.id}>
          <button
            type="button"
            className={styles.fileRow}
            aria-current={doc.id === activeTabId ? 'true' : undefined}
            onClick={() => setActiveTab(doc.id)}
          >
            <span className={styles.fileTag} data-tag={doc.colorIndex} aria-hidden="true" />
            <span className={styles.fileName}>{doc.name}</span>
            <span className={styles.fileSize}>{formatBytes(doc.size)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
