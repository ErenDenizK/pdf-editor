/**
 * The reconciliation summary shown before download: what the export kept, changed or
 * removed, in plain sentences (VISION.md principle 5, "honest UI"). Source notes (password
 * protection removed, damaged files repaired) come first. Engine warnings not covered by a
 * dedicated line are shown as the engine wrote them (English).
 */
import type { ReconciliationReport } from '@pdf-editor/engine';

import { m } from '../i18n';
import type { SourceNotes } from './export-service';

export interface SummaryItem {
  readonly id: string;
  readonly text: string;
  /** 'changed' items altered the content (removed, renamed, joined); 'kept' ones did not. */
  readonly tone: 'kept' | 'changed';
  /** Optional detail lines (e.g. renamed fields). */
  readonly details?: readonly string[];
}

/** Engine warnings already expressed by a dedicated summary line. */
const COVERED = [
  /^Tagged PDF structure was removed/,
  /^XFA form data was removed/,
  /^Fields with equal names were joined/,
  /^Password protection from \d+ files? was removed/,
  /^\d+ files? had to be repaired when opened/,
];

const NO_NOTES: SourceNotes = { securityRemoved: [], repaired: [] };

export function summarizeReport(
  report: ReconciliationReport,
  notes: SourceNotes = NO_NOTES,
): SummaryItem[] {
  const items: SummaryItem[] = [];
  if (notes.securityRemoved.length > 0) {
    items.push({
      id: 'security',
      tone: 'changed',
      text: m.summary_security_removed({ count: notes.securityRemoved.length }),
      details: notes.securityRemoved,
    });
  }
  if (notes.repaired.length > 0) {
    items.push({
      id: 'repaired',
      tone: 'changed',
      text: m.summary_repaired({ count: notes.repaired.length }),
      details: notes.repaired,
    });
  }
  const { outlineNodesKept: kept, outlineNodesDropped: dropped } = report;
  if (kept > 0 || dropped > 0) {
    items.push({
      id: 'outline',
      tone: dropped > 0 ? 'changed' : 'kept',
      text:
        dropped > 0
          ? m.summary_bookmarks_dropped({ kept, dropped })
          : m.summary_bookmarks_kept({ count: kept }),
    });
  }
  if (report.linksRewritten > 0 || report.linksDropped > 0) {
    items.push({
      id: 'links',
      tone: report.linksDropped > 0 ? 'changed' : 'kept',
      text:
        report.linksDropped > 0
          ? m.summary_links_dropped({
              count: report.linksRewritten,
              dropped: report.linksDropped,
            })
          : m.summary_links({ count: report.linksRewritten }),
    });
  }
  if (report.formFieldsRenamed.length > 0) {
    items.push({
      id: 'renamed',
      tone: 'changed',
      text: m.summary_fields_renamed({ count: report.formFieldsRenamed.length }),
      details: report.formFieldsRenamed.map((r) => `${r.from} → ${r.to}`),
    });
  }
  if (report.formFieldsUnified.length > 0) {
    items.push({
      id: 'unified',
      tone: 'changed',
      text: m.summary_fields_unified({ count: report.formFieldsUnified.length }),
      details: report.formFieldsUnified,
    });
  }
  if (report.structureTreeRemoved) {
    items.push({
      id: 'tags',
      tone: 'changed',
      text: m.summary_tags_removed(),
    });
  }
  if (report.xfaRemoved) {
    items.push({
      id: 'xfa',
      tone: 'changed',
      text: m.summary_xfa_removed(),
    });
  }
  report.warnings
    .filter((warning) => !COVERED.some((pattern) => pattern.test(warning)))
    .forEach((warning, index) => {
      items.push({ id: `warning-${index}`, tone: 'changed', text: warning });
    });
  return items;
}
