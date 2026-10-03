/**
 * Edits of annotations the lasso took whole (craft spec §5.5): everything but ink paths,
 * which keep the split rule of `split.ts`. A lasso edit (`LassoEdit`) applies to both in
 * one history entry (`editLassoSelection`, actions.ts).
 *
 * - **Move**: the geometry translated (`translateAnnotation`): vertices, quads (a moved text
 *   markup keeps its quads translated), the rect of everything else; a note's icon moves
 *   with its /Rect.
 * - **Colour**: the primary colour (`withColor`); stamps and signature images have none.
 * - **Opacity**: every kind.
 * - **Width**: kinds with a stroke width (line, arrow, polyline, polygon, rectangle,
 *   ellipse); free text, notes, stamps and markups ignore it.
 * - **Font size**: free text only (the bar shows it when a text box is in the selection).
 * - **Resize and rotate**: the group transform, kind by kind (`transformAnnotation`,
 *   `transform.ts`).
 */
import type { Annotation } from '@pdf-editor/engine';

import { hasStrokeWidth, normalizeHex, withColor } from '../colors';
import { translateAnnotation } from '../geometry';
import { type LassoEdit, transformAnnotation } from './transform';

/** True when a width change applies to `a`. */
export function takesStrokeWidth(a: Annotation): boolean {
  return hasStrokeWidth(a);
}

/** True when a colour change applies to `a`. */
export function takesColor(a: Annotation): boolean {
  return a.kind !== 'stamp' && a.kind !== 'link';
}

/**
 * The annotation after `edit` (not for delete), or undefined when the edit does not apply
 * to its kind (a width change of a note).
 */
export function editWhole(a: Annotation, edit: LassoEdit): Annotation | undefined {
  if (edit.kind === 'delete') return undefined;
  if (edit.kind === 'move') return translateAnnotation(a, edit.dx, edit.dy);
  if (edit.kind === 'transform') return transformAnnotation(a, edit.matrix, edit.frame);
  const { color, opacity, strokeWidth, fontSize } = edit.patch;
  let next: Annotation = a;
  let changed = false;
  if (color !== undefined && takesColor(next)) {
    next = withColor(next, normalizeHex(color));
    changed = true;
  }
  if (opacity !== undefined) {
    next = { ...next, opacity: Math.round(opacity * 100) / 100 };
    changed = true;
  }
  if (strokeWidth !== undefined && strokeWidth > 0 && hasStrokeWidth(next)) {
    next = { ...next, strokeWidth };
    changed = true;
  }
  if (fontSize !== undefined && next.kind === 'free-text') {
    next = { ...next, fontSize };
    changed = true;
  }
  return changed ? next : undefined;
}

/** True when a style patch changes ink at all (a font size alone leaves ink paths be). */
export function patchTouchesInk(edit: LassoEdit): boolean {
  if (edit.kind !== 'style') return true;
  const { color, opacity, strokeWidth } = edit.patch;
  return color !== undefined || opacity !== undefined || strokeWidth !== undefined;
}
