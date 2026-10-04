/**
 * The overflow policy (spec craft §4.6, ADR-0020 §6, research 11 §5), pure arithmetic over
 * layouts: (1) same or fewer lines commit; (2) growth that fits the empty space below while
 * keeping the original gap to the next block grows; (3) else word spacing is tightened up to
 * −15 %, then the rewritten lines' leading up to −5 %, never the glyph size; (4) else the
 * text runs over with a warning, unless that would put it past the edge of the page's visible
 * box (`offPage`: the writer refuses it). When tightening the whole paragraph (the lines
 * before the edit included) within the same floors would fit, the run-over carries that
 * layout as `fit`, for the editor to offer ("Tighten to fit"). Moving text to the next page
 * is never an outcome.
 */
import type { OverflowDecision, ParagraphLayout } from '../types';
import { type LayoutEdit, type LayoutInput, layoutWithThresholds } from './linebreak';

/** Tightening floors (spec craft §4.6). */
export const MIN_WORD_SPACING = 0.85;
export const MIN_LEADING = 0.95;

/** Height tolerance (points). */
const EPSILON = 1e-6;
/** Guard on the word-spacing search (each step lets one more word up; a paragraph has fewer). */
const MAX_STEPS = 500;

/** The paragraph and its surroundings, as the policy needs them. */
export interface OverflowBox {
  /** The paragraph and the edit `layout` was made from (tightening lays it out again). */
  readonly input: LayoutInput;
  readonly edit: LayoutEdit;
  /** The original gap between the paragraph and the block below it (points), kept when growing. */
  readonly paragraphGap: number;
  /**
   * The space from the paragraph's ink down to the edge of the page's visible box (points;
   * `ParagraphLayoutAnalysis.pageRoom`). A run-over past it is `offPage`. Default: unbounded.
   */
  readonly pageRoom?: number;
}

function growthOf(layout: ParagraphLayout): number {
  return layout.height - layout.originalHeight;
}

/** Sum of the baseline steps of rewritten lines (what a leading factor scales). */
function rewrittenSteps(layout: ParagraphLayout): number {
  let sum = 0;
  for (let i = 1; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    const prev = layout.lines[i - 1];
    if (line?.status === 'rewritten' && prev) sum += line.y - prev.y;
  }
  return sum;
}

/**
 * Decides what happens to `layout` (made from `box.input` and `box.edit` without
 * tightening). `gapBelow` is the empty space from the paragraph's last baseline area to the
 * next block below it (or the bottom margin), points.
 */
export function decideOverflow(
  layout: ParagraphLayout,
  box: OverflowBox,
  gapBelow: number,
): OverflowDecision {
  const growth = growthOf(layout);
  if (layout.lineDelta <= 0 && growth <= EPSILON) return { kind: 'commit', layout };
  const room = Math.max(0, gapBelow - box.paragraphGap);
  if (growth <= room + EPSILON) return { kind: 'grow', layout, growth };

  const local = tightenWithin(box, room, false);
  if (local) return local;
  const overflow = overflowOf(layout, growth, room, gapBelow, box.pageRoom);
  // The whole paragraph tightened (lines before the edit included) is offered, not applied:
  // it changes lines the user did not touch.
  const fit = tightenWithin(box, room, true);
  return fit?.kind === 'tighten' && overflow.kind === 'overflow' ? { ...overflow, fit } : overflow;
}

/**
 * The least tightening that makes the paragraph fit `room`: word spacing first (down to
 * −15 %), then leading (down to −5 %), on the rewritten lines or, `whole`, on every line.
 */
function tightenWithin(
  box: OverflowBox,
  room: number,
  whole: boolean,
): OverflowDecision | undefined {
  // Word spacing: step down through the exact factors at which a line takes one more word,
  // largest first, so the first that fits is the least tightening that does.
  let wordSpacing = 1;
  let current = layoutWithThresholds(box.input, box.edit, { wordSpacing, whole });
  for (let step = 0; step < MAX_STEPS; step++) {
    if (growthOf(current.layout) <= room + EPSILON && wordSpacing < 1) {
      return tighten(current.layout, wordSpacing, 1);
    }
    const below = current.thresholds.filter(
      (f) => f < wordSpacing && f >= MIN_WORD_SPACING - EPSILON,
    );
    if (below.length === 0) break;
    wordSpacing = Math.max(MIN_WORD_SPACING, Math.max(...below));
    current = layoutWithThresholds(box.input, box.edit, { wordSpacing, whole });
  }

  // Leading: the rewritten lines' steps shrink linearly with the factor.
  const tightest = current.layout;
  const steps = rewrittenSteps(tightest);
  if (steps > 0) {
    const needed = growthOf(tightest) - room;
    const leading = 1 - needed / steps;
    if (leading >= MIN_LEADING - EPSILON) {
      const final = layoutWithThresholds(box.input, box.edit, {
        wordSpacing,
        leading: Math.min(1, Math.max(MIN_LEADING, leading)),
        whole,
      }).layout;
      if (growthOf(final) <= room + EPSILON) return tighten(final, wordSpacing, final.leading);
    }
  }
  return undefined;
}

/** The run-over verdict: off the page when the growth passes the room to the page edge. */
export function overflowOf(
  layout: ParagraphLayout,
  growth: number,
  room: number,
  gapBelow: number,
  pageRoom = Number.POSITIVE_INFINITY,
): OverflowDecision {
  return {
    kind: 'overflow',
    layout,
    growth,
    excess: growth - room,
    overlap: Math.max(0, growth - gapBelow),
    offPage: growth > pageRoom + EPSILON,
  };
}

function tighten(layout: ParagraphLayout, wordSpacing: number, leading: number): OverflowDecision {
  const reduction = Math.max(1 - wordSpacing, 1 - leading);
  return {
    kind: 'tighten',
    layout,
    wordSpacing,
    leading,
    percent: Math.max(1, Math.round(reduction * 100)),
    growth: growthOf(layout),
  };
}
