/**
 * Mounted annotation layers by page, so actions that start outside a page (a text
 * selection turned into a highlight, the comments panel) can map screen geometry to the
 * right page and source.
 */
import type { PageId } from '@pdf-editor/document-model';

import type { PageTarget } from './annotation-store';
import type { PageFrame } from './geometry';

export interface MountedLayer {
  readonly element: HTMLElement;
  readonly frame: PageFrame;
  readonly target: PageTarget;
}

export const mountedLayers = new Map<PageId, MountedLayer>();
