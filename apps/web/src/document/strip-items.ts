/**
 * The "Strip metadata" checklist (spec document-tools.md §3): one row per removable kind,
 * with what the diagnostics found in the document's sources (and what the model holds).
 */
import type { DocumentMetadata, MetadataStrip } from '@pdf-editor/document-model';
import type { MetadataFindings } from '@pdf-editor/engine';

import { m } from '../i18n';

export interface StripItem {
  readonly key: keyof MetadataStrip;
  readonly label: () => string;
  readonly hint: () => string;
  /** Not selected by default even when found. */
  readonly optional?: boolean;
}

export const STRIP_ITEMS: readonly StripItem[] = [
  { key: 'info', label: m.strip_info, hint: m.strip_info_hint },
  { key: 'customKeys', label: m.strip_custom, hint: m.strip_custom_hint },
  { key: 'xmp', label: m.strip_xmp, hint: m.strip_xmp_hint },
  { key: 'attachments', label: m.strip_attachments, hint: m.strip_attachments_hint },
  { key: 'javascript', label: m.strip_javascript, hint: m.strip_javascript_hint },
  { key: 'pieceInfo', label: m.strip_piece_info, hint: m.strip_piece_info_hint },
  { key: 'thumbnails', label: m.strip_thumbnails, hint: m.strip_thumbnails_hint },
  {
    key: 'annotationAuthors',
    label: m.strip_annotation_authors,
    hint: m.strip_annotation_authors_hint,
    optional: true,
  },
];

const STANDARD_FIELDS = [
  'title',
  'author',
  'subject',
  'keywords',
  'creator',
  'creationDate',
] as const;

/** Findings of several sources summed; key lists merged. */
export function mergeFindings(list: readonly MetadataFindings[]): MetadataFindings {
  const union = (pick: (f: MetadataFindings) => readonly string[]) => [
    ...new Set(list.flatMap(pick)),
  ];
  const sum = (pick: (f: MetadataFindings) => number) =>
    list.reduce((total, f) => total + pick(f), 0);
  return {
    infoKeys: union((f) => f.infoKeys),
    customKeys: union((f) => f.customKeys),
    xmpPackets: sum((f) => f.xmpPackets),
    attachments: sum((f) => f.attachments),
    attachmentNames: union((f) => f.attachmentNames),
    javascript: sum((f) => f.javascript),
    pieceInfo: sum((f) => f.pieceInfo),
    thumbnails: sum((f) => f.thumbnails),
    annotationAuthors: sum((f) => f.annotationAuthors),
  };
}

export interface ItemFinding {
  readonly count: number;
  /** Names found (Info keys, custom keys, attachment names), when meaningful. */
  readonly names?: readonly string[];
}

/** What was found for `key` in the sources and the document's own metadata. */
export function findingFor(
  key: keyof MetadataStrip,
  findings: MetadataFindings,
  meta: DocumentMetadata,
): ItemFinding {
  switch (key) {
    case 'info': {
      const fromModel = STANDARD_FIELDS.filter((f) => meta[f] !== undefined).map(
        (f) => f.charAt(0).toUpperCase() + f.slice(1),
      );
      const names = [
        ...new Set([...findings.infoKeys.filter((k) => k !== 'Producer'), ...fromModel]),
      ];
      return { count: names.length, names };
    }
    case 'customKeys': {
      const names = [...new Set([...findings.customKeys, ...Object.keys(meta.custom ?? {})])];
      return { count: names.length, names };
    }
    case 'xmp':
      return { count: findings.xmpPackets };
    case 'attachments':
      return { count: findings.attachments, names: findings.attachmentNames };
    case 'javascript':
      return { count: findings.javascript };
    case 'pieceInfo':
      return { count: findings.pieceInfo };
    case 'thumbnails':
      return { count: findings.thumbnails };
    case 'annotationAuthors':
      return { count: findings.annotationAuthors };
  }
}

/** The initial selection: everything found, except optional items; a previous strip wins. */
export function initialStrip(findings: MetadataFindings, meta: DocumentMetadata): MetadataStrip {
  if (meta.strip) return meta.strip;
  const pick = (key: keyof MetadataStrip) => {
    const item = STRIP_ITEMS.find((i) => i.key === key);
    return item?.optional !== true && findingFor(key, findings, meta).count > 0;
  };
  return {
    info: pick('info'),
    xmp: pick('xmp'),
    attachments: pick('attachments'),
    javascript: pick('javascript'),
    pieceInfo: pick('pieceInfo'),
    thumbnails: pick('thumbnails'),
    annotationAuthors: pick('annotationAuthors'),
    customKeys: pick('customKeys'),
  };
}

/** Labels of the selected items, for summaries ("Info, XMP, attachments"). */
export function stripSummary(strip: MetadataStrip): string {
  return STRIP_ITEMS.filter((item) => strip[item.key])
    .map((item) => item.label())
    .join(', ');
}
