/**
 * Signature fields of a document, read with pdf-lib: the AcroForm field tree (/FT /Sig,
 * inherited, fully qualified names) with each field's /V signature dictionary, plus the
 * signature dictionaries the catalog's /Perms names that no field holds (usage rights).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  type PDFObject,
  PDFRef,
  PDFString,
  ParseSpeeds,
} from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

export interface SignatureFieldInfo {
  /** Fully qualified name, or `/Perms /<key>` for a /Perms-only dictionary. */
  readonly name: string;
  /** Object number of the terminal field (undefined for /Perms entries). */
  readonly fieldObject?: number;
  readonly pageIndex?: number;
  readonly rect?: Rect;
  /** The field has a /V signature dictionary. */
  readonly signed: boolean;
  readonly sig?: SignatureDictionary;
}

export interface SignatureDictionary {
  /** Object number of the dictionary when indirect. */
  readonly object?: number;
  readonly type?: string;
  readonly filter?: string;
  readonly subFilter: string;
  /** /ByteRange as written; empty when absent or not all integers. */
  readonly byteRange: readonly number[];
  /** Decoded /Contents as pdf-lib reads it (unencrypted files only; compared with the gap). */
  readonly contents?: Uint8Array;
  /** /M as written. */
  readonly m?: string;
  readonly reason?: string;
  readonly location?: string;
  readonly contactInfo?: string;
  readonly name?: string;
  /** DocMDP /P from a /Reference entry, when this is a certification signature. */
  readonly docMdp?: 1 | 2 | 3;
  /** The field's /V could not be read as a signature dictionary. */
  readonly unreadable?: boolean;
}

const MAX_DEPTH = 32;

/**
 * Loads `bytes` for reading signature facts. Encrypted files are decrypted with `password`
 * (or the empty user password); otherwise they are read raw, `decrypted: false`, and their
 * strings must not be trusted.
 */
export async function loadForSignatures(
  bytes: Uint8Array,
  password?: string,
): Promise<{ readonly doc: PDFDocument; readonly decrypted: boolean }> {
  const base = {
    updateMetadata: false,
    throwOnInvalidObject: false,
    preserveXFA: true,
    parseSpeed: ParseSpeeds.Fastest,
  } as const;
  const raw = await PDFDocument.load(bytes, { ...base, ignoreEncryption: true });
  if (!raw.isEncrypted) return { doc: raw, decrypted: true };
  for (const attempt of password === undefined ? [''] : [password, '']) {
    try {
      return {
        doc: await PDFDocument.load(bytes, { ...base, password: attempt }),
        decrypted: true,
      };
    } catch {
      // Next attempt, then the raw document.
    }
  }
  return { doc: raw, decrypted: false };
}

function text(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return undefined;
}

function nameOf(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

function pageIndexByRef(doc: PDFDocument): Map<string, number> {
  const map = new Map<string, number>();
  doc.getPages().forEach((page, i) => map.set(page.ref.toString(), i));
  return map;
}

/** Page of a widget: its /P, else the page whose /Annots holds it. */
function widgetPage(
  widget: PDFDict,
  widgetRef: PDFRef | undefined,
  pages: Map<string, number>,
  annotsIndex: () => Map<string, number>,
): number | undefined {
  const p = widget.get(PDFName.of('P'));
  if (p instanceof PDFRef) {
    const index = pages.get(p.toString());
    if (index !== undefined) return index;
  }
  return widgetRef ? annotsIndex().get(widgetRef.toString()) : undefined;
}

function rectOf(dict: PDFDict): Rect | undefined {
  const arr = dict.lookup(PDFName.of('Rect'));
  if (!(arr instanceof PDFArray) || arr.size() !== 4) return undefined;
  const n = arr.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : NaN));
  if (n.some((v) => !Number.isFinite(v))) return undefined;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = n;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function docMdpOf(sig: PDFDict): 1 | 2 | 3 | undefined {
  const refs = sig.lookup(PDFName.of('Reference'));
  if (!(refs instanceof PDFArray)) return undefined;
  for (let i = 0; i < refs.size(); i++) {
    const ref = refs.lookup(i);
    if (!(ref instanceof PDFDict)) continue;
    if (nameOf(ref.lookup(PDFName.of('TransformMethod'))) !== 'DocMDP') continue;
    const params = ref.lookup(PDFName.of('TransformParams'));
    const p = params instanceof PDFDict ? params.lookup(PDFName.of('P')) : undefined;
    const value = p instanceof PDFNumber ? p.asNumber() : 2;
    return value === 1 || value === 3 ? value : 2;
  }
  return undefined;
}

export function readSignatureDictionary(
  sig: PDFDict,
  ref: PDFRef | undefined,
  decrypted: boolean,
): SignatureDictionary {
  const br = sig.lookup(PDFName.of('ByteRange'));
  const byteRange =
    br instanceof PDFArray && br.asArray().every((v) => v instanceof PDFNumber)
      ? br.asArray().map((v) => (v as PDFNumber).asNumber())
      : [];
  const contents = sig.lookup(PDFName.of('Contents'));
  const str = (key: string) => (decrypted ? text(sig.lookup(PDFName.of(key))) : undefined);
  const type = nameOf(sig.lookup(PDFName.of('Type')));
  const filter = nameOf(sig.lookup(PDFName.of('Filter')));
  const m = str('M');
  const reason = str('Reason');
  const location = str('Location');
  const contactInfo = str('ContactInfo');
  const name = str('Name');
  const docMdp = docMdpOf(sig);
  return {
    ...(ref ? { object: ref.objectNumber } : {}),
    ...(type === undefined ? {} : { type }),
    ...(filter === undefined ? {} : { filter }),
    subFilter: nameOf(sig.lookup(PDFName.of('SubFilter'))) ?? '',
    byteRange,
    ...(decrypted && contents instanceof PDFHexString ? { contents: contents.asBytes() } : {}),
    ...(m === undefined ? {} : { m }),
    ...(reason === undefined ? {} : { reason }),
    ...(location === undefined ? {} : { location }),
    ...(contactInfo === undefined ? {} : { contactInfo }),
    ...(name === undefined ? {} : { name }),
    ...(docMdp === undefined ? {} : { docMdp }),
  };
}

function isSignatureDict(obj: PDFObject | undefined): obj is PDFDict {
  if (!(obj instanceof PDFDict)) return false;
  const type = nameOf(obj.lookup(PDFName.of('Type')));
  return (
    type === 'Sig' ||
    type === 'DocTimeStamp' ||
    (obj.has(PDFName.of('ByteRange')) && obj.has(PDFName.of('Contents')))
  );
}

/**
 * Every signature field (signed or not) in field-tree order, then /Perms-only dictionaries.
 * Never throws on odd structure: what cannot be read is skipped.
 */
export function readSignatureFields(doc: PDFDocument, decrypted: boolean): SignatureFieldInfo[] {
  const out: SignatureFieldInfo[] = [];
  const pages = pageIndexByRef(doc);
  let annots: Map<string, number> | undefined;
  const annotsIndex = (): Map<string, number> => {
    if (annots) return annots;
    annots = new Map();
    doc.getPages().forEach((page, i) => {
      const list = page.node.lookup(PDFName.of('Annots'));
      if (!(list instanceof PDFArray)) return;
      for (const item of list.asArray()) {
        if (item instanceof PDFRef && !annots?.has(item.toString()))
          annots?.set(item.toString(), i);
      }
    });
    return annots;
  };
  const seenSigs = new Set<number>();
  const visited = new Set<string>();

  const visit = (
    entry: PDFObject | undefined,
    parentName: string | undefined,
    inheritedFt: string | undefined,
    inheritedV: PDFObject | undefined,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH) return;
    const ref = entry instanceof PDFRef ? entry : undefined;
    if (ref) {
      if (visited.has(ref.toString())) return;
      visited.add(ref.toString());
    }
    const dict = ref ? doc.context.lookup(ref) : entry;
    if (!(dict instanceof PDFDict)) return;
    const partial = text(dict.lookup(PDFName.of('T')));
    const name =
      partial === undefined ? parentName : parentName ? `${parentName}.${partial}` : partial;
    const ft = nameOf(dict.lookup(PDFName.of('FT'))) ?? inheritedFt;
    const vRaw = dict.get(PDFName.of('V')) ?? inheritedV;
    const kids = dict.lookup(PDFName.of('Kids'));
    const kidList = kids instanceof PDFArray ? kids.asArray() : [];
    const fieldKids = kidList.filter((k) => {
      const kd = k instanceof PDFRef ? doc.context.lookup(k) : k;
      return kd instanceof PDFDict && kd.has(PDFName.of('T'));
    });
    if (fieldKids.length > 0) {
      for (const kid of fieldKids) visit(kid, name, ft, vRaw, depth + 1);
      return;
    }
    if (ft !== 'Sig') return;
    // A terminal signature field: itself a widget, or with widget kids.
    const widgetEntries: { dict: PDFDict; ref: PDFRef | undefined }[] = [];
    if (nameOf(dict.lookup(PDFName.of('Subtype'))) === 'Widget' || kidList.length === 0) {
      widgetEntries.push({ dict, ref });
    }
    for (const kid of kidList) {
      const kd = kid instanceof PDFRef ? doc.context.lookup(kid) : kid;
      if (kd instanceof PDFDict)
        widgetEntries.push({ dict: kd, ref: kid instanceof PDFRef ? kid : undefined });
    }
    const first = widgetEntries[0];
    const pageIndex = first ? widgetPage(first.dict, first.ref, pages, annotsIndex) : undefined;
    const rect = first ? rectOf(first.dict) : undefined;
    const vRef = vRaw instanceof PDFRef ? vRaw : undefined;
    const v = vRef ? doc.context.lookup(vRef) : vRaw;
    const readable = isSignatureDict(v);
    if (readable && vRef) seenSigs.add(vRef.objectNumber);
    // A /V that is not a readable signature dictionary (damaged): signed, with a malformed
    // dictionary, so it is reported (Broken) rather than taken for an empty field.
    const signed = readable || (vRaw !== undefined && vRaw !== PDFNull);
    const sig: SignatureDictionary | undefined = readable
      ? readSignatureDictionary(v, vRef, decrypted)
      : signed
        ? {
            ...(vRef ? { object: vRef.objectNumber } : {}),
            subFilter: '',
            byteRange: [],
            unreadable: true,
          }
        : undefined;
    out.push({
      name: name ?? '',
      ...(ref ? { fieldObject: ref.objectNumber } : {}),
      ...(pageIndex === undefined ? {} : { pageIndex }),
      ...(rect === undefined ? {} : { rect }),
      signed,
      ...(sig ? { sig } : {}),
    });
  };

  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(PDFName.of('Fields')) : undefined;
  if (fields instanceof PDFArray) {
    for (const field of fields.asArray()) visit(field, undefined, undefined, undefined, 0);
  }

  const perms = doc.catalog.lookup(PDFName.of('Perms'));
  if (perms instanceof PDFDict) {
    for (const [key, value] of perms.entries()) {
      const ref = value instanceof PDFRef ? value : undefined;
      if (ref && seenSigs.has(ref.objectNumber)) continue;
      const dict = ref ? doc.context.lookup(ref) : value;
      if (!isSignatureDict(dict)) continue;
      out.push({
        name: `/Perms /${key.decodeText()}`,
        signed: true,
        sig: readSignatureDictionary(dict, ref, decrypted),
      });
    }
  }
  return out;
}

/** `D:YYYYMMDDHHmmSSOHH'mm'` → ISO 8601; undefined when it is not a PDF date. */
export function parsePdfDate(value: string | undefined): Date | undefined {
  const m =
    value &&
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:([Zz+-])\s*(\d{2})?'?(\d{2})?'?)?/.exec(
      value.trim(),
    );
  if (!m) return undefined;
  const num = (s: string | undefined, d: number) => (s === undefined ? d : Number(s));
  const utc = Date.UTC(
    num(m[1], 0),
    num(m[2], 1) - 1,
    num(m[3], 1),
    num(m[4], 0),
    num(m[5], 0),
    num(m[6], 0),
  );
  const sign = m[7] === '+' ? 1 : m[7] === '-' ? -1 : 0;
  const offset = sign * (num(m[8], 0) * 60 + num(m[9], 0));
  const date = new Date(utc - offset * 60_000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
