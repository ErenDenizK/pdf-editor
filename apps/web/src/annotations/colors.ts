/** Colour helpers for annotation chrome (SVG previews use the annotation's own colours). */
import type { Annotation } from '@pdf-editor/engine';

/** The colour the colour controls edit for an annotation, if it has one. */
export function primaryColor(a: Annotation): string | undefined {
  if (a.kind === 'free-text') return a.textColor ?? a.color;
  if (a.kind === 'stamp' || a.kind === 'link') return undefined;
  return a.color;
}

/** The annotation with its primary colour changed. */
export function withColor(a: Annotation, color: string): Annotation {
  if (a.kind === 'free-text') return { ...a, textColor: color };
  return { ...a, color };
}

export function hasStrokeWidth(a: Annotation): a is Extract<Annotation, { strokeWidth: number }> {
  return 'strokeWidth' in a;
}

export function normalizeHex(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : value;
}
