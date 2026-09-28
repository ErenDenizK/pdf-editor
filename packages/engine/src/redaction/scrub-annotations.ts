/**
 * Scrub steps 1 and 2 (research 06 §3 step 4.1–4.2): annotations and form fields.
 *
 * An annotation is removed when its /Rect or any /QuadPoints quad intersects an area of its
 * page, when it carries a redacted string (any string, or its appearance streams, whose
 * shown text is read with the content lexer of `content-text.ts`), when it is a leftover
 * /Redact mark, or (unless attachments are kept) when it is a FileAttachment or a
 * RichMedia annotation (whose assets are embedded files).
 * Removal cascades to its /Popup, to popups whose /Parent is removed and to /IRT replies.
 *
 * Widgets removed that way clear their field: /V, /DV, /RV and /I go from the field and its
 * ancestors, every other widget of the field loses /AP (and shows /AS /Off), and a field
 * left without widgets leaves /Fields (or its parent's /Kids, recursively). A field whose
 * value (or a widget's appearance) carries a redacted string is cleared the same way but
 * keeps its widgets. /XFA is always removed. Destination names are not "carrying": the
 * string step renames them and their referrers.
 */

import {
  PDFArray,
  type PDFContext,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

import { annotationInAreas } from './pdf-util';

const N = {
  AcroForm: PDFName.of('AcroForm'),
  Annots: PDFName.of('Annots'),
  AP: PDFName.of('AP'),
  AS: PDFName.of('AS'),
  CO: PDFName.of('CO'),
  DV: PDFName.of('DV'),
  Fields: PDFName.of('Fields'),
  FT: PDFName.of('FT'),
  I: PDFName.of('I'),
  IRT: PDFName.of('IRT'),
  Kids: PDFName.of('Kids'),
  P: PDFName.of('P'),
  Parent: PDFName.of('Parent'),
  Popup: PDFName.of('Popup'),
  RV: PDFName.of('RV'),
  Subtype: PDFName.of('Subtype'),
  T: PDFName.of('T'),
  V: PDFName.of('V'),
  XFA: PDFName.of('XFA'),
};

/** Tests a decoded text or decoded stream bytes for redacted strings. */
export interface CarryTest {
  text(value: string): boolean;
  bytes(value: Uint8Array): boolean;
  /**
   * The decoded content stream `stream` shows a redacted string as text (kerned TJ arrays,
   * escapes, spaced hex); false for streams that are not content streams.
   */
  shows?(stream: PDFStream, data: Uint8Array): boolean;
  /** Decoded data of a stream, `undefined` when not decodable. */
  decode(stream: PDFStream): Uint8Array | undefined;
}

export interface AnnotationScrubOptions {
  readonly areasByPage: ReadonlyMap<number, readonly Rect[]>;
  readonly carries: CarryTest;
  readonly removeFileAttachments: boolean;
}

export interface AnnotationScrubResult {
  annotationsRemoved: number;
  linksRemoved: number;
  pendingMarksRemoved: number;
  fileAttachmentsRemoved: number;
  widgetsRemoved: number;
  fieldsCleared: number;
  fieldsRemoved: number;
  xfaRemoved: boolean;
  /** Every annotation dictionary removed (structure /OBJR references to them dangle). */
  readonly removed: Set<PDFDict>;
}

/** Keys never followed when looking for strings (links to other objects, not content). */
const SKIP_KEYS = new Set(['P', 'Parent', 'Popup', 'IRT', 'Kids', 'StructParent']);
/** Keys whose string or name value is a destination name, renamed by the string step. */
const DEST_KEYS = new Set(['D', 'Dest']);

/**
 * Whether `value` (followed through references, streams decoded) carries a redacted string.
 * Destination names (/Dest, GoTo /D) do not count: the string step renames them together
 * with their named destination. `skip` names further keys to ignore.
 */
export function objectCarries(
  context: PDFContext,
  value: PDFObject,
  test: CarryTest,
  skip: ReadonlySet<string> = new Set(),
): boolean {
  const seen = new Set<PDFObject>();
  const stack: { value: PDFObject; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop() as { value: PDFObject; depth: number };
    const v = item.value instanceof PDFRef ? context.lookup(item.value) : item.value;
    if (!v || seen.has(v) || item.depth > 12) continue;
    seen.add(v);
    const text = textValue(v);
    if (text !== undefined) {
      if (test.text(text)) return true;
      continue;
    }
    if (v instanceof PDFStream) {
      const data = test.decode(v);
      if (data && (test.bytes(data) || test.shows?.(v, data) === true)) return true;
      stack.push({ value: v.dict, depth: item.depth + 1 });
    } else if (v instanceof PDFDict) {
      for (const [key, child] of v.entries()) {
        const k = key.decodeText();
        if (SKIP_KEYS.has(k) || (item.depth === 0 && skip.has(k))) continue;
        const resolved = context.lookup(child);
        const isName =
          resolved instanceof PDFString ||
          resolved instanceof PDFHexString ||
          resolved instanceof PDFName;
        if (DEST_KEYS.has(k) && isName) continue;
        stack.push({ value: child, depth: item.depth + 1 });
      }
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) stack.push({ value: v.get(i), depth: item.depth + 1 });
    }
  }
  return false;
}

function textValue(v: PDFObject): string | undefined {
  if (!(v instanceof PDFString || v instanceof PDFHexString)) return undefined;
  try {
    return v.decodeText();
  } catch {
    return undefined;
  }
}

/** Keys of a widget (or merged field) that hold or show the field value. */
const WIDGET_VALUE_KEYS: ReadonlySet<string> = new Set(['AP', 'V', 'DV', 'RV']);

function subtypeOf(context: PDFContext, dict: PDFDict): string | undefined {
  const s = context.lookup(dict.get(N.Subtype));
  return s instanceof PDFName ? s.decodeText() : undefined;
}

/** Runs steps 1 and 2 on `doc` in place. */
export function scrubAnnotations(
  doc: PDFDocument,
  options: AnnotationScrubOptions,
): AnnotationScrubResult {
  const { context } = doc;
  const result: AnnotationScrubResult = {
    annotationsRemoved: 0,
    linksRemoved: 0,
    pendingMarksRemoved: 0,
    fileAttachmentsRemoved: 0,
    widgetsRemoved: 0,
    fieldsCleared: 0,
    fieldsRemoved: 0,
    xfaRemoved: false,
    removed: new Set(),
  };
  const pages = doc.getPages();
  const pageIndexByRef = new Map<string, number>();
  pages.forEach((p, i) => pageIndexByRef.set(p.ref.toString(), i));
  const doomed = result.removed;
  const all: PDFDict[] = [];

  // 1. Direct reasons.
  pages.forEach((page, pageIndex) => {
    const annots = context.lookupMaybe(page.node.get(N.Annots), PDFArray);
    const areas = options.areasByPage.get(pageIndex) ?? [];
    for (let i = 0; annots && i < annots.size(); i++) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict);
      if (!annot) continue;
      all.push(annot);
      const subtype = subtypeOf(context, annot);
      // A widget's appearance shows its field value: a carrying value clears the field (and
      // drops /AP) below instead of removing the widget.
      const skip = subtype === 'Widget' ? WIDGET_VALUE_KEYS : undefined;
      if (
        (areas.length > 0 && annotationInAreas(context, annot, areas)) ||
        subtype === 'Redact' ||
        ((subtype === 'FileAttachment' || subtype === 'RichMedia') &&
          options.removeFileAttachments) ||
        objectCarries(context, annot, options.carries, skip)
      ) {
        doomed.add(annot);
      }
    }
  });

  // Widgets reachable only through the field tree still count when their /P page has areas.
  const acroForm = context.lookupMaybe(doc.catalog.get(N.AcroForm), PDFDict);
  const fields = acroForm ? context.lookupMaybe(acroForm.get(N.Fields), PDFArray) : undefined;
  const widgets = fields ? collectWidgets(context, fields) : [];
  for (const widget of widgets) {
    const page = widget.get(N.P);
    const pageIndex = page instanceof PDFRef ? pageIndexByRef.get(page.toString()) : undefined;
    const areas = pageIndex === undefined ? [] : (options.areasByPage.get(pageIndex) ?? []);
    if (areas.length > 0 && annotationInAreas(context, widget, areas)) doomed.add(widget);
  }

  // 2. Cascade: popups of removed annotations, popups whose parent went, replies.
  for (let changed = true; changed; ) {
    changed = false;
    for (const annot of all) {
      if (doomed.has(annot)) {
        const popup = context.lookupMaybe(annot.get(N.Popup), PDFDict);
        if (popup && !doomed.has(popup)) {
          doomed.add(popup);
          changed = true;
        }
        continue;
      }
      const parent = context.lookupMaybe(annot.get(N.Parent), PDFDict);
      const irt = context.lookupMaybe(annot.get(N.IRT), PDFDict);
      const isWidget = subtypeOf(context, annot) === 'Widget';
      if ((!isWidget && parent && doomed.has(parent)) || (irt && doomed.has(irt))) {
        doomed.add(annot);
        changed = true;
      }
    }
  }

  // 3. Remove from the pages.
  for (const page of pages) {
    const annots = context.lookupMaybe(page.node.get(N.Annots), PDFArray);
    for (let i = (annots?.size() ?? 0) - 1; annots && i >= 0; i--) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict);
      if (!annot || !doomed.has(annot)) continue;
      annots.remove(i);
      const subtype = subtypeOf(context, annot);
      if (subtype === 'Widget') continue; // counted with the form below
      result.annotationsRemoved++;
      if (subtype === 'Link') result.linksRemoved++;
      if (subtype === 'Redact') result.pendingMarksRemoved++;
      if (subtype === 'FileAttachment' || subtype === 'RichMedia') {
        result.fileAttachmentsRemoved++;
      }
    }
  }

  // 4. Forms.
  if (acroForm) {
    if (acroForm.has(N.XFA)) {
      acroForm.delete(N.XFA);
      result.xfaRemoved = true;
    }
    if (fields) scrubFields(context, acroForm, fields, widgets, options.carries, result);
  }
  return result;
}

/** Widget dictionaries of the field tree (merged field-widgets included). */
function collectWidgets(context: PDFContext, fields: PDFArray): PDFDict[] {
  const out: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  const stack: PDFDict[] = [];
  for (let i = 0; i < fields.size(); i++) {
    const f = context.lookupMaybe(fields.get(i), PDFDict);
    if (f) stack.push(f);
  }
  while (stack.length > 0 && seen.size < 100_000) {
    const node = stack.pop() as PDFDict;
    if (seen.has(node)) continue;
    seen.add(node);
    if (subtypeOf(context, node) === 'Widget') out.push(node);
    const kids = context.lookupMaybe(node.get(N.Kids), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      const kid = context.lookupMaybe(kids.get(i), PDFDict);
      if (kid) stack.push(kid);
    }
  }
  return out;
}

/** The field a widget belongs to: itself when merged (it has /T or /FT), else its /Parent. */
function fieldOf(context: PDFContext, widget: PDFDict): PDFDict {
  if (widget.has(N.T) || widget.has(N.FT)) return widget;
  return context.lookupMaybe(widget.get(N.Parent), PDFDict) ?? widget;
}

function scrubFields(
  context: PDFContext,
  acroForm: PDFDict,
  fields: PDFArray,
  widgets: readonly PDFDict[],
  carries: CarryTest,
  result: AnnotationScrubResult,
): void {
  const doomed = result.removed;
  const widgetsOf = new Map<PDFDict, PDFDict[]>();
  for (const w of widgets) {
    const field = fieldOf(context, w);
    widgetsOf.set(field, [...(widgetsOf.get(field) ?? []), w]);
  }
  const cleared = new Set<PDFDict>();
  const clear = (field: PDFDict) => {
    if (cleared.has(field)) return;
    cleared.add(field);
    result.fieldsCleared++;
    const seen = new Set<PDFDict>();
    for (let node: PDFDict | undefined = field; node && !seen.has(node); ) {
      seen.add(node);
      for (const key of [N.V, N.DV, N.RV, N.I]) node.delete(key);
      node = context.lookupMaybe(node.get(N.Parent), PDFDict);
    }
    for (const w of widgetsOf.get(field) ?? []) {
      w.delete(N.AP);
      if (w.has(N.AS)) w.set(N.AS, PDFName.of('Off'));
    }
  };
  for (const [field, ws] of widgetsOf) {
    const valueCarries =
      [N.V, N.DV, N.RV].some((key) => {
        const v = field.get(key);
        return v !== undefined && objectCarries(context, v, carries);
      }) ||
      ws.some((w) => {
        const ap = w.get(N.AP);
        return ap !== undefined && objectCarries(context, ap, carries);
      });
    if (valueCarries || ws.some((w) => doomed.has(w))) clear(field);
  }

  // Remove doomed widgets from the tree, then fields left without widgets.
  const removedFields = new Set<PDFDict>();
  const prune = (container: PDFArray): number => {
    let remaining = 0;
    for (let i = container.size() - 1; i >= 0; i--) {
      const node = context.lookupMaybe(container.get(i), PDFDict);
      if (!node) continue;
      if (doomed.has(node) && subtypeOf(context, node) === 'Widget') {
        container.remove(i);
        result.widgetsRemoved++;
        if (node.has(N.T) || node.has(N.FT)) removedFields.add(node);
        continue;
      }
      const kids = context.lookupMaybe(node.get(N.Kids), PDFArray);
      if (kids && kids.size() > 0) {
        if (prune(kids) === 0) {
          container.remove(i);
          removedFields.add(node);
          continue;
        }
      }
      remaining++;
    }
    return remaining;
  };
  prune(fields);
  result.fieldsRemoved = removedFields.size;
  const co = context.lookupMaybe(acroForm.get(N.CO), PDFArray);
  for (let i = (co?.size() ?? 0) - 1; co && i >= 0; i--) {
    const f = context.lookupMaybe(co.get(i), PDFDict);
    if (f && removedFields.has(f)) co.remove(i);
  }
}
