/**
 * The blank-region gate (research 06 §3 step 3): after the engine pass and the scrub, and
 * before the fill hides anything, every area rendered with annotations and forms must be
 * page background (white) only. Anything else is content that was not removed: a path the
 * policy kept, a widget or annotation on top, or a construct the engine does not handle.
 * Each area that is not blank lists what still touches it (page objects, at any depth in
 * Form XObjects, and annotations).
 */

import type { Rect } from '@pdf-editor/document-model';

import { annotationRectToUser, pageGeometry } from '../pdfium/coords';
import type { RawAccess } from '../pdfium/host/hosted-engine';
import { runTask } from '../pdfium/task-bridge';
import type {
  RedactionGateArea,
  RedactionGateReport,
  RedactionLeftoverKind,
  RedactionPlan,
} from '../types';
import {
  boundsOf,
  type Container,
  formContainer,
  IDENTITY,
  type Matrix,
  matrixOf,
  multiply,
  pageContainer,
  touches,
  transformBox,
} from './engine-pass';
import type { RedactionHost, ScratchDocument } from './engine-session';
import { intersects } from './pdf-util';

/** Render scale, device pixels ignored along each edge, and the white tolerance. */
const SCALE = 2;
const INSET = 2;
const TOLERANCE = 24;
/** Share of background pixels an area needs to count as blank. */
export const MIN_BACKGROUND_SHARE = 0.99;

const KINDS: Readonly<Record<number, RedactionLeftoverKind>> = {
  1: 'text',
  2: 'path',
  3: 'image',
  4: 'shading',
};

function leftovers(
  raw: RawAccess,
  container: Container,
  toPage: Matrix,
  area: Rect,
  depth: number,
  out: Set<RedactionLeftoverKind>,
) {
  for (let i = 0; i < container.count(); i++) {
    const obj = container.get(i);
    const local = obj ? boundsOf(raw, obj) : undefined;
    if (!obj || !local || !touches(transformBox(local, toPage), area)) continue;
    const type = raw.module.FPDFPageObj_GetType(obj);
    if (type === 5) {
      const before = out.size;
      if (depth < 12)
        leftovers(
          raw,
          formContainer(raw, obj),
          multiply(matrixOf(raw, obj), toPage),
          area,
          depth + 1,
          out,
        );
      if (out.size === before) out.add('form');
    } else out.add(KINDS[type] ?? 'unknown');
  }
}

/** Runs the gate on an open scratch document of the scrubbed, unfilled bytes. */
export async function blankRegionGate(
  host: RedactionHost,
  scratch: ScratchDocument,
  plan: RedactionPlan,
  signal?: AbortSignal,
): Promise<RedactionGateReport> {
  const areas: {
    areaIndex: number;
    pageIndex: number;
    share: number;
    remaining: Set<RedactionLeftoverKind>;
  }[] = [];
  for (const [areaIndex, area] of plan.areas.entries()) {
    const px = await scratch.renderArea(area.pageIndex, area.rect, SCALE);
    const inset = (n: number) => Math.min(INSET, Math.max(0, Math.floor((n - 1) / 2)));
    const [ix, iy] = [inset(px.width), inset(px.height)];
    let white = 0;
    let total = 0;
    for (let y = iy; y < px.height - iy; y++) {
      for (let x = ix; x < px.width - ix; x++) {
        const i = (y * px.width + x) * 4;
        total++;
        if (
          (px.data[i] ?? 0) >= 255 - TOLERANCE &&
          (px.data[i + 1] ?? 0) >= 255 - TOLERANCE &&
          (px.data[i + 2] ?? 0) >= 255 - TOLERANCE
        ) {
          white++;
        }
      }
    }
    areas.push({
      areaIndex,
      pageIndex: area.pageIndex,
      share: total === 0 ? 1 : white / total,
      remaining: new Set(),
    });
  }
  const failing = areas.filter((a) => a.share < MIN_BACKGROUND_SHARE);
  // Annotations first: engine calls must not run inside the raw access below.
  for (const a of failing) {
    const page = scratch.page(a.pageIndex);
    const annotations = await runTask(host.engine.getPageAnnotations(scratch.doc, page), signal, {
      op: 'redaction gate',
    });
    const g = pageGeometry(page);
    const rect = plan.areas[a.areaIndex]?.rect;
    if (rect && annotations.some((x) => intersects(annotationRectToUser(g, x.rect), rect))) {
      a.remaining.add('annotation');
    }
  }
  if (failing.length > 0) {
    await host.withRawAccess(scratch.id, (raw) => {
      for (const a of failing) {
        const rect = plan.areas[a.areaIndex]?.rect;
        if (!rect) continue;
        const page = raw.doc.acquirePage(a.pageIndex);
        try {
          leftovers(raw, pageContainer(raw, page.pagePtr), IDENTITY, rect, 0, a.remaining);
        } finally {
          page.release();
        }
        if (a.remaining.size === 0) a.remaining.add('unknown');
      }
    });
  }
  const report: RedactionGateArea[] = areas.map((a) => ({
    areaIndex: a.areaIndex,
    pageIndex: a.pageIndex,
    backgroundShare: Math.round(a.share * 1000) / 1000,
    blank: a.share >= MIN_BACKGROUND_SHARE,
    remaining: [...a.remaining].sort(),
  }));
  return { ok: report.every((a) => a.blank), areas: report };
}
