/**
 * Localized names for the redaction self-check and the blank-region gate (the apply result
 * sheet and the export summary). Findings themselves are engine data (object numbers,
 * channels) and are shown as the engine wrote them.
 */
import type {
  ForensicCheckId,
  ForensicCheckResult,
  ForensicFinding,
  ForensicReport,
  RedactionLeftoverKind,
} from '@pdf-editor/engine';

import { m } from '../i18n';

const CHECK_NAMES: Readonly<Record<ForensicCheckId, () => string>> = {
  parse: m.redaction_check_parse,
  'single-revision': m.redaction_check_single_revision,
  'no-unreachable-objects': m.redaction_check_no_unreachable_objects,
  'no-text-in-areas': m.redaction_check_no_text_in_areas,
  'no-search-hits': m.redaction_check_no_search_hits,
  'object-strings': m.redaction_check_object_strings,
  'byte-grep': m.redaction_check_byte_grep,
  'no-annotations-in-areas': m.redaction_check_no_annotations_in_areas,
  'fill-pixels': m.redaction_check_fill_pixels,
};

const LEFTOVER_NAMES: Readonly<Record<RedactionLeftoverKind, () => string>> = {
  text: m.redaction_leftover_text,
  path: m.redaction_leftover_path,
  image: m.redaction_leftover_image,
  shading: m.redaction_leftover_shading,
  form: m.redaction_leftover_form,
  annotation: m.redaction_leftover_annotation,
  unknown: m.redaction_leftover_unknown,
};

export function checkName(id: ForensicCheckId): string {
  return CHECK_NAMES[id]?.() ?? id;
}

export function leftoverName(kind: RedactionLeftoverKind): string {
  return LEFTOVER_NAMES[kind]?.() ?? kind;
}

/** "page 1, area 0 · search · redacted string 0" (engine words). */
export function findingText(finding: ForensicFinding): string {
  return [finding.where, finding.channel, finding.detail]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
}

/** One line per finding of every failing check: "Check name: where · channel · detail". */
export function failingCheckLines(report: ForensicReport): string[] {
  const lines: string[] = [];
  for (const check of report.checks.filter((c: ForensicCheckResult) => !c.passed)) {
    const name = checkName(check.id);
    if (check.findings.length === 0) lines.push(check.note ? `${name}: ${check.note}` : name);
    for (const finding of check.findings) lines.push(`${name}: ${findingText(finding)}`);
    if (check.truncated) lines.push(`${name}: …`);
  }
  return lines;
}
