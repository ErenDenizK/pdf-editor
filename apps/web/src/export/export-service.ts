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
 *    Sources with text edits (`text.edit`) are always saved by PDFium and then finalized
 *    (`finalizeTextEdits`: `/Untitled` subset fonts renamed, repeated MCIDs repaired,
 *    unreachable objects dropped; ADR-0011 §5) right where their edited bytes are produced,
 *    so the assembler only ever sees finalized bytes. Sources with image edits (`image.*`)
 *    get the garbage collection alone (`finalizeContentEdits`). Sources with applied redactions
 *    (`plan.redaction`) are always saved by PDFium too: the engine holds their redacted
 *    document, never the original bytes kept at open.
 *    Content edits (text, image, redaction) are read from the edits the engine holds
 *    (`appliedEdits`), not from the history: the export fails when the two differ (a replay
 *    the engine refused; the edit runner's `runExclusive` refuses first), and the summary's
 *    text-edit counts, per source and by font outcome, are those of the saved bytes.
 * 3. Assemble in the assembly worker, with progress. Image pages take their bytes from the
 *    workspace store's blobs (PNG or JPEG; WebP was re-encoded to PNG when inserted). The
 *    assembler always writes a new file (pdf-lib `copyPages`): there is no incremental or
 *    byte-preserving path, which a redacted export must never take (spec §5.3).
 * 4. Verify: re-open the output in PDFium (and pdf-lib via the inspector; with the user
 *    password when the output is encrypted) and compare page count, sizes, rotations,
 *    labels and outline; with edited annotations also the annotation count per page and
 *    the annotation conformance rules for the annotations this app wrote. With applied
 *    redactions, the redaction self-check (`verifyRedactedOutput` in the PDFium worker) runs
 *    on the exact final bytes (after assembly, compression and encryption, with the user
 *    password) against every plan mapped to output pages; a failing check fails
 *    verification with the check's findings. Only verified bytes are offered.
 *
 * Order for an edited, redacted source: engine save (annotation and form post-passes) →
 * `finalizeTextEdits` → assembly (and encryption) → compression → PDFium verification →
 * redaction self-check.
 *
 * Never rejects: failures resolve to `{ ok: false }` with a message fit for the UI.
 */
import {
  type BlobId,
  type DocumentId,
  type DocumentMetadata,
  type EngineEdit,
  type SecurityPolicy,
  type SourceId,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';
import type {
  CompressionSettings,
  ForensicReport,
  PdfAssembler,
  PdfEditor,
  PdfRedactor,
  ReconciliationReport,
  VerificationExpectation,
  VerificationResult,
} from '@pdf-editor/engine';

import { appliedEdits, runExclusive } from '../annotations/edit-runner';
import { getAssembler } from '../engine/assembler-client';
import {
  type EngineResult,
  type EngineService,
  getEngineService,
  toFailure,
} from '../engine/engine-service';
import { m } from '../i18n';
import { failingCheckLines } from '../redaction/report-text';
import { blobsOfDocument, useWorkspaceStore } from '../state/workspace-store';
import { compressExport, type ExportCompressor } from '../tools/export-compression';
import { exportCompressionFor } from '../tools/tools-store';

export type ExportPhase = 'reading' | 'assembling' | 'verifying' | 'redaction';

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
/** The redaction self-check of an export with applied redactions (summary data). */
export interface RedactionExportSummary {
  /** Areas checked, in output pages. */
  readonly areas: number;
  /** Areas per output page index. */
  readonly areasByPage: Readonly<Record<number, number>>;
  /** Areas on resized output pages: not checked by area (their strings still are). */
  readonly unmappedAreas: number;
  /** The self-check on the exact bytes offered. */
  readonly report: ForensicReport;
  /**
   * Captured strings too short to search document-wide (`RedactionCapture.skipped`): removed
   * inside the marked areas only.
   */
  readonly areaOnlyStrings: readonly string[];
}

/** How the text edits of a source were typeset (spec §2.1, §5.3; summary data). */
export interface TextEditFonts {
  /** Tier 2 in the original, embedded font. */
  readonly sameFont: number;
  /** Tier 2 in the original font, which the file does not embed. */
  readonly sameFontNotEmbedded: number;
  /** Tier 1 in a bundled face (tier 2 was not possible), count per face key. */
  readonly substituted: Readonly<Record<string, number>>;
  /** Tier 2 failed its read-back and fell back to tier 1: count per bundled face key. */
  readonly fellBack: Readonly<Record<string, number>>;
  /** Tier 1 for text inside a form XObject: the line moved out of its form. */
  readonly movedOutOfForm: number;
}

/** What `finalizeTextEdits` did for the sources with text edits (summary data). */
export interface TextEditExportSummary {
  /** `text.edit` edits in the exported sources. */
  readonly edits: number;
  readonly fontsRenamed: number;
  readonly mcidsReassigned: number;
  readonly unreachableRemoved: number;
  readonly sources: readonly TextEditSourceSummary[];
}

export interface TextEditSourceSummary {
  readonly name: string;
  readonly edits: number;
  readonly fontsRenamed: number;
  readonly mcidsReassigned: number;
  readonly unreachableRemoved: number;
  /** The edits by font outcome (same font, substituted, fell back, moved out of form). */
  readonly fonts: TextEditFonts;
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
  /** Present when the document shows pages of sources with applied redactions. */
  readonly redaction?: RedactionExportSummary;
  /** Present when the document shows pages of sources with text edits. */
  readonly textEdits?: TextEditExportSummary;
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
   * The edits the engine holds for a source (annotations/edit-runner.ts `appliedEdits`).
   * Content edits and the summary counts come from them; without it the workspace's edits
   * are taken as held (engines that keep no history, tests).
   */
  readonly appliedEdits?: (source: SourceId) => readonly EngineEdit[];
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
  /**
   * Runs the redaction self-check on export bytes (the PDFium worker's `PdfRedactor`).
   * Without it an export with applied redactions fails: it cannot be verified.
   */
  readonly redactor?: () => Promise<Pick<PdfRedactor, 'verifyRedactedOutput'>>;
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
  appliedEdits,
  exclusive: runExclusive,
  compress: compressExport,
  compressionFor: exportCompressionFor,
  redactor: () => getEngineService().redactor(),
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

/** Edits that rewrite page content and cannot be undone in place (replayed after a reopen). */
function isContentEdit(edit: EngineEdit): boolean {
  return (
    edit.kind === 'text.edit' || edit.kind === 'redaction.apply' || edit.kind.startsWith('image.')
  );
}

/** Whether two edit lists hold the same content edits, in the same order. */
function sameContentEdits(a: readonly EngineEdit[], b: readonly EngineEdit[]): boolean {
  const ids = (edits: readonly EngineEdit[]) =>
    edits
      .filter(isContentEdit)
      .map((edit) => edit.id)
      .join('\u0000');
  return ids(a) === ids(b);
}

type Honesty = 'same-font' | 'same-font-not-embedded' | 'font-substituted' | 'moved-out-of-form';
const HONESTY: readonly string[] = [
  'same-font',
  'same-font-not-embedded',
  'font-substituted',
  'moved-out-of-form',
];

/**
 * The font outcome of recorded `text.edit` edits: the `honesty`, `fellBack` and `face` the
 * edit runner records with each applied edit. An edit recorded without them counts by its
 * tier (2: same font; 1: font substituted).
 */
export function textEditFontsOf(edits: readonly EngineEdit[]): TextEditFonts {
  let sameFont = 0;
  let sameFontNotEmbedded = 0;
  let movedOutOfForm = 0;
  const substituted: Record<string, number> = {};
  const fellBack: Record<string, number> = {};
  for (const edit of edits) {
    if (edit.kind !== 'text.edit') continue;
    const payload = (edit.payload ?? {}) as {
      readonly tier?: unknown;
      readonly face?: unknown;
      readonly honesty?: unknown;
      readonly fellBack?: unknown;
    };
    const honesty: Honesty =
      typeof payload.honesty === 'string' && HONESTY.includes(payload.honesty)
        ? (payload.honesty as Honesty)
        : payload.tier === 2
          ? 'same-font'
          : 'font-substituted';
    if (honesty === 'same-font') sameFont += 1;
    else if (honesty === 'same-font-not-embedded') sameFontNotEmbedded += 1;
    else if (honesty === 'moved-out-of-form') movedOutOfForm += 1;
    else {
      const face = typeof payload.face === 'string' ? payload.face : '';
      const into = payload.fellBack === true ? fellBack : substituted;
      into[face] = (into[face] ?? 0) + 1;
    }
  }
  return { sameFont, sameFontNotEmbedded, substituted, fellBack, movedOutOfForm };
}

/** Captured strings of recorded `redaction.apply` edits kept to their areas (deduplicated). */
function areaOnlyStringsOf(edits: readonly EngineEdit[]): string[] {
  const strings = new Set<string>();
  for (const edit of edits) {
    if (edit.kind !== 'redaction.apply') continue;
    const list = (edit.payload as { readonly areaOnlyStrings?: unknown } | null)?.areaOnlyStrings;
    if (!Array.isArray(list)) continue;
    for (const value of list) if (typeof value === 'string') strings.add(value);
  }
  return [...strings];
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
    const plan = planExport(ws, documentId, {
      ...(options.security === undefined ? {} : { security: options.security }),
      // Flattened created fields are not expected in the output.
      ...(options.flattenForms ? { flattenForms: true } : {}),
    });

    const redaction = plan.redaction;
    const redactor = redaction ? await deps.redactor?.() : undefined;
    // A redacted export that cannot be checked is never offered.
    if (redaction && !redactor) return failed(m.export_failed_redaction());
    const redacted = new Set<SourceId>(redaction?.sources ?? []);
    // What the engine holds: the saved bytes contain these edits, whatever the history says.
    const modelEdits = (source: SourceId) => ws.engineEdits.filter((e) => e.source === source);
    const held = new Map<SourceId, readonly EngineEdit[]>();
    for (const source of plan.sources) {
      const edits = deps.appliedEdits ? deps.appliedEdits(source) : modelEdits(source);
      // Edits the history shows but the engine lacks (or the reverse) would be missing from
      // (or extra in) the file: never offer it. The edit runner refuses before this point.
      if (!sameContentEdits(edits, modelEdits(source))) {
        return failed(m.export_error_edits_not_applied());
      }
      held.set(source, edits);
    }
    const heldOf = (source: SourceId) => held.get(source) ?? [];
    const { finalizeContentEdits, finalizeTextEdits } = await import('@pdf-editor/engine');
    const textEditSources: TextEditSourceSummary[] = [];

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
      const textEdits = heldOf(sourceId).filter((e) => e.kind === 'text.edit');
      const edits = textEdits.length;
      // Redacted and text-edited sources: the engine's document, never the bytes kept at
      // open (they would bring the removed content or the old text back).
      const viaEngine =
        needsEngineSave(ws, sourceId, saveContext) || redacted.has(sourceId) || edits > 0;
      const read = viaEngine
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
      let bytes = read.value;
      if (edits > 0) {
        // Where the edited bytes are produced: fonts renamed, MCIDs repaired, GC.
        const finalized = await finalizeTextEdits(bytes);
        bytes = finalized.bytes;
        textEditSources.push({
          name,
          edits,
          fontsRenamed: finalized.fontsRenamed,
          mcidsReassigned: finalized.mcidsReassigned,
          unreachableRemoved: finalized.unreachableRemoved,
          fonts: textEditFontsOf(textEdits),
        });
      } else if (heldOf(sourceId).some((e) => e.kind.startsWith('image.'))) {
        // Image edits rewrote page content: drop the orphaned streams (the old content, a
        // removed or replaced image) so nothing removed survives in the file.
        bytes = (await finalizeContentEdits(bytes)).bytes;
      }
      sources.set(sourceId, bytes);
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
        // Fields created in the app are flattened by the assembler (source fields by save).
        ...(options.flattenForms ? { flattenForms: true } : {}),
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
      const packed = await deps.compress(bytes, compressWith, plan.security, signal, {
        compatibility: options.compatibility === true,
      });
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

    let verification = verified.value;
    let redactionSummary: RedactionExportSummary | undefined;
    if (redaction && redactor) {
      if (signal?.aborted) return failed(m.export_error_cancelled(), 'aborted');
      onProgress?.({ phase: 'redaction', done: 0, total: 1 });
      const password = plan.security?.userPassword;
      // On the exact bytes offered (a copy: the worker opens its own).
      const check = await redactor.verifyRedactedOutput(bytes.slice(0), redaction.plans, {
        ...(password ? { password } : {}),
        ...(signal ? { signal } : {}),
      });
      const areasByPage: Record<number, number> = {};
      let areas = 0;
      for (const p of redaction.plans) {
        for (const area of p.areas) {
          areasByPage[area.pageIndex] = (areasByPage[area.pageIndex] ?? 0) + 1;
          areas += 1;
        }
      }
      redactionSummary = {
        areas,
        areasByPage,
        unmappedAreas: redaction.unmappedAreas,
        report: check,
        areaOnlyStrings: areaOnlyStringsOf(redaction.sources.flatMap(heldOf)),
      };
      if (!check.ok) {
        // Marks left unapplied are flagged by the check (any /Redact in a redacted file).
        const pendingMarks = check.checks.some((c) =>
          c.findings.some((f) => f.detail === 'pending /Redact mark'),
        );
        verification = {
          ok: false,
          problems: [
            ...verification.problems,
            ...(pendingMarks ? [m.export_redaction_pending_marks()] : []),
            ...failingCheckLines(check),
          ],
        };
      }
      onProgress?.({ phase: 'redaction', done: 1, total: 1 });
    }
    const textEditSummary: TextEditExportSummary | undefined =
      textEditSources.length > 0
        ? {
            edits: textEditSources.reduce((n, s) => n + s.edits, 0),
            fontsRenamed: textEditSources.reduce((n, s) => n + s.fontsRenamed, 0),
            mcidsReassigned: textEditSources.reduce((n, s) => n + s.mcidsReassigned, 0),
            unreachableRemoved: textEditSources.reduce((n, s) => n + s.unreachableRemoved, 0),
            sources: textEditSources,
          }
        : undefined;
    return {
      ok: true,
      value: {
        bytes,
        report: { ...report, warnings: [...report.warnings, ...sourceNoteWarnings(sourceNotes)] },
        sourceNotes,
        verification,
        pageCount,
        sourceCount: plan.sources.length,
        durationMs: performance.now() - started,
        ...(compression ? { compression } : {}),
        ...(redactionSummary ? { redaction: redactionSummary } : {}),
        ...(textEditSummary ? { textEdits: textEditSummary } : {}),
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
