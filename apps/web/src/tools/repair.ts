/**
 * "Save repaired copy" (spec §7): the original bytes of a source PDFium had to repair on
 * open go through a full qpdf rewrite, the result is re-opened and checked (PDFium page
 * count and sizes against the open document), and only then offered for download.
 */
import type { SourceDocument, SourceId } from '@pdf-editor/document-model';
import type { PlumberCheckResult } from '@pdf-editor/engine';

import { getEngineService } from '../engine/engine-service';
import { deliverPdf } from '../export/deliver';
import { exportFileName } from '../export/filename';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useWorkspaceStore } from '../state/workspace-store';
import { getCompressor } from './compress-client';

/** Repaired sources of the active document, in page order. */
export function repairedSources(): SourceDocument[] {
  const { workspace } = useWorkspaceStore.getState();
  const doc = workspace.activeDocument ? workspace.documents[workspace.activeDocument] : undefined;
  const seen = new Set<SourceId>();
  const out: SourceDocument[] = [];
  for (const page of doc?.pages ?? []) {
    if (page.ref.kind !== 'source' || seen.has(page.ref.source)) continue;
    seen.add(page.ref.source);
    const source = workspace.sources[page.ref.source];
    if (source?.flags.repaired) out.push(source);
  }
  return out;
}

export type RepairOutcome = 'saved' | 'downloaded' | 'cancelled' | 'failed';

/**
 * The repaired copy of an open source: a full qpdf rewrite of its original bytes, checked
 * in PDFium against the open document (page count, sizes, rotations). An encrypted source
 * keeps its protection: qpdf opens it with the password that opened it here and writes it
 * back encrypted the same way. Rejects with the verification problems.
 */
export async function repairedCopy(
  source: Pick<SourceDocument, 'id' | 'pageCount' | 'pages'>,
): Promise<{ readonly bytes: ArrayBuffer; readonly repaired: boolean }> {
  const engine = getEngineService();
  const original = await engine.sourceBytes(source.id);
  if (!original.ok) throw new Error(original.error.message);
  const plumber = await getCompressor();
  const password = engine.sourcePassword(source.id);
  const result = await plumber.process(original.value, {
    objectStreams: 'preserve',
    ...(password === undefined ? {} : { password }),
  });
  const verified = await engine.verify(result.bytes.slice(0), {
    pageCount: source.pageCount,
    pageSizes: source.pages.map((p) => p.size),
    rotations: source.pages.map((p) => p.rotation),
    ...(password === undefined ? {} : { password }),
  });
  if (!verified.ok) throw new Error(verified.error.message);
  if (!verified.value.ok) throw new Error(verified.value.problems.join('; '));
  return { bytes: result.bytes, repaired: result.repaired };
}

export async function saveRepairedCopy(source: SourceDocument): Promise<RepairOutcome> {
  announce(m.repair_running({ name: source.name }));
  try {
    const repaired = await repairedCopy(source);
    const stem = source.name.replace(/\.pdf$/i, '');
    const name = exportFileName(`${stem}-repaired`);
    const outcome = await deliverPdf(repaired.bytes, name);
    if (outcome !== 'cancelled') {
      announce(
        repaired.repaired
          ? m.repair_saved({ name: source.name })
          : m.repair_not_needed({ name: source.name }),
      );
    }
    return outcome;
  } catch (error) {
    announce(
      m.repair_failed({
        name: source.name,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return 'failed';
  }
}

const checks = new Map<SourceId, Promise<PlumberCheckResult>>();
let closeListener: (() => void) | undefined;

/**
 * The structural check of an open source for a diagnostics panel (qpdf's cheap read:
 * xref, trailer, page tree and encryption, no stream decoding), with the password that
 * opened it. Memoized per source (a source's bytes never change) until it is closed.
 * Loads the compress worker on first use. Never rejects.
 */
export function structuralCheck(sourceId: SourceId): Promise<PlumberCheckResult> {
  const engine = getEngineService();
  closeListener ??= engine.onSourceClosed((id) => checks.delete(id));
  let pending = checks.get(sourceId);
  if (pending === undefined) {
    pending = (async (): Promise<PlumberCheckResult> => {
      const original = await engine.sourceBytes(sourceId);
      if (!original.ok) throw new Error(original.error.message);
      const password = engine.sourcePassword(sourceId);
      const plumber = await getCompressor();
      return plumber.check(original.value, password === undefined ? {} : { password });
    })().catch((error: unknown) => ({
      ok: false,
      unreadable: true,
      repaired: false,
      encrypted: false,
      linearized: false,
      warnings: [error instanceof Error ? error.message : String(error)],
    }));
    checks.set(sourceId, pending);
  }
  return pending;
}

/** Structural warnings of a source (English, as qpdf reports them); see `structuralCheck`. */
export async function structuralWarnings(sourceId: SourceId): Promise<readonly string[]> {
  return (await structuralCheck(sourceId)).warnings;
}
