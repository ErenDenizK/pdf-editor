/**
 * Words for the Changes list, shared by the panel and the plain-text export: what changed
 * (`title`) and the evidence (`detail`). Called at render time (the language can change).
 */
import type { ComparisonResult, FactChange, PagePair } from '@pdf-editor/engine';

import { formatNumber, m } from '../i18n';
import type { ChangeItem, ChangeSign } from './changes';

/** Screen-reader words for the +/−/~ glyphs. */
export function signLabel(sign: ChangeSign): string {
  if (sign === '+') return m.compare_sign_added();
  if (sign === '-') return m.compare_sign_removed();
  return m.compare_sign_changed();
}

/** The glyph shown (a real minus sign for removals). */
export function signGlyph(sign: ChangeSign): string {
  return sign === '-' ? '−' : sign;
}

/** A share of a page as a percentage; tiny non-zero shares read "< 0.1%". */
export function sharePercent(ratio: number): string {
  if (ratio > 0 && ratio < 0.001) {
    return `< ${formatNumber(0.001, { style: 'percent', maximumFractionDigits: 1 })}`;
  }
  return formatNumber(ratio, { style: 'percent', maximumFractionDigits: 1 });
}

/** Clips long snippets for the list (the report and the text export keep more). */
export function snippet(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function factTitle(fact: FactChange): string {
  switch (fact.kind) {
    case 'page-count':
      return m.compare_fact_page_count();
    case 'metadata':
      return m.compare_fact_metadata({ key: fact.key });
    case 'xmp':
      return m.compare_fact_xmp({ key: fact.key });
    case 'page-size':
      return m.compare_fact_page_size();
    case 'page-rotation':
      return m.compare_fact_page_rotation();
    case 'annotations':
      return m.compare_fact_annotations({ key: fact.key });
    case 'form-field':
      return m.compare_fact_form_field({ key: fact.key });
    case 'attachment':
      return m.compare_fact_attachment({ key: fact.key });
    case 'signature':
      return m.compare_fact_signature({ key: fact.key });
  }
}

function factDetail(fact: FactChange, max: number): string {
  if (fact.a !== undefined && fact.b !== undefined) {
    return m.compare_fact_values({ a: snippet(fact.a, max), b: snippet(fact.b, max) });
  }
  if (fact.b !== undefined) return m.compare_fact_only_b({ value: snippet(fact.b, max) });
  if (fact.a !== undefined) return m.compare_fact_only_a({ value: snippet(fact.a, max) });
  return '';
}

export interface ChangeLabel {
  readonly title: string;
  readonly detail: string;
}

/** Title and detail of a change; `max` bounds quoted snippets. */
export function changeLabel(item: ChangeItem, max = 80): ChangeLabel {
  switch (item.kind) {
    case 'page': {
      const page = item.page + 1;
      const title =
        item.status === 'inserted'
          ? m.compare_change_page_inserted({ page })
          : m.compare_change_page_deleted({ page });
      const parts: string[] = [];
      if (item.firstLine) parts.push(m.compare_quote({ text: snippet(item.firstLine, max) }));
      if (item.words !== undefined) parts.push(m.compare_words({ count: item.words }));
      return { title, detail: parts.join(' · ') };
    }
    case 'visual': {
      const parts = [m.compare_change_share({ share: sharePercent(item.ratio) })];
      if (item.sizeMismatch) parts.push(m.compare_change_size_mismatch());
      return { title: m.compare_change_visual({ count: item.regions }), detail: parts.join(' · ') };
    }
    case 'text': {
      const { change } = item;
      const before = snippet(change.a?.text ?? '', max);
      const after = snippet(change.b?.text ?? '', max);
      const title =
        change.kind === 'changed'
          ? m.compare_change_text_changed({ before, after })
          : change.kind === 'added'
            ? m.compare_change_text_added({ text: after })
            : m.compare_change_text_removed({ text: before });
      const line = change.b?.line ?? change.a?.line;
      return { title, detail: line ? snippet(line, max * 2) : '' };
    }
    case 'fact':
      return { title: factTitle(item.fact), detail: factDetail(item.fact, max) };
  }
}

/** The heading of a page-map row: which page of each document it holds. */
export function rowLabel(pair: PagePair): string {
  if (pair.a !== undefined && pair.b !== undefined) {
    return m.compare_row_pair({ a: pair.a + 1, b: pair.b + 1 });
  }
  if (pair.a !== undefined) return m.compare_row_only_a({ page: pair.a + 1 });
  return m.compare_row_only_b({ page: (pair.b ?? 0) + 1 });
}

/** How many honesty lines the engine writes (`COMPARE_NOTES`); the UI translates them. */
export const ENGINE_NOTE_COUNT = 4;

/**
 * The honesty lines (spec §2.2) in the UI language: the result's `notes` (visual diff at N
 * dpi, text diff limits, what neither sees, export-time additions), translated; should the
 * engine write other notes, they are shown as written.
 */
export function honestyLines(
  result: Pick<ComparisonResult, 'settings' | 'notes'>,
  assembled: readonly string[] = [],
): string[] {
  const lines =
    result.notes.length === ENGINE_NOTE_COUNT
      ? [
          m.compare_note_visual({ dpi: result.settings.dpi }),
          m.compare_note_text(),
          m.compare_note_scope(),
          m.compare_note_export(),
        ]
      : [...result.notes];
  for (const name of assembled) lines.push(m.compare_note_assembled({ name }));
  return lines;
}
