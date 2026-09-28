/**
 * The reconciliation summary shown before download: what the export kept, changed or
 * removed, in plain sentences (VISION.md principle 5, "honest UI"). Source notes (password
 * protection removed, damaged files repaired) come first. Engine warnings not covered by a
 * dedicated line are shown as the engine wrote them (English).
 */
import type { ReconciliationReport } from '@pdf-editor/engine';

import { restrictionList } from '../document/security-text';
import { STRIP_ITEMS } from '../document/strip-items';
import { formatNumber, m } from '../i18n';
import { pagesPhrase } from '../state/workspace-store';
import { checkName } from '../redaction/report-text';
import type {
  ExportOutcome,
  RedactionExportSummary,
  SourceNotes,
  TextEditExportSummary,
} from './export-service';

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

/** Content edits the export verified or finalized (Output section lines). */
export interface ContentSummary {
  readonly redaction?: RedactionExportSummary;
  readonly textEdits?: TextEditExportSummary;
}

/** "Redaction: N areas on M pages, self-check passed (9 checks)", per page and per check. */
function redactionItems(redaction: RedactionExportSummary): SummaryItem[] {
  const { report } = redaction;
  const pages = Object.keys(redaction.areasByPage)
    .map(Number)
    .sort((a, b) => a - b);
  const items: SummaryItem[] = [
    {
      id: 'redaction',
      tone: 'changed',
      text: m.summary_redaction({
        count: redaction.areas,
        countText: formatNumber(redaction.areas),
        pages: pagesPhrase(pages.length),
        checks: formatNumber(report.checks.length),
      }),
      details: [
        ...pages.map((index) =>
          m.summary_redaction_page({
            page: index + 1,
            count: formatNumber(redaction.areasByPage[index] ?? 0),
          }),
        ),
        ...report.checks
          .filter((check) => check.passed)
          .map((check) => m.summary_redaction_check({ name: checkName(check.id) })),
      ],
    },
  ];
  if (redaction.unmappedAreas > 0) {
    items.push({
      id: 'redaction-unmapped',
      tone: 'changed',
      text: m.summary_redaction_unmapped({ count: redaction.unmappedAreas }),
    });
  }
  if (report.unverifiedAttachments.length > 0) {
    items.push({
      id: 'redaction-unverified',
      tone: 'changed',
      text: m.summary_redaction_unverified({ names: report.unverifiedAttachments.join(', ') }),
    });
  }
  return items;
}

function textEditItem(textEdits: TextEditExportSummary): SummaryItem {
  return {
    id: 'text-edits',
    tone: 'changed',
    text: m.summary_text_edits({
      count: textEdits.edits,
      countText: formatNumber(textEdits.edits),
      fonts: formatNumber(textEdits.fontsRenamed),
      mcids: formatNumber(textEdits.mcidsReassigned),
      objects: formatNumber(textEdits.unreachableRemoved),
    }),
    details: textEdits.sources.map((s) =>
      m.summary_text_edits_source({ name: s.name, count: formatNumber(s.edits) }),
    ),
  };
}

export function summarizeReport(
  report: ReconciliationReport,
  notes: SourceNotes = NO_NOTES,
  outcome?: ExportOutcome,
  content: ContentSummary = {},
): SummaryItem[] {
  const items: SummaryItem[] = [];
  // Output: what the content edits became, first.
  if (content.redaction) items.push(...redactionItems(content.redaction));
  if (content.textEdits) items.push(textEditItem(content.textEdits));
  if (outcome?.security) {
    const restricted = restrictionList(outcome.security.permissions);
    items.push({
      id: 'encryption',
      tone: 'kept',
      text: outcome.security.userPassword
        ? restricted
          ? m.summary_encrypted_password_restricted({ restricted })
          : m.summary_encrypted_password()
        : m.summary_encrypted_owner({ restricted: restricted || m.security_nothing() }),
    });
  }
  if (notes.securityRemoved.length > 0) {
    items.push({
      id: 'security',
      tone: outcome?.passwordRemoved ? 'kept' : 'changed',
      text: outcome?.passwordRemoved
        ? m.summary_security_removed_requested({ count: notes.securityRemoved.length })
        : m.summary_security_removed({ count: notes.securityRemoved.length }),
      details: notes.securityRemoved,
    });
  }
  if (outcome) items.push(metadataItem(outcome, report));
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

/** The metadata policy line (spec document-tools.md §8), with strip counts as details. */
function metadataItem(outcome: ExportOutcome, report: ReconciliationReport): SummaryItem {
  const stripped = report.metadataStripped;
  if (stripped) {
    const counts: Record<string, number> = {
      info: stripped.infoKeys,
      customKeys: stripped.infoKeys,
      xmp: stripped.xmpPackets,
      attachments: stripped.attachments,
      javascript: stripped.javascript,
      pieceInfo: stripped.pieceInfo,
      thumbnails: stripped.thumbnails,
      annotationAuthors: stripped.annotationAuthors,
    };
    const details = STRIP_ITEMS.filter(
      (item) => stripped.applied[item.key] && item.key !== 'customKeys',
    ).map((item) =>
      m.summary_strip_detail({
        item: item.label(),
        count: formatNumber(counts[item.key] ?? 0),
      }),
    );
    return {
      id: 'metadata',
      tone: 'changed',
      text: m.summary_metadata_stripped(),
      details,
    };
  }
  return {
    id: 'metadata',
    tone: 'kept',
    text:
      outcome.metadata.policy === 'explicit'
        ? m.summary_metadata_explicit()
        : m.summary_metadata_inherited(),
  };
}
