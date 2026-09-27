/**
 * Link hotspots over a page (spec §1). Links are read through the engine's read-only
 * `listAnnotations` (kind 'link') for pages near the viewport.
 *
 * - Internal links (`targetPageIndex`, a page of the same source) scroll Read mode to that
 *   page when it is in the active document.
 * - URI links never navigate silently: the hotspot names the destination (tooltip and
 *   accessible name) and a click opens a confirmation popover; only its "Open" button
 *   opens a new tab, with `noopener`.
 *
 * Hotspots are live only with the Select tool, so annotation tools can draw over links.
 */
import { Popover } from '@base-ui/react/popover';
import type { SourceId } from '@pdf-editor/document-model';
import type { Annotation, LinkAnnotation } from '@pdf-editor/engine';
import { useEffect, useState } from 'react';

import { getEngineService } from '../engine/engine-service';
import { m } from '../i18n';
import { openableUrl } from '../shell/OutlinePanel.tree';
import type { PageOverlayProps } from '../stage/page-overlays';
import { distanceFromView, useViewStore } from '../state/view-store';
import { useActiveDocument } from '../state/workspace-store';
import popoverStyles from '../ui/Popover.module.css';
import { Tooltip } from '../ui/Tooltip';
import { userRectToCss } from './geometry';
import styles from './LinkLayer.module.css';
import { pageFrame } from './page-frame';
import { useToolStore } from './tool-store';

const MAX_CACHED_PAGES = 300;
const links = new Map<string, Promise<readonly LinkAnnotation[]>>();

function isLink(annotation: Annotation): annotation is LinkAnnotation {
  return annotation.kind === 'link';
}

/** Link annotations of a source page (memoized; failures are not kept). */
export function pageLinks(sourceId: SourceId, index: number): Promise<readonly LinkAnnotation[]> {
  const key = `${sourceId}:${index}`;
  const cached = links.get(key);
  if (cached) return cached;
  const pending = getEngineService()
    .editor()
    .then((editor) => editor.listAnnotations(sourceId, index))
    .then((annotations) => annotations.filter(isLink));
  pending.catch(() => links.delete(key));
  links.set(key, pending);
  if (links.size > MAX_CACHED_PAGES) {
    const oldest = links.keys().next().value;
    if (oldest !== undefined) links.delete(oldest);
  }
  return pending;
}

/** Forgets the cached links of a source (call when it closes; its ids are never reused). */
export function clearLinksForSource(sourceId: SourceId): void {
  const prefix = `${sourceId}:`;
  for (const key of [...links.keys()]) {
    if (key.startsWith(prefix)) links.delete(key);
  }
}

export function LinkLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageIndex } = props;
  const near = useViewStore((s) => distanceFromView(pageIndex, s.visibleRange) <= 1);
  const live = useToolStore((s) => s.mode === 'select');
  const doc = useActiveDocument();
  const [found, setFound] = useState<{
    key: string;
    links: readonly LinkAnnotation[];
  } | null>(null);
  const key = `${sourceId ?? ''}:${sourceIndex}`;

  useEffect(() => {
    if (!near || sourceId === undefined) return;
    let cancelled = false;
    pageLinks(sourceId, sourceIndex).then(
      (list) => {
        if (!cancelled) setFound({ key, links: list });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [near, sourceId, sourceIndex, key]);

  if (found?.key !== key || found.links.length === 0 || !doc) return null;
  const frame = pageFrame(props);

  return (
    <div className={styles.layer} data-live={live} data-testid="link-layer">
      {found.links.map((link) => {
        if (link.flags?.hidden) return null;
        const box = userRectToCss(frame, link.rect);
        const style = { left: box.left, top: box.top, width: box.width, height: box.height };
        if (link.targetPageIndex !== undefined) {
          const targetIndex = doc.pages.findIndex(
            (page) =>
              page.ref.kind === 'source' &&
              page.ref.source === sourceId &&
              page.ref.index === link.targetPageIndex,
          );
          const target = doc.pages[targetIndex];
          const label = target
            ? m.viewer_link_page({ page: targetIndex + 1 })
            : m.viewer_link_missing();
          return (
            <Tooltip key={link.id} label={label}>
              <button
                type="button"
                className={styles.hotspot}
                style={style}
                aria-label={label}
                aria-disabled={target === undefined || undefined}
                tabIndex={live ? 0 : -1}
                data-link="internal"
                onClick={() => {
                  if (target) useViewStore.getState().scrollToPage(target.id);
                }}
              />
            </Tooltip>
          );
        }
        if (link.uri !== undefined) {
          return <UriHotspot key={link.id} uri={link.uri} style={style} tabIndex={live ? 0 : -1} />;
        }
        return null;
      })}
    </div>
  );
}

function UriHotspot({
  uri,
  style,
  tabIndex,
}: {
  readonly uri: string;
  readonly style: { left: number; top: number; width: number; height: number };
  readonly tabIndex: number;
}) {
  const [open, setOpen] = useState(false);
  const url = openableUrl(uri);
  const label = m.viewer_link_external({ uri });
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={uri}>
        <Popover.Trigger
          className={styles.hotspot}
          style={style}
          aria-label={label}
          tabIndex={tabIndex}
          data-link="uri"
        />
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Popover.Popup className={popoverStyles.popup} data-testid="link-confirm">
            <Popover.Title className={popoverStyles.title}>
              {url ? m.viewer_link_confirm_title() : m.viewer_link_unsupported()}
            </Popover.Title>
            <p className={styles.url} title={uri}>
              {uri}
            </p>
            {url ? (
              <Popover.Description className={popoverStyles.body}>
                {m.viewer_link_confirm_body({
                  host: url.protocol === 'mailto:' ? url.pathname : url.host,
                })}
              </Popover.Description>
            ) : null}
            <div className={styles.actions}>
              <Popover.Close className={styles.secondary}>
                {url ? m.common_cancel() : m.common_close()}
              </Popover.Close>
              {url ? (
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => {
                    window.open(url.href, '_blank', 'noopener,noreferrer');
                    setOpen(false);
                  }}
                >
                  {m.viewer_link_open()}
                </button>
              ) : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
