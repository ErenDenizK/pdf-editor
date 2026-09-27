/**
 * Export pipeline (ARCHITECTURE.md §4): virtual document → verified PDF bytes.
 *
 * 1. Plan (`planExport`, engine package): label ranges only when needed, outline without
 *    unresolved leaves, the verification expectation.
 * 2. Source bytes: sources with engine edits (the workspace store's `dirtySources` when it
 *    has one, and sources with `workspace.engineEdits`), encrypted sources (pdf-lib cannot
 *    read them without their password; security is removed) and sources PDFium repaired on
 *    open (the original bytes still carry the broken structure; ARCHITECTURE.md §5) go
 *    through `PdfEditor.save()`; so does every source when annotations are flattened or
 *    comments are left out (spec viewer-annotations.md §6), because those options change
 *    unedited sources too. The rest use the original bytes the engine service kept at
 *    open. Removals and repairs are reported (`sourceNotes`, and a report warning), never
 *    silent (ARCHITECTURE.md §5). Before saving, the annotations of every exported page of
 *    an edited source are counted (`listAnnotations`) for verification.
 * 3. Assemble in the assembly worker, with progress. Image pages take their bytes from the
 *    workspace store's blobs (PNG or JPEG; WebP was re-encoded to PNG when inserted).
 * 4. Verify: re-open the output in PDFium (and pdf-lib via the inspector; with the user
 *    password when the output is encrypted) and compare page count, sizes, rotations,
 *    labels and outline; with edited annotations also the annotation count per page and
 *    the annotation conformance rules for the annotations this app wrote. Only verified
 *    bytes are offered.
 *
 * Never rejects: failures resolve to `{ ok: false }` with a message fit for the UI.
 */
import {
  type BlobId,
  type DocumentId,
  type DocumentMetadata,
  type SecurityPolicy,
  type SourceId,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';
import type {
  CompressionSettings,
  PdfAssembler,
  PdfEditor,
  ReconciliationReport,
  VerificationExpectation,
  VerificationResult,
} from '@pdf-editor/engine';

import { runExclusive } from '../annotations/edit-runner';
import { getAssembler } from '../engine/assembler-client';
import {
  type EngineResult,
  type EngineService,
  getEngineService,
  toFailure,
} from '../engine/engine-service';
import { m } from '../i18n';
import { blobsOfDocument, useWorkspaceStore } from '../state/workspace-store';
import { compressExport, type ExportCompressor } from '../tools/export-compression';
import { exportCompressionFor } from '../tools/tools-store';

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

/** Document-level choices the export applied (spec document-tools.md §8). */
export interface ExportOutcome {
  /** The encryption written (always AES-256), absent when the output is not encrypted. */
  readonly security?: SecurityPolicy;
  /** The user chose "Remove password" for encrypted sources. */
  readonly passwordRemoved: boolean;
  readonly metadata: DocumentMetadata;
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
  /** What the export applied at document level, for the summary's security and metadata lines. */
  readonly outcome?: ExportOutcome;
  /** Sizes around the compression pass (spec §5, §8), when a preset was applied. */
  readonly compression?: {
    readonly preset: CompressionSettings['preset'];
    readonly before: number;
    readonly after: number;
  };
}

export interface ExportOptions {
  readonly compatibility?: boolean;
  /**
   * Encrypt the output (overrides the document's own policy); `null` exports without a
   * password even when the document has one (the export dialog's Security override).
   */
  readonly security?: SecurityPolicy | null;
  /**
   * Bake annotations into the page content (spec §6, off by default). Links stay
   * interactive; comments go with their annotations.
   */
  readonly flattenAnnotations?: boolean;
  /**
   * Bake form fields into the page content and remove the form (spec document-tools §1,
   * off by default). Other annotations stay unless `flattenAnnotations` is set too.
   */
  readonly flattenForms?: boolean;
  /** Write comment popups for notes and commented markup (spec §6, on by default). */
  readonly includeComments?: boolean;
  /**
   * Compress the assembled bytes (spec §5). Undefined: the preset applied to this document
   * with "Apply to export" (tools store), if any; null: none.
   */
  readonly compression?: CompressionSettings | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ExportProgress) => void;
}

export interface ExportDependencies {
  readonly engine: Pick<EngineService, 'sourceBytes' | 'saveSource' | 'verify'> &
    /** Lists annotations for the per-page count check; without it counts are not checked. */
    Partial<{ readonly editor: () => Promise<Pick<PdfEditor, 'listAnnotations'>> }>;
  readonly assembler: () => Promise<PdfAssembler>;
  readonly workspace: () => Workspace;
  /** Image bytes by blob id (image pages); defaults to none. */
  readonly blobs?: (id: BlobId) => ArrayBuffer | undefined;
  /**
   * Sources with engine edits not (or not yet) in `workspace.engineEdits`: the workspace
   * store's `dirtySources`, when it has one.
   */
  readonly dirtySources?: () => ReadonlySet<SourceId> | undefined;
  /**
   * Runs the export once queued engine edits (annotations) have finished and the engine
   * matches the workspace, with no edit able to run until it is done, so the model read,
   * the annotation counts and the saved sources agree (annotations/edit-runner.ts
   * `runExclusive`). Without it the export runs at once.
   */
  readonly exclusive?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Compresses assembled bytes; without it compression settings are ignored. */
  readonly compress?: ExportCompressor;
  /** The compression preset applied to a document's export, if any. */
  readonly compressionFor?: (documentId: DocumentId) => CompressionSettings | undefined;
}

const defaultDependencies = (): ExportDependencies => ({
  engine: getEngineService(),
  assembler: getAssembler,
  workspace: () => useWorkspaceStore.getState().workspace,
  blobs: (id) => useWorkspaceStore.getState().blobs[id]?.bytes,
  // Duck-typed: the store gains `dirtySources` with the annotation tools (M2).
  dirtySources: () =>
    (useWorkspaceStore.getState() as { readonly dirtySources?: ReadonlySet<SourceId> })
      .dirtySources,
  exclusive: runExclusive,
  compress: compressExport,
  compressionFor: exportCompressionFor,
});

const failed = (message: string, code: 'internal' | 'aborted' = 'internal') =>
  ({ ok: false, error: { code, message } }) as const;

/** What besides the source itself decides whether it goes through `PdfEditor.save()`. */
export interface EngineSaveContext {
  /** Sources with engine edits beyond `workspace.engineEdits` (the store's dirtySources). */
  readonly dirty?: ReadonlySet<SourceId>;
  readonly flattenAnnotations?: boolean;
  readonly flattenForms?: boolean;
  readonly includeComments?: boolean;
}

/** Whether a source carries engine edits (annotations, form values). */
export function hasEngineEdits(
  ws: Workspace,
  sourceId: SourceId,
  dirty?: ReadonlySet<SourceId>,
): boolean {
  return dirty?.has(sourceId) === true || ws.engineEdits.some((edit) => edit.source === sourceId);
}

/** Whether a source must be serialized by PDFium instead of using its original bytes. */
export function needsEngineSave(
  ws: Workspace,
  sourceId: SourceId,
  context: EngineSaveContext = {},
): boolean {
  const source = ws.sources[sourceId];
  return (
    source?.flags.encrypted === true ||
    source?.flags.repaired === true ||
    context.flattenAnnotations === true ||
    (context.flattenForms === true && source?.flags.hasAcroForm === true) ||
    context.includeComments === false ||
    hasEngineEdits(ws, sourceId, context.dirty)
  );
}

/**
 * Expected annotations per output page (non-link, as the verifier counts them) for pages
 * of edited sources, listed from the live engine documents before they are saved. With
 * flattening every source page expects none. Pages from untouched sources are not listed:
 * their bytes go through unchanged.
 */
async function expectedAnnotationCounts(
  doc: VirtualDocument,
  edited: ReadonlySet<SourceId>,
  flatten: boolean,
  listAnnotations: PdfEditor['listAnnotations'] | undefined,
  signal: AbortSignal | undefined,
): Promise<Record<number, number> | undefined> {
  const counts: Record<number, number> = {};
  const cache = new Map<string, number>();
  let any = false;
  for (const [index, page] of doc.pages.entries()) {
    if (page.ref.kind !== 'source') continue;
    if (flatten) {
      counts[index] = 0;
      any = true;
      continue;
    }
    if (!listAnnotations || !edited.has(page.ref.source)) continue;
    const key = `${page.ref.source}#${page.ref.index}`;
    let count = cache.get(key);
    if (count === undefined) {
      const listed = await listAnnotations(
        page.ref.source,
        page.ref.index,
        signal ? { signal } : {},
      );
      count = listed.filter((a) => a.kind !== 'link').length;
      cache.set(key, count);
    }
    counts[index] = count;
    any = true;
  }
  return any ? counts : undefined;
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
  if (!deps.exclusive) return prepareExportNow(documentId, options, deps);
  try {
    return await deps.exclusive(() => prepareExportNow(documentId, options, deps));
  } catch (error) {
    return failed(toFailure(error).message);
  }
}

async function prepareExportNow(
  documentId: DocumentId,
  options: ExportOptions,
  deps: ExportDependencies,
): Promise<EngineResult<PreparedExport>> {
  const started = performance.now();
  const { signal, onProgress } = options;
  const ws = deps.workspace();
  const doc = ws.documents[documentId];
  if (doc === undefined) return failed(m.export_error_closed());
  if (doc.pages.length === 0) return failed(m.export_error_no_pages());
  try {
    const { annotationIdsOfEdits, planExport } = await import('@pdf-editor/engine');
    const plan = planExport(
      ws,
      documentId,
      options.security === undefined ? {} : { security: options.security },
    );

    const dirty = deps.dirtySources?.();
    const edited = new Set(plan.sources.filter((id) => hasEngineEdits(ws, id, dirty)));
    const flatten = options.flattenAnnotations === true;
    const saveContext: EngineSaveContext = {
      ...(dirty ? { dirty } : {}),
      ...(flatten ? { flattenAnnotations: true } : {}),
      ...(options.flattenForms ? { flattenForms: true } : {}),
      ...(options.includeComments === false ? { includeComments: false } : {}),
    };
    const editor = edited.size > 0 && !flatten ? await deps.engine.editor?.() : undefined;
    const annotationCounts = await expectedAnnotationCounts(
      doc,
      edited,
      flatten,
      editor ? (id, page, opts) => editor.listAnnotations(id, page, opts) : undefined,
      signal,
    );
    const writtenIds = [
      ...new Set(
        [...annotationIdsOfEdits(ws.engineEdits)]
          .filter(([source]) => edited.has(source as SourceId))
          .flatMap(([, ids]) => [...ids]),
      ),
    ];
    const expectation: VerificationExpectation = {
      ...plan.expectation,
      ...(annotationCounts ? { annotationCounts } : {}),
      // Conformance covers the annotations this app wrote (sources keep their own).
      ...(edited.size > 0 && !flatten ? { checkAnnotations: true, annotationIds: writtenIds } : {}),
    };

    const sources = new Map<SourceId, ArrayBuffer>();
    const securityRemoved: string[] = [];
    const repaired: string[] = [];
    for (const [index, sourceId] of plan.sources.entries()) {
      if (signal?.aborted) return failed(m.export_error_cancelled(), 'aborted');
      onProgress?.({ phase: 'reading', done: index, total: plan.sources.length });
      const source = ws.sources[sourceId];
      const name = source?.name ?? m.unknown_file();
      const encrypted = source?.flags.encrypted === true;
      const read = needsEngineSave(ws, sourceId, saveContext)
        ? await deps.engine.saveSource(sourceId, {
            removeSecurity: encrypted,
            ...(flatten ? { flattenAnnotations: true } : {}),
            ...(options.flattenForms ? { flattenForms: true } : {}),
            ...(options.includeComments === false ? { includeComments: false } : {}),
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
    const assembled = await assembler.assemble(
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

    const { report } = assembled;
    let { bytes } = assembled;
    const compressWith =
      options.compression === undefined ? deps.compressionFor?.(documentId) : options.compression;
    let compression: PreparedExport['compression'];
    if (compressWith && deps.compress) {
      const packed = await deps.compress(bytes, compressWith, plan.security, signal);
      bytes = packed.bytes;
      compression = { preset: compressWith.preset, before: packed.before, after: packed.after };
    }

    onProgress?.({ phase: 'verifying', done: 0, total: 1 });
    // The verifier's adapter transfers what it opens; keep `bytes` for the download.
    const verified = await deps.engine.verify(bytes.slice(0), expectation, signal);
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
        ...(compression ? { compression } : {}),
        outcome: {
          ...(plan.security ? { security: plan.security } : {}),
          passwordRemoved: doc.passwordRemoved === true,
          metadata: doc.metadata,
        },
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
