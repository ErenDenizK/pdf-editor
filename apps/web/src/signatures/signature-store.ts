/**
 * Signature validation on open (spec recognize-and-compare §3.1, ADR-0013 §1): every
 * source the engine flags `hasSignatures` is checked once, in the shared signature worker,
 * on a copy of the original bytes the engine service kept (with the password it opened
 * with). Reports are kept per source until it closes; a failure is kept too.
 *
 * "View signed version" opens `revisionBytes(bytes, revision)` as a new document whose tab
 * title names the revision; the store remembers which sources are such views.
 */
import type { DocumentId, SourceId, SourceDocument } from '@pdf-editor/document-model';
import type { SignatureProxy, SignatureReport } from '@pdf-editor/engine';
import { create } from 'zustand';

import {
  type EngineResult,
  getEngineService,
  getSignatureWorkers,
  toFailure,
} from '../engine/engine-service';
import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';

export type SignatureEntry =
  | { readonly status: 'checking' }
  | { readonly status: 'ready'; readonly reports: readonly SignatureReport[] }
  | { readonly status: 'failed'; readonly message: string };

/** A document opened by "View signed version". */
export interface SignedVersionView {
  /** File name of the source it was cut from. */
  readonly from: string;
  readonly revision: number;
  readonly fieldName: string;
}

interface SignatureState {
  readonly entries: Readonly<Record<string, SignatureEntry>>;
  readonly views: Readonly<Record<string, SignedVersionView>>;
}

export const useSignatureStore = create<SignatureState>()(() => ({ entries: {}, views: {} }));

export interface SignatureDependencies {
  /** A fresh copy of a source's original bytes (transferred to the worker). */
  readonly bytes: (sourceId: SourceId) => Promise<EngineResult<ArrayBuffer>>;
  readonly password: (sourceId: SourceId) => string | undefined;
  /** Runs a call on the shared signature worker. */
  readonly run: <T>(task: (proxy: SignatureProxy) => Promise<T>) => Promise<T>;
  readonly onSourceClosed: (listener: (sourceId: SourceId) => void) => () => void;
  /** Opens files as new documents (the workspace store's `openFiles`). */
  readonly openFiles: (
    files: readonly File[],
  ) => Promise<{ readonly opened: readonly { readonly documentId: DocumentId }[] }>;
}

const defaults = (): SignatureDependencies => ({
  bytes: (id) => getEngineService().sourceBytes(id),
  password: (id) => getEngineService().sourcePassword(id),
  run: (task) => getSignatureWorkers().run(task),
  onSourceClosed: (listener) => getEngineService().onSourceClosed(listener),
  openFiles: (files) => useWorkspaceStore.getState().openFiles(files),
});

let deps: SignatureDependencies | undefined;
let unsubscribeClosed: (() => void) | undefined;

function dependencies(): SignatureDependencies {
  deps ??= defaults();
  unsubscribeClosed ??= deps.onSourceClosed((id) => {
    const { entries, views } = useSignatureStore.getState();
    if (entries[id] === undefined && views[id] === undefined) return;
    const { [id]: _closed, ...rest } = entries;
    const { [id]: _view, ...otherViews } = views;
    useSignatureStore.setState({ entries: rest, views: otherViews });
  });
  return deps;
}

/** Replaces the dependencies (tests) and clears the store. */
export function setSignatureDependencies(next: SignatureDependencies | undefined): void {
  unsubscribeClosed?.();
  unsubscribeClosed = undefined;
  deps = next;
  useSignatureStore.setState({ entries: {}, views: {} });
}

function put(id: SourceId, entry: SignatureEntry): void {
  useSignatureStore.setState((s) => ({ entries: { ...s.entries, [id]: entry } }));
}

/** Validates a source's signatures unless done or in flight. */
export function requestValidation(sourceId: SourceId): Promise<void> {
  if (useSignatureStore.getState().entries[sourceId] !== undefined) return Promise.resolve();
  const d = dependencies();
  put(sourceId, { status: 'checking' });
  return (async () => {
    try {
      const read = await d.bytes(sourceId);
      if (!read.ok) {
        put(sourceId, { status: 'failed', message: read.error.message });
        return;
      }
      const password = d.password(sourceId);
      const reports = await d.run((proxy) =>
        proxy.validateSignatures(read.value, password === undefined ? {} : { password }),
      );
      // The source may have closed meanwhile.
      if (useSignatureStore.getState().entries[sourceId] !== undefined) {
        put(sourceId, { status: 'ready', reports });
      }
    } catch (error) {
      if (useSignatureStore.getState().entries[sourceId] !== undefined) {
        put(sourceId, { status: 'failed', message: toFailure(error).message });
      }
    }
  })();
}

/** Validates every flagged source not seen yet. */
function validateNewSources(sources: Readonly<Record<string, SourceDocument>>): void {
  const { entries } = useSignatureStore.getState();
  for (const source of Object.values(sources)) {
    if (source.flags.hasSignatures && entries[source.id] === undefined) {
      void requestValidation(source.id);
    }
  }
}

/**
 * Starts validation on open: watches the workspace's sources and checks each signed one
 * once. Returns the stop function (the app calls it on unmount).
 */
export function startSignatureValidation(): () => void {
  dependencies();
  validateNewSources(useWorkspaceStore.getState().workspace.sources);
  return useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspace.sources !== previous.workspace.sources) {
      validateNewSources(state.workspace.sources);
    }
  });
}

/** "report.pdf" → "report (signed version, revision 2).pdf". */
export function signedVersionFileName(name: string, revision: number): string {
  const stem = name.replace(/\.pdf$/i, '');
  return `${m.signature_version_file({ name: stem, revision })}.pdf`;
}

/**
 * Opens the file as saved at `revision` (the signed version) as a new document. Resolves
 * to the new document's id, or rejects with the reason.
 */
export async function openSignedVersion(
  source: Pick<SourceDocument, 'id' | 'name'>,
  report: Pick<SignatureReport, 'revision' | 'fieldName'>,
): Promise<DocumentId> {
  const revision = report.revision;
  if (revision === undefined) throw new Error(m.signature_version_unavailable());
  const d = dependencies();
  const read = await d.bytes(source.id);
  if (!read.ok) throw new Error(read.error.message);
  const bytes = await d.run((proxy) => proxy.revisionBytes(read.value, revision));
  const file = new File([bytes], signedVersionFileName(source.name, revision), {
    type: 'application/pdf',
  });
  const { opened } = await d.openFiles([file]);
  const documentId = opened[0]?.documentId;
  if (documentId === undefined) throw new Error(m.signature_version_unavailable());
  const doc = useWorkspaceStore.getState().workspace.documents[documentId];
  const viewSource = doc?.pages.find((page) => page.ref.kind === 'source')?.ref;
  if (viewSource?.kind === 'source') {
    useSignatureStore.setState((s) => ({
      views: {
        ...s.views,
        [viewSource.source]: { from: source.name, revision, fieldName: report.fieldName },
      },
    }));
  }
  return documentId;
}
