/**
 * "Select text, then a markup tool" (spec §3): the browser selection in the text layer,
 * mapped onto each page's glyphs, becomes one markup annotation per page.
 */
import type { Rect } from '@pdf-editor/document-model';

import { canEditActive } from '../state/ui-store';
import { useAnnotationStore } from './annotation-store';
import { createAnnotations } from './actions';
import { markupDraft, styleGroupOf } from './drafts';
import { cssBoxToUser } from './geometry';
import { mountedLayers } from './layer-registry';
import { pageText } from './page-text';
import { glyphsInRects, quadsForGlyphs } from './quads';
import type { MarkupMode } from './tools';

/** Client rects of the current selection, or none when nothing (or only a caret) is selected. */
function selectionRects(selection: Selection | null): DOMRect[] {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  const rects: DOMRect[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    for (const rect of selection.getRangeAt(i).getClientRects()) {
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
  }
  return rects;
}

/** Whether there is a text selection a markup tool could apply to. */
export function hasTextSelection(): boolean {
  return selectionRects(globalThis.getSelection?.() ?? null).length > 0;
}

/**
 * Creates `kind` over the selected text on every page it spans. Resolves to whether an
 * annotation was created; the selection is cleared when one was. Never in Read (ADR-0019
 * §3): the selection stays for a second press in Edit.
 */
export async function markupFromSelection(
  kind: MarkupMode,
  /** The Highlighter's tint for Highlight (H) (craft spec §5.4); else the tool's style. */
  style: { readonly color: string; readonly opacity: number } = useAnnotationStore.getState()
    .styles[styleGroupOf(kind)],
): Promise<boolean> {
  if (!canEditActive()) return false;
  const selection = globalThis.getSelection?.() ?? null;
  const rects = selectionRects(selection);
  if (rects.length === 0) return false;
  let created = false;
  // A snapshot: layers re-register (re-render) while the creations below run.
  for (const layer of [...mountedLayers.values()]) {
    const bounds = layer.element.getBoundingClientRect();
    const onPage: Rect[] = [];
    for (const r of rects) {
      if (r.right < bounds.left || r.left > bounds.right) continue;
      if (r.bottom < bounds.top || r.top > bounds.bottom) continue;
      onPage.push(
        cssBoxToUser(layer.frame, {
          left: r.left - bounds.left,
          top: r.top - bounds.top,
          width: r.width,
          height: r.height,
        }),
      );
    }
    if (onPage.length === 0) continue;
    const runs = await pageText(layer.target.source, layer.target.pageIndex);
    const glyphs = glyphsInRects(runs, onPage);
    const quads = quadsForGlyphs(runs, glyphs);
    if (quads.length === 0) continue;
    const draft = markupDraft(kind, layer.target.pageIndex, quads, style.color, style.opacity);
    const done = await createAnnotations(layer.target, [draft]);
    if (done) created = true;
  }
  if (created) selection?.removeAllRanges();
  return created;
}
