/**
 * Page furniture (M3, document-tools spec §2): page numbers, headers and footers, Bates
 * numbering and watermarks. Importing this module registers the preview page overlay and
 * the click-to-edit handler; commands register through `registerFurnitureCommands`.
 */
import { findPageLocation, type PageId } from '@pdf-editor/document-model';

import { registerPageOverlay } from '../stage/page-overlays';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import { FurnitureLayer, pageHits } from './FurnitureLayer';
import { kindOfRole } from './furniture-model';
import { roleAt } from './furniture-preview';
import { openFurnitureDialog, useFurnitureStore } from './furniture-store';

export { registerFurnitureCommands } from './furniture-commands';
export { FurnitureDialogs } from './FurnitureDialogs';

registerPageOverlay(Object.assign(FurnitureLayer, { displayName: 'FurnitureLayer' }));

const INTERACTIVE = 'a, button, input, textarea, select, [contenteditable="true"], [role="dialog"]';

/**
 * Click on a piece of furniture in Read mode (Select tool): select it, i.e. open its
 * dialog on the page's document. A window capture listener with hit testing against the
 * laid-out boxes, so the preview layer itself never intercepts pointer events (text
 * selection and annotations keep working underneath).
 */
function onClick(event: MouseEvent): void {
  if (event.button !== 0 || event.defaultPrevented) return;
  if (useUiStore.getState().viewMode !== 'read') return;
  if (useToolStore.getState().mode !== 'select') return;
  if (useFurnitureStore.getState().dialog !== null) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(INTERACTIVE)) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  const pageElement = target.closest<HTMLElement>('[data-page-id]');
  const pageId = pageElement?.dataset.pageId as PageId | undefined;
  if (!pageElement || pageId === undefined) return;
  const info = pageHits.get(pageId);
  if (!info) return;
  const rect = pageElement.getBoundingClientRect();
  const point = {
    x: (event.clientX - rect.left) / info.cssScale,
    y: info.heightPt - (event.clientY - rect.top) / info.cssScale,
  };
  const role = roleAt(info.laid, point);
  if (role === undefined) return;
  const ws = useWorkspaceStore.getState().workspace;
  const documentId = findPageLocation(ws, pageId)?.document ?? info.documentId;
  event.preventDefault();
  event.stopPropagation();
  openFurnitureDialog(kindOfRole(role), documentId);
}

if (typeof window !== 'undefined') {
  window.addEventListener('click', onClick, { capture: true });
}
