/**
 * Compress worker entry: qpdf (`QpdfPlumber`), the compression pipeline (pdf-lib + a
 * private PDFium for decoding + OffscreenCanvas for JPEG) and the PDF → images encoder
 * with its streaming ZIP (fflate). Loaded lazily by the app; the wasm files are fetched
 * on the first job that needs them. Construct with Vite's `?worker` import and wrap with
 * `createCompressProxy`.
 */
import { expose, releaseProxy, type Remote, transfer } from 'comlink';

import { analyzeCompression, compressPdf } from '../compress/compress';
import { canvasEncoder } from '../compress/encode';
import { PdfiumImageDecoder } from '../compress/pdfium-decoder';
import { QpdfPlumber } from '../plumber/qpdf-plumber';
import { RasterArchive, RasterCanvas } from '../rasterize/encode-page';
import { RASTER_MIME } from '../rasterize/plan';
import { EngineError } from '../types';
import {
  COMPRESS_ABORT_MESSAGE,
  type CompressWorkerApi,
  type CompressWorkerConfig,
  type Wire,
} from './compress-protocol';

let config: CompressWorkerConfig | undefined;
let plumber: QpdfPlumber | undefined;
let decoder: PdfiumImageDecoder | undefined;

function configured(): CompressWorkerConfig {
  if (!config) throw new EngineError('internal', 'Compress worker is not configured');
  return config;
}
function getPlumber(): QpdfPlumber {
  plumber ??= new QpdfPlumber({ wasmUrl: configured().qpdfWasmUrl });
  return plumber;
}
function getDecoder(): PdfiumImageDecoder {
  decoder ??= new PdfiumImageDecoder(configured().pdfiumWasmUrl);
  return decoder;
}

function failure(error: unknown): Wire<never> {
  if (error instanceof EngineError) return { ok: false, code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: error instanceof RangeError || /memory/i.test(message) ? 'out-of-memory' : 'internal',
    message,
  };
}

const ok = <T>(value: T): Wire<T> => ({ ok: true, value });

interface RasterJob {
  readonly archive: RasterArchive;
  page: RasterCanvas | undefined;
}
const rasterJobs = new Map<string, RasterJob>();

function job(id: string): RasterJob {
  const found = rasterJobs.get(id);
  if (!found) throw new EngineError('internal', `Unknown raster job ${id}`);
  return found;
}

const api: CompressWorkerApi = {
  configure(next) {
    config = next;
  },
  async plumb(bytes, options) {
    try {
      const result = await getPlumber().process(bytes, options);
      return transfer(ok(result), [result.bytes]);
    } catch (error) {
      return failure(error);
    }
  },
  async check(bytes, options) {
    try {
      return ok(await getPlumber().check(bytes, options));
    } catch (error) {
      return failure(error);
    }
  },
  async analyze(bytes, password) {
    try {
      const value = await analyzeCompression(
        bytes,
        { plumber: getPlumber() },
        password === undefined ? {} : { password },
      );
      return ok(value);
    } catch (error) {
      return failure(error);
    }
  },
  async compress(bytes, settings, options, onProgress, abortPort) {
    const controller = new AbortController();
    if (abortPort) {
      abortPort.onmessage = (event: MessageEvent) => {
        if (event.data === COMPRESS_ABORT_MESSAGE) controller.abort();
      };
    }
    try {
      const result = await compressPdf(
        bytes,
        settings,
        { plumber: getPlumber(), decoder: getDecoder(), encoder: canvasEncoder },
        {
          ...options,
          signal: controller.signal,
          ...(onProgress ? { onProgress } : {}),
        },
      );
      return transfer(ok(result), [result.bytes]);
    } catch (error) {
      return failure(error);
    } finally {
      abortPort?.close();
      // The progress callback is a Comlink proxy: release its MessageChannel.
      (onProgress as Remote<(p: unknown) => void> | undefined)?.[releaseProxy]();
    }
  },
  rasterBegin(id, page) {
    try {
      const entry = rasterJobs.get(id) ?? { archive: new RasterArchive(), page: undefined };
      rasterJobs.set(id, entry);
      entry.page = new RasterCanvas(page);
      return Promise.resolve(ok(null));
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  },
  rasterTile(id, tile) {
    try {
      const page = job(id).page;
      if (!page) {
        tile.bitmap.close();
        throw new EngineError('internal', 'No page started');
      }
      page.draw(tile);
      return Promise.resolve(ok(null));
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  },
  async rasterEnd(id) {
    try {
      const entry = job(id);
      const page = entry.page;
      if (!page) throw new EngineError('internal', 'No page started');
      entry.page = undefined;
      const bytes = await page.encode();
      entry.archive.add(page.spec.name, bytes, RASTER_MIME[page.spec.format]);
      return ok(bytes.byteLength);
    } catch (error) {
      return failure(error);
    }
  },
  rasterFinish(id, zipName) {
    const entry = rasterJobs.get(id);
    rasterJobs.delete(id);
    try {
      if (!entry) throw new EngineError('internal', 'No pages were rendered');
      return Promise.resolve(ok(entry.archive.finish(zipName)));
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  },
  rasterCancel(id) {
    rasterJobs.delete(id);
  },
};

expose(api);
