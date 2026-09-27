/**
 * Export pipeline (ARCHITECTURE.md §4): virtual document → verified PDF bytes.
 *
 * 1. Plan (`planExport`, engine package): label ranges only when needed, outline without
 *    unresolved leaves, the verification expectation.
 * 2. Source bytes: sources with engine edits — and encrypted sources, which pdf-lib cannot
 *    read without their password — go through `PdfEditor.save()` (PDFium, security
 *    removed); the rest use the original bytes the engine service kept at open.
 *    TODO(M2): engine edits (annotations, form values) are recorded in the model from M2
 *    on; the hook already routes such sources through `save()`.
 * 3. Assemble in the assembly worker, with progress. Image pages take their bytes from the
 *    workspace store's blobs (PNG or JPEG; WebP was re-encoded to PNG when inserted).
 * 4. Verify: re-open the output in PDFium (and pdf-lib via the inspector) and compare page
 *    count, sizes, rotations, labels and outline. Only verified bytes are offered.
 *
 * Never rejects: failures resolve to `{ ok: false }` with a message fit for the UI.
 */
import type { BlobId, DocumentId, SourceId, Workspace } from '@pdf-editor/document-model';
import type { PdfAssembler, ReconciliationReport, VerificationResult } from '@pdf-editor/engine';

import { getAssembler } from '../engine/assembler-client';
import {
  type EngineResult,
  type EngineService,
  getEngineService,
  toFailure,
} from '../engine/engine-service';
import { m } from '../i18n';
import { blobsOfDocument, useWorkspaceStore } from '../state/workspace-store';

export type ExportPhase = 'reading' | 'assembling' | 'verifying';

export interface ExportProgress {
  readonly phase: ExportPhase;
  readonly done: number;
  readonly total: number;
}

export interface PreparedExport {
  readonly bytes: ArrayBuffer;
  readonly report: ReconciliationReport;
  readonly verification: VerificationResult;
  readonly pageCount: number;
  readonly sourceCount: number;
  readonly durationMs: number;
}

export interface ExportOptions {
  readonly compatibility?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ExportProgress) => void;
}

export interface ExportDependencies {
  readonly engine: Pick<EngineService, 'sourceBytes' | 'saveSource' | 'verify'>;
  readonly assembler: () => Promise<PdfAssembler>;
  readonly workspace: () => Workspace;
  /** Image bytes by blob id (image pages); defaults to none. */
  readonly blobs?: (id: BlobId) => ArrayBuffer | undefined;
}

const defaultDependencies = (): ExportDependencies => ({
  engine: getEngineService(),
  assembler: getAssembler,
  workspace: () => useWorkspaceStore.getState().workspace,
  blobs: (id) => useWorkspaceStore.getState().blobs[id]?.bytes,
});

const failed = (message: string, code: 'internal' | 'aborted' = 'internal') =>
  ({ ok: false, error: { code, message } }) as const;

/** Whether a source must be serialized by PDFium instead of using its original bytes. */
export function needsEngineSave(ws: Workspace, sourceId: SourceId): boolean {
  const source = ws.sources[sourceId];
  return (
    source?.flags.encrypted === true || ws.engineEdits.some((edit) => edit.source === sourceId)
  );
}

export async function prepareExport(
  documentId: DocumentId,
  options: ExportOptions = {},
  deps: ExportDependencies = defaultDependencies(),
): Promise<EngineResult<PreparedExport>> {
  const started = performance.now();
  const { signal, onProgress } = options;
  const ws = deps.workspace();
  const doc = ws.documents[documentId];
  if (doc === undefined) return failed(m.export_error_closed());
  if (doc.pages.length === 0) return failed(m.export_error_no_pages());
  try {
    const { planExport } = await import('@pdf-editor/engine');
    const plan = planExport(ws, documentId);

    const sources = new Map<SourceId, ArrayBuffer>();
    for (const [index, sourceId] of plan.sources.entries()) {
      if (signal?.aborted) return failed(m.export_error_cancelled(), 'aborted');
      onProgress?.({ phase: 'reading', done: index, total: plan.sources.length });
      const read = needsEngineSave(ws, sourceId)
        ? await deps.engine.saveSource(sourceId, {
            removeSecurity: ws.sources[sourceId]?.flags.encrypted === true,
            ...(signal ? { signal } : {}),
          })
        : await deps.engine.sourceBytes(sourceId);
      if (!read.ok) {
        const name = ws.sources[sourceId]?.name ?? m.unknown_file();
        return failed(
          m.export_error_read({ name, reason: read.error.message }),
          codeOf(read.error.code),
        );
      }
      sources.set(sourceId, read.value);
    }

    const blobs = new Map<string, ArrayBuffer>();
    for (const blobId of blobsOfDocument(doc)) {
      const bytes = deps.blobs?.(blobId);
      if (bytes === undefined) return failed(m.export_error_image_missing());
      // The worker may take ownership; keep the stored bytes for later exports.
      blobs.set(blobId, bytes.slice(0));
    }

    const assembler = await deps.assembler();
    const pageCount = doc.pages.length;
    onProgress?.({ phase: 'assembling', done: 0, total: pageCount });
    const { bytes, report } = await assembler.assemble(
      {
        document: plan.document,
        sources,
        blobs,
        sourceNames: plan.sourceNames,
      },
      {
        ...(options.compatibility ? { compatibility: true } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (done, total) => onProgress?.({ phase: 'assembling', done, total }),
      },
    );

    onProgress?.({ phase: 'verifying', done: 0, total: 1 });
    // The verifier's adapter transfers what it opens; keep `bytes` for the download.
    const verified = await deps.engine.verify(bytes.slice(0), plan.expectation, signal);
    if (!verified.ok) {
      return failed(
        m.export_error_check({ reason: verified.error.message }),
        codeOf(verified.error.code),
      );
    }
    onProgress?.({ phase: 'verifying', done: 1, total: 1 });
    return {
      ok: true,
      value: {
        bytes,
        report,
        verification: verified.value,
        pageCount,
        sourceCount: plan.sources.length,
        durationMs: performance.now() - started,
      },
    };
  } catch (error) {
    const failure = toFailure(error);
    return failed(
      failure.code === 'aborted' ? m.export_error_cancelled() : failure.message,
      codeOf(failure.code),
    );
  }
}

function codeOf(code: string): 'internal' | 'aborted' {
  return code === 'aborted' ? 'aborted' : 'internal';
}
