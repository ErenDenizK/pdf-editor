/**
 * Application shell (DESIGN.md §2):
 *
 *   title / tab bar ............................................
 *   left rail + panel | stage (+ floating tool bar) | inspector
 *   status bar .................................................
 *
 * The shell is the stage's bleed area (`data-stage-bleed`, craft spec §7): the Read view's
 * page canvas extends under the docked frame, which stacks above it, and lays its pages out
 * in the rectangle the frame leaves free (stage/stage-bleed.ts).
 *
 * Owns the global shortcut listener, window-wide file drops and the appearance settings on
 * the root element (Glass panels, Reduce transparency).
 */
import { type DragEvent, useEffect, useRef, useState } from 'react';

import { openDocuments } from '../commands/app-commands';
import { commandRegistry } from '../commands/registry';
import { useShortcuts } from '../commands/use-shortcuts';
import { dragHasFiles, filesFromDataTransfer, isOpenableFile } from '../files/open-files';
import { CombinedToast } from '../home/CombinedToast';
import { showOpened } from '../home/home-actions';
import { m } from '../i18n';
import { useAppearanceRoot } from '../state/appearance-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { TooltipProvider } from '../ui/Tooltip';
import { AboutDialog } from './about/AboutDialog';
import { registerAppearanceCommands } from './appearance-commands';
import { announce } from './announcer';
import styles from './AppShell.module.css';
import { CommandPalette } from './CommandPalette';
import { LeftRail } from './LeftRail';
import { useRegionCycling } from './LeftRail.regions';
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
  // F6 / Shift+F6 between the regions (experience-redesign §10).
  const shellRef = useRef<HTMLDivElement>(null);
  useRegionCycling(shellRef);
  useAppearanceRoot();
  useEffect(() => registerAppearanceCommands(commandRegistry), []);

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
    void filesFromDataTransfer(event.dataTransfer, isOpenableFile).then(async (files) => {
      if (files.length === 0) {
        announce(m.drop_no_pdfs());
        return;
      }
      // Two or more files dropped on an empty workspace, or any dropped on Home: Home with
      // the new cards selected (experience-redesign §3).
      const wasEmpty = useWorkspaceStore.getState().workspace.documentOrder.length === 0;
      showOpened(await openDocuments(files), { wasEmpty });
    });
  };

  return (
    <TooltipProvider>
      <div
        ref={shellRef}
        className={styles.shell}
        data-testid="app-shell"
        data-stage-bleed=""
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
      <AboutDialog />
      <PasswordDialog />
      <CombinedToast />
      <LiveRegion />
    </TooltipProvider>
  );
}
