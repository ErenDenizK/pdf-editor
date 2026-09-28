/**
 * Private scratch documents on the hosted engine (ADR-0011): the redaction pipeline opens
 * every intermediate result as its own document on the same `PdfEngine`, never touching the
 * document the user has open, so in-session orphans stay out of it and the orchestrator's
 * queue (and `withRawAccess` for raw edits) serialises everything.
 *
 * Reads go straight to the orchestrator (glyphs, search, raw renders), so this module needs
 * no DOM: it runs in the PDFium worker as well as in tests.
 */

import type { PdfDocumentObject, PdfPageObject } from '@embedpdf/models';
import type { Rect } from '@pdf-editor/document-model';

import type { HostedEngine } from '../pdfium/host/hosted-engine';
import { deviceToUserRect, pageGeometry, unionRect, userToDeviceRect } from '../pdfium/coords';
import { runTask } from '../pdfium/task-bridge';
import {
  EngineError,
  type ForensicDeps,
  type ForensicPixels,
  type Glyph,
  type TextRun,
} from '../types';

/** The part of `HostedEngine` the pipeline uses. */
export type RedactionHost = Pick<HostedEngine, 'engine' | 'module' | 'memory' | 'withRawAccess'>;

/** One character of a page: its text and, unless the engine generated it, its box. */
export interface PageChar {
  readonly text: string;
  /** User space; absent for generated characters (line breaks, synthesized spaces). */
  readonly rect?: Rect;
}

export interface ScratchDocument {
  readonly id: string;
  readonly doc: PdfDocumentObject;
  page(pageIndex: number): PdfPageObject;
  /** Every character of a page in content order. */
  chars(pageIndex: number): Promise<PageChar[]>;
  /** Case-insensitive search over all pages; hit rects in user space. */
  search(query: string): Promise<{ pageIndex: number; rects: Rect[] }[]>;
  /** Raw RGBA render of `rect` (user space) with annotations and forms. */
  renderArea(pageIndex: number, rect: Rect, scale: number): Promise<ForensicPixels>;
  close(): Promise<void>;
}

let counter = 0;

/** Opens `bytes` (copied) as a private scratch document. */
export async function openScratch(
  host: RedactionHost,
  bytes: ArrayBuffer | Uint8Array,
  options: { readonly password?: string; readonly signal?: AbortSignal } = {},
): Promise<ScratchDocument> {
  const { engine } = host;
  const id = `__redaction:${++counter}`;
  const content = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
  const { signal, password } = options;
  const doc = await runTask(
    engine.openDocumentBuffer({ id, content }, password === undefined ? {} : { password }),
    signal,
    { op: 'open', passwordProvided: password !== undefined },
  );
  const page = (pageIndex: number): PdfPageObject => {
    const p = doc.pages[pageIndex];
    if (!p) throw new EngineError('internal', `Page ${pageIndex + 1} does not exist`);
    return p;
  };
  return {
    id,
    doc,
    page,
    async chars(pageIndex) {
      const p = page(pageIndex);
      const glyphs = await runTask(engine.getPageGlyphs(doc, p), signal, { op: 'redaction text' });
      if (glyphs.length === 0) return [];
      const texts = await runTask(
        engine.getTextSlices(
          doc,
          glyphs.map((_, charIndex) => ({ pageIndex, charIndex, charCount: 1 })),
        ),
        signal,
        { op: 'redaction text' },
      );
      const g = pageGeometry(p);
      // The glyph array is sparse (generated characters have no entry): index, not map.
      const out: PageChar[] = [];
      for (let i = 0; i < glyphs.length; i++) {
        const box = glyphs[i];
        const text = texts[i] ?? '';
        out.push(
          !box || box.isEmpty
            ? { text }
            : { text, rect: deviceToUserRect(g, { origin: box.origin, size: box.size }) },
        );
      }
      return out;
    },
    async search(query) {
      const result = await runTask(engine.searchAllPages(doc, query, { flags: [] }), signal, {
        op: 'redaction search',
      });
      return result.results.map((hit) => ({
        pageIndex: hit.pageIndex,
        rects: hit.rects.map((r) => deviceToUserRect(pageGeometry(page(hit.pageIndex)), r)),
      }));
    },
    async renderArea(pageIndex, rect, scale) {
      const p = page(pageIndex);
      const image = await runTask(
        engine.renderPageRectRaw(doc, p, userToDeviceRect(pageGeometry(p), rect), {
          scaleFactor: scale,
          rotation: 0,
          withAnnotations: true,
          withForms: true,
        }),
        signal,
        { op: 'redaction render' },
      );
      return { width: image.width, height: image.height, data: image.data };
    },
    async close() {
      await engine
        .closeDocument(doc)
        .toPromise()
        .catch(() => undefined);
    },
  };
}

/** Text runs for `ForensicDeps.getPageText`: one run of the page's boxed glyphs. */
export function textRunsOf(chars: readonly PageChar[]): TextRun[] {
  const glyphs: Glyph[] = chars.flatMap((c) =>
    c.rect ? [{ text: c.text, rect: c.rect, fontSize: 0 }] : [],
  );
  const rect = unionRect(glyphs.map((g) => g.rect));
  return rect ? [{ text: glyphs.map((g) => g.text).join(''), rect, glyphs }] : [];
}

/** Forensic dependencies bound to a scratch document. */
export function forensicDepsOf(scratch: ScratchDocument): ForensicDeps {
  return {
    getPageText: async (pageIndex) => textRunsOf(await scratch.chars(pageIndex)),
    search: async (query) =>
      (await scratch.search(query)).map((hit) => ({
        pageIndex: hit.pageIndex,
        rects: hit.rects,
        context: '',
      })),
    renderArea: (pageIndex, rect, scale) => scratch.renderArea(pageIndex, rect, scale),
  };
}

/**
 * Opens `bytes` on the host, runs `fn` with forensic dependencies bound to it, and closes
 * the scratch document afterwards (the export service's entry for `verifyRedactedOutput`).
 */
export async function withForensicDeps<R>(
  host: RedactionHost,
  bytes: ArrayBuffer | Uint8Array,
  fn: (deps: ForensicDeps) => Promise<R>,
  options: { readonly password?: string; readonly signal?: AbortSignal } = {},
): Promise<R> {
  const scratch = await openScratch(host, bytes, options);
  try {
    return await fn(forensicDepsOf(scratch));
  } finally {
    await scratch.close();
  }
}
