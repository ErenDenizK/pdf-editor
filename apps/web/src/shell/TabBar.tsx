/**
 * Title bar with document tabs (APG Tabs pattern, automatic activation).
 *
 * Keyboard: Left/Right move between tabs and activate them, Home/End jump to the ends,
 * Delete closes the focused tab, F2 (or a double click) renames it in place. Only the active tab is in the Tab order. The close "×"
 * is a pointer affordance and is hidden from assistive tech because it would otherwise
 * be an interactive element nested in a tab; keyboard and screen-reader users close with
 * Delete (announced through `aria-keyshortcuts`) or the "Close tab" command.
 *
 * On Home no tab is selected (the glyph is current); the arrows still move between tabs,
 * and a click, Enter or Space shows the tab's document in its last view and mode.
 */
import type { DocumentId } from '@pdf-editor/document-model';
import { Download, PanelRight, Plus, Search, X } from 'lucide-react';
import { type KeyboardEvent, useEffect } from 'react';

import { openFilesFromPicker } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { currentPlatform, toAriaKeyShortcut } from '../commands/shortcuts';
import { FurnitureDialogs } from '../furniture';
import { showTab } from '../home/home-actions';
import { m } from '../i18n';
import { InlineTitleEditor } from '../stage/InlineTitleEditor';
import { startRename } from '../stage/section-operations';
import { TabArrangeMenu } from '../stage/TabArrangeMenu';
import { useUiStore } from '../state/ui-store';
import { useTabItems, useWorkspaceStore } from '../state/workspace-store';
import { SignatureTabGlyph } from '../signatures/SignatureBadge';
import { DocumentMenu } from '../tools/DocumentMenu';
import { IconButton } from '../ui/IconButton';
import { Keycaps } from '../ui/Keycaps';
import { HomeButton } from './AppGlyph';
import { announce } from './announcer';
import styles from './TabBar.module.css';
import { useCommandShortcut } from './use-command-shortcut';

export const STAGE_ID = 'stage';

export function tabDomId(documentId: string): string {
  return `tab-${documentId}`;
}

export function TabBar() {
  const documents = useTabItems();
  const activeTabId = useWorkspaceStore((s) => s.workspace.activeDocument ?? null);
  const setActiveTab = useWorkspaceStore((s) => s.setActive);
  const closeDocument = useWorkspaceStore((s) => s.closeDocument);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  // On Home no tab is selected: the stage shows the open files, not a document (ADR-0019 §1).
  const onHome = useUiStore((s) => s.destination === 'home');
  const renamingTab = useUiStore((s) =>
    s.renaming?.surface === 'tab' ? s.renaming.documentId : null,
  );
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const openShortcut = useCommandShortcut('file.open');
  const paletteShortcut = useCommandShortcut('view.palette');
  const rightShortcut = useCommandShortcut('view.toggleRightPanel');
  const exportShortcut = useCommandShortcut('file.export');

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    if (!activeTabId) return;
    const el = document.getElementById(tabDomId(activeTabId));
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const focusTab = (id: DocumentId) => {
    setActiveTab(id);
    requestAnimationFrame(() => document.getElementById(tabDomId(id))?.focus());
  };

  const closeTab = (id: DocumentId, name: string, refocus: boolean) => {
    const index = documents.findIndex((d) => d.id === id);
    closeDocument(id);
    announce(m.announce_closed({ name }));
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
    else if (event.key === 'F2') {
      event.preventDefault();
      const current = documents[index];
      if (current) startRename(current.id, 'tab');
      return;
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const current = documents[index];
      if (current) closeTab(current.id, current.title, true);
      return;
    }
    if (target === null) return;
    event.preventDefault();
    const doc = documents[target];
    if (doc) focusTab(doc.id);
  };

  return (
    <header className={styles.bar}>
      <HomeButton className={styles.brand} />

      <div className={styles.tabsRegion}>
        {documents.length > 0 ? (
          <div role="tablist" aria-label={m.tabs_label()} className={styles.tablist}>
            {documents.map((doc) => {
              const active = doc.id === activeTabId;
              const selected = active && !onHome;
              if (doc.id === renamingTab) {
                return (
                  <div
                    key={doc.id}
                    className={styles.tabWrap}
                    data-selected={selected || undefined}
                    data-renaming=""
                  >
                    <span className={styles.tag} data-tag={doc.colorIndex} aria-hidden="true" />
                    <InlineTitleEditor
                      documentId={doc.id}
                      title={doc.title}
                      className={styles.tabEditor}
                      onDone={() => {
                        requestAnimationFrame(() =>
                          document.getElementById(tabDomId(doc.id))?.focus(),
                        );
                      }}
                    />
                  </div>
                );
              }
              return (
                <TabArrangeMenu key={doc.id} documentId={doc.id} title={doc.title}>
                  <div className={styles.tabWrap} data-selected={selected || undefined}>
                    <button
                      type="button"
                      role="tab"
                      id={tabDomId(doc.id)}
                      aria-selected={selected}
                      aria-controls={STAGE_ID}
                      aria-keyshortcuts="Delete F2"
                      tabIndex={active ? 0 : -1}
                      className={styles.tab}
                      onKeyDown={onKeyDown}
                      // On Home, the document in the view and mode it was last shown in.
                      onClick={() => showTab(doc.id)}
                      onDoubleClick={() => startRename(doc.id, 'tab')}
                      onMouseDown={(event) => {
                        // Middle click closes, as in browsers.
                        if (event.button === 1) {
                          event.preventDefault();
                          closeTab(doc.id, doc.title, false);
                        }
                      }}
                      title={doc.title}
                    >
                      <span className={styles.tag} data-tag={doc.colorIndex} aria-hidden="true" />
                      <span className={styles.name}>{doc.title}</span>
                      <SignatureTabGlyph documentId={doc.id} />
                    </button>
                    <span
                      aria-hidden="true"
                      className={styles.close}
                      onClick={() => closeTab(doc.id, doc.title, false)}
                    >
                      <X />
                    </span>
                  </div>
                </TabArrangeMenu>
              );
            })}
          </div>
        ) : null}
        <IconButton
          id="open-files-button"
          label={m.open_files()}
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
          <span className={styles.searchLabel}>{m.search_commands_placeholder()}</span>
          {paletteShortcut ? <Keycaps shortcut={paletteShortcut} /> : null}
        </button>
        <DocumentMenu visible={documents.length > 0} />
        {documents.length > 0 ? (
          <IconButton
            label={m.export_document()}
            icon={<Download />}
            shortcut={exportShortcut}
            aria-haspopup="dialog"
            onClick={() => void commandRegistry.execute('file.export')}
          />
        ) : null}
        {documents.length > 0 ? (
          <IconButton
            label={rightPanelOpen ? m.right_panel_hide() : m.right_panel_show()}
            icon={<PanelRight />}
            shortcut={rightShortcut}
            aria-pressed={rightPanelOpen}
            aria-controls={rightPanelOpen ? 'right-panel' : undefined}
            onClick={toggleRightPanel}
          />
        ) : null}
      </div>
      <FurnitureDialogs />
    </header>
  );
}
