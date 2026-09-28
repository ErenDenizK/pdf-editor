/**
 * The conversion run on the caller's side: pulls each page's text runs, URI links and images
 * from a `ConvertSource` (in the app, the PDFium worker's proxy) and pushes them to the
 * analysis worker one page at a time; the worker lays everything out at the end.
 */
import type { Rotation, SourceId } from '@pdf-editor/document-model';

import type { AnalysisBackend } from '../analysis/backend';
import { abortedError, throwIfAborted } from '../analysis/scheduler';
import type {
  ComparePageGeometry,
  ConvertImageInput,
  ConvertLinkInput,
  ConvertOptions,
  ConvertResult,
  EngineCallOptions,
  OpenedDocument,
  PdfEditor,
  PdfImageEditor,
  PdfRenderer,
  ProgressCallback,
  TextRun,
} from '../types';

export interface ConvertSource {
  readonly pageCount: number;
  geometry(index: number): ComparePageGeometry;
  text(index: number, options: EngineCallOptions): Promise<readonly TextRun[]>;
  links?(index: number, options: EngineCallOptions): Promise<readonly ConvertLinkInput[]>;
  images?(index: number, options: EngineCallOptions): Promise<readonly ConvertImageInput[]>;
}

type EngineLike = Pick<PdfRenderer, 'getPageText'> &
  Pick<PdfEditor, 'listAnnotations'> &
  Partial<Pick<PdfImageEditor, 'locateImages' | 'extractImage'>>;

/** A `ConvertSource` over an open source of the viewer's engine (e.g. `PdfiumProxy`). */
export function pdfiumConvertSource(
  engine: EngineLike,
  id: SourceId,
  opened: Pick<OpenedDocument, 'pageCount' | 'pages'>,
  options: { readonly rotations?: readonly Rotation[]; readonly images?: boolean } = {},
): ConvertSource {
  const { locateImages, extractImage } = engine;
  const withImages =
    (options.images ?? true) && locateImages !== undefined && extractImage !== undefined;
  return {
    pageCount: opened.pageCount,
    geometry(index) {
      const page = opened.pages[index];
      if (!page) throw new RangeError(`No page ${index}`);
      return {
        size: page.size,
        rotation: ((page.rotation + (options.rotations?.[index] ?? 0)) % 360) as Rotation,
        ...(page.cropBox ? { origin: { x: page.cropBox.x, y: page.cropBox.y } } : {}),
      };
    },
    text: (index, callOptions) => engine.getPageText(id, index, callOptions),
    async links(index, callOptions) {
      const annotations = await engine.listAnnotations(id, index, callOptions);
      return annotations.flatMap((a) =>
        a.kind === 'link' && a.uri !== undefined ? [{ rect: a.rect, uri: a.uri }] : [],
      );
    },
    ...(withImages
      ? {
          async images(index: number, callOptions: EngineCallOptions) {
            const located = await locateImages.call(engine, id, index, callOptions);
            const out: ConvertImageInput[] = [];
            for (const image of located) {
              const pixels = await extractImage.call(engine, image, callOptions);
              out.push(
                pixels.original
                  ? { rect: image.bounds, jpeg: pixels.original.bytes }
                  : {
                      rect: image.bounds,
                      rgba: { width: pixels.width, height: pixels.height, data: pixels.rgba },
                    },
              );
            }
            return out;
          },
        }
      : {}),
  };
}

let jobCounter = 0;

export async function convertDocument(
  backend: AnalysisBackend,
  source: ConvertSource,
  options: ConvertOptions &
    EngineCallOptions & {
      /** Pages to convert (0-based, in order); default all. */
      readonly pages?: readonly number[];
      readonly onProgress?: ProgressCallback;
    } = {},
): Promise<ConvertResult> {
  const { signal, priority, onProgress, pages: only, ...convertOptions } = options;
  throwIfAborted(signal, 'convert');
  const call: EngineCallOptions = { ...(signal ? { signal } : {}), priority: priority ?? 'low' };
  const job = `convert-${++jobCounter}-${Date.now().toString(36)}`;
  const pages = only ?? Array.from({ length: source.pageCount }, (_, i) => i);
  await backend.convertBegin(job, convertOptions);
  try {
    let done = 0;
    onProgress?.(0, pages.length + 1);
    for (const index of pages) {
      const [runs, links, images] = await Promise.all([
        source.text(index, call),
        source.links?.(index, call) ?? Promise.resolve([]),
        convertOptions.format !== 'text' && convertOptions.images !== false && source.images
          ? source.images(index, call)
          : Promise.resolve([]),
      ]);
      throwIfAborted(signal, 'convert');
      await backend.convertAddPage(job, index, { ...source.geometry(index), runs, links, images });
      onProgress?.(++done, pages.length + 1);
    }
    const result = await backend.convertFinish(job, signal ? { signal } : {});
    onProgress?.(pages.length + 1, pages.length + 1);
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortedError('convert', signal.reason);
    throw error;
  } finally {
    await backend.convertEnd(job).catch(() => undefined);
  }
}
