/**
 * pdf-lib passes the export runs around signatures (spec recognize-and-compare §3.2):
 *
 * - `stripSignatures`: before assembly, a signed source's signature values are removed. The
 *   export writes a new file (pdf-lib `copyPages`), so an existing signature could only come
 *   out Broken; the plain statement in the UI is that a rewrite removes it, and this pass makes
 *   that true: each signed /Sig field loses /V (the field stays, empty) and its widgets lose
 *   their appearance, the signature dictionaries are dropped, the catalog's /Perms (DocMDP,
 *   UR3) goes and /SigFlags is cleared.
 * - `visibleSignatureRect`: the widget rectangle of a visible signature at a corner of an
 *   output page, in its unrotated user space (CropBox origin and /Rotate respected).
 *
 * Loaded on demand (pdf-lib is the engine's pinned `@cantoo/pdf-lib`).
 * TODO(M5 follow-up): move `stripSignatures` into the engine (assembler option) so it runs
 * in the assembly worker with the rest of the rewrite.
 */
import type { PDFDict as PdfDict, PDFRef as PdfRef } from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

export interface StripResult {
  readonly bytes: ArrayBuffer;
  /** Signature values removed (signed fields found). */
  readonly removed: number;
}

/** Removes every signature value (and the appearances showing it) from `bytes`. */
export async function stripSignatures(bytes: ArrayBuffer): Promise<StripResult> {
  const { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    // Keep what the assembler reports on (it drops XFA itself and says so).
    preserveXFA: true,
    throwOnInvalidObject: false,
  });
  const { context, catalog } = doc;
  const N = {
    FT: PDFName.of('FT'),
    V: PDFName.of('V'),
    Kids: PDFName.of('Kids'),
    Parent: PDFName.of('Parent'),
    AP: PDFName.of('AP'),
    AS: PDFName.of('AS'),
    Sig: PDFName.of('Sig'),
    Subtype: PDFName.of('Subtype'),
    Widget: PDFName.of('Widget'),
    Annots: PDFName.of('Annots'),
    AcroForm: PDFName.of('AcroForm'),
    Fields: PDFName.of('Fields'),
    SigFlags: PDFName.of('SigFlags'),
    Perms: PDFName.of('Perms'),
  };
  type Dict = PdfDict;
  const cleared = new Set<Dict>();
  const blanked = new Set<Dict>();
  /** The signature dictionaries themselves, dropped from the file (not left as orphans). */
  const values = new Set<PdfRef>();

  /** A field's /FT, inherited through /Parent. */
  const fieldType = (dict: Dict): unknown => {
    let current: Dict | undefined = dict;
    for (let depth = 0; current && depth < 32; depth++) {
      const ft = current.get(N.FT);
      if (ft) return ft;
      current = context.lookupMaybe(current.get(N.Parent), PDFDict);
    }
    return undefined;
  };
  const blank = (widget: Dict) => {
    if (blanked.has(widget)) return;
    blanked.add(widget);
    widget.delete(N.AP);
    widget.delete(N.AS);
  };
  const widgetsOf = (field: Dict): Dict[] => {
    const kids = context.lookupMaybe(field.get(N.Kids), PDFArray);
    const out: Dict[] = field.get(N.Subtype) === N.Widget ? [field] : [];
    for (const kid of kids?.asArray() ?? []) {
      const dict = context.lookupMaybe(kid, PDFDict);
      if (dict && !dict.get(N.FT) && dict.get(N.Subtype) === N.Widget) out.push(dict);
    }
    return out;
  };
  const clear = (field: Dict) => {
    if (cleared.has(field) || fieldType(field) !== N.Sig || !field.get(N.V)) return;
    cleared.add(field);
    const value = field.get(N.V);
    if (value instanceof PDFRef) values.add(value);
    field.delete(N.V);
    for (const widget of widgetsOf(field)) blank(widget);
  };
  const visit = (item: unknown, seen: Set<string>) => {
    if (item instanceof PDFRef) {
      if (seen.has(item.toString())) return;
      seen.add(item.toString());
    }
    const dict = context.lookupMaybe(item as never, PDFDict);
    if (!dict) return;
    clear(dict);
    const kids = context.lookupMaybe(dict.get(N.Kids), PDFArray);
    for (const kid of kids?.asArray() ?? []) visit(kid, seen);
  };

  const acroForm = context.lookupMaybe(catalog.get(N.AcroForm), PDFDict);
  const fields = acroForm ? context.lookupMaybe(acroForm.get(N.Fields), PDFArray) : undefined;
  const seen = new Set<string>();
  for (const field of fields?.asArray() ?? []) visit(field, seen);
  // Signed widgets that /Fields does not reach still travel with their pages.
  for (const page of doc.getPages()) {
    const annots = context.lookupMaybe(page.node.get(N.Annots), PDFArray);
    for (const item of annots?.asArray() ?? []) {
      const widget = context.lookupMaybe(item, PDFDict);
      if (widget?.get(N.Subtype) !== N.Widget) continue;
      let field: Dict | undefined = widget;
      for (let depth = 0; field && depth < 32; depth++) {
        if (field.get(N.V) && fieldType(field) === N.Sig) {
          clear(field);
          blank(widget);
          break;
        }
        field = context.lookupMaybe(field.get(N.Parent), PDFDict);
      }
    }
  }
  const hadPerms = catalog.get(N.Perms) !== undefined;
  if (cleared.size === 0 && !hadPerms) return { bytes, removed: 0 };
  const perms = context.lookupMaybe(catalog.get(N.Perms), PDFDict);
  for (const [, entry] of perms?.entries() ?? []) {
    if (entry instanceof PDFRef) values.add(entry);
  }
  catalog.delete(N.Perms);
  acroForm?.delete(N.SigFlags);
  for (const ref of values) context.delete(ref);
  const saved = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return {
    bytes: saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength),
    removed: cleared.size,
  };
}

export type SignatureCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export const SIGNATURE_CORNERS: readonly SignatureCorner[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
];

/** Size of a visible signature as displayed (points) and its distance from the edges. */
export const VISIBLE_SIGNATURE = { width: 200, height: 50, margin: 36 } as const;

type Side = 'min' | 'max';

/**
 * Which unrotated corner shows at a displayed corner of a page with /Rotate `rotation`
 * (viewers turn the page clockwise): `[x side, y side]`.
 */
export function unrotatedCorner(corner: SignatureCorner, rotation: number): readonly [Side, Side] {
  const right = corner.endsWith('right');
  const top = corner.startsWith('top');
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      // Displayed left/right come from unrotated bottom/top; displayed top/bottom from left/right.
      return [top ? 'min' : 'max', right ? 'max' : 'min'];
    case 180:
      return [right ? 'min' : 'max', top ? 'min' : 'max'];
    case 270:
      return [top ? 'max' : 'min', right ? 'min' : 'max'];
    default:
      return [right ? 'max' : 'min', top ? 'max' : 'min'];
  }
}

/** The widget rectangle at `corner` of a page box (unrotated user space). */
export function cornerRect(box: Rect, rotation: number, corner: SignatureCorner): Rect {
  const quarter = ((rotation % 180) + 180) % 180 === 90;
  const { margin } = VISIBLE_SIGNATURE;
  const width = Math.max(
    1,
    Math.min(quarter ? VISIBLE_SIGNATURE.height : VISIBLE_SIGNATURE.width, box.width - 2 * margin),
  );
  const height = Math.max(
    1,
    Math.min(quarter ? VISIBLE_SIGNATURE.width : VISIBLE_SIGNATURE.height, box.height - 2 * margin),
  );
  const [xSide, ySide] = unrotatedCorner(corner, rotation);
  const inset = (size: number, available: number) =>
    Math.max(0, Math.min(margin, (available - size) / 2));
  return {
    x:
      xSide === 'min'
        ? box.x + inset(width, box.width)
        : box.x + box.width - inset(width, box.width) - width,
    y:
      ySide === 'min'
        ? box.y + inset(height, box.height)
        : box.y + box.height - inset(height, box.height) - height,
    width,
    height,
  };
}

/** The visible signature's rectangle on output page `pageIndex` of `bytes`. */
export async function visibleSignatureRect(
  bytes: ArrayBuffer,
  pageIndex: number,
  corner: SignatureCorner,
): Promise<Rect> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const page = doc.getPages()[pageIndex];
  if (!page) throw new RangeError(`The export has no page ${pageIndex + 1}`);
  return cornerRect(page.getCropBox(), page.getRotation().angle, corner);
}
