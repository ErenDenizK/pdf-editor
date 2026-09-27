/**
 * Application shell (DESIGN.md §2):
 *
 *   title / tab bar ............................................
 *   left rail + panel | stage (+ floating tool bar) | inspector
 *   status bar .................................................
 *
 * Owns the global shortcut listener and window-wide file drops.
 */
import { type DragEvent, useRef, useState } from 'react';

import { openDocuments } from '../commands/app-commands';
import { useShortcuts } from '../commands/use-shortcuts';
import { dragHasFiles, filesFromDataTransfer } from '../files/open-files';
import { m } from '../i18n';
import { TooltipProvider } from '../ui/Tooltip';
import { announce } from './announcer';
import styles from './AppShell.module.css';
import { CommandPalette } from './CommandPalette';
import { LeftRail } from './LeftRail';
import { LiveRegion } from './LiveRegion';
import { PasswordDialog } from './PasswordDialog';
import { RightPanel } from './RightPanel';
import { ShortcutOverlay } from './ShortcutOverlay';
import { Stage } from './Stage';
import { StatusBar } from './StatusBar';
import { TabBar } from './TabBar';

export function AppShell() {
  useShortcuts();
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child crossed; count depth to avoid flicker.
  const depth = useRef(0);

  const onDragEnter = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    // Light-table sections insert dropped files at the drop point themselves.
    if (event.target instanceof Element && event.target.closest('[data-file-drop-zone]')) return;
    // filesFromDataTransfer reads the items synchronously, before its first await.
    void filesFromDataTransfer(event.dataTransfer).then((files) => {
      if (files.length === 0) {
        announce(m.drop_no_pdfs());
        return;
      }
      void openDocuments(files);
    });
  };

  return (
    <TooltipProvider>
      <div
        className={styles.shell}
        data-testid="app-shell"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <TabBar />
        <LeftRail />
        <Stage dragging={dragging} />
        <RightPanel />
        <StatusBar />
      </div>
      <CommandPalette />
      <ShortcutOverlay />
      <PasswordDialog />
      <LiveRegion />
    </TooltipProvider>
  );
}
