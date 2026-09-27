/**
 * Title bar with document tabs (APG Tabs pattern, automatic activation).
 *
 * Keyboard: Left/Right move between tabs and activate them, Home/End jump to the ends,
 * Delete closes the focused tab. Only the active tab is in the Tab order. The close "×"
 * is a pointer affordance and is hidden from assistive tech because it would otherwise
 * be an interactive element nested in a tab; keyboard and screen-reader users close with
 * Delete (announced through `aria-keyshortcuts`) or the "Close tab" command.
 */
import { PanelRight, Plus, Search, X } from 'lucide-react';
import { type KeyboardEvent, useEffect } from 'react';

import { openFilesFromPicker } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { currentPlatform, toAriaKeyShortcut } from '../commands/shortcuts';
import { useUiStore } from '../state/ui-store';
import { closeDocument, useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { Keycaps } from '../ui/Keycaps';
import { AppGlyph } from './AppGlyph';
import { announce } from './announcer';
import styles from './TabBar.module.css';
import { useCommandShortcut } from './use-command-shortcut';

export const STAGE_ID = 'stage';

export function tabDomId(documentId: string): string {
  return `tab-${documentId}`;
}

export function TabBar() {
  const documents = useWorkspaceStore((s) => s.documents);
  const activeTabId = useUiStore((s) => s.activeTabId);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const openShortcut = useCommandShortcut('file.open');
  const paletteShortcut = useCommandShortcut('view.palette');
  const rightShortcut = useCommandShortcut('view.toggleRightPanel');

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    if (!activeTabId) return;
    const el = document.getElementById(tabDomId(activeTabId));
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const focusTab = (id: string) => {
    setActiveTab(id);
    requestAnimationFrame(() => document.getElementById(tabDomId(id))?.focus());
  };

  const closeTab = (id: string, name: string, refocus: boolean) => {
    const index = documents.findIndex((d) => d.id === id);
    closeDocument(id);
    announce(`Closed ${name}`);
    if (!refocus) return;
    const next = documents[index + 1] ?? documents[index - 1];
    if (next) focusTab(next.id);
    else requestAnimationFrame(() => document.getElementById('open-files-button')?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = documents.findIndex((d) => d.id === activeTabId);
    if (index < 0) return;
    let target: number | null = null;
    if (event.key === 'ArrowRight') target = (index + 1) % documents.length;
    else if (event.key === 'ArrowLeft') target = (index - 1 + documents.length) % documents.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = documents.length - 1;
    else if (event.key === 'Delete') {
      event.preventDefault();
      const current = documents[index];
      if (current) closeTab(current.id, current.name, true);
      return;
    }
    if (target === null) return;
    event.preventDefault();
    const doc = documents[target];
    if (doc) focusTab(doc.id);
  };

  return (
    <header className={styles.bar}>
      <div className={styles.brand} title="pdf-editor">
        <AppGlyph />
      </div>

      <div className={styles.tabsRegion}>
        {documents.length > 0 ? (
          <div role="tablist" aria-label="Open documents" className={styles.tablist}>
            {documents.map((doc) => {
              const selected = doc.id === activeTabId;
              return (
                <div key={doc.id} className={styles.tabWrap} data-selected={selected || undefined}>
                  <button
                    type="button"
                    role="tab"
                    id={tabDomId(doc.id)}
                    aria-selected={selected}
                    aria-controls={STAGE_ID}
                    aria-keyshortcuts="Delete"
                    tabIndex={selected ? 0 : -1}
                    className={styles.tab}
                    onKeyDown={onKeyDown}
                    onClick={() => setActiveTab(doc.id)}
                    onMouseDown={(event) => {
                      // Middle click closes, as in browsers.
                      if (event.button === 1) {
                        event.preventDefault();
                        closeTab(doc.id, doc.name, false);
                      }
                    }}
                    title={doc.name}
                  >
                    <span className={styles.tag} data-tag={doc.colorIndex} aria-hidden="true" />
                    <span className={styles.name}>{doc.name}</span>
                  </button>
                  <span
                    aria-hidden="true"
                    className={styles.close}
                    onClick={() => closeTab(doc.id, doc.name, false)}
                  >
                    <X />
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        <IconButton
          id="open-files-button"
          label="Open files"
          icon={<Plus />}
          shortcut={openShortcut}
          onClick={() => void openFilesFromPicker()}
        />
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.search}
          aria-haspopup="dialog"
          aria-keyshortcuts={
            paletteShortcut ? toAriaKeyShortcut(paletteShortcut, currentPlatform) : undefined
          }
          onClick={() => void commandRegistry.execute('view.palette')}
        >
          <Search aria-hidden="true" />
          <span className={styles.searchLabel}>Search commands…</span>
          {paletteShortcut ? <Keycaps shortcut={paletteShortcut} /> : null}
        </button>
        {documents.length > 0 ? (
          <IconButton
            label={rightPanelOpen ? 'Hide right panel' : 'Show right panel'}
            icon={<PanelRight />}
            shortcut={rightShortcut}
            aria-pressed={rightPanelOpen}
            aria-controls="right-panel"
            onClick={toggleRightPanel}
          />
        ) : null}
      </div>
    </header>
  );
}
