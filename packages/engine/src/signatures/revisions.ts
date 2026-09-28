/**
 * Classifies what the incremental revisions after a signed one changed (spec §3.1 step 6,
 * ADR-0013). The later revisions are read through their cross-reference chain (later.ts): each
 * object a later xref section resolves is compared with the signed revision's, so unchanged
 * rewrites are ignored, and every real change is attributed by what it is or by what reaches
 * it: page content and resources, annotations (with their appearance streams), form fields,
 * signatures, DSS, metadata, the page tree, or the catalog in other ways. Unreachable objects
 * cannot change what a reader shows and are ignored. Whatever the xref chain cannot account
 * for (later.ts) is kind `other`, which no DocMDP level allows — except an unreferenced object
 * that no xref section uses and that cannot carry content: it is listed as `other` for
 * information, and such a change alone keeps the signature "Intact, changed later".
 */
import {
  PDFArray,
  type PDFContext,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNull,
  type PDFObject,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';

import type { RevisionChange, RevisionChangeKind } from '../types';
import { readLaterRevisions, type StructuralChange } from './later';

/** Kinds an approval signature allows (no DocMDP): ISO 32000-2 §12.8.2.2 with Info metadata. */
const ALLOWED_DEFAULT: ReadonlySet<RevisionChangeKind> = new Set([
  'form-fill',
  'annotations',
  'signature',
  'dss',
  'metadata',
]);
const ALLOWED_BY_DOCMDP: Readonly<Record<1 | 2 | 3, ReadonlySet<RevisionChangeKind>>> = {
  1: new Set(['dss']),
  2: new Set(['form-fill', 'signature', 'dss', 'metadata']),
  3: ALLOWED_DEFAULT,
};

export function allowedKinds(docMdp: 1 | 2 | 3 | undefined): ReadonlySet<RevisionChangeKind> {
  return docMdp ? ALLOWED_BY_DOCMDP[docMdp] : ALLOWED_DEFAULT;
}

interface Written {
  readonly revision: number;
  readonly generation: number;
}

/** One reader's view of a document: its objects, catalog, trailer /Info and page leaves. */
interface DocView {
  readonly objects: ReadonlyMap<number, PDFObject>;
  readonly catalog: PDFDict | undefined;
  readonly catalogNum: number;
  readonly infoNum: number;
  readonly pages: readonly { readonly num: number; readonly node: PDFDict }[];
}

function objectsByNumber(context: PDFContext): Map<number, { ref: PDFRef; object: PDFObject }> {
  const map = new Map<number, { ref: PDFRef; object: PDFObject }>();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    map.set(ref.objectNumber, { ref, object });
  }
  return map;
}

/** Page leaves in order, walked from the catalog's /Pages (cycles and depth bounded). */
function pageLeaves(context: PDFContext, catalog: PDFDict | undefined): DocView['pages'] {
  const out: { num: number; node: PDFDict }[] = [];
  const seen = new Set<number>();
  const visit = (value: PDFObject | undefined, depth: number): void => {
    if (!(value instanceof PDFRef) || depth > 64 || seen.has(value.objectNumber)) return;
    seen.add(value.objectNumber);
    const node = context.lookup(value);
    if (!(node instanceof PDFDict)) return;
    const kids = node.lookup(PDFName.of('Kids'));
    const type = node.get(PDFName.of('Type'));
    if (type === PDFName.of('Pages') || (type !== PDFName.of('Page') && kids instanceof PDFArray)) {
      if (kids instanceof PDFArray) for (const kid of kids.asArray()) visit(kid, depth + 1);
      return;
    }
    out.push({ num: value.objectNumber, node });
  };
  visit(catalog?.get(PDFName.of('Pages')), 0);
  return out;
}

function viewOf(
  context: PDFContext,
  root: PDFObject | undefined,
  info: PDFObject | undefined,
): DocView {
  const catalog = root instanceof PDFRef ? context.lookup(root) : undefined;
  const dict = catalog instanceof PDFDict ? catalog : undefined;
  const objects = new Map<number, PDFObject>();
  for (const [num, { object }] of objectsByNumber(context)) objects.set(num, object);
  return {
    objects,
    catalog: dict,
    catalogNum: root instanceof PDFRef ? root.objectNumber : -1,
    infoNum: info instanceof PDFRef ? info.objectNumber : -1,
    pages: pageLeaves(context, dict),
  };
}

function nameOf(dict: PDFDict, key: string): string | undefined {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : undefined;
}

function dictOf(obj: PDFObject | undefined): PDFDict | undefined {
  if (obj instanceof PDFDict) return obj;
  if (obj instanceof PDFStream) return obj.dict;
  return undefined;
}

function refNums(obj: PDFObject | undefined): Set<number> {
  const out = new Set<number>();
  if (obj instanceof PDFRef) out.add(obj.objectNumber);
  if (obj instanceof PDFArray)
    for (const v of obj.asArray()) if (v instanceof PDFRef) out.add(v.objectNumber);
  return out;
}

function changedKeys(before: PDFDict, after: PDFDict): string[] {
  const keys = new Set([...before.keys(), ...after.keys()].map((k) => k.decodeText()));
  return [...keys].filter(
    (k) => String(before.get(PDFName.of(k)) ?? '') !== String(after.get(PDFName.of(k)) ?? ''),
  );
}

const ANNOT_SUBTYPES = new Set([
  'Text',
  'Link',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Caret',
  'Stamp',
  'Ink',
  'Popup',
  'FileAttachment',
  'Sound',
  'Movie',
  'Screen',
  'Widget',
  'PrinterMark',
  'TrapNet',
  'Watermark',
  '3D',
  'Redact',
  'Projection',
  'RichMedia',
]);

function isAnnotation(dict: PDFDict): boolean {
  const type = nameOf(dict, 'Type');
  const subtype = nameOf(dict, 'Subtype');
  return (
    type === 'Annot' ||
    (type === undefined &&
      subtype !== undefined &&
      ANNOT_SUBTYPES.has(subtype) &&
      dict.has(PDFName.of('Rect')))
  );
}

/**
 * Reachability with memo: the changed objects reachable from an object, never descending
 * into pages, the page tree, the catalog, or other annotations (their owners count them).
 */
class Reach {
  private readonly memo = new Map<number, Set<number>>();
  private readonly active = new Set<number>();

  constructor(
    private readonly objects: ReadonlyMap<number, PDFObject>,
    private readonly changed: ReadonlySet<number>,
  ) {}

  private isBarrier(obj: PDFObject | undefined): boolean {
    const dict = dictOf(obj);
    if (!dict) return false;
    const type = nameOf(dict, 'Type');
    return type === 'Page' || type === 'Pages' || type === 'Catalog' || isAnnotation(dict);
  }

  /** Changed objects reachable from a direct value (the root itself is not a barrier). */
  fromValue(value: PDFObject | undefined, out = new Set<number>(), depth = 0): Set<number> {
    if (value === undefined || depth > 64) return out;
    if (value instanceof PDFRef) {
      for (const n of this.fromRef(value.objectNumber)) out.add(n);
      return out;
    }
    if (value instanceof PDFArray) {
      for (const v of value.asArray()) this.fromValue(v, out, depth + 1);
    } else if (value instanceof PDFDict || value instanceof PDFStream) {
      const dict = dictOf(value);
      for (const [, v] of dict?.entries() ?? []) this.fromValue(v, out, depth + 1);
    }
    return out;
  }

  fromRef(num: number, root = false): Set<number> {
    const memo = this.memo.get(num);
    if (memo) return memo;
    const out = new Set<number>();
    if (this.active.has(num)) return out;
    const obj = this.objects.get(num);
    if (!root && this.isBarrier(obj)) {
      if (this.changed.has(num)) out.add(num);
      return out;
    }
    this.active.add(num);
    if (this.changed.has(num)) out.add(num);
    const dict = dictOf(obj);
    if (dict) {
      for (const [key, v] of dict.entries()) {
        const k = key.decodeText();
        if (k === 'P' || k === 'Parent' || k === 'IRT' || k === 'Popup') continue;
        this.fromValue(v, out);
      }
    } else if (obj instanceof PDFArray) {
      this.fromValue(obj, out);
    }
    this.active.delete(num);
    if (!root) this.memo.set(num, out);
    return out;
  }
}

/** A page attribute, inherited through /Parent when absent. */
function inherited(page: PDFDict, key: string): PDFObject | undefined {
  let node: PDFDict | undefined = page;
  for (let i = 0; node && i < 64; i++) {
    const v = node.get(PDFName.of(key));
    if (v !== undefined) return v;
    const parent: PDFObject | undefined = node.lookup(PDFName.of('Parent'));
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

export interface LaterChanges {
  readonly changes: RevisionChange[];
  /**
   * The `other` changes (members of `changes`) that only list unreferenced objects readers
   * ignore: they do not count against what the signature allows.
   */
  readonly informational: readonly RevisionChange[];
  /** Why the structural (`other`) changes were listed, one English line each. */
  readonly notes: readonly string[];
  /** 1-based number of the newest revision. */
  readonly lastRevision: number;
}

/**
 * What the revisions after `signedEnd` (the end of revision `signedRevision`) changed.
 * `before` and `afterCopy` are two loads of the bytes cut at `signedEnd` (the same way);
 * `afterCopy` is turned into the file as a reader resolves it and must not be shared.
 */
export async function classifyLaterChanges(
  bytes: Uint8Array,
  text: string,
  signedEnd: number,
  signedRevision: number,
  before: PDFDocument,
  afterCopy: PDFDocument,
): Promise<LaterChanges> {
  const context = afterCopy.context;
  const later = await readLaterRevisions(bytes, text, signedEnd, signedRevision, context);
  const structural: StructuralChange[] = [...later.structural];
  const signedObjects = objectsByNumber(before.context);
  const written = new Map<number, Written>();
  for (const [num, entry] of later.objects) {
    const was = signedObjects.get(num);
    if (entry.object === undefined) {
      // Free: a reference to the object now reads as null (ISO 32000-2 §7.3.10).
      if (!was) continue;
      context.assign(was.ref, PDFNull);
      written.set(num, { revision: entry.revision, generation: was.ref.generationNumber });
      continue;
    }
    if (was && was.ref.generationNumber !== entry.gen) {
      structural.push({
        revision: entry.revision,
        detail: `Object ${num} is redefined with generation ${entry.gen} (it had ${was.ref.generationNumber} when signed).`,
        objects: [`${num} ${entry.gen} R`],
      });
      context.delete(was.ref);
    }
    context.assign(PDFRef.of(num, entry.gen), entry.object);
    written.set(num, { revision: entry.revision, generation: entry.gen });
  }
  // The trailer: another catalog or encryption is structural; another /Info is metadata.
  const signedTrailer = before.context.trailerInfo;
  const sameRef = (a: PDFObject | undefined, b: { num: number; gen: number } | undefined) =>
    a instanceof PDFRef
      ? a.objectNumber === b?.num && a.generationNumber === b.gen
      : b === undefined;
  const infoChange: number[] = [];
  if (later.complete) {
    if (!later.root) {
      structural.push({
        revision: later.lastRevision,
        detail: 'The last trailer names no catalog.',
        objects: [],
      });
    } else if (!sameRef(signedTrailer.Root, later.root)) {
      structural.push({
        revision: later.lastRevision,
        detail: `The last trailer names another catalog (${later.root.num} ${later.root.gen} R).`,
        objects: [`${later.root.num} ${later.root.gen} R`],
      });
      context.trailerInfo.Root = PDFRef.of(later.root.num, later.root.gen);
    }
    if (!sameRef(signedTrailer.Encrypt, later.encrypt)) {
      structural.push({
        revision: later.lastRevision,
        detail: 'The last trailer changes the encryption dictionary.',
        objects: later.encrypt ? [`${later.encrypt.num} ${later.encrypt.gen} R`] : [],
      });
    }
    if (later.info && !sameRef(signedTrailer.Info, later.info)) {
      context.trailerInfo.Info = PDFRef.of(later.info.num, later.info.gen);
      infoChange.push(later.info.num);
      if (!written.has(later.info.num)) {
        written.set(later.info.num, { revision: later.lastRevision, generation: later.info.gen });
      }
    }
  }
  const beforeView = viewOf(before.context, signedTrailer.Root, signedTrailer.Info);
  const afterView = viewOf(context, context.trailerInfo.Root, context.trailerInfo.Info);
  const beforeObjs = beforeView.objects;
  const afterObjs = afterView.objects;

  // Object and xref streams are compared like any object: a stream's /Type is only a claim
  // (a content stream may call itself /ObjStm), and a real one is unreachable, so ignored.
  const changed = new Set<number>(infoChange);
  for (const [num] of written) {
    const now = afterObjs.get(num);
    if (now === undefined) continue;
    const was = beforeObjs.get(num);
    if (was?.toString() === now.toString()) continue;
    changed.add(num);
  }

  const groups = new Map<string, Group>();
  /** `informational` groups hold only unreferenced objects readers ignore. */
  const group = (kind: RevisionChangeKind, revision: number, informational = false) => {
    const key = `${revision}:${kind}`;
    let found = groups.get(key);
    if (!found) {
      found = { kind, revision, pages: new Set(), objects: new Set(), informational };
      groups.set(key, found);
    }
    if (!informational) found.informational = false;
    return found;
  };
  const add = (kind: RevisionChangeKind, num: number, pages: Iterable<number> = []): void => {
    const w = written.get(num);
    const found = group(kind, w?.revision ?? later.lastRevision);
    for (const p of pages) found.pages.add(p);
    found.objects.add(`${num} ${w?.generation ?? 0} R`);
  };
  for (const s of structural) {
    const found = group('other', s.revision, s.informational === true);
    for (const o of s.objects) found.objects.add(o);
  }
  const done = (): LaterChanges => ({
    ...finish(groups),
    notes: structural.map((s) => s.detail),
    lastRevision: later.lastRevision,
  });
  if (changed.size === 0) return done();
  const after = afterView;

  // Page facts (whole file, as a reader resolves it).
  const pages = after.pages;
  const pageOfNum = new Map<number, number>();
  const annotOwner = new Map<number, number>();
  pages.forEach((page, index) => {
    pageOfNum.set(page.num, index);
    for (const n of refNums(page.node.lookup(PDFName.of('Annots')))) {
      if (!annotOwner.has(n)) annotOwner.set(n, index);
    }
  });
  const reach = new Reach(afterObjs, changed);
  const contentPages = new Map<number, Set<number>>();
  pages.forEach((page, index) => {
    const found = reach.fromValue(page.node.get(PDFName.of('Contents')));
    reach.fromValue(inherited(page.node, 'Resources'), found);
    for (const n of found) {
      const set = contentPages.get(n) ?? new Set<number>();
      set.add(index);
      contentPages.set(n, set);
    }
  });
  const acroRef = after.catalog?.get(PDFName.of('AcroForm'));
  const acroNum = acroRef instanceof PDFRef ? acroRef.objectNumber : -1;
  const acroForm = after.catalog?.lookup(PDFName.of('AcroForm'));
  const beforeAcro = beforeView.catalog?.lookup(PDFName.of('AcroForm'));
  const isSigWidget = (num: number): boolean => {
    const d = dictOf(afterObjs.get(num));
    if (!d) return false;
    if (nameOf(d, 'FT') === 'Sig') return true;
    const parent = d.lookup(PDFName.of('Parent'));
    return parent instanceof PDFDict && nameOf(parent, 'FT') === 'Sig';
  };
  const annotKind = (num: number): RevisionChangeKind => {
    const d = dictOf(afterObjs.get(num));
    if (!d) return 'annotations';
    if (nameOf(d, 'Subtype') !== 'Widget') return 'annotations';
    return isSigWidget(num) ? 'signature' : 'form-fill';
  };
  const annotPage = (num: number): number[] => {
    const owner = annotOwner.get(num);
    if (owner !== undefined) return [owner];
    const d = dictOf(afterObjs.get(num));
    const p = d?.get(PDFName.of('P'));
    const index = p instanceof PDFRef ? pageOfNum.get(p.objectNumber) : undefined;
    return index === undefined ? [] : [index];
  };
  // Changed objects reachable from each annotation (appearance streams and their resources).
  const annotReach = new Map<number, number>();
  const allAnnots = new Set<number>([...annotOwner.keys()]);
  for (const n of changed) {
    const d = dictOf(afterObjs.get(n));
    if (d && isAnnotation(d)) allAnnots.add(n);
  }
  for (const a of allAnnots) {
    for (const n of reach.fromRef(a, true)) if (n !== a && !annotReach.has(n)) annotReach.set(n, a);
  }
  const fieldsReach = acroForm ? reach.fromValue(acroForm) : new Set<number>();
  const dssReach = reach.fromValue(after.catalog?.get(PDFName.of('DSS')));
  const infoRef = context.trailerInfo.Info;
  const infoNum = after.infoNum;
  const metadataReach = reach.fromValue(after.catalog?.get(PDFName.of('Metadata')));
  if (infoRef) reach.fromValue(infoRef, metadataReach);
  const catalogNum = after.catalogNum;
  const catalogReach = new Reach(afterObjs, changed);
  const anywhere = catalogReach.fromRef(catalogNum, true);
  // Pages and annotations are barriers to Reach; add everything under them too.
  for (const page of pages) {
    anywhere.add(page.num);
    catalogReach.fromValue(page.node, anywhere);
  }
  for (const a of allAnnots) for (const n of catalogReach.fromRef(a, true)) anywhere.add(n);

  const addedFields = (): number[] => {
    const now =
      acroForm instanceof PDFDict
        ? refNums(acroForm.lookup(PDFName.of('Fields')))
        : new Set<number>();
    const was =
      beforeAcro instanceof PDFDict
        ? refNums(beforeAcro.lookup(PDFName.of('Fields')))
        : new Set<number>();
    return [...now].filter((r) => !was.has(r));
  };
  const acroKind = (): RevisionChangeKind => {
    const was = beforeAcro instanceof PDFDict ? beforeAcro : undefined;
    const now = acroForm instanceof PDFDict ? acroForm : undefined;
    if (!now) return 'form-fill';
    const keys = was ? changedKeys(was, now) : now.keys().map((k) => k.decodeText());
    if (keys.includes('XFA')) return 'other';
    const onlySignature =
      keys.every((k) => k === 'Fields' || k === 'SigFlags') && addedFields().every(isSigWidget);
    return onlySignature ? 'signature' : 'form-fill';
  };

  for (const n of [...changed].sort((a, b) => a - b)) {
    const now = afterObjs.get(n);
    const was = beforeObjs.get(n);
    const dict = dictOf(now);
    const type = dict ? nameOf(dict, 'Type') : undefined;
    // What a page draws first: a content stream or resource that claims another /Type (a
    // signature, an annotation) is still page content.
    const drawnOn = contentPages.get(n);
    if (drawnOn) {
      add('content', n, drawnOn);
      continue;
    }
    if (n === infoNum) {
      add('metadata', n);
      continue;
    }
    if (dict && (type === 'Sig' || type === 'DocTimeStamp')) {
      add('signature', n);
      continue;
    }
    if (dict && isAnnotation(dict)) {
      add(annotKind(n), n, annotPage(n));
      continue;
    }
    if (dict && type === 'Page') {
      const index = pageOfNum.get(n);
      const pagesOf = index === undefined ? [] : [index];
      const wasDict = dictOf(was);
      if (!wasDict) {
        add('pages', n, pagesOf);
        continue;
      }
      const keys = changedKeys(wasDict, dict);
      if (keys.some((k) => k === 'Contents' || k === 'Resources')) add('content', n, pagesOf);
      else if (keys.every((k) => k === 'Annots')) {
        const old = refNums(wasDict.lookup(PDFName.of('Annots')));
        const added = [...refNums(dict.lookup(PDFName.of('Annots')))].filter((r) => !old.has(r));
        add(added.length > 0 && added.every(isSigWidget) ? 'signature' : 'annotations', n, pagesOf);
      } else add('pages', n, pagesOf);
      continue;
    }
    if (dict && type === 'Pages') {
      add('pages', n);
      continue;
    }
    if (n === catalogNum && dict) {
      const wasDict = dictOf(was);
      const keys = wasDict ? changedKeys(wasDict, dict) : ['(new catalog)'];
      const kinds = new Set<RevisionChangeKind>();
      for (const k of keys) {
        if (k === 'DSS') kinds.add('dss');
        else if (k === 'AcroForm') kinds.add(acroKind());
        else if (k === 'Metadata') kinds.add('metadata');
        else kinds.add('other');
      }
      for (const kind of kinds) add(kind, n);
      continue;
    }
    if (n === acroNum) {
      add(acroKind(), n);
      continue;
    }
    const owner = annotReach.get(n);
    if (owner !== undefined) {
      add(annotKind(owner), n, annotPage(owner));
      continue;
    }
    if (dssReach.has(n) || (dict && type === 'DSS')) {
      add('dss', n);
      continue;
    }
    if (fieldsReach.has(n)) {
      const ft = dict ? nameOf(dict, 'FT') : undefined;
      add(ft === 'Sig' ? 'signature' : 'form-fill', n);
      continue;
    }
    if (metadataReach.has(n)) {
      add('metadata', n);
      continue;
    }
    if (anywhere.has(n)) {
      add('other', n);
      continue;
    }
    // Not reachable from the catalog or the trailer: cannot change what a reader shows.
  }
  return done();
}

interface Group {
  readonly kind: RevisionChangeKind;
  readonly revision: number;
  readonly pages: Set<number>;
  readonly objects: Set<string>;
  informational: boolean;
}

function finish(groups: Map<string, Group>): Pick<LaterChanges, 'changes' | 'informational'> {
  const changes: RevisionChange[] = [];
  const informational: RevisionChange[] = [];
  for (const g of [...groups.values()].sort(
    (a, b) => a.revision - b.revision || a.kind.localeCompare(b.kind),
  )) {
    const change: RevisionChange = {
      revision: g.revision,
      kind: g.kind,
      pages: [...g.pages].sort((a, b) => a - b),
      objects: [...g.objects].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
    };
    changes.push(change);
    if (g.informational) informational.push(change);
  }
  return { changes, informational };
}
