/**
 * Sharp rendering at high zoom. When a page's full bitmap would exceed the engine
 * service's single-bitmap cap (`MAX_BITMAP_PIXELS`, 16 MP), `PageCanvas` draws a capped,
 * slightly soft bitmap and this layer covers the visible part of the page with tiles
 * rendered at full resolution through the engine's `clip` option.
 *
 * Tiles are TILE_PX device pixels square in displayed-page space; each is mapped back to an
 * unrotated user-space clip (viewer/geometry.ts, which applies rotation and the CropBox
 * origin). Only tiles intersecting the viewport (plus a margin) are mounted; the engine
 * cache keeps recent ones.
 */
import type { Rotation, SourceId } from '@pdf-editor/document-model';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  chooseBucket,
  getEngineService,
  RENDER_PRIORITY,
  scaleBucket,
} from '../engine/engine-service';
import { displayedSize, displayRectToUser, type PageFrame } from '../viewer/geometry';
import styles from './PageCanvas.module.css';

/** Tile edge in device pixels. */
export const TILE_PX = 1024;
/** Extra margin (CSS px) around the viewport in which tiles are prepared. */
const MARGIN_PX = 256;

/** True when the whole page at this scale would be capped (so tiles are needed). */
export function needsTiles(cssScale: number, widthPt: number, heightPt: number): boolean {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const wanted = cssScale * dpr;
  return chooseBucket(wanted, widthPt, heightPt) < scaleBucket(wanted);
}

export interface Tile {
  readonly col: number;
  readonly row: number;
  /** Displayed-page box in points. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Tiles covering `visible` (a box on the displayed page in points) for a page of
 * `size` points rendered at `bucket` device pixels per point.
 */
export function tilesFor(
  size: { readonly width: number; readonly height: number },
  bucket: number,
  visible: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
): Tile[] {
  const edge = TILE_PX / bucket;
  const left = Math.max(0, visible.left);
  const top = Math.max(0, visible.top);
  const right = Math.min(size.width, visible.right);
  const bottom = Math.min(size.height, visible.bottom);
  if (right <= left || bottom <= top) return [];
  const tiles: Tile[] = [];
  for (let row = Math.floor(top / edge); row * edge < bottom; row++) {
    for (let col = Math.floor(left / edge); col * edge < right; col++) {
      const x = col * edge;
      const y = row * edge;
      tiles.push({
        col,
        row,
        left: x,
        top: y,
        width: Math.min(edge, size.width - x),
        height: Math.min(edge, size.height - y),
      });
    }
  }
  return tiles;
}

export function TiledPage({
  sourceId,
  index,
  rotation,
  frame,
}: {
  readonly sourceId: SourceId;
  readonly index: number;
  /** Rotation on top of the intrinsic /Rotate (VirtualPage.rotation). */
  readonly rotation: Rotation;
  readonly frame: PageFrame;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tiles, setTiles] = useState<readonly Tile[]>([]);
  const dpr = window.devicePixelRatio || 1;
  const bucket = scaleBucket(frame.scale * dpr);
  const size = displayedSize(frame);
  const { width: widthPt, height: heightPt } = size;
  const scale = frame.scale;

  useEffect(() => {
    const layer = ref.current;
    const viewport = layer?.closest<HTMLElement>('[data-read-viewport]');
    if (!layer || !viewport) return;
    let frameId = 0;
    let shown = '';
    const update = () => {
      frameId = 0;
      const page = layer.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      const next = tilesFor({ width: widthPt, height: heightPt }, bucket, {
        left: (view.left - MARGIN_PX - page.left) / scale,
        top: (view.top - MARGIN_PX - page.top) / scale,
        right: (view.right + MARGIN_PX - page.left) / scale,
        bottom: (view.bottom + MARGIN_PX - page.top) / scale,
      });
      const key = next.map((t) => `${t.col},${t.row}`).join(';');
      if (key !== shown) {
        shown = key;
        setTiles(next);
      }
    };
    const schedule = () => {
      if (frameId === 0) frameId = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (frameId !== 0) cancelAnimationFrame(frameId);
    };
  }, [bucket, scale, widthPt, heightPt]);

  return (
    <div ref={ref} className={styles.tiles} aria-hidden="true" data-testid="page-tiles">
      {tiles.map((tile) => (
        <TileCanvas
          key={`${bucket}:${tile.col},${tile.row}`}
          sourceId={sourceId}
          index={index}
          rotation={rotation}
          frame={frame}
          bucket={bucket}
          tile={tile}
        />
      ))}
    </div>
  );
}

function TileCanvas({
  sourceId,
  index,
  rotation,
  frame,
  bucket,
  tile,
}: {
  readonly sourceId: SourceId;
  readonly index: number;
  readonly rotation: Rotation;
  readonly frame: PageFrame;
  readonly bucket: number;
  readonly tile: Tile;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const service = getEngineService();
  const revision = useSyncExternalStore(service.subscribeRevisions, () =>
    service.pageRevision(sourceId, index),
  );
  const { originX, originY, rotation: total } = frame;
  const unrotatedWidth = frame.size.width;
  const unrotatedHeight = frame.size.height;
  const { col, row, left, top, width, height } = tile;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const controller = new AbortController();
    const clip = displayRectToUser(
      {
        size: { width: unrotatedWidth, height: unrotatedHeight },
        originX,
        originY,
        rotation: total,
        scale: 1,
      },
      { left, top, width, height },
    );
    void getEngineService()
      .renderPage({
        sourceId,
        index,
        rotation,
        bucket,
        priority: RENDER_PRIORITY.page,
        signal: controller.signal,
        clip,
        tile: `t${TILE_PX}:${col},${row}`,
      })
      .then((result) => {
        if (!result.ok || controller.signal.aborted) return;
        const { bitmap } = result.value;
        if (bitmap.width === 0) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        canvas.dataset.state = 'rendered';
      });
    return () => controller.abort();
  }, [
    sourceId,
    index,
    rotation,
    bucket,
    unrotatedWidth,
    unrotatedHeight,
    originX,
    originY,
    total,
    col,
    row,
    left,
    top,
    width,
    height,
    revision,
  ]);

  const scale = frame.scale;
  return (
    <canvas
      ref={ref}
      className={styles.tile}
      data-state="placeholder"
      style={{ left: left * scale, top: top * scale, width: width * scale, height: height * scale }}
    />
  );
}
