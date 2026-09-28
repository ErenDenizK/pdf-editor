/**
 * What the export needs to know about applied redactions (spec redaction §5.3): which
 * sources carry them (`redaction.apply` engine edits), and their plans mapped from source
 * pages to output pages for `verifyRedactedOutput`.
 *
 * Areas stay valid through the assembler's page copy, rotation and crop (user space is
 * unchanged); areas on a page that is resized are not mapped (its content is transformed)
 * and are counted in `unmappedAreas`, while their strings are still checked document-wide.
 */

import type { EngineEdit, SourceId, VirtualDocument, Workspace } from '@pdf-editor/document-model';

import type { RedactionApplyPayload, RedactionArea, RedactionPlan } from '../types';

/** Redactions in an export (`ExportPlan.redaction`). */
export interface RedactionExportPlan {
  /**
   * Sources with applied redactions. Their bytes must be the redacted ones
   * (`ApplyRedactionsResult.bytes`), never the bytes kept at open, and the output is always
   * a full rewrite: no incremental save, no byte-preserving passthrough.
   */
  readonly sources: readonly SourceId[];
  /** One plan per applied redaction, areas in output page indices. */
  readonly plans: readonly RedactionPlan[];
  /** Areas on exported pages that could not be mapped (resized pages). */
  readonly unmappedAreas: number;
}

function isArea(value: unknown): value is RedactionArea {
  const a = value as Partial<RedactionArea> | null;
  const r = a?.rect as Partial<RedactionArea['rect']> | undefined;
  return (
    typeof a?.pageIndex === 'number' &&
    [r?.x, r?.y, r?.width, r?.height].every((n) => typeof n === 'number')
  );
}

/** The plan of a `redaction.apply` edit, when its payload is a `RedactionApplyPayload`. */
export function redactionPlanOf(edit: EngineEdit): RedactionPlan | undefined {
  if (edit.kind !== 'redaction.apply') return undefined;
  const plan = (edit.payload as Partial<RedactionApplyPayload> | null)?.plan;
  if (
    !plan ||
    !Array.isArray(plan.areas) ||
    !Array.isArray(plan.strings) ||
    !plan.areas.every(isArea) ||
    !plan.strings.every((s) => typeof s === 'string')
  ) {
    return undefined;
  }
  return plan;
}

/** The redactions of `doc` for its export, or undefined when none of its sources has any. */
export function redactionExportPlan(
  ws: Workspace,
  doc: VirtualDocument,
): RedactionExportPlan | undefined {
  const bySource = new Map<SourceId, RedactionPlan[]>();
  for (const edit of ws.engineEdits) {
    const plan = redactionPlanOf(edit);
    if (plan) bySource.set(edit.source, [...(bySource.get(edit.source) ?? []), plan]);
  }
  const used = new Set<SourceId>();
  for (const page of doc.pages) {
    if (page.ref.kind === 'source' && bySource.has(page.ref.source)) used.add(page.ref.source);
  }
  if (used.size === 0) return undefined;
  let unmappedAreas = 0;
  const plans: RedactionPlan[] = [];
  for (const source of used) {
    for (const plan of bySource.get(source) ?? []) {
      const areas: RedactionArea[] = [];
      doc.pages.forEach((page, outputIndex) => {
        if (page.ref.kind !== 'source' || page.ref.source !== source) return;
        const index = page.ref.index;
        const mine = plan.areas.filter((a) => a.pageIndex === index);
        if ((page as { readonly resize?: unknown }).resize !== undefined) {
          unmappedAreas += mine.length;
          return;
        }
        for (const area of mine) areas.push({ ...area, pageIndex: outputIndex });
      });
      plans.push({ ...plan, areas });
    }
  }
  return { sources: [...used], plans, unmappedAreas };
}
