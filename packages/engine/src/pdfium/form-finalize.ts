/**
 * Form post-pass of `PdfEditor.save()` (pdf-lib), for what EmbedPDF 2.15 cannot do:
 *
 * - Flatten form fields only. `EPDFAnnot_Flatten` refuses widgets whose normal appearance
 *   is a state dictionary (every checkbox and radio button), and `FPDFPage_Flatten` bakes
 *   and removes *every* annotation of the page. Here each widget's current appearance
 *   (/AP /N, or /AP /N /<AS> for buttons) is drawn into the page content exactly where a
 *   viewer shows it (ISO 32000-2 12.5.5: BBox transformed by Matrix, fitted to Rect), the
 *   widget leaves /Annots, and /AcroForm goes. Other annotations are untouched.
 * - `/NeedAppearances false` once PDFium regenerated the appearance of every text and
 *   choice widget (spec document-tools §1), so other viewers show the stored appearances
 *   instead of re-laying out the values themselves.
 *
 * - Emptying fields PDFium's form filler cannot empty (`clearFields`): it only ever turns
 *   radio buttons on, and it cannot deselect a non-editable combo box. The field gets
 *   `/V /Off` and every widget `/AS /Off` (radio), or loses `/V` and `/I` (choice); the
 *   adapter re-opens the rewritten bytes so rendering and listing agree at once.
 *
 * Pure functions of the bytes and the request; the adapter runs them around PDFium.
 */

import {
  concatTransformationMatrix,
  drawObject,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  popGraphicsState,
  pushGraphicsState,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
} from '@cantoo/pdf-lib';

export interface FormFinalizeRequest {
  /** Bake widget appearances into the pages and remove the form. */
  readonly flatten: boolean;
  /** Password of an encrypted input (the output is written unencrypted). */
  readonly password?: string;
}

export interface FormFinalizeResult {
  readonly bytes: ArrayBuffer;
  /** Widgets drawn into page content. */
  readonly flattened: number;
}

const N = {
  AcroForm: PDFName.of('AcroForm'),
  Annots: PDFName.of('Annots'),
  AP: PDFName.of('AP'),
  AS: PDFName.of('AS'),
  BBox: PDFName.of('BBox'),
  F: PDFName.of('F'),
  Matrix: PDFName.of('Matrix'),
  N: PDFName.of('N'),
  Fields: PDFName.of('Fields'),
  I: PDFName.of('I'),
  Kids: PDFName.of('Kids'),
  NeedAppearances: PDFName.of('NeedAppearances'),
  Off: PDFName.of('Off'),
  T: PDFName.of('T'),
  V: PDFName.of('V'),
  Rect: PDFName.of('Rect'),
  Subtype: PDFName.of('Subtype'),
  Widget: PDFName.of('Widget'),
};

/** Annotation flags that keep a widget off the page (Invisible, Hidden, NoView). */
const NOT_SHOWN = 1 | 2 | 32;

function numbers(doc: PDFDocument, value: PDFObject | undefined): number[] | undefined {
  const array = doc.context.lookupMaybe(value, PDFArray);
  if (!array) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const n = doc.context.lookup(array.get(i));
    if (!(n instanceof PDFNumber)) return undefined;
    out.push(n.asNumber());
  }
  return out;
}

/** The appearance stream a viewer shows for the widget now, as a reference. */
function currentAppearance(doc: PDFDocument, widget: PDFDict): PDFRef | undefined {
  const { context } = doc;
  const ap = context.lookupMaybe(widget.get(N.AP), PDFDict);
  if (!ap) return undefined;
  let normal: PDFObject | undefined = ap.get(N.N);
  const resolved = normal === undefined ? undefined : context.lookup(normal);
  if (resolved instanceof PDFDict && !(resolved instanceof PDFStream)) {
    const state = context.lookupMaybe(widget.get(N.AS), PDFName);
    normal = state ? resolved.get(state) : undefined;
  }
  if (normal instanceof PDFRef) {
    return context.lookup(normal) instanceof PDFStream ? normal : undefined;
  }
  if (normal instanceof PDFStream) return context.register(normal);
  return undefined;
}

/** The `cm` that maps the appearance (BBox through Matrix) onto the widget's Rect. */
export function appearanceTransform(
  rect: readonly number[],
  bbox: readonly number[],
  matrix: readonly number[] = [1, 0, 0, 1, 0, 0],
): [number, number, number, number, number, number] | undefined {
  const [x0, y0, x1, y1] = bbox as [number, number, number, number];
  const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number];
  const corners = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [
    a * (x as number) + c * (y as number) + e,
    b * (x as number) + d * (y as number) + f,
  ]);
  const xs = corners.map((p) => p[0] as number);
  const ys = corners.map((p) => p[1] as number);
  const bx0 = Math.min(...xs);
  const by0 = Math.min(...ys);
  const bw = Math.max(...xs) - bx0;
  const bh = Math.max(...ys) - by0;
  const [r0, s0, r1, s1] = rect as [number, number, number, number];
  const rx = Math.min(r0, r1);
  const ry = Math.min(s0, s1);
  const rw = Math.abs(r1 - r0);
  const rh = Math.abs(s1 - s0);
  if (bw <= 0 || bh <= 0 || rw <= 0 || rh <= 0) return undefined;
  const sx = rw / bw;
  const sy = rh / bh;
  return [sx, 0, 0, sy, rx - sx * bx0, ry - sy * by0];
}

export async function finalizeForms(
  bytes: ArrayBuffer | Uint8Array,
  request: FormFinalizeRequest,
): Promise<FormFinalizeResult> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: false,
    ...(request.password === undefined ? {} : { password: request.password }),
  });
  const { context, catalog } = doc;
  let flattened = 0;
  if (request.flatten) {
    for (const page of doc.getPages()) {
      const annots = context.lookupMaybe(page.node.get(N.Annots), PDFArray);
      if (!annots) continue;
      const keep: PDFObject[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const item = annots.get(i);
        const dict = context.lookupMaybe(item, PDFDict);
        if (dict?.get(N.Subtype) !== N.Widget) {
          keep.push(item);
          continue;
        }
        const flags = context.lookup(dict.get(N.F));
        const hidden = flags instanceof PDFNumber && (flags.asNumber() & NOT_SHOWN) !== 0;
        const appearance = hidden ? undefined : currentAppearance(doc, dict);
        const stream = appearance ? context.lookup(appearance, PDFStream) : undefined;
        const rect = numbers(doc, dict.get(N.Rect));
        const bbox = stream ? numbers(doc, stream.dict.get(N.BBox)) : undefined;
        const matrix = stream ? numbers(doc, stream.dict.get(N.Matrix)) : undefined;
        const cm =
          rect?.length === 4 && bbox?.length === 4
            ? appearanceTransform(rect, bbox, matrix?.length === 6 ? matrix : undefined)
            : undefined;
        if (appearance && cm) {
          const name = page.node.newXObject('FlatWidget', appearance);
          page.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(...cm),
            drawObject(name),
            popGraphicsState(),
          );
          flattened += 1;
        }
      }
      if (keep.length === annots.size()) continue;
      if (keep.length === 0) page.node.delete(N.Annots);
      else page.node.set(N.Annots, context.obj(keep));
    }
    catalog.delete(N.AcroForm);
  } else {
    const form = context.lookupMaybe(catalog.get(N.AcroForm), PDFDict);
    form?.set(N.NeedAppearances, PDFBool.False);
  }
  const saved = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes: saved.slice().buffer, flattened };
}

export interface ClearFieldsRequest {
  /** Radio groups (fully-qualified names) to turn off: no option selected. */
  readonly radiosOff?: readonly string[];
  /** Choice fields (fully-qualified names) to leave without a selection. */
  readonly choicesEmpty?: readonly string[];
  /** Password of an encrypted input (the output is written unencrypted). */
  readonly password?: string;
}

function partialName(doc: PDFDocument, dict: PDFDict): string | undefined {
  const t = doc.context.lookup(dict.get(N.T));
  return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : undefined;
}

/** Field dictionaries by fully-qualified name (terminal fields and groups). */
function fieldsByName(doc: PDFDocument): Map<string, PDFDict> {
  const out = new Map<string, PDFDict>();
  const form = doc.context.lookupMaybe(doc.catalog.get(N.AcroForm), PDFDict);
  const seen = new Set<PDFDict>();
  const visit = (value: PDFObject | undefined, parent: string | undefined) => {
    const dict = doc.context.lookupMaybe(value, PDFDict);
    if (!dict || seen.has(dict)) return;
    seen.add(dict);
    const t = partialName(doc, dict);
    const name = t === undefined ? parent : parent === undefined ? t : `${parent}.${t}`;
    if (t !== undefined && name !== undefined && !out.has(name)) out.set(name, dict);
    const kids = doc.context.lookupMaybe(dict.get(N.Kids), PDFArray);
    for (let i = 0; i < (kids?.size() ?? 0); i++) visit(kids?.get(i), name);
  };
  const fields = doc.context.lookupMaybe(form?.get(N.Fields), PDFArray);
  for (let i = 0; i < (fields?.size() ?? 0); i++) visit(fields?.get(i), undefined);
  return out;
}

/** The widget dictionaries of a field: itself when merged, and its widget descendants. */
function widgetDicts(doc: PDFDocument, field: PDFDict): PDFDict[] {
  const out: PDFDict[] = [];
  const visit = (dict: PDFDict) => {
    if (dict.get(N.Subtype) === N.Widget) out.push(dict);
    const kids = doc.context.lookupMaybe(dict.get(N.Kids), PDFArray);
    for (let i = 0; i < (kids?.size() ?? 0); i++) {
      const kid = doc.context.lookupMaybe(kids?.get(i), PDFDict);
      if (kid) visit(kid);
    }
  };
  visit(field);
  return out;
}

/**
 * Empties the named fields (see the module comment). Resolves to the new bytes and the
 * names that were not found.
 */
export async function clearFields(
  bytes: ArrayBuffer | Uint8Array,
  request: ClearFieldsRequest,
): Promise<{ bytes: ArrayBuffer; missing: string[] }> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: false,
    ...(request.password === undefined ? {} : { password: request.password }),
  });
  const fields = fieldsByName(doc);
  const missing: string[] = [];
  for (const name of request.radiosOff ?? []) {
    const field = fields.get(name);
    if (!field) {
      missing.push(name);
      continue;
    }
    field.set(N.V, N.Off);
    for (const widget of widgetDicts(doc, field)) widget.set(N.AS, N.Off);
  }
  for (const name of request.choicesEmpty ?? []) {
    const field = fields.get(name);
    if (!field) {
      missing.push(name);
      continue;
    }
    field.delete(N.V);
    field.delete(N.I);
  }
  const saved = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes: saved.slice().buffer, missing };
}
