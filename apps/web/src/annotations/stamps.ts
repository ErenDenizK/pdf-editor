/**
 * Stamp and signature appearances (spec §3). Built-in stamps (Draft, Approved,
 * Confidential) are named stamps; when the engine cannot generate a named stamp's
 * appearance they are drawn here as images. Images are PNG or JPEG (what the engine
 * embeds); anything else is re-encoded to PNG. Signatures are images too: an "image
 * signature", never a digital signature.
 */
import { decodeImageFile } from '../files/images';
import { m } from '../i18n';
import type { PendingStamp } from './annotation-store';
import { INK } from './palette';

export interface BuiltinStamp {
  /** /Name written to the annotation. */
  readonly name: 'Draft' | 'Approved' | 'Confidential';
  readonly label: () => string;
  readonly color: string;
}

/** Colours from the one palette (craft spec §6): blue, green and red writing inks. */
export const BUILTIN_STAMPS: readonly BuiltinStamp[] = [
  { name: 'Draft', label: m.stamp_draft, color: INK.blue },
  { name: 'Approved', label: m.stamp_approved, color: INK.green },
  { name: 'Confidential', label: m.stamp_confidential, color: INK.red },
];

/** Natural size of a built-in stamp, in points. */
export const BUILTIN_STAMP_SIZE = { width: 150, height: 40 } as const;
/** Pixels per point of drawn stamp and signature images. */
const IMAGE_SCALE = 4;

function canvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

/** A built-in stamp drawn as a PNG (fallback when the engine cannot draw named stamps). */
export async function builtinStampImage(name: string): Promise<Blob> {
  const stamp = BUILTIN_STAMPS.find((s) => s.name === name);
  const text = name.toUpperCase();
  const color = stamp?.color ?? INK.red;
  const w = BUILTIN_STAMP_SIZE.width * IMAGE_SCALE;
  const h = BUILTIN_STAMP_SIZE.height * IMAGE_SCALE;
  const c = canvas(w, h);
  const g = c.getContext('2d');
  if (!g) throw new Error('No 2D context for the stamp');
  const line = 3 * IMAGE_SCALE;
  g.strokeStyle = color;
  g.lineWidth = line;
  g.beginPath();
  g.roundRect(line / 2, line / 2, w - line, h - line, 6 * IMAGE_SCALE);
  g.stroke();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 22 * IMAGE_SCALE;
  g.font = `700 ${size}px Inter, Helvetica, Arial, sans-serif`;
  while (g.measureText(text).width > w - 16 * IMAGE_SCALE && size > 8) {
    size -= 2;
    g.font = `700 ${size}px Inter, Helvetica, Arial, sans-serif`;
  }
  g.fillText(text, w / 2, h / 2 + IMAGE_SCALE);
  return c.convertToBlob({ type: 'image/png' });
}

/** An image file as a pending stamp (PNG or JPEG, pixel size for the aspect ratio). */
export async function imageStamp(file: File, kind: 'image' | 'signature'): Promise<PendingStamp> {
  const decoded = await decodeImageFile(file);
  return {
    kind,
    blob: new Blob([decoded.bytes], { type: decoded.type }),
    width: decoded.width,
    height: decoded.height,
  };
}

export function builtinPendingStamp(name: BuiltinStamp['name']): PendingStamp {
  return { kind: 'builtin', name, ...BUILTIN_STAMP_SIZE };
}

/** A typed signature drawn with the UI font (no script font is bundled; spec §3). */
export async function typedSignature(text: string, color = '#1A237E'): Promise<PendingStamp> {
  const size = 36 * IMAGE_SCALE;
  const font = `italic 500 ${size}px Inter, Helvetica, Arial, sans-serif`;
  const probe = canvas(1, 1).getContext('2d');
  if (!probe) throw new Error('No 2D context for the signature');
  probe.font = font;
  const width = Math.ceil(probe.measureText(text).width) + 16 * IMAGE_SCALE;
  const height = Math.round(size * 1.5);
  const c = canvas(width, height);
  const g = c.getContext('2d');
  if (!g) throw new Error('No 2D context for the signature');
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 8 * IMAGE_SCALE, height / 2);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { kind: 'signature', blob, width, height };
}

/** Strokes drawn on the signature pad (pad pixels), cropped to their bounds. */
export async function drawnSignature(
  strokes: readonly (readonly { x: number; y: number }[])[],
  color = '#1A237E',
  lineWidth = 2.5,
): Promise<PendingStamp | undefined> {
  const points = strokes.flat();
  if (points.length === 0) return undefined;
  const pad = lineWidth * 2;
  const minX = Math.min(...points.map((p) => p.x)) - pad;
  const minY = Math.min(...points.map((p) => p.y)) - pad;
  const maxX = Math.max(...points.map((p) => p.x)) + pad;
  const maxY = Math.max(...points.map((p) => p.y)) + pad;
  const scale = IMAGE_SCALE / 2;
  const c = canvas((maxX - minX) * scale, (maxY - minY) * scale);
  const g = c.getContext('2d');
  if (!g) throw new Error('No 2D context for the signature');
  g.scale(scale, scale);
  g.translate(-minX, -minY);
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const stroke of strokes) {
    const [first, ...rest] = stroke;
    if (!first) continue;
    g.beginPath();
    g.moveTo(first.x, first.y);
    if (rest.length === 0) g.lineTo(first.x + 0.1, first.y);
    for (const p of rest) g.lineTo(p.x, p.y);
    g.stroke();
  }
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { kind: 'signature', blob, width: c.width, height: c.height };
}

/**
 * Size in points for a stamp placed by a click: images at 72 dpi capped to 200 pt wide
 * (signatures to 180 pt), keeping the aspect ratio.
 */
export function naturalStampSize(stamp: PendingStamp): { width: number; height: number } {
  if (stamp.kind === 'builtin') return { width: stamp.width, height: stamp.height };
  const max = stamp.kind === 'signature' ? 180 : 200;
  const ratio = stamp.height / Math.max(1, stamp.width);
  const width = Math.min(max, Math.max(24, stamp.width / (stamp.kind === 'signature' ? 2 : 1)));
  return { width, height: Math.max(8, width * ratio) };
}
