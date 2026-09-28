/**
 * "Export changes as text": the Changes list as Markdown (a plain list that also reads as
 * text), in the UI language, with the honesty lines. Pure apart from the messages.
 */
import type { ComparisonResult } from '@pdf-editor/engine';

import { m } from '../i18n';
import { changeLabel, honestyLines, rowLabel, signGlyph } from './change-labels';
import type { ChangeItem, ChangeList } from './changes';

function line(item: ChangeItem): string {
  const { title, detail } = changeLabel(item, 400);
  return `- ${signGlyph(item.sign)} ${title}${detail ? ` — ${detail}` : ''}`;
}

export function changesMarkdown(
  result: ComparisonResult,
  list: ChangeList,
  assembled: readonly string[] = [],
): string {
  const { counts } = result;
  const out: string[] = [
    `# ${m.compare_text_heading({ a: result.a.name, b: result.b.name })}`,
    '',
    m.compare_summary({
      changed: counts.changed,
      inserted: counts.inserted,
      deleted: counts.deleted,
      identical: counts.identical,
    }),
    '',
    ...honestyLines(result, assembled).map((note) => `> ${note}`),
    '',
  ];
  if (list.flat.length === 0) {
    out.push(m.compare_no_changes(), '');
    return out.join('\n');
  }
  if (list.document.length > 0) {
    out.push(`## ${m.compare_group_document()}`, '', ...list.document.map(line), '');
  }
  for (const group of list.groups) {
    out.push(`## ${rowLabel(group.pair)}`, '', ...group.items.map(line), '');
  }
  return out.join('\n');
}
