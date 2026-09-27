/**
 * Draws one page bitmap from the engine service into a canvas that fills its parent (a
 * page-shaped, white placeholder sheet). The canvas keeps its pixels, so the service's
 * cache may evict the bitmap at any time.
 *
 * - Exact cache hit: drawn synchronously on mount.
 * - Otherwise the best cached lower (or higher) scale is drawn at once, stretched by CSS,
 *   and the right scale is requested. `delayMs` debounces the request while a bitmap is
 *   already shown (zoom gestures); an empty sheet requests at once.
 * - Unmounting or changing page/scale aborts the request (after the replacement request
 *   has joined the same job, so a priority change never restarts a running render).
 *
 * Image pages (`blobId`) are drawn from the stored image bytes instead, fitted and centred
 * on the page like the assembler places them, with the page rotation applied.
 *
 * The canvas exposes `data-state`: placeholder | preview | rendered | error.
 */
import type { BlobId, Rotation, SourceId } from '@pdf-editor/document-model';
import { useEffect, useRef } from 'react';

import { type CachedBitmap, chooseBucket, getEngineService } from '../engine/engine-service';
import { useWorkspaceStore } from '../state/workspace-store';
import styles from './PageCanvas.module.css';

/** Decoded image blobs, shared by every canvas that shows the same image page. */
const imageBitmaps = new Map<BlobId, Promise<ImageBitmap>>();

function imageBitmap(blobId: BlobId): Promise<ImageBitmap> | undefined {
  const cached = imageBitmaps.get(blobId);
  if (cached) return cached;
  const stored = useWorkspaceStore.getState().blobs[blobId];
  if (!stored) return undefined;
  const decoded = createImageBitmap(new Blob([stored.bytes], { type: stored.type }));
  decoded.catch(() => imageBitmaps.delete(blobId));
  imageBitmaps.set(blobId, decoded);
  return decoded;
}

/** Draws an image page: white sheet, image fitted and centred, then the page rotation. */
function drawImagePage(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  rotation: Rotation,
  widthPt: number,
  heightPt: number,
  cssWidth: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round((width * heightPt) / Math.max(1, widthPt)));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  const quarter = rotation === 90 || rotation === 270;
  // The unrotated page, in canvas pixels.
  const pageW = quarter ? height : width;
  const pageH = quarter ? width : height;
  const scale = Math.min(pageW / bitmap.width, pageH / bitmap.height);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
  context.restore();
  canvas.dataset.state = 'rendered';
}

export interface PageCanvasProps {
  readonly sourceId: SourceId | undefined;
  /** Image pages: the stored image to draw instead of an engine bitmap. */
  readonly blobId?: BlobId | undefined;
  readonly index: number;
  /** Rotation on top of the intrinsic /Rotate (VirtualPage.rotation). */
  readonly rotation: Rotation;
  /** Displayed page size in points (after all rotation), to cap the bitmap size. */
  readonly widthPt: number;
  readonly heightPt: number;
  /** CSS width the page occupies; with devicePixelRatio this picks the scale bucket. */
  readonly cssWidth: number;
  readonly priority: number;
  readonly delayMs?: number;
}

type DrawState = 'placeholder' | 'preview' | 'rendered' | 'error';

function draw(canvas: HTMLCanvasElement, entry: CachedBitmap, state: DrawState): boolean {
  const { bitmap } = entry;
  if (bitmap.width === 0) return false; // closed by an eviction race; request again
  try {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.drawImage(bitmap, 0, 0);
    canvas.dataset.state = state;
    canvas.dataset.bucket = String(entry.bucket);
    return true;
  } catch {
    return false;
  }
}

export function PageCanvas({
  sourceId,
  blobId,
  index,
  rotation,
  widthPt,
  heightPt,
  cssWidth,
  priority,
  delayMs = 0,
}: PageCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  /** Which page (source:index:rotation) the canvas currently shows. */
  const shownRef = useRef<string>('');
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const bucket = chooseBucket((cssWidth * dpr) / Math.max(1, widthPt), widthPt, heightPt);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || blobId === undefined) return;
    let cancelled = false;
    shownRef.current = `blob:${blobId}`;
    void imageBitmap(blobId)?.then(
      (bitmap) => {
        if (!cancelled) drawImagePage(canvas, bitmap, rotation, widthPt, heightPt, cssWidth);
      },
      () => {
        if (!cancelled) canvas.dataset.state = 'error';
      },
    );
    return () => {
      cancelled = true;
    };
  }, [blobId, rotation, widthPt, heightPt, cssWidth]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || sourceId === undefined) return;
    const service = getEngineService();
    const page = `${sourceId}:${index}:${rotation}`;
    if (shownRef.current !== page) {
      // Another page (or rotation): never show stale pixels in the new shape.
      canvas.width = 0;
      canvas.height = 0;
      canvas.dataset.state = 'placeholder';
      delete canvas.dataset.bucket;
      shownRef.current = page;
    }
    const exact = service.peek(sourceId, index, rotation, bucket);
    if (exact && draw(canvas, exact, 'rendered')) return;
    const shownBucket = Number(canvas.dataset.bucket ?? 0);
    const preview = service.preview(sourceId, index, rotation, bucket);
    if (preview && canvas.dataset.state !== 'rendered' && preview.bucket > shownBucket) {
      draw(canvas, preview, 'preview');
    }

    const controller = new AbortController();
    let cancelled = false;
    const request = () => {
      void service
        .renderPage({ sourceId, index, rotation, bucket, priority, signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            draw(canvas, result.value, 'rendered');
          } else if (result.error.code !== 'aborted' && canvas.dataset.state === 'placeholder') {
            canvas.dataset.state = 'error';
          }
        });
    };
    // Debounce only when something is already shown (zooming); first paint is immediate.
    const showing = canvas.dataset.state === 'preview' || canvas.dataset.state === 'rendered';
    const timer = delayMs > 0 && showing ? window.setTimeout(request, delayMs) : undefined;
    if (timer === undefined) request();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      // Abort after the next effect (if any) has subscribed to the same job.
      queueMicrotask(() => controller.abort());
    };
  }, [sourceId, index, rotation, bucket, priority, delayMs]);

  return <canvas ref={ref} className={styles.canvas} data-state="placeholder" aria-hidden="true" />;
}
