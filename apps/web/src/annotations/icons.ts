/** One icon per annotation kind, so colour is never the only cue (spec §9). */
import type { Annotation } from '@pdf-editor/engine';
import {
  ArrowUpRight,
  Circle,
  EyeOff,
  Highlighter,
  Link,
  type LucideIcon,
  Minus,
  PenLine,
  Pentagon,
  Spline,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  Waves,
} from 'lucide-react';

import { displayKind } from './geometry';

export function annotationIcon(a: Annotation): LucideIcon {
  switch (displayKind(a)) {
    case 'highlight':
      return Highlighter;
    case 'underline':
      return Underline;
    case 'strikeout':
      return Strikethrough;
    case 'squiggly':
      return Waves;
    case 'ink':
      return PenLine;
    case 'square':
      return Square;
    case 'circle':
      return Circle;
    case 'line':
      return Minus;
    case 'arrow':
      return ArrowUpRight;
    case 'polygon':
      return Pentagon;
    case 'polyline':
      return Spline;
    case 'free-text':
      return Type;
    case 'text':
      return StickyNote;
    case 'stamp':
    case 'signature':
      return Stamp;
    case 'link':
      return Link;
    case 'redact':
      return EyeOff;
  }
}
