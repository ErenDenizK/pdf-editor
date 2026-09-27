/**
 * The bytes the document tools work on: the document assembled exactly as it would be
 * exported (page order, rotations, overlays, crops, image pages), but without compression
 * and without the document's password. The real export applies both afterwards, so an
 * encrypted copy must never reach the analysis or the scratch renderer, which open it
 * without a password.
 */
import type { DocumentId } from '@pdf-editor/document-model';

import type { EngineFailureCode } from '../engine/engine-service';
import { type ExportDependencies, prepareExport } from '../export/export-service';

export class ToolSourceError extends Error {
  constructor(
    readonly code: EngineFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolSourceError';
  }
}

export async function toolSourceBytes(
  documentId: DocumentId,
  signal?: AbortSignal,
  deps?: ExportDependencies,
): Promise<ArrayBuffer> {
  const prepared = await prepareExport(
    documentId,
    { compression: null, security: null, ...(signal ? { signal } : {}) },
    ...(deps ? [deps] : []),
  );
  if (!prepared.ok) throw new ToolSourceError(prepared.error.code, prepared.error.message);
  return prepared.value.bytes;
}
