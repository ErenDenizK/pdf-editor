/**
 * What a document's signatures look like to the UI: its signed sources, their validation
 * entries, the badge summary and whether the user edited a signed source (spec
 * recognize-and-compare §3.4; the plain export statement of ADR-0013's consequences).
 */
import type { DocumentId, SourceDocument, SourceId, Workspace } from '@pdf-editor/document-model';
import type { SignatureReport } from '@pdf-editor/engine';

import { documentSources, useWorkspaceStore } from '../state/workspace-store';
import { type SignatureEntry, useSignatureStore } from './signature-store';
import { type SignatureSummary, summarize } from './status';

/** Whether a source carries engine edits (annotations, form values, text, redaction…). */
export function sourceEdited(
  ws: Workspace,
  sourceId: SourceId,
  dirty: ReadonlySet<SourceId> | undefined,
): boolean {
  return dirty?.has(sourceId) === true || ws.engineEdits.some((edit) => edit.source === sourceId);
}

/** The badge state of a set of sources' entries. */
export interface DocumentSignatureState {
  readonly sources: readonly SourceDocument[];
  /** Some source is still being checked. */
  readonly checking: boolean;
  /** Some source's check failed. */
  readonly failed: boolean;
  readonly summary: SignatureSummary;
  /** A signed source (with signatures found) carries edits. */
  readonly edited: boolean;
}

export function signatureStateOf(
  sources: readonly SourceDocument[],
  entries: Readonly<Record<string, SignatureEntry>>,
  edited: (id: SourceId) => boolean,
): DocumentSignatureState {
  const reports: SignatureReport[] = [];
  let checking = false;
  let failed = false;
  let anyEdited = false;
  for (const source of sources) {
    const entry = entries[source.id];
    if (entry === undefined || entry.status === 'checking') checking = true;
    else if (entry.status === 'failed') failed = true;
    else {
      reports.push(...entry.reports);
      if (entry.reports.length > 0 && edited(source.id)) anyEdited = true;
    }
  }
  return { sources, checking, failed, summary: summarize(reports), edited: anyEdited };
}

/** Ids of a document's sources the engine flagged as signed, joined (a stable selector). */
function signedKey(ws: Workspace, documentId: DocumentId | undefined): string {
  const doc = documentId === undefined ? undefined : ws.documents[documentId];
  if (!doc) return '';
  return documentSources(doc)
    .filter((id) => ws.sources[id]?.flags.hasSignatures === true)
    .join('|');
}

/** A document's signed sources, in page order. */
export function useSignedSources(documentId: DocumentId | undefined): readonly SourceDocument[] {
  const key = useWorkspaceStore((s) => signedKey(s.workspace, documentId));
  const sources = useWorkspaceStore((s) => s.workspace.sources);
  if (key === '') return [];
  return key.split('|').flatMap((id) => {
    const source = sources[id as SourceId];
    return source ? [source] : [];
  });
}

export function useDocumentSignatureState(
  documentId: DocumentId | undefined,
): DocumentSignatureState {
  const sources = useSignedSources(documentId);
  const entries = useSignatureStore((s) => s.entries);
  const ws = useWorkspaceStore((s) => s.workspace);
  const dirty = useWorkspaceStore((s) => s.dirtySources);
  return signatureStateOf(sources, entries, (id) => sourceEdited(ws, id, dirty));
}
