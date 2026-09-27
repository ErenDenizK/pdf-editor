/**
 * Tab / Shift+Tab through form fields in document order across pages (spec document-tools
 * §1), and opening a field from outside its page (the Forms panel).
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useToolStore } from '../viewer/tool-store';
import {
  type ActiveField,
  type FieldStop,
  fieldStops,
  isFillable,
  useFormStore,
} from './form-store';

function sameStop(a: ActiveField, b: ActiveField): boolean {
  return (
    a.source === b.source && a.name === b.name && a.widget === b.widget && a.pageId === b.pageId
  );
}

/** The fillable stops of the active document, in document order. */
export function activeStops(): FieldStop[] {
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace);
  if (!doc) return [];
  return fieldStops(doc, useFormStore.getState().sources).filter((s) => isFillable(s.field));
}

/** Opens a field: shows its page in Read mode with the Select tool and activates it. */
export function openField(stop: ActiveField): void {
  const ui = useUiStore.getState();
  if (ui.viewMode !== 'read') ui.setViewMode('read');
  useToolStore.getState().setMode('select');
  const current = useFormStore.getState().active;
  useFormStore.getState().setActive({
    source: stop.source,
    name: stop.name,
    widget: stop.widget,
    pageId: stop.pageId,
    ...(stop.selectAll ? { selectAll: true } : {}),
  });
  if (current?.pageId !== stop.pageId) useViewStore.getState().scrollToPage(stop.pageId);
}

/**
 * Moves from `from` to the next (1) or previous (-1) fillable field, wrapping around.
 * Returns false when there is nowhere to go.
 */
export function moveField(from: ActiveField, direction: 1 | -1): boolean {
  const stops = activeStops();
  if (stops.length === 0) return false;
  const index = stops.findIndex((s) => sameStop(s, from));
  const nextIndex =
    index < 0
      ? direction > 0
        ? 0
        : stops.length - 1
      : (index + direction + stops.length) % stops.length;
  const next = stops[nextIndex];
  if (!next || (index >= 0 && nextIndex === index)) return false;
  openField({ ...next, selectAll: true });
  return true;
}
