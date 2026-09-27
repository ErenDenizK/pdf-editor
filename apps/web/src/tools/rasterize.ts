/**
 * PDF → images (spec §6): renders the chosen pages through the PDFium adapter at the
 * requested DPI, in tiles when a page exceeds the single-bitmap cap, and streams the tiles
 * to the compress worker, which stitches, encodes (PNG/JPEG/WebP) and zips them (fflate).
 *
 * Pages that are plain source pages (no overlays, no crop override) render straight from
 * their source with the page's rotation. Otherwise the document is first assembled exactly
 * as it would be exported (page numbers, watermarks, crops, image pages) and the images
 * are rendered from that, so they always match the exported PDF.
 */
import type { DocumentId, Rotation, SourceId, VirtualDocument } from '@pdf-editor/document-model';
import {
  fitsCanvas,
  type RasterBackground,
  type RasterFile,
  type RasterFormat,
  rasterFileName,
  rasterSize,
  rasterTiles,
  uniqueNames,
} from '@pdf-editor/engine';

import { getEngineService } from '../engine/engine-service';
import { displaySize } from '../pages/page-geometry';
import { useWorkspaceStore } from '../state/workspace-store';
import { displayRectToUser, type PageFrame } from '../viewer/geometry';
import { getCompressor } from './compress-client';
import { openScratch, type ScratchDocument, toolRenderer } from './engine-access';
import { ToolSourceError, toolSourceBytes } from './tool-source';

export interface RasterOptions {
  readonly format: RasterFormat;
  readonly dpi: number;
  /** JPEG / WebP quality, 1–100. */
  readonly quality: number;
  readonly background: RasterBackground;
  /** 0-based page indices of the document, in order. */
  readonly pages: readonly number[];
  /** File name template ({title}, {page}, {label}). */
  readonly template: string;
}

export interface RasterProgress {
  readonly done: number;
  readonly total: number;
}

export class RasterError extends Error {
  constructor(
    readonly code: 'too-large' | 'export-failed' | 'aborted' | 'no-pages',
    message: string,
  ) {
    super(message);
    this.name = 'RasterError';
  }
}

interface PageTarget {
  readonly sourceId: SourceId;
  readonly index: number;
  /** Extra rotation passed to the renderer (on top of the page's own /Rotate). */
  readonly rotation: Rotation;
  readonly frame: PageFrame;
  readonly label: string;
}

function isPlain(doc: VirtualDocument, pages: readonly number[]): boolean {
  return pages.every((i) => {
    const page = doc.pages[i];
    return page?.ref.kind === 'source' && page.overlays.length === 0 && page.cropBox === undefined;
  });
}

let jobCounter = 0;

export async function rasterizeDocument(
  documentId: DocumentId,
  options: RasterOptions,
  control: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (p: RasterProgress) => void;
  } = {},
): Promise<RasterFile> {
  const { signal, onProgress } = control;
  const ws = useWorkspaceStore.getState().workspace;
  const doc = ws.documents[documentId];
  if (!doc || options.pages.length === 0) throw new RasterError('no-pages', 'No pages to export');
  const scale = options.dpi / 72;

  let scratch: ScratchDocument | undefined;
  const targets: PageTarget[] = [];
  const labels = doc.pages.map((_, i) => String(i + 1));
  if (isPlain(doc, options.pages)) {
    for (const i of options.pages) {
      const page = doc.pages[i];
      if (page?.ref.kind !== 'source') continue;
      const source = ws.sources[page.ref.source];
      const intrinsic = source?.pages[page.ref.index]?.rotation ?? 0;
      const total = ((intrinsic + page.rotation) % 360) as Rotation;
      const shown = displaySize(ws, page);
      const quarter = total === 90 || total === 270;
      const crop = getEngineService().pageCropBox(page.ref.source, page.ref.index);
      targets.push({
        sourceId: page.ref.source,
        index: page.ref.index,
        rotation: page.rotation,
        frame: {
          size: quarter ? { width: shown.height, height: shown.width } : shown,
          originX: crop?.x ?? 0,
          originY: crop?.y ?? 0,
          rotation: total,
          scale,
        },
        label: source?.pages[page.ref.index]?.label ?? labels[i] ?? String(i + 1),
      });
    }
  } else {
    let bytes: ArrayBuffer;
    try {
      // The images are rendered from this copy: no password, whatever the export applies.
      bytes = await toolSourceBytes(documentId, signal);
    } catch (error) {
      const code = error instanceof ToolSourceError ? error.code : 'internal';
      throw new RasterError(
        code === 'aborted' ? 'aborted' : 'export-failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    scratch = await openScratch(bytes);
    for (const i of options.pages) {
      const info = scratch.document.pages[i];
      if (!info) continue;
      const crop = info.cropBox;
      targets.push({
        sourceId: scratch.id,
        index: i,
        rotation: 0,
        frame: {
          size: crop ? { width: crop.width, height: crop.height } : info.size,
          originX: crop?.x ?? 0,
          originY: crop?.y ?? 0,
          rotation: info.rotation,
          scale,
        },
        label: info.label ?? String(i + 1),
      });
    }
  }

  const renderer = await toolRenderer();
  const compressor = await getCompressor();
  const job = `raster-${++jobCounter}`;
  const names = uniqueNames(
    options.pages.map((i, n) =>
      rasterFileName(
        options.template,
        {
          title: doc.title,
          page: i + 1,
          pageCount: doc.pages.length,
          label: targets[n]?.label ?? String(i + 1),
        },
        options.format,
      ),
    ),
  );
  try {
    for (const [n, target] of targets.entries()) {
      if (signal?.aborted) throw new RasterError('aborted', 'Cancelled');
      onProgress?.({ done: n, total: targets.length });
      const { frame } = target;
      const quarter = frame.rotation === 90 || frame.rotation === 270;
      const shownW = quarter ? frame.size.height : frame.size.width;
      const shownH = quarter ? frame.size.width : frame.size.height;
      const { width, height } = rasterSize(shownW, shownH, options.dpi);
      if (!fitsCanvas(width, height)) {
        throw new RasterError('too-large', `${width}×${height}`);
      }
      const background = options.format === 'jpeg' ? 'white' : options.background;
      const spec = {
        name: names[n] ?? `page-${n + 1}`,
        format: options.format,
        quality: options.quality,
        background,
      };
      const layout = rasterTiles(width, height);
      if (layout.length === 1) {
        const rendered = await renderer.renderPage(target.sourceId, target.index, {
          scale,
          rotation: target.rotation,
          background,
          ...(signal ? { signal } : {}),
        });
        await compressor.rasterBegin(job, {
          ...spec,
          width: rendered.width,
          height: rendered.height,
        });
        await compressor.rasterTile(job, { bitmap: rendered.bitmap, x: 0, y: 0 });
      } else {
        // Each tile goes to the worker's page canvas as soon as it is rendered: at most one
        // tile bitmap is alive at a time.
        await compressor.rasterBegin(job, { ...spec, width, height });
        for (const tile of layout) {
          const clip = displayRectToUser(frame, {
            left: tile.x / scale,
            top: tile.y / scale,
            width: tile.width / scale,
            height: tile.height / scale,
          });
          const rendered = await renderer.renderPage(target.sourceId, target.index, {
            scale,
            rotation: target.rotation,
            clip,
            background,
            ...(signal ? { signal } : {}),
          });
          await compressor.rasterTile(job, { bitmap: rendered.bitmap, x: tile.x, y: tile.y });
        }
      }
      await compressor.rasterEnd(job);
    }
    onProgress?.({ done: targets.length, total: targets.length });
    return await compressor.rasterFinish(
      job,
      `${doc.title.replace(/[\\/:*?"<>|]+/g, '_')}-images.zip`,
    );
  } catch (error) {
    compressor.rasterCancel(job);
    throw error;
  } finally {
    await scratch?.close();
  }
}
