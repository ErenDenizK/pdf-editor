/**
 * Classifies what the incremental revisions after a signed one changed (spec §3.1 step 6,
 * ADR-0013). The objects each later revision writes come from its own xref section (raw
 * object headers when that section cannot be read); each is compared between the signed
 * revision and the whole file (pdf-lib), so unchanged rewrites are ignored, and every real
 * change is attributed by what it is or by what reaches it: page content and resources,
 * annotations (with their appearance streams), form fields, signatures, DSS, metadata, the
 * page tree, or the catalog in other ways. Unreachable objects cannot change what a reader
 * shows and are ignored.
 */
import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';

import type { RevisionChange, RevisionChangeKind } from '../types';
import { latin1 } from './bytes';
import { parseSection, type RevisionEnd } from './xref';

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

/** Object numbers each revision after `signedEnd` writes (latest revision wins). */
async function writtenAfter(
  bytes: Uint8Array,
  signedEnd: number,
  ends: readonly RevisionEnd[],
): Promise<{ written: Map<number, Written>; unreadable: number[] }> {
  const written = new Map<number, Written>();
  const unreadable: number[] = [];
  let previousEnd = signedEnd;
  for (const rev of ends) {
    if (rev.end <= signedEnd) continue;
    const regionStart = previousEnd;
    previousEnd = rev.end;
    const nums: [number, number][] = [];
    let ok = false;
    if (rev.startxref >= regionStart && rev.startxref < rev.end) {
      try {
        const section = await parseSection(bytes, rev.startxref);
        const sections = [section];
        if (section.xrefStm !== undefined)
          sections.push(await parseSection(bytes, section.xrefStm));
        for (const s of sections) {
          for (const e of s.entries) {
            if (e.type === 0 || e.num === s.streamObject) continue;
            nums.push([e.num, e.type === 1 ? e.field3 : 0]);
          }
        }
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      // Raw object headers in the revision's bytes; compressed objects cannot be listed so.
      const text = latin1(bytes, regionStart, rev.end);
      if (/\/Type\s*\/ObjStm/.test(text)) unreadable.push(rev.revision);
      const header = /(?:^|[^\d])(\d+)\s+(\d+)\s+obj\b/g;
      for (let m = header.exec(text); m; m = header.exec(text)) {
        nums.push([Number(m[1]), Number(m[2])]);
      }
    }
    for (const [num, generation] of nums) written.set(num, { revision: rev.revision, generation });
  }
  return { written, unreadable };
}

function objectsByNumber(doc: PDFDocument): Map<number, PDFObject> {
  const map = new Map<number, PDFObject>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) map.set(ref.objectNumber, obj);
  return map;
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
  /** Revisions whose objects could not be listed (compressed and no readable xref). */
  readonly unreadable: readonly number[];
}

/**
 * What the revisions after `signedEnd` changed. `before` is the file cut at `signedEnd`,
 * `after` the whole file, both loaded with pdf-lib the same way.
 */
export async function classifyLaterChanges(
  bytes: Uint8Array,
  signedEnd: number,
  ends: readonly RevisionEnd[],
  before: PDFDocument,
  after: PDFDocument,
): Promise<LaterChanges> {
  const { written, unreadable } = await writtenAfter(bytes, signedEnd, ends);
  const beforeObjs = objectsByNumber(before);
  const afterObjs = objectsByNumber(after);

  const changed = new Set<number>();
  for (const [num] of written) {
    const now = afterObjs.get(num);
    if (now === undefined) continue;
    if (now instanceof PDFRawStream) {
      const type = nameOf(now.dict, 'Type');
      if (type === 'ObjStm' || type === 'XRef') continue;
    }
    const was = beforeObjs.get(num);
    if (was?.toString() === now.toString()) continue;
    changed.add(num);
  }

  const groups = new Map<
    string,
    { kind: RevisionChangeKind; revision: number; pages: Set<number>; objects: Set<string> }
  >();
  const add = (kind: RevisionChangeKind, num: number, pages: Iterable<number> = []): void => {
    const w = written.get(num);
    const revision = w?.revision ?? 0;
    const key = `${revision}:${kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { kind, revision, pages: new Set(), objects: new Set() };
      groups.set(key, group);
    }
    for (const p of pages) group.pages.add(p);
    group.objects.add(`${num} ${w?.generation ?? 0} R`);
  };
  for (const rev of unreadable) {
    const key = `${rev}:other`;
    groups.set(key, { kind: 'other', revision: rev, pages: new Set(), objects: new Set() });
  }
  if (changed.size === 0) return { changes: finish(groups), unreadable };

  // Page facts (whole file).
  const pages = after.getPages();
  const pageOfNum = new Map<number, number>();
  const annotOwner = new Map<number, number>();
  pages.forEach((page, index) => {
    pageOfNum.set(page.ref.objectNumber, index);
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
  const acroRef = after.catalog.get(PDFName.of('AcroForm'));
  const acroNum = acroRef instanceof PDFRef ? acroRef.objectNumber : -1;
  const acroForm = after.catalog.lookup(PDFName.of('AcroForm'));
  const beforeAcro = before.catalog.lookup(PDFName.of('AcroForm'));
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
  const dssReach = reach.fromValue(after.catalog.get(PDFName.of('DSS')));
  const infoRef = after.context.trailerInfo.Info;
  const infoNum = infoRef instanceof PDFRef ? infoRef.objectNumber : -1;
  const metadataReach = reach.fromValue(after.catalog.get(PDFName.of('Metadata')));
  if (infoRef) reach.fromValue(infoRef, metadataReach);
  const catalogNum =
    after.context.trailerInfo.Root instanceof PDFRef
      ? after.context.trailerInfo.Root.objectNumber
      : -1;
  const catalogReach = new Reach(afterObjs, changed);
  const anywhere = catalogReach.fromRef(catalogNum, true);
  // Pages and annotations are barriers to Reach; add everything under them too.
  for (const page of pages) {
    anywhere.add(page.ref.objectNumber);
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
    const onPages = contentPages.get(n);
    if (onPages) {
      add('content', n, onPages);
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
  return { changes: finish(groups), unreadable };
}

function finish(
  groups: Map<
    string,
    { kind: RevisionChangeKind; revision: number; pages: Set<number>; objects: Set<string> }
  >,
): RevisionChange[] {
  return [...groups.values()]
    .sort((a, b) => a.revision - b.revision || a.kind.localeCompare(b.kind))
    .map((g) => ({
      revision: g.revision,
      kind: g.kind,
      pages: [...g.pages].sort((a, b) => a - b),
      objects: [...g.objects].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
    }));
}
