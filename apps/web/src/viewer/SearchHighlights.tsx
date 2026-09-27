/**
 * Search hits drawn over a page (spec §1): an accent-muted fill per match, the current
 * match stronger and outlined so it is not told apart by colour alone.
 */
import type { Rect } from '@pdf-editor/document-model';

import type { PageOverlayProps } from '../stage/page-overlays';
import { useWorkspaceStore } from '../state/workspace-store';
import { userRectToCss } from './geometry';
import { pageFrame } from './page-frame';
import { useSearchStore } from './search';
import styles from './SearchHighlights.module.css';

export function SearchHighlights(props: PageOverlayProps) {
  const hits = useSearchStore((s) => s.hits);
  const current = useSearchStore((s) => s.current);
  const documentId = useSearchStore((s) => s.documentId);
  const active = useWorkspaceStore((s) => s.workspace.activeDocument);
  if (hits.length === 0 || documentId !== active) return null;
  const mine: { index: number; rects: readonly Rect[] }[] = [];
  hits.forEach((hit, index) => {
    if (hit.pageId === props.pageId) mine.push({ index, rects: hit.rects });
  });
  if (mine.length === 0) return null;
  const frame = pageFrame(props);
  return (
    <div className={styles.layer} aria-hidden="true" data-testid="search-highlights">
      {mine.flatMap(({ index, rects }) =>
        rects.map((rect, i) => {
          const box = userRectToCss(frame, rect);
          return (
            <div
              key={`${index}:${i}`}
              className={styles.hit}
              data-current={index === current || undefined}
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            />
          );
        }),
      )}
    </div>
  );
}
