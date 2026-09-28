/**
 * The pdf-lib post-pass of redaction (research 06 §3 step 4): runs on the bytes the engine
 * pass produced (text, images and paths under the areas already removed, marks applied
 * with no fill) and removes every document-level channel the engine leaves, then draws the
 * fill and writes a fresh single-revision file.
 *
 * Steps, in order:
 * 1–2. annotations in areas or carrying a redacted string (popups, replies), widgets and
 *      their field values, /XFA (`scrub-annotations.ts`);
 * 3.   redacted strings in every string object and name-tree key (`scrub-strings.ts`);
 * 4.   metadata: XMP regenerated from the scrubbed Info, per-object /Metadata, /PieceInfo,
 *      /Thumb, scripts (`scrub-metadata.ts`); structure tree pruned (`scrub-structure.ts`);
 * 5.   attachments removed unless `plan.keepAttachments` (then reported as unverified);
 * 6.   fill and overlay text (`fill.ts`);
 * 7.   garbage collection (`dropUnreachable`, which also removes the engine's in-session
 *      orphans), a new /ID, and a full save with object streams, as the assembler does.
 *
 * Areas are in unrotated user space, whatever the page's /Rotate. Throws `EngineError`
 * when the bytes cannot be parsed or are encrypted (the engine pass decrypts).
 */

import { PDFDocument, PDFHexString } from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

import { dropUnreachable } from '../pdflib/metadata';
import {
  EngineError,
  type RedactionArea,
  type RedactionPlan,
  type RedactionReport,
} from '../types';
import { byteVariants, grepBytes } from './byte-grep';
import { drawFills } from './fill';
import {
  BLACK,
  contrastingColor,
  decodeStream,
  isStructuralStream,
  parseColor,
  reachableRefs,
  refKey,
} from './pdf-util';
import { type CarryTest, scrubAnnotations } from './scrub-annotations';
import { scrubMetadata } from './scrub-metadata';
import { scrubStrings } from './scrub-strings';
import { pruneStructure } from './scrub-structure';
import { RedactedStringMatcher } from './strings';

/** Scrub steps; `ScrubOptions.skip` exists to prove the forensic check catches each one. */
export type ScrubStep =
  | 'annotations'
  | 'strings'
  | 'metadata'
  | 'structure'
  | 'attachments'
  | 'fill'
  | 'gc';

export interface ScrubOptions {
  /** Testing only: steps to leave out (a deliberately broken redaction). */
  readonly skip?: readonly ScrubStep[];
}

export interface ScrubResult {
  readonly bytes: ArrayBuffer;
  readonly report: RedactionReport;
}

type IndexedArea = RedactionArea & { readonly index: number };

function validArea(area: RedactionArea): boolean {
  const { x, y, width, height } = area.rect;
  return (
    Number.isInteger(area.pageIndex) &&
    area.pageIndex >= 0 &&
    [x, y, width, height].every(Number.isFinite) &&
    width > 0 &&
    height > 0
  );
}

/**
 * Scrubs engine-redacted `bytes` according to `plan` and writes a fresh file (no /Prev, no
 * unreachable objects). See the module comment for what each step removes.
 */
export async function scrubRedactedDocument(
  bytes: ArrayBuffer | Uint8Array,
  plan: RedactionPlan,
  options: ScrubOptions = {},
): Promise<ScrubResult> {
  const skip = new Set(options.skip ?? []);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
      updateMetadata: false,
    });
  } catch (cause) {
    const encrypted = cause instanceof Error && /encrypt/i.test(cause.message);
    throw new EngineError(
      encrypted ? 'unsupported-encryption' : 'corrupt',
      encrypted
        ? 'Redaction scrub needs decrypted bytes (the engine pass removes encryption)'
        : 'Redaction scrub could not parse the engine output',
      { cause },
    );
  }
  const { context } = doc;
  const warnings: string[] = [];
  const pageCount = doc.getPageCount();

  const areasByPage = new Map<number, IndexedArea[]>();
  const rectsByPage = new Map<number, Rect[]>();
  plan.areas.forEach((area, index) => {
    if (!validArea(area) || area.pageIndex >= pageCount) {
      warnings.push(`Area ${index} is not on a page of the document or has no size; ignored`);
      return;
    }
    areasByPage.set(area.pageIndex, [
      ...(areasByPage.get(area.pageIndex) ?? []),
      { ...area, index },
    ]);
    rectsByPage.set(area.pageIndex, [...(rectsByPage.get(area.pageIndex) ?? []), area.rect]);
  });

  const matcher = new RedactedStringMatcher(plan.strings);
  const placeholder = matcher.placeholder(plan.placeholder);
  if (plan.placeholder !== undefined && placeholder !== plan.placeholder) {
    warnings.push('The placeholder contains a redacted string; a neutral one was used');
  }
  const variants = plan.strings.flatMap((s) => byteVariants(s));
  const carries: CarryTest = {
    text: (value) => matcher.matches(value),
    bytes: (value) => variants.length > 0 && grepBytes(value, variants).length > 0,
    decode: (stream) => decodeStream(context, stream),
  };
  const keepAttachments = plan.keepAttachments === true || skip.has('attachments');

  // 1–2. Annotations and forms.
  const annotations = skip.has('annotations')
    ? undefined
    : scrubAnnotations(doc, {
        areasByPage: rectsByPage,
        carries,
        removeFileAttachments: !keepAttachments,
      });
  // 3. Strings.
  const strings = skip.has('strings')
    ? { stringsReplaced: 0, namesRenamed: 0 }
    : scrubStrings(doc, matcher, placeholder);
  // 4–5. Metadata and attachments; structure.
  const metadata = skip.has('metadata') ? undefined : scrubMetadata(doc, keepAttachments);
  const structure = skip.has('structure')
    ? { outcome: 'intact' as const, pruned: 0 }
    : pruneStructure(doc, annotations?.removed ?? new Set());
  // 6. Fill.
  const fill = parseColor(plan.fillColor) ?? BLACK;
  if (plan.fillColor !== undefined && !parseColor(plan.fillColor)) {
    warnings.push(`Fill colour "${plan.fillColor}" is not #rrggbb; black was used`);
  }
  const overlayColor = parseColor(plan.overlayColor) ?? contrastingColor(fill);
  if (!skip.has('fill')) {
    await drawFills(doc, areasByPage, {
      fill,
      overlayColor,
      ...(plan.overlayText === undefined ? {} : { overlayText: plan.overlayText }),
      matcher,
      warnings,
    });
  }
  // 7. Rewrite.
  await doc.flush();
  let unreachableObjectsRemoved = 0;
  if (!skip.has('gc')) {
    const reachable = reachableRefs(context);
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (!reachable.has(refKey(ref)) && !isStructuralStream(context, object)) {
        unreachableObjectsRemoved++;
      }
    }
    dropUnreachable(doc);
  }
  const id = PDFHexString.fromBytes(crypto.getRandomValues(new Uint8Array(16)));
  context.trailerInfo.ID = context.obj([id, id]);
  const out = await doc.save({
    useObjectStreams: true,
    updateFieldAppearances: false,
    addDefaultPage: false,
  });

  const areasCount: Record<number, number> = {};
  for (const [pageIndex, areas] of areasByPage) areasCount[pageIndex] = areas.length;
  const report: RedactionReport = {
    areasByPage: areasCount,
    annotationsRemoved: annotations?.annotationsRemoved ?? 0,
    linksRemoved: annotations?.linksRemoved ?? 0,
    pendingMarksRemoved: annotations?.pendingMarksRemoved ?? 0,
    fieldsCleared: annotations?.fieldsCleared ?? 0,
    widgetsRemoved: annotations?.widgetsRemoved ?? 0,
    fieldsRemoved: annotations?.fieldsRemoved ?? 0,
    xfaRemoved: annotations?.xfaRemoved ?? false,
    stringsReplaced: strings.stringsReplaced,
    namesRenamed: strings.namesRenamed,
    metadata: {
      xmpRegenerated: metadata?.xmpRegenerated ?? false,
      objectMetadata: metadata?.objectMetadata ?? 0,
      pieceInfo: metadata?.pieceInfo ?? 0,
      thumbnails: metadata?.thumbnails ?? 0,
      javascript: metadata?.javascript ?? 0,
    },
    structure: structure.outcome,
    structElementsPruned: structure.pruned,
    attachments: {
      removed: (metadata?.attachmentsRemoved ?? 0) + (annotations?.fileAttachmentsRemoved ?? 0),
      unverified: metadata?.unverified ?? [],
    },
    unreachableObjectsRemoved,
    warnings,
  };
  return { bytes: out.slice().buffer, report };
}
