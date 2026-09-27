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
 */

import {
  countNodes,
  type DocumentId,
  deriveLabelRanges,
  documentTitleFromName,
  dropUnresolved,
  effectiveLabels,
  getDocument,
  needsPageLabels,
  type OutlineNode,
  pageTotalRotation,
  type SecurityPolicy,
  pageUnrotatedSize,
  type SourceId,
  type VirtualDocument,
  walkOutline,
  type Workspace,
} from '@pdf-editor/document-model';

import type { VerificationExpectation } from './types';

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
}

export interface ExportPlanOptions {
  /**
   * Overrides the document's security policy, as `AssemblyOptions.security` does; `null`
   * exports without a password even when the document has a policy.
   */
  readonly security?: SecurityPolicy | null;
}

function outlineTitles(nodes: readonly OutlineNode[]): string[] {
  const titles: string[] = [];
  walkOutline(nodes, (node) => titles.push(node.title));
  return titles;
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
  const document: VirtualDocument = {
    ...rest,
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
    expectation: {
      pageCount: doc.pages.length,
      pageSizes: doc.pages.map((page) => pageUnrotatedSize(ws, page)),
      rotations: doc.pages.map((page) => pageTotalRotation(ws, page)),
      outlineCount: countNodes(outline),
      outlineTitles: outlineTitles(outline),
      pageLabels: labeled ? effectiveLabels(ws, doc) : null,
      ...(password ? { password } : {}),
    },
  };
}
