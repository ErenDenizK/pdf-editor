/**
 * Extension point for layers drawn over a rendered page in Read mode.
 *
 * Features register a component once at module load (text layer, annotation layer,
 * search highlights, link hotspots). ReadView renders every registered overlay inside each
 * page container, absolutely positioned over the canvas, in registration order. Overlays
 * receive the page geometry they need to map PDF user space to CSS pixels and must not
 * assume anything about the other overlays.
 */
import type { PageId, Rotation, Size, SourceId, VirtualPage } from '@pdf-editor/document-model';
import type { ComponentType } from 'react';

import { useSyncExternalStore } from 'react';

export interface PageOverlayProps {
  /** The page as the model sees it. */
  readonly page: VirtualPage;
  readonly pageId: PageId;
  /** Zero-based position in the document. */
  readonly pageIndex: number;
  /** Source and source page index when the page comes from a PDF (undefined for blank/image pages). */
  readonly sourceId: SourceId | undefined;
  readonly sourceIndex: number;
  /** Displayed page size in points (after the total rotation). */
  readonly sizePt: Size;
  /** CSS pixels per point at the current zoom (device pixel ratio not included). */
  readonly cssScale: number;
  /** Total rotation applied to the source page: intrinsic /Rotate plus the model delta. */
  readonly rotation: Rotation;
  /** Whether the page intersects the viewport (overlays may skip expensive work otherwise). */
  readonly visible: boolean;
}

export type PageOverlayComponent = ComponentType<PageOverlayProps>;

let overlays: readonly PageOverlayComponent[] = [];
const listeners = new Set<() => void>();

/** Registers an overlay; returns an unregister function. Order of registration is draw order. */
export function registerPageOverlay(component: PageOverlayComponent): () => void {
  overlays = [...overlays, component];
  for (const listener of listeners) listener();
  return () => {
    overlays = overlays.filter((c) => c !== component);
    for (const listener of listeners) listener();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly PageOverlayComponent[] {
  return overlays;
}

/** Renders every registered overlay for one page. Mount inside the page container. */
export function PageOverlays(props: PageOverlayProps) {
  const components = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (components.length === 0) return null;
  return (
    <div className="page-overlays" data-page-overlays>
      {components.map((Overlay, i) => (
        <Overlay key={Overlay.displayName ?? Overlay.name ?? i} {...props} />
      ))}
    </div>
  );
}
