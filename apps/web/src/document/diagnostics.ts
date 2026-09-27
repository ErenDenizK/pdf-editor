/**
 * Source diagnostics (spec document-tools.md §7), computed lazily in the assembly worker
 * (`AssemblerProxy.diagnose`) from the original bytes the engine service kept, decrypted
 * with the password the file was opened with. Cached per source until the source closes;
 * a failure is cached too (retry by re-opening the file).
 */
import type { SourceId } from '@pdf-editor/document-model';
import type { SourceDiagnostics } from '@pdf-editor/engine';
import { useEffect } from 'react';
import { create } from 'zustand';

import { getAssembler } from '../engine/assembler-client';
import { type EngineResult, getEngineService, toFailure } from '../engine/engine-service';

export type DiagnosticsEntry =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: SourceDiagnostics }
  | { readonly status: 'failed'; readonly message: string };

interface DiagnosticsState {
  readonly entries: Readonly<Record<string, DiagnosticsEntry>>;
}

export const useDiagnosticsStore = create<DiagnosticsState>()(() => ({ entries: {} }));

export interface DiagnosticsDependencies {
  readonly bytes: (sourceId: SourceId) => Promise<EngineResult<ArrayBuffer>>;
  readonly password: (sourceId: SourceId) => string | undefined;
  /** `bytes` may be transferred. */
  readonly diagnose: (bytes: ArrayBuffer, password?: string) => Promise<SourceDiagnostics>;
  /** Registers a listener for closed sources; returns its removal. */
  readonly onSourceClosed: (listener: (sourceId: SourceId) => void) => () => void;
}

const defaults = (): DiagnosticsDependencies => ({
  bytes: (id) => getEngineService().sourceBytes(id),
  password: (id) => getEngineService().sourcePassword(id),
  diagnose: async (bytes, password) =>
    (await getAssembler()).diagnose(bytes, password === undefined ? {} : { password }),
  onSourceClosed: (listener) => getEngineService().onSourceClosed(listener),
});

let deps: DiagnosticsDependencies | undefined;
let unsubscribe: (() => void) | undefined;

function dependencies(): DiagnosticsDependencies {
  deps ??= defaults();
  unsubscribe ??= deps.onSourceClosed((id) => {
    const { entries } = useDiagnosticsStore.getState();
    if (entries[id] === undefined) return;
    const { [id]: _closed, ...rest } = entries;
    useDiagnosticsStore.setState({ entries: rest });
  });
  return deps;
}

/** Replaces the dependencies (tests) and clears the cache. */
export function setDiagnosticsDependencies(next: DiagnosticsDependencies | undefined): void {
  unsubscribe?.();
  unsubscribe = undefined;
  deps = next;
  useDiagnosticsStore.setState({ entries: {} });
}

function put(id: SourceId, entry: DiagnosticsEntry): void {
  useDiagnosticsStore.setState((s) => ({ entries: { ...s.entries, [id]: entry } }));
}

/** Starts computing a source's diagnostics unless they are cached or in flight. */
export function requestDiagnostics(sourceId: SourceId): void {
  if (useDiagnosticsStore.getState().entries[sourceId] !== undefined) return;
  const d = dependencies();
  put(sourceId, { status: 'loading' });
  void (async () => {
    try {
      const read = await d.bytes(sourceId);
      if (!read.ok) {
        put(sourceId, { status: 'failed', message: read.error.message });
        return;
      }
      const value = await d.diagnose(read.value, d.password(sourceId));
      // The source may have closed meanwhile.
      if (useDiagnosticsStore.getState().entries[sourceId] !== undefined) {
        put(sourceId, { status: 'ready', value });
      }
    } catch (error) {
      put(sourceId, { status: 'failed', message: toFailure(error).message });
    }
  })();
}

/** Resolves once every listed source has an entry that is not loading. */
export function whenDiagnosed(sourceIds: readonly SourceId[]): Promise<void> {
  for (const id of sourceIds) requestDiagnostics(id);
  const done = () =>
    sourceIds.every((id) => {
      const entry = useDiagnosticsStore.getState().entries[id];
      return entry !== undefined && entry.status !== 'loading';
    });
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useDiagnosticsStore.subscribe(() => {
      if (done()) {
        stop();
        resolve();
      }
    });
  });
}

/**
 * The diagnostics of `sourceIds` (same order), requested when `enabled` (e.g. once a
 * "Details" disclosure opens). Entries are undefined until requested.
 */
export function useSourceDiagnostics(
  sourceIds: readonly SourceId[],
  enabled = true,
): readonly (DiagnosticsEntry | undefined)[] {
  const key = sourceIds.join('|');
  useEffect(() => {
    if (!enabled || key === '') return;
    for (const id of key.split('|')) requestDiagnostics(id as SourceId);
  }, [key, enabled]);
  const entries = useDiagnosticsStore((s) => s.entries);
  return sourceIds.map((id) => entries[id]);
}
