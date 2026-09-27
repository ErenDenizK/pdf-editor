/**
 * The bundled furniture fonts in the browser, for the live preview: the same TTFs the
 * assembler embeds (`@pdf-editor/engine/fonts`), registered as FontFaces under private
 * family names on first use, and a canvas text measurer that matches the assembler's
 * (advance widths, no kerning).
 */
import type { TextOverlay } from '@pdf-editor/document-model';
import { type BundledFace, bundledFontUrl } from '@pdf-editor/engine/fonts';
import { type ResolvedFont, resolveFont } from '@pdf-editor/engine/overlay-geometry';

/** CSS family name of a bundled face (private: never clashes with the UI's Inter). */
export function cssFamilyOf(face: BundledFace): string {
  return `pdfe-furniture-${face.key}`;
}

const STANDARD_CSS: Readonly<Record<string, string>> = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

/** CSS `font-family` value for a resolved font (bundled face first, generic fallback). */
export function cssFontFamily(resolved: ResolvedFont): string {
  if (resolved.kind === 'standard') return STANDARD_CSS[resolved.family] ?? 'sans-serif';
  return `"${cssFamilyOf(resolved.face)}", ${resolved.family.generic}`;
}

const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

/** Starts loading a face (idempotent); listeners run when it is ready. */
export function ensureFace(face: BundledFace): void {
  if (loaded.has(face.key) || loading.has(face.key) || typeof FontFace === 'undefined') return;
  const font = new FontFace(cssFamilyOf(face), `url("${bundledFontUrl(face)}")`, {
    weight: String(face.weight),
    style: 'normal',
  });
  const pending = font
    .load()
    .then((ready) => {
      document.fonts.add(ready);
      loaded.add(face.key);
      version++;
      for (const listener of listeners) listener();
    })
    .catch((error: unknown) => {
      console.warn(`Could not load furniture font ${face.key}`, error);
    })
    .finally(() => loading.delete(face.key));
  loading.set(face.key, pending);
}

export function isFaceLoaded(face: BundledFace): boolean {
  return loaded.has(face.key);
}

/** Increments whenever a face finishes loading (for useSyncExternalStore). */
export function fontsVersion(): number {
  return version;
}

export function subscribeFonts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;

function measureContext() {
  if (context !== undefined) return context;
  if (typeof OffscreenCanvas !== 'undefined') {
    context = new OffscreenCanvas(1, 1).getContext('2d');
  } else if (typeof document !== 'undefined') {
    context = document.createElement('canvas').getContext('2d');
  } else {
    context = null;
  }
  return context;
}

/** Advance width in points of `text` in the overlay's font; an estimate without canvas. */
export function measureOverlayText(text: string, overlay: TextOverlay): number {
  const resolved = resolveFont(overlay.font);
  if (resolved.kind === 'bundled') ensureFace(resolved.face);
  const size = overlay.font.size;
  const ctx = measureContext();
  if (!ctx) return text.length * size * 0.55;
  // Measure at 100 px for precision, then scale to points.
  const weight = resolved.kind === 'bundled' ? resolved.face.weight : resolved.bold ? 700 : 400;
  ctx.font = `${weight} 100px ${cssFontFamily(resolved)}`;
  if ('fontKerning' in ctx) ctx.fontKerning = 'none';
  const width = ctx.measureText(text).width;
  return Number.isFinite(width) && width > 0 ? (width / 100) * size : text.length * size * 0.55;
}
