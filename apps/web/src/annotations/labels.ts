/** Names and history labels of annotations (spec §5: "Highlight on page 3", "Move note"). */
import type { Annotation } from '@pdf-editor/engine';

import { getLocale, m } from '../i18n';
import { type DisplayKind, displayKind } from './geometry';

const KIND_NAMES: Record<DisplayKind, () => string> = {
  highlight: m.annot_kind_highlight,
  underline: m.annot_kind_underline,
  strikeout: m.annot_kind_strikeout,
  squiggly: m.annot_kind_squiggly,
  ink: m.annot_kind_ink,
  square: m.annot_kind_square,
  circle: m.annot_kind_circle,
  line: m.annot_kind_line,
  arrow: m.annot_kind_arrow,
  polygon: m.annot_kind_polygon,
  polyline: m.annot_kind_polyline,
  'free-text': m.annot_kind_free_text,
  text: m.annot_kind_text,
  stamp: m.annot_kind_stamp,
  signature: m.annot_kind_signature,
  link: m.annot_kind_link,
  redact: m.annot_kind_redact,
};

/** Lower-case kind name for use inside a sentence ("note", "text box"). */
export function kindName(kind: DisplayKind): string {
  return KIND_NAMES[kind]();
}

export function annotationName(a: Annotation): string {
  return kindName(displayKind(a));
}

/** Upper-cases the first letter in the active language ("i" → "İ" in Turkish). */
export function capitalize(text: string): string {
  const first = text.charAt(0);
  return first.toLocaleUpperCase(getLocale()) + text.slice(1);
}

export type UpdateAction =
  | 'move'
  | 'resize'
  | 'color'
  | 'opacity'
  | 'stroke'
  | 'font'
  | 'text'
  | 'comment'
  | 'erase';

export function createLabel(kind: DisplayKind, position: number): string {
  return capitalize(m.history_annot_create({ kind: kindName(kind), page: position }));
}

export function updateLabel(action: UpdateAction, kind: DisplayKind): string {
  const name = kindName(kind);
  const label = {
    move: () => m.history_annot_move({ kind: name }),
    resize: () => m.history_annot_resize({ kind: name }),
    color: () => m.history_annot_color({ kind: name }),
    opacity: () => m.history_annot_opacity({ kind: name }),
    stroke: () => m.history_annot_stroke({ kind: name }),
    font: () => m.history_annot_font({ kind: name }),
    text: () => m.history_annot_text({ kind: name }),
    comment: () => m.history_annot_comment({ kind: name }),
    erase: () => m.history_annot_erase(),
  }[action]();
  return capitalize(label);
}

export function deleteLabel(annotations: readonly Annotation[]): string {
  const only = annotations[0];
  if (annotations.length === 1 && only) {
    return capitalize(m.history_annot_delete_one({ kind: annotationName(only) }));
  }
  return m.history_annot_delete({ count: annotations.length });
}
