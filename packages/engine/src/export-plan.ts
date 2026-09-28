/**
 * Export planning: turns a workspace document into exactly what the assembler writes and
 * what the verifier must find afterwards (ARCHITECTURE.md §4, steps 3 and 5). Pure; shared
 * by the app's export service and the engine's golden-file test.
 *
 * - Page labels: when `needsPageLabels`, `deriveLabelRanges` covers every page, folding in
 *   the sources' authored labels (pages before the first explicit range keep them);
 *   otherwise no ranges, so no /PageLabels is written.
 * - Outline: `dropUnresolved` (unresolved leaves dropped, unresolved parents kept as
 *   headings), the same rule the assembler applies.
 * - Security: the effective policy's user password goes into the expectation, so an
 *   encrypted output can be re-opened by the verifier.
 * - Resized pages whose content fits inside the new page (fit, stretch, a growing canvas)
 *   are listed in `annotationsInsidePages`: their annotations must stay on the page.
 */

import {
  countNodes,
  type DocumentId,
  deriveLabelRanges,
  documentTitleFromName,
  dropUnresolved,
  effectiveBates,
  effectiveLabels,
  getDocument,
  needsPageLabels,
  type OutlineNode,
  pageTotalRotation,
  type SecurityPolicy,
  pageContentSize,
  pageUnrotatedSize,
  resizeTransform,
  type SourceId,
  type VirtualPage,
  type VirtualDocument,
  walkOutline,
  type Workspace,
} from '@pdf-editor/document-model';

import type { VerificationExpectation } from './types';
import { type RedactionExportPlan, redactionExportPlan } from './redaction/export-hooks';

/** The export's redaction check on the exact final bytes (see redaction/verify-output.ts). */
export { verifyRedactedOutput } from './redaction/verify-output';
export type { RedactionExportPlan } from './redaction/export-hooks';

export interface ExportPlan {
  /** The document to hand to `PdfAssembler.assemble`. */
  readonly document: VirtualDocument;
  /** Sources referenced by the document, in order of first use. */
  readonly sources: readonly SourceId[];
  /** File name stems per source (form field namespaces). */
  readonly sourceNames: ReadonlyMap<SourceId, string>;
  /** What the output must look like when re-opened. */
  readonly expectation: VerificationExpectation;
  /**
   * Encryption the assembler applies (`AssemblyOptions.security`, else the document's own
   * policy); its user password is in `expectation.password` so verification can open it.
   */
  readonly security?: SecurityPolicy;
  /**
   * Present when a source of the document has applied redactions: those sources must be
   * read as their redacted bytes, the export is a full rewrite (never incremental or
   * byte-preserving), and `verifyRedactedOutput(finalBytes, redaction.plans, …)` must pass
   * on the exact bytes offered for download.
   */
  readonly redaction?: RedactionExportPlan;
}

export interface ExportPlanOptions {
  /**
   * Overrides the document's security policy, as `AssemblyOptions.security` does; `null`
   * exports without a password even when the document has a policy.
   */
  readonly security?: SecurityPolicy | null;
}

/** Whether a resized page's scaled content box lies inside the new page. */
function contentFitsPage(ws: Workspace, page: VirtualPage): boolean {
  const resize = page.resize;
  if (resize === undefined) return false;
  const content = pageContentSize(ws, page);
  const t = resizeTransform(content, resize);
  const epsilon = 0.01;
  return (
    t.offsetX >= -epsilon &&
    t.offsetY >= -epsilon &&
    t.offsetX + t.scaleX * content.width <= resize.width + epsilon &&
    t.offsetY + t.scaleY * content.height <= resize.height + epsilon
  );
}

function outlineTitles(nodes: readonly OutlineNode[]): string[] {
  const titles: string[] = [];
  walkOutline(nodes, (node) => titles.push(node.title));
  return titles;
}

function insideExpectation(
  ws: Workspace,
  pages: readonly VirtualPage[],
): { annotationsInsidePages?: readonly number[] } {
  const indices = pages.flatMap((page, i) => (contentFitsPage(ws, page) ? [i] : []));
  return indices.length > 0 ? { annotationsInsidePages: indices } : {};
}

function redactionOf(ws: Workspace, doc: VirtualDocument): { redaction?: RedactionExportPlan } {
  const redaction = redactionExportPlan(ws, doc);
  return redaction === undefined ? {} : { redaction };
}

export function planExport(
  ws: Workspace,
  documentId: DocumentId,
  options: ExportPlanOptions = {},
): ExportPlan {
  const doc = getDocument(ws, documentId);
  const security = options.security === null ? undefined : (options.security ?? doc.security);
  const password = security?.userPassword;
  const labeled = needsPageLabels(ws, doc);
  const outline = dropUnresolved(doc.outline);
  const { security: _documentPolicy, ...rest } = doc;
  const bates = effectiveBates(ws, documentId);
  const { bates: _run, ...unnumbered } = rest;
  const document: VirtualDocument = {
    ...unnumbered,
    // Bates starts of a run follow the current page counts of its documents.
    ...(bates === undefined ? {} : { bates }),
    // The effective policy only: the assembler falls back to the document's own.
    ...(security === undefined ? {} : { security }),
    labels: labeled ? deriveLabelRanges(ws, doc) : [],
    outline,
  };
  const sources: SourceId[] = [];
  const sourceNames = new Map<SourceId, string>();
  for (const page of doc.pages) {
    if (page.ref.kind !== 'source' || sourceNames.has(page.ref.source)) continue;
    sources.push(page.ref.source);
    const name = ws.sources[page.ref.source]?.name;
    sourceNames.set(
      page.ref.source,
      name === undefined ? String(page.ref.source) : documentTitleFromName(name),
    );
  }
  return {
    document,
    sources,
    sourceNames,
    ...(security === undefined ? {} : { security }),
    ...redactionOf(ws, doc),
    expectation: {
      pageCount: doc.pages.length,
      pageSizes: doc.pages.map((page) => pageUnrotatedSize(ws, page)),
      rotations: doc.pages.map((page) => pageTotalRotation(ws, page)),
      outlineCount: countNodes(outline),
      outlineTitles: outlineTitles(outline),
      pageLabels: labeled ? effectiveLabels(ws, doc) : null,
      ...insideExpectation(ws, doc.pages),
      ...(password ? { password } : {}),
    },
  };
}
