/**
 * The reconciliation summary shown before download: what the export kept, changed or
 * removed, in plain sentences (VISION.md principle 5, "honest UI"). Source notes (password
 * protection removed, damaged files repaired) come first. Engine warnings not covered by a
 * dedicated line are shown as the engine wrote them (English).
 */
import type { ReconciliationReport } from '@pdf-editor/engine';

import { restrictionList } from '../document/security-text';
import { STRIP_ITEMS } from '../document/strip-items';
import { formatNumber, getLocale, m } from '../i18n';
import { languageList, type OcrExportSummary } from '../ocr/ocr-model';
import { pagesPhrase } from '../state/workspace-store';
import { checkName } from '../redaction/report-text';
import type { SignatureExportSummary } from '../signatures/signing';
import { familyOfFace } from '../text-edit/model';
import type {
  ExportOutcome,
  RedactionExportSummary,
  SourceNotes,
  TextEditExportSummary,
  TextEditFonts,
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
  /** The signature the export added (spec recognize-and-compare §3.2). */
  readonly signature?: SignatureExportSummary;
  /** Existing signatures the rewrite removed. */
  readonly signaturesRemoved?: { readonly files: readonly string[]; readonly count: number };
  /** Recognised pages (OCR, spec recognize-and-compare §1.3). */
  readonly ocr?: OcrExportSummary;
}

/** "Recognized text (OCR) on 12 pages: Turkish and English …" with the honesty line. */
function ocrItems(ocr: OcrExportSummary): SummaryItem[] {
  const locale = getLocale();
  return [
    {
      id: 'ocr',
      tone: 'changed',
      text: m.ocr_summary({
        count: ocr.pages,
        countText: formatNumber(ocr.pages),
        languages: languageList(ocr.languages, locale),
      }),
      details: [m.ocr_honesty()],
    },
  ];
}

/** "Signed by …": signer, algorithm, field, and what the signature does not prove. */
function signatureItems(content: ContentSummary): SummaryItem[] {
  const items: SummaryItem[] = [];
  const { signature, signaturesRemoved } = content;
  if (signature) {
    items.push({
      id: 'signature',
      tone: 'changed',
      text: m.summary_signature({
        signer: signature.signer,
        algorithm: signature.algorithm,
        field: signature.fieldName,
      }),
    });
  }
  if (signaturesRemoved && signaturesRemoved.count > 0) {
    items.push({
      id: 'signatures-removed',
      tone: 'changed',
      text: m.summary_signatures_removed({
        count: signaturesRemoved.count,
        countText: formatNumber(signaturesRemoved.count),
      }),
      details: signaturesRemoved.files,
    });
  }
  return items;
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
  if (report.notSearched.length > 0) items.push(notSearchedItem(report.notSearched));
  const short = redaction.areaOnlyStrings;
  if (short.length > 0) {
    items.push({
      id: 'redaction-area-only',
      tone: 'changed',
      text: m.summary_redaction_area_only({
        count: short.length,
        countText: formatNumber(short.length),
      }),
      details: short.map((text) => m.summary_redaction_area_only_string({ text })),
    });
  }
  return items;
}

/** Stream kinds the self-check cannot search, in summary order. */
export type NotSearchedKind = 'jbig2' | 'ccitt' | 'jpx' | 'dct' | 'undecodable';

const FILTER_KINDS: readonly (readonly [string, NotSearchedKind])[] = [
  ['JBIG2Decode', 'jbig2'],
  ['CCITTFaxDecode', 'ccitt'],
  ['JPXDecode', 'jpx'],
  ['DCTDecode', 'dct'],
];

/**
 * The kind of a `ForensicReport.notSearched` entry ("object 12 (JBIG2Decode)", "object 12
 * (DCTDecode not decodable here)": the stream and, in parentheses, its filters or why it could
 * not be decoded): the image codec it names, else a stream that could not be decoded.
 */
export function notSearchedKind(entry: string): NotSearchedKind {
  const words = new Set(entry.split(/[^A-Za-z0-9]+/));
  return FILTER_KINDS.find(([filter]) => words.has(filter))?.[1] ?? 'undecodable';
}

const KIND_LABEL: Readonly<Record<NotSearchedKind, () => string>> = {
  jbig2: () => m.summary_filter_jbig2(),
  ccitt: () => m.summary_filter_ccitt(),
  jpx: () => m.summary_filter_jpx(),
  dct: () => m.summary_filter_dct(),
  undecodable: () => m.summary_filter_undecodable(),
};

/** "3 streams could not be checked for the redacted strings (JBIG2 images: 2, …)". */
function notSearchedItem(entries: readonly string[]): SummaryItem {
  const byKind = new Map<NotSearchedKind, string[]>();
  for (const entry of entries) {
    const kind = notSearchedKind(entry);
    byKind.set(kind, [...(byKind.get(kind) ?? []), entry]);
  }
  const kinds = (Object.keys(KIND_LABEL) as NotSearchedKind[]).filter((kind) => byKind.has(kind));
  return {
    id: 'redaction-not-searched',
    tone: 'changed',
    text: m.summary_redaction_not_searched({
      count: entries.length,
      countText: formatNumber(entries.length),
      groups: kinds
        .map((kind) =>
          m.summary_redaction_not_searched_group({
            kind: KIND_LABEL[kind](),
            count: formatNumber(byKind.get(kind)?.length ?? 0),
          }),
        )
        .join(', '),
    }),
    // The streams as the check names them, grouped.
    details: kinds.flatMap((kind) => byKind.get(kind) ?? []),
  };
}

/** A bundled face key as a name: `NotoSerif-Bold` → "Noto Serif Bold". */
function faceName(face: string): string {
  if (face === '') return m.summary_text_edits_face_unknown();
  const style = face.split('-').slice(1).join(' ');
  const family = familyOfFace(face);
  return style === '' || style === 'Regular' ? family : `${family} ${style}`;
}

/** "Noto Sans" for one face, "Noto Sans: 2, JetBrains Mono: 1" for several. */
function facesText(faces: Readonly<Record<string, number>>): string {
  const entries = Object.entries(faces).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 1) return faceName(entries[0]?.[0] ?? '');
  return entries
    .map(([face, count]) =>
      m.summary_text_edits_face_count({ face: faceName(face), count: formatNumber(count) }),
    )
    .join(', ');
}

const total = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((n, c) => n + c, 0);

/**
 * "report.pdf: 2 in the original font; 1 with a substituted font (Noto Sans); 1 fell back
 * from the original font to Noto Sans." (spec §2.1, §5.3: the export summary says how every
 * text edit was typeset).
 */
function textEditFontsText(name: string, fonts: TextEditFonts): string | undefined {
  const parts: string[] = [];
  const count = (n: number) => ({ count: n, countText: formatNumber(n) });
  if (fonts.sameFont > 0) parts.push(m.summary_text_edits_same_font(count(fonts.sameFont)));
  if (fonts.sameFontNotEmbedded > 0) {
    parts.push(m.summary_text_edits_same_font_not_embedded(count(fonts.sameFontNotEmbedded)));
  }
  const substituted = total(fonts.substituted);
  if (substituted > 0) {
    parts.push(
      m.summary_text_edits_substituted({
        ...count(substituted),
        faces: facesText(fonts.substituted),
      }),
    );
  }
  const fellBack = total(fonts.fellBack);
  if (fellBack > 0) {
    parts.push(
      m.summary_text_edits_fell_back({ ...count(fellBack), faces: facesText(fonts.fellBack) }),
    );
  }
  if (fonts.movedOutOfForm > 0) {
    parts.push(m.summary_text_edits_moved_out_of_form(count(fonts.movedOutOfForm)));
  }
  if (parts.length === 0) return undefined;
  return m.summary_text_edits_fonts({ name, parts: parts.join('; ') });
}

/** "A, B and C" in the interface language. */
function andList(parts: readonly string[]): string {
  try {
    return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(parts);
  } catch {
    return parts.join(', ');
  }
}

/** "1 paragraph and 2 lines of text edited". */
function textEditsText(textEdits: TextEditExportSummary): string {
  const paragraphs = textEdits.paragraphs ?? 0;
  const lines = textEdits.edits - paragraphs;
  const count = (n: number) => ({ count: n, countText: formatNumber(n) });
  const what: string[] = [];
  if (paragraphs > 0) what.push(m.summary_text_edits_paragraphs(count(paragraphs)));
  if (lines > 0 || paragraphs === 0) what.push(m.summary_text_edits_lines(count(lines)));
  return m.summary_text_edits_edited({ what: andList(what) });
}

/** What the export pass tidied after the edits, only the counters that are not zero. */
function tidiedText(textEdits: TextEditExportSummary): string | undefined {
  const parts: string[] = [];
  const count = (n: number) => ({ countText: formatNumber(n) });
  if (textEdits.fontsRenamed > 0) {
    parts.push(m.summary_text_edits_tidied_fonts(count(textEdits.fontsRenamed)));
  }
  if (textEdits.mcidsReassigned > 0) {
    parts.push(m.summary_text_edits_tidied_tags(count(textEdits.mcidsReassigned)));
  }
  if (textEdits.unreachableRemoved > 0) {
    parts.push(m.summary_text_edits_tidied_objects(count(textEdits.unreachableRemoved)));
  }
  return parts.length > 0 ? m.summary_text_edits_tidied({ parts: parts.join(', ') }) : undefined;
}

function textEditItems(textEdits: TextEditExportSummary): SummaryItem[] {
  const tidied = tidiedText(textEdits);
  return [
    {
      // What the user did: not a warning.
      id: 'text-edits',
      tone: 'kept',
      text: textEditsText(textEdits),
      ...(tidied ? { details: [tidied] } : {}),
    },
    // One visible line per source: which edits kept their font, which did not.
    ...textEdits.sources.flatMap((s, index): SummaryItem[] => {
      const text = textEditFontsText(s.name, s.fonts);
      if (text === undefined) return [];
      const tone = s.fonts.sameFont === s.edits ? 'kept' : 'changed';
      return [{ id: `text-edit-fonts-${index}`, tone, text }];
    }),
  ];
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
  if (content.textEdits) items.push(...textEditItems(content.textEdits));
  if (content.ocr) items.push(...ocrItems(content.ocr));
  items.push(...signatureItems(content));
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
