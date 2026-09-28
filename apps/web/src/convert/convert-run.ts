/**
 * PDF → Markdown / text (spec recognize-and-compare §4): reads an open tab page by page
 * (`compare/document-pages.ts`: text runs, URI links and images from the PDFium worker) and
 * lays it out in the analysis worker (`AnalysisProxy.convert`). The dialog's choices map to
 * the engine's `ConvertOptions` here; `outputFile` names the download.
 */
import type { DocumentId } from '@pdf-editor/document-model';
import type {
  ConvertOptions,
  ConvertPageBreak,
  ConvertResult,
  EngineCallOptions,
} from '@pdf-editor/engine';

import {
  documentPages,
  pageAt,
  pageEngine,
  pageGeometry,
  pageImages,
  pageLinks,
  pageText,
} from '../compare/document-pages';
import { getAnalysisWorkers } from '../engine/engine-service';
import { exportFileName } from '../export/filename';

export type ConvertFormat = 'markdown' | 'text';
export type ConvertScope = 'document' | 'page' | 'range';

export interface ConvertChoice {
  readonly format: ConvertFormat;
  readonly scope: ConvertScope;
  /** Page range for `range` scope (1-based, e.g. "1-3, 5"). */
  readonly range: string;
  readonly pageBreak: ConvertPageBreak;
  readonly keepHeadersFooters: boolean;
  readonly joinHyphens: boolean;
  /** Markdown only: images in a ZIP next to `document.md` (true) or left out. */
  readonly images: boolean;
}

export const DEFAULT_CHOICE: ConvertChoice = {
  format: 'markdown',
  scope: 'document',
  range: '',
  pageBreak: 'none',
  keepHeadersFooters: false,
  joinHyphens: true,
  images: true,
};

/**
 * The 0-based pages a choice converts, or null for an invalid range. `parseRange` is the
 * engine's `parsePageRange` (1-based text → 0-based indices, empty = all).
 */
export function choicePages(
  choice: Pick<ConvertChoice, 'scope' | 'range'>,
  pageCount: number,
  currentPage: number,
  parseRange: (text: string, count: number) => number[] | null,
): number[] | null {
  if (pageCount <= 0) return null;
  if (choice.scope === 'page') {
    return [Math.min(pageCount - 1, Math.max(0, currentPage))];
  }
  if (choice.scope === 'range') {
    const pages = parseRange(choice.range, pageCount);
    return pages && pages.length > 0 ? pages : null;
  }
  return Array.from({ length: pageCount }, (_, i) => i);
}

/** The engine options of a choice. */
export function convertOptions(choice: ConvertChoice): ConvertOptions {
  const markdown = choice.format === 'markdown';
  return {
    format: choice.format,
    scope: 'document',
    pageBreak: choice.pageBreak,
    keepHeadersFooters: choice.keepHeadersFooters,
    joinHyphens: choice.joinHyphens,
    images: markdown && choice.images,
  };
}

export interface OutputFile {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly type: string;
}

/** What gets downloaded: the ZIP (Markdown with images), else the one text file. */
export function outputFile(result: ConvertResult, title: string): OutputFile {
  const stem = exportFileName(title).replace(/\.pdf$/, '');
  if (result.zip) return { bytes: result.zip, name: `${stem}.zip`, type: 'application/zip' };
  const markdown = result.format === 'markdown';
  const first = result.files[0];
  const bytes = first?.bytes ?? new TextEncoder().encode(result.text);
  return {
    bytes,
    name: `${stem}.${markdown ? 'md' : 'txt'}`,
    type: markdown ? 'text/markdown' : 'text/plain',
  };
}

/** The first `count` lines of the converted text, for the dialog's preview. */
export function previewLines(text: string, count = 40): { text: string; more: boolean } {
  const lines = text.split('\n');
  return { text: lines.slice(0, count).join('\n'), more: lines.length > count };
}

/** Converts pages of an open tab in the analysis worker. */
export async function convertDocumentPages(
  documentId: DocumentId,
  pages: readonly number[],
  choice: ConvertChoice,
  control: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ConvertResult> {
  const { signal, onProgress } = control;
  const lease = await getAnalysisWorkers().acquire();
  try {
    const engine = await pageEngine();
    const side = await documentPages(documentId, signal ? { signal } : {});
    try {
      const call = (options: EngineCallOptions): EngineCallOptions => ({
        ...options,
        priority: 'low',
      });
      return await lease.proxy.convert(
        {
          pageCount: side.pages.length,
          geometry: (index) => pageGeometry(pageAt(side, index)),
          text: (index, options) => pageText(engine, side, index, call(options)),
          links: (index, options) => pageLinks(engine, pageAt(side, index), call(options)),
          images: (index, options) => pageImages(engine, pageAt(side, index), call(options)),
        },
        {
          ...convertOptions(choice),
          pages,
          ...(signal ? { signal } : {}),
          ...(onProgress ? { onProgress } : {}),
        },
      );
    } finally {
      await side.dispose().catch(() => undefined);
    }
  } finally {
    lease.release();
  }
}
