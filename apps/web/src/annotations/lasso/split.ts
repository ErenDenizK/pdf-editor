/**
 * Editing some paths of an Ink annotation (experience-redesign spec §6.5).
 *
 * **Split rule.** A lasso may take only some paths of a multi-path Ink (a pen burst, §6.4).
 * An edit of those paths changes them only:
 *
 * - **Whole.** When every path of the Ink is taken, the Ink is edited in place (same id).
 * - **Recolour, width, opacity, move.** The Ink keeps its id, its comment and the paths that
 *   were not taken (the rest, in their order); the taken paths become a new Ink annotation
 *   (new `/NM`, same author, colour, opacity, width and flags, no comment) carrying the edit.
 * - **Delete.** The taken paths are removed from the Ink, which keeps its id and the rest;
 *   it goes when nothing remains (that is the whole case).
 *
 * Per-point widths (ADR-0018) stay parallel to the paths on both sides: each path keeps its
 * own widths. Widths that no longer match the paths (written elsewhere) are dropped, and
 * those strokes are constant width. A width change scales a path's per-point widths by the
 * same factor as the nominal width, so a pressure stroke keeps its shape. A move translates
 * the points only. Each annotation's rect is recomputed from its paths and widest width.
 * The update and the create of a split are one history entry (`editInkPaths`, actions.ts).
 */
import type { Rect } from '@pdf-editor/document-model';
import type { InkAnnotation, NewAnnotation } from '@pdf-editor/engine';

import type { ToolStyle } from '../annotation-store';
import { normalizeHex } from '../colors';
import { roundRect } from '../geometry';
import { boundsOf, type Point } from '../ink';
import { translatePath } from './geometry';

/** Which paths of an Ink an edit takes, and which stay. */
export interface SplitPlan {
  /** Taken path indices, ascending, unique, in range. */
  readonly taken: readonly number[];
  /** The other indices, ascending. */
  readonly rest: readonly number[];
  /** Every path is taken: edit the Ink in place. */
  readonly whole: boolean;
}

export function splitPlan(pathCount: number, picked: readonly number[]): SplitPlan {
  const taken = [...new Set(picked)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < pathCount)
    .sort((a, b) => a - b);
  const set = new Set(taken);
  const rest: number[] = [];
  for (let i = 0; i < pathCount; i++) if (!set.has(i)) rest.push(i);
  return { taken, rest, whole: taken.length > 0 && rest.length === 0 };
}

/** The ink's widths when they are parallel to its paths, point for point; else undefined. */
export function alignedWidths(ink: InkAnnotation): readonly (readonly number[])[] | undefined {
  const widths = ink.widths;
  if (widths?.length !== ink.paths.length) return undefined;
  return widths.every((w, i) => w.length === ink.paths[i]?.length) ? widths : undefined;
}

/** The rect of paths drawn at `strokeWidth` and per-point `widths` (as the pen commits it). */
export function inkRect(
  paths: readonly (readonly Point[])[],
  strokeWidth: number,
  widths?: readonly (readonly number[])[],
): Rect {
  const widest = Math.max(strokeWidth, ...(widths?.flat() ?? []));
  return roundRect(boundsOf(paths, widest / 2 + 1));
}

/** The ink with only the paths at `indices` (their widths kept parallel) and its rect. */
export function inkWithPaths(ink: InkAnnotation, indices: readonly number[]): InkAnnotation {
  const widths = alignedWidths(ink);
  const paths = indices.flatMap((i) => (ink.paths[i] ? [ink.paths[i]] : []));
  const kept = widths ? indices.flatMap((i) => (widths[i] ? [widths[i]] : [])) : undefined;
  const { widths: _old, ...base } = ink;
  return {
    ...base,
    paths,
    ...(kept ? { widths: kept } : {}),
    rect: inkRect(paths, ink.strokeWidth, kept),
  };
}

/** The ink moved by (dx, dy) in user space: points only, widths unchanged. */
export function translateInk(ink: InkAnnotation, dx: number, dy: number): InkAnnotation {
  const paths = ink.paths.map((path) => translatePath(path, dx, dy));
  return { ...ink, paths, rect: inkRect(paths, ink.strokeWidth, alignedWidths(ink)) };
}

/**
 * The ink with a style patch applied: colour, opacity, and a width that scales the
 * per-point widths with the nominal one.
 */
export function restyleInk(ink: InkAnnotation, patch: Partial<ToolStyle>): InkAnnotation {
  let next: InkAnnotation = ink;
  if (patch.color !== undefined) next = { ...next, color: normalizeHex(patch.color) };
  if (patch.opacity !== undefined) {
    next = { ...next, opacity: Math.round(patch.opacity * 100) / 100 };
  }
  if (patch.strokeWidth !== undefined && patch.strokeWidth > 0) {
    const strokeWidth = patch.strokeWidth;
    const widths = alignedWidths(next);
    const factor = next.strokeWidth > 0 ? strokeWidth / next.strokeWidth : 1;
    const scaled = widths?.map((w) => w.map((x) => Math.round(x * factor * 1000) / 1000));
    const { widths: _old, ...base } = next;
    next = {
      ...base,
      strokeWidth,
      ...(scaled ? { widths: scaled } : {}),
      rect: inkRect(next.paths, strokeWidth, scaled),
    };
  }
  return next;
}

/** An edit of taken paths. */
export type PathEdit =
  | { readonly kind: 'style'; readonly patch: Partial<ToolStyle> }
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'delete' };

/** The ink after `edit` (not for delete). */
export function applyPathEdit(ink: InkAnnotation, edit: PathEdit): InkAnnotation {
  if (edit.kind === 'style') return restyleInk(ink, edit.patch);
  if (edit.kind === 'move') return translateInk(ink, edit.dx, edit.dy);
  return ink;
}

/** What an edit of some paths of one Ink becomes. */
export interface SplitOutcome {
  /** The Ink, same id, after the edit; undefined when it goes (delete of every path). */
  readonly update?: InkAnnotation;
  /** The taken paths as a new Ink (a split), with the new id. */
  readonly create?: NewAnnotation & { readonly kind: 'ink'; readonly id: string };
  /** Delete the Ink (every path taken by a delete). */
  readonly remove: boolean;
  /** Where the taken paths are afterwards: annotation id → path indices (none after delete). */
  readonly picks: Readonly<Record<string, readonly number[]>>;
  /** How many paths the edit changed. */
  readonly count: number;
}

/**
 * The split rule (module header) for one Ink: `picked` path indices, `edit`, and the id the
 * taken paths get when they become their own annotation.
 */
export function splitInk(
  ink: InkAnnotation,
  picked: readonly number[],
  edit: PathEdit,
  newId: string,
): SplitOutcome {
  const plan = splitPlan(ink.paths.length, picked);
  const count = plan.taken.length;
  if (count === 0) return { remove: false, picks: {}, count: 0 };
  if (edit.kind === 'delete') {
    if (plan.whole) return { remove: true, picks: {}, count };
    return { update: inkWithPaths(ink, plan.rest), remove: false, picks: {}, count };
  }
  if (plan.whole) {
    return {
      update: applyPathEdit(ink, edit),
      remove: false,
      picks: { [ink.id]: plan.taken },
      count,
    };
  }
  const rest = inkWithPaths(ink, plan.rest);
  const {
    contents: _comment,
    modified: _modified,
    ...taken
  } = applyPathEdit(inkWithPaths(ink, plan.taken), edit);
  return {
    update: rest,
    create: { ...taken, id: newId },
    remove: false,
    picks: { [newId]: plan.taken.map((_, i) => i) },
    count,
  };
}
