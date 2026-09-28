/**
 * Redaction marks (redaction spec §1.1): standard /Redact annotations with /QuadPoints,
 * /IC (the fill applying will paint, black by default) and /C (the red outline viewers
 * show while the mark is pending). Marks are created through the annotation edit runner,
 * so undo, the Comments panel, save and export treat them like any annotation. Nothing
 * here removes content: applying marks is a separate, later step.
 */
import type { EngineEdit, Rect } from '@pdf-editor/document-model';
import type { Annotation, MarkupAnnotation, NewAnnotation } from '@pdf-editor/engine';

import { type PageTarget, useAnnotationStore } from '../annotations/annotation-store';
import {
  type ActionResult,
  type EngineContext,
  executeEdit,
  readAnnotations,
  runAction,
} from '../annotations/edit-runner';
import { createLabel } from '../annotations/labels';
import { mountedLayers } from '../annotations/layer-registry';
import { cssBoxToUser, roundRect } from '../annotations/geometry';
import { pageText } from '../annotations/page-text';
import { glyphsInRects, quadsForGlyphs } from '../annotations/quads';
import { m } from '../i18n';
import { announce } from '../shell/announcer';

/** Outline of a pending mark (/C): the annotation palette's red. */
export const MARK_OUTLINE = '#E53935';
/** Fill painted when the mark is applied (/IC). */
export const MARK_FILL = '#000000';

export type RedactMark = MarkupAnnotation & { readonly kind: 'redact' };

export function isRedactMark(a: Annotation): a is RedactMark {
  return a.kind === 'redact';
}

function union(rects: readonly Rect[]): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Bounds of a mark's quads (to reveal it). */
export function markBounds(quads: readonly Rect[]): Rect {
  return union(quads);
}

/** A /Redact annotation over `quads` (user space). */
export function redactDraft(
  pageIndex: number,
  quads: readonly Rect[],
  fill: string = MARK_FILL,
): NewAnnotation {
  return {
    kind: 'redact',
    pageIndex,
    quads,
    rect: roundRect(union(quads)),
    color: MARK_OUTLINE,
    interiorColor: fill,
  };
}

/** Whether `inner` lies inside `outer` (with a small tolerance). */
function contains(outer: Rect, inner: Rect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** Whether every quad is already covered by one quad of an existing mark. */
export function alreadyMarked(existing: readonly Annotation[], quads: readonly Rect[]): boolean {
  const covering = existing.filter(isRedactMark).flatMap((a) => a.quads);
  return quads.length > 0 && quads.every((q) => covering.some((c) => contains(c, q)));
}

export interface MarkRequest {
  readonly target: PageTarget;
  /** One mark per entry: its quads. */
  readonly marks: readonly (readonly Rect[])[];
}

export interface CreateMarksOptions {
  /** History label when more than one mark is created (default "Mark n areas…"). */
  readonly label?: (count: number) => string;
  /** Select a single new mark (default true). */
  readonly select?: boolean;
  /** Fill colour (/IC). */
  readonly fill?: string;
}

async function serialize(a: NewAnnotation) {
  const engine = await import('@pdf-editor/engine');
  return engine.serializeAnnotation(a);
}

function stamped(draft: NewAnnotation): NewAnnotation {
  const author = useAnnotationStore.getState().author.trim();
  return {
    ...draft,
    modified: new Date().toISOString(),
    ...(author === '' ? {} : { author }),
  };
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Creates marks on one or more pages as one history entry. Quads already covered by an
 * existing mark on their page are skipped. Resolves to the created marks, or undefined
 * when nothing was created.
 */
export function createMarks(
  requests: readonly MarkRequest[],
  options: CreateMarksOptions = {},
): Promise<readonly Annotation[] | undefined> {
  return runAction(async (ctx: EngineContext) => {
    const edits: EngineEdit[] = [];
    const created: { annotation: Annotation; target: PageTarget }[] = [];
    for (const { target, marks } of requests) {
      const existing = [...(await readAnnotations(target.source, target.pageIndex, ctx))];
      for (const quads of marks) {
        if (quads.length === 0 || alreadyMarked(existing, quads)) continue;
        const draft = stamped(redactDraft(target.pageIndex, quads, options.fill));
        const done = await executeEdit(ctx, {
          id: newId(),
          source: target.source,
          pageIndex: target.pageIndex,
          kind: 'annotation.create',
          payload: { annotation: await serialize(draft) },
        });
        edits.push(done.recorded);
        if (done.annotation) {
          created.push({ annotation: done.annotation, target });
          existing.push(done.annotation);
        }
      }
    }
    const first = created[0];
    if (!first) return undefined;
    const label =
      created.length === 1
        ? createLabel('redact', first.target.position)
        : (options.label ?? ((count: number) => m.history_redaction_marks({ count })))(
            created.length,
          );
    announce(label);
    if ((options.select ?? true) && created.length === 1) {
      useAnnotationStore.getState().select({ ...first.target, ids: [first.annotation.id] });
    }
    const result: ActionResult<readonly Annotation[]> = {
      edits,
      label,
      value: created.map((c) => c.annotation),
    };
    return result;
  });
}

// ---------------------------------------------------------------------------
// Text selection → marks ("select text, then X")
// ---------------------------------------------------------------------------

function selectionRects(selection: Selection | null): DOMRect[] {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  const rects: DOMRect[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    for (const rect of selection.getRangeAt(i).getClientRects()) {
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
  }
  return rects;
}

/**
 * Marks the selected text on every page it spans (one mark per page, one history entry).
 * Resolves to whether a mark was created; the selection is cleared when one was.
 */
export async function markSelection(): Promise<boolean> {
  const selection = globalThis.getSelection?.() ?? null;
  const rects = selectionRects(selection);
  if (rects.length === 0) return false;
  const requests: MarkRequest[] = [];
  for (const layer of [...mountedLayers.values()]) {
    const bounds = layer.element.getBoundingClientRect();
    const onPage: Rect[] = [];
    for (const r of rects) {
      if (r.right < bounds.left || r.left > bounds.right) continue;
      if (r.bottom < bounds.top || r.top > bounds.bottom) continue;
      onPage.push(
        cssBoxToUser(layer.frame, {
          left: r.left - bounds.left,
          top: r.top - bounds.top,
          width: r.width,
          height: r.height,
        }),
      );
    }
    if (onPage.length === 0) continue;
    const runs = await pageText(layer.target.source, layer.target.pageIndex);
    const quads = quadsForGlyphs(runs, glyphsInRects(runs, onPage));
    if (quads.length > 0) requests.push({ target: layer.target, marks: [quads] });
  }
  if (requests.length === 0) return false;
  const done = await createMarks(requests);
  if (done) selection?.removeAllRanges();
  return done !== undefined;
}
