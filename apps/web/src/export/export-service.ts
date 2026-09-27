/**
 * Export pipeline (ARCHITECTURE.md §4): virtual document → verified PDF bytes.
 *
 * 1. Plan (`planExport`, engine package): label ranges only when needed, outline without
 *    unresolved leaves, the verification expectation.
 * 2. Source bytes: sources with engine edits, encrypted sources (pdf-lib cannot read them
 *    without their password; security is removed) and sources PDFium repaired on open (the
 *    original bytes still carry the broken structure; ARCHITECTURE.md §5) go through
 *    `PdfEditor.save()`; the rest use the original bytes the engine service kept at open.
 *    Both removals and repairs are reported (`sourceNotes`, and a report warning), never
 *    silent (ARCHITECTURE.md §5).
 *    TODO(M2): engine edits (annotations, form values) are recorded in the model from M2
 *    on; the hook already routes such sources through `save()`.
 * 3. Assemble in the assembly worker, with progress. Image pages take their bytes from the
 *    workspace store's blobs (PNG or JPEG; WebP was re-encoded to PNG when inserted).
 * 4. Verify: re-open the output in PDFium (and pdf-lib via the inspector; with the user
 *    password when the output is encrypted) and compare page count, sizes, rotations,
 *    labels and outline. Only verified bytes are offered.
 *
 * Never rejects: failures resolve to `{ ok: false }` with a message fit for the UI.
 */
import type {
  BlobId,
  DocumentId,
  SecurityPolicy,
  SourceId,
  Workspace,
} from '@pdf-editor/document-model';
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

/** What happened to source files on the way in (file names, in order of first use). */
export interface SourceNotes {
  /** Encrypted sources whose password protection the output does not carry. */
  readonly securityRemoved: readonly string[];
  /** Sources PDFium repaired on open; the output is built from the repaired copy. */
  readonly repaired: readonly string[];
}

export interface PreparedExport {
  readonly bytes: ArrayBuffer;
  /** The assembler's report, plus warnings about security removed and repairs. */
  readonly report: ReconciliationReport;
  readonly sourceNotes: SourceNotes;
  readonly verification: VerificationResult;
  readonly pageCount: number;
  readonly sourceCount: number;
  readonly durationMs: number;
}

export interface ExportOptions {
  readonly compatibility?: boolean;
  /** Encrypt the output (overrides the document's own policy). */
  readonly security?: SecurityPolicy;
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
    source?.flags.encrypted === true ||
    source?.flags.repaired === true ||
    ws.engineEdits.some((edit) => edit.source === sourceId)
  );
}

/** English report warnings for the source notes (the summary shows localized lines). */
export function sourceNoteWarnings(notes: SourceNotes): string[] {
  const warnings: string[] = [];
  const count = (n: number) => (n === 1 ? '1 file' : `${n} files`);
  if (notes.securityRemoved.length > 0) {
    warnings.push(
      `Password protection from ${count(notes.securityRemoved.length)} was removed; set a new password in Export options`,
    );
  }
  if (notes.repaired.length > 0) {
    warnings.push(
      `${count(notes.repaired.length)} had to be repaired when opened; the output was built from the repaired copy`,
    );
  }
  return warnings;
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
    const plan = planExport(ws, documentId, options.security ? { security: options.security } : {});

    const sources = new Map<SourceId, ArrayBuffer>();
    const securityRemoved: string[] = [];
    const repaired: string[] = [];
    for (const [index, sourceId] of plan.sources.entries()) {
      if (signal?.aborted) return failed(m.export_error_cancelled(), 'aborted');
      onProgress?.({ phase: 'reading', done: index, total: plan.sources.length });
      const source = ws.sources[sourceId];
      const name = source?.name ?? m.unknown_file();
      const encrypted = source?.flags.encrypted === true;
      const read = needsEngineSave(ws, sourceId)
        ? await deps.engine.saveSource(sourceId, {
            removeSecurity: encrypted,
            ...(signal ? { signal } : {}),
          })
        : await deps.engine.sourceBytes(sourceId);
      if (!read.ok) {
        return failed(
          m.export_error_read({ name, reason: read.error.message }),
          codeOf(read.error.code),
        );
      }
      sources.set(sourceId, read.value);
      // With a new password on the output, the old protection is replaced, not dropped.
      if (encrypted && plan.security === undefined) securityRemoved.push(name);
      if (source?.flags.repaired === true) repaired.push(name);
    }
    const sourceNotes: SourceNotes = { securityRemoved, repaired };

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
        ...(plan.security ? { security: plan.security } : {}),
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
        report: { ...report, warnings: [...report.warnings, ...sourceNoteWarnings(sourceNotes)] },
        sourceNotes,
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
