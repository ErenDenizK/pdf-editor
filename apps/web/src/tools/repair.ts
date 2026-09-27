/**
 * "Save repaired copy" (spec §7): the original bytes of a source PDFium had to repair on
 * open go through a full qpdf rewrite, the result is re-opened and checked (PDFium page
 * count and sizes against the open document), and only then offered for download.
 */
import type { SourceDocument, SourceId } from '@pdf-editor/document-model';

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

export async function saveRepairedCopy(source: SourceDocument): Promise<RepairOutcome> {
  const engine = getEngineService();
  announce(m.repair_running({ name: source.name }));
  try {
    const original = await engine.sourceBytes(source.id);
    if (!original.ok) throw new Error(original.error.message);
    const plumber = await getCompressor();
    const repaired = await plumber.process(original.value, { objectStreams: 'preserve' });
    const verified = await engine.verify(repaired.bytes.slice(0), {
      pageCount: source.pageCount,
      pageSizes: source.pages.map((p) => p.size),
      rotations: source.pages.map((p) => p.rotation),
    });
    if (!verified.ok) throw new Error(verified.error.message);
    if (!verified.value.ok) throw new Error(verified.value.problems.join('; '));
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

/**
 * Structural warnings of a source for a diagnostics panel (`qpdf --check`), in English as
 * qpdf reports them. Loads the compress worker on first use.
 */
export async function structuralWarnings(sourceId: SourceId): Promise<readonly string[]> {
  const original = await getEngineService().sourceBytes(sourceId);
  if (!original.ok) return [original.error.message];
  const plumber = await getCompressor();
  return (await plumber.check(original.value)).warnings;
}
