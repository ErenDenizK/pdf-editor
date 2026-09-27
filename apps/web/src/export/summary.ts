/**
 * The reconciliation summary shown before download: what the export kept, changed or
 * removed, in plain sentences (VISION.md principle 5, "honest UI").
 */
import type { ReconciliationReport } from '@pdf-editor/engine';

export interface SummaryItem {
  readonly id: string;
  readonly text: string;
  /** 'changed' items altered the content (removed, renamed, joined); 'kept' ones did not. */
  readonly tone: 'kept' | 'changed';
  /** Optional detail lines (e.g. renamed fields). */
  readonly details?: readonly string[];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Engine warnings already expressed by a dedicated summary line. */
const COVERED = [
  /^Tagged PDF structure was removed/,
  /^XFA form data was removed/,
  /^Fields with equal names were joined/,
];

export function summarizeReport(report: ReconciliationReport): SummaryItem[] {
  const items: SummaryItem[] = [];
  const { outlineNodesKept: kept, outlineNodesDropped: dropped } = report;
  if (kept > 0 || dropped > 0) {
    items.push({
      id: 'outline',
      tone: dropped > 0 ? 'changed' : 'kept',
      text:
        dropped > 0
          ? `Bookmarks: ${kept} kept, ${dropped} dropped because their pages are not in this document.`
          : `Bookmarks: all ${plural(kept, 'bookmark', 'bookmarks')} kept.`,
    });
  }
  if (report.linksRewritten > 0 || report.linksDropped > 0) {
    items.push({
      id: 'links',
      tone: report.linksDropped > 0 ? 'changed' : 'kept',
      text:
        `Links: ${plural(report.linksRewritten, 'link', 'links')} to pages rewritten` +
        (report.linksDropped > 0
          ? `, ${report.linksDropped} removed because their target page is not in this document.`
          : '.'),
    });
  }
  if (report.formFieldsRenamed.length > 0) {
    items.push({
      id: 'renamed',
      tone: 'changed',
      text: `Form fields: ${plural(report.formFieldsRenamed.length, 'field', 'fields')} renamed so fields from different files stay separate.`,
      details: report.formFieldsRenamed.map((r) => `${r.from} → ${r.to}`),
    });
  }
  if (report.formFieldsUnified.length > 0) {
    items.push({
      id: 'unified',
      tone: 'changed',
      text: `Form fields: ${plural(report.formFieldsUnified.length, 'field', 'fields')} with the same name joined; they share the first file’s value.`,
      details: report.formFieldsUnified,
    });
  }
  if (report.structureTreeRemoved) {
    items.push({
      id: 'tags',
      tone: 'changed',
      text: 'Accessibility tags removed: they could not stay intact, so the output is not tagged.',
    });
  }
  if (report.xfaRemoved) {
    items.push({
      id: 'xfa',
      tone: 'changed',
      text: 'XFA form data removed; the regular form fields are kept.',
    });
  }
  report.warnings
    .filter((warning) => !COVERED.some((pattern) => pattern.test(warning)))
    .forEach((warning, index) => {
      items.push({ id: `warning-${index}`, tone: 'changed', text: warning });
    });
  return items;
}
