/**
 * Compress worker entry: qpdf (`QpdfPlumber`), the compression pipeline (pdf-lib + a
 * private PDFium for decoding + OffscreenCanvas for JPEG) and the PDF → images encoder
 * with its ZIP builder (fflate). Loaded lazily by the app; the wasm files are fetched on
 * the first job that needs them. Construct with Vite's `?worker` import and wrap with
 * `createCompressProxy`.
 */
import { expose, transfer } from 'comlink';

import { analyzeCompression, compressPdf } from '../compress/compress';
import { canvasEncoder } from '../compress/encode';
import { PdfiumImageDecoder } from '../compress/pdfium-decoder';
import { QpdfPlumber } from '../plumber/qpdf-plumber';
import { encodeRasterPage, zipFiles } from '../rasterize/encode-page';
import { RASTER_MIME, type RasterFormat } from '../rasterize/plan';
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

interface RasterJob {
  readonly files: { name: string; bytes: Uint8Array; format: RasterFormat }[];
}
const rasterJobs = new Map<string, RasterJob>();

const api: CompressWorkerApi = {
  configure(next) {
    config = next;
  },
  async plumb(bytes, options) {
    try {
      const result = await getPlumber().process(bytes, options);
      return transfer({ ok: true as const, value: result }, [result.bytes]);
    } catch (error) {
      return failure(error);
    }
  },
  async check(bytes, password) {
    try {
      return { ok: true, value: await getPlumber().check(bytes, password) };
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
      return { ok: true, value };
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
      return transfer({ ok: true as const, value: result }, [result.bytes]);
    } catch (error) {
      return failure(error);
    } finally {
      abortPort?.close();
    }
  },
  async rasterAdd(job, page) {
    try {
      const bytes = await encodeRasterPage(page);
      const entry = rasterJobs.get(job) ?? { files: [] };
      entry.files.push({ name: page.name, bytes, format: page.format });
      rasterJobs.set(job, entry);
      return { ok: true, value: bytes.byteLength };
    } catch (error) {
      return failure(error);
    }
  },
  rasterFinish(job, zipName) {
    const entry = rasterJobs.get(job);
    rasterJobs.delete(job);
    try {
      if (!entry || entry.files.length === 0) {
        throw new EngineError('internal', 'No pages were rendered');
      }
      const only = entry.files.length === 1 ? entry.files[0] : undefined;
      const bytes = only ? only.bytes : zipFiles(entry.files);
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const value = only
        ? { bytes: buffer, name: only.name, type: RASTER_MIME[only.format] }
        : { bytes: buffer, name: zipName, type: 'application/zip' };
      return Promise.resolve(transfer({ ok: true as const, value }, [buffer]));
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  },
  rasterCancel(job) {
    rasterJobs.delete(job);
  },
};

expose(api);
