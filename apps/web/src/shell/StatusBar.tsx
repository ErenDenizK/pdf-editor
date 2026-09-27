/**
 * Status bar: selection summary and the privacy indicator on the left; zoom and view mode
 * on the right. Numerals are tabular so counts never jitter (DESIGN.md §3).
 */
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { BookOpen, LayoutGrid, Minus, Plus } from 'lucide-react';

import { useExternalRequests } from '../privacy/external-requests';
import { MAX_ZOOM, MIN_ZOOM, useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { Keycaps } from '../ui/Keycaps';
import menuStyles from '../ui/Menu.module.css';
import popoverStyles from '../ui/Popover.module.css';
import styles from './StatusBar.module.css';
import { useCommandShortcut } from './use-command-shortcut';

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function StatusBar() {
  const documents = useWorkspaceStore((s) => s.documents);
  const knownPages = documents.every((d) => d.pageCount !== null);
  const pageCount = documents.reduce((sum, d) => sum + (d.pageCount ?? 0), 0);
  const summary = knownPages ? plural(pageCount, 'page') : plural(documents.length, 'document');

  return (
    <footer className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.item}>{summary}</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <PrivacyIndicator />
      </div>
      {documents.length > 0 ? (
        <div className={styles.right}>
          <ZoomControls />
          <span className={styles.divider} aria-hidden="true" />
          <ModeToggles />
        </div>
      ) : null}
    </footer>
  );
}

function PrivacyIndicator() {
  const { count, origins } = useExternalRequests();
  const clean = count === 0;
  return (
    <Popover.Root>
      <Popover.Trigger className={styles.privacy} data-state={clean ? 'clean' : 'external'}>
        <span className={styles.privacyMark} aria-hidden="true" />
        <span>Local only</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span className={styles.numeric}>{plural(count, 'external request')}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8}>
          <Popover.Popup className={popoverStyles.popup}>
            <Popover.Title className={popoverStyles.title}>
              {clean ? 'Nothing has left this device' : 'This page contacted other servers'}
            </Popover.Title>
            <Popover.Description className={popoverStyles.body}>
              Files are read into memory in this tab and are never uploaded. The count is measured
              live from the browser’s resource timing: every request to an origin other than this
              site is counted.
            </Popover.Description>
            {origins.length > 0 ? (
              <ul className={popoverStyles.list}>
                {origins.map((origin) => (
                  <li key={origin}>{origin}</li>
                ))}
              </ul>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ZoomControls() {
  const zoom = useUiStore((s) => s.zoom);
  const zoomToFit = useUiStore((s) => s.zoomToFit);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const zoomFit = useUiStore((s) => s.zoomFit);
  const setZoom = useUiStore((s) => s.setZoom);
  const inShortcut = useCommandShortcut('zoom.in');
  const outShortcut = useCommandShortcut('zoom.out');
  const fitShortcut = useCommandShortcut('zoom.fit');
  const percent = `${Math.round(zoom * 100)}%`;

  return (
    <div className={styles.zoom}>
      <IconButton
        label="Zoom out"
        icon={<Minus />}
        shortcut={outShortcut}
        tooltipSide="top"
        className={styles.small}
        disabled={zoom <= MIN_ZOOM}
        onClick={zoomOut}
      />
      <Menu.Root>
        <Menu.Trigger className={styles.zoomValue} aria-label={`Zoom ${percent}`}>
          {percent}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="center" sideOffset={8} collisionPadding={8}>
            <Menu.Popup className={menuStyles.popup}>
              <Menu.RadioGroup
                value={zoomToFit ? 'fit' : String(zoom)}
                onValueChange={(value: string) => {
                  if (value === 'fit') zoomFit();
                  else setZoom(Number(value));
                }}
              >
                <Menu.RadioItem className={menuStyles.item} value="fit" closeOnClick>
                  <span className={menuStyles.check} aria-hidden="true" />
                  <span className={menuStyles.label}>Fit width</span>
                  {fitShortcut ? <Keycaps shortcut={fitShortcut} tone="quiet" /> : null}
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
                      {Math.round(preset * 100)}%
                    </span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <IconButton
        label="Zoom in"
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
        label="Read mode"
        icon={<BookOpen />}
        shortcut={readShortcut}
        tooltipSide="top"
        className={styles.small}
        aria-pressed={viewMode === 'read'}
        onClick={() => setViewMode('read')}
      />
      <IconButton
        label="Arrange mode"
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
