/**
 * Compression inside the export pipeline (export-service.ts): the assembled bytes go
 * through the compress worker with the document's preset. An encrypted output is
 * decrypted with its user password, compressed and re-encrypted with the same policy.
 */
import type { SecurityPolicy } from '@pdf-editor/document-model';
import type { CompressionSettings } from '@pdf-editor/engine';

export interface CompressedExport {
  readonly bytes: ArrayBuffer;
  readonly before: number;
  readonly after: number;
}

export type ExportCompressor = (
  bytes: ArrayBuffer,
  settings: CompressionSettings,
  security: SecurityPolicy | undefined,
  signal: AbortSignal | undefined,
) => Promise<CompressedExport>;

export const compressExport: ExportCompressor = async (bytes, settings, security, signal) => {
  const { getCompressor } = await import('./compress-client');
  const compressor = await getCompressor();
  const result = await compressor.compress(bytes.slice(0), settings, {
    ...(security ? { password: security.userPassword ?? '', encrypt: security } : {}),
    ...(signal ? { signal } : {}),
  });
  return { bytes: result.bytes, before: result.before, after: result.after };
};
