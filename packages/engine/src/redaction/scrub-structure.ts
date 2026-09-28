/**
 * Tagged-PDF repair after redaction (spec redaction §1.4 "prune, do not untag").
 *
 * A marked-content reference (an MCID kid, or an /MCR dictionary) is dangling when its
 * content stream (the page's, or the MCR's /Stm) no longer contains that MCID; an object
 * reference (/OBJR) is dangling when its annotation was removed or is gone. Dangling kids
 * are dropped; their element loses /ActualText and /Alt (which described the removed
 * content); an element left with no kids at all is removed from its parent, recursively.
 * /ParentTree entries pointing to removed MCIDs or elements become null.
 *
 * The pruned tree is then validated: every element is a dictionary with an /S name, no
 * element is reached twice (cycles, shared elements), MCID kids have a page, and the root
 * still has kids. When that fails the whole tree goes (/StructTreeRoot, /StructParents,
 * /StructParent, /MarkInfo /Marked false) and the outcome is "untagged".
 */

import {
  PDFArray,
  type PDFContext,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNull,
  PDFNumber,
  type PDFObject,
  PDFStream,
} from '@cantoo/pdf-lib';

import type { RedactionStructureOutcome } from '../types';
import { decodeStream } from './pdf-util';

const N = {
  ActualText: PDFName.of('ActualText'),
  Alt: PDFName.of('Alt'),
  Contents: PDFName.of('Contents'),
  K: PDFName.of('K'),
  MarkInfo: PDFName.of('MarkInfo'),
  MCID: PDFName.of('MCID'),
  Nums: PDFName.of('Nums'),
  Kids: PDFName.of('Kids'),
  Obj: PDFName.of('Obj'),
  ParentTree: PDFName.of('ParentTree'),
  Pg: PDFName.of('Pg'),
  Properties: PDFName.of('Properties'),
  Resources: PDFName.of('Resources'),
  S: PDFName.of('S'),
  Stm: PDFName.of('Stm'),
  StructParent: PDFName.of('StructParent'),
  StructParents: PDFName.of('StructParents'),
  StructTreeRoot: PDFName.of('StructTreeRoot'),
  Type: PDFName.of('Type'),
};

const MAX_DEPTH = 500;

export interface StructureResult {
  readonly outcome: RedactionStructureOutcome;
  readonly pruned: number;
}

/** MCIDs used in a content stream's data (BDC operands and named property lists). */
function mcidsIn(data: Uint8Array, properties: PDFDict | undefined, context: PDFContext) {
  const ids = new Set<number>();
  const text = new TextDecoder('latin1').decode(data);
  for (const m of text.matchAll(/\/MCID\s+(\d+)/g)) ids.add(Number(m[1]));
  for (const [, value] of properties?.entries() ?? []) {
    const dict = context.lookupMaybe(value, PDFDict);
    const id = context.lookup(dict?.get(N.MCID));
    if (id instanceof PDFNumber) ids.add(id.asNumber());
  }
  return ids;
}

/** Prunes (or removes) the structure tree of `doc` in place. */
export function pruneStructure(
  doc: PDFDocument,
  removedAnnotations: ReadonlySet<PDFDict>,
): StructureResult {
  const { context, catalog } = doc;
  const root = context.lookupMaybe(catalog.get(N.StructTreeRoot), PDFDict);
  if (!root) return { outcome: 'not-tagged', pruned: 0 };

  /** MCIDs per content owner (page dict or stream); `undefined` = could not be read. */
  const cache = new Map<PDFObject, Set<number> | undefined>();
  const mcidsOf = (owner: PDFDict | PDFStream): Set<number> | undefined => {
    if (cache.has(owner)) return cache.get(owner);
    let ids: Set<number> | undefined;
    if (owner instanceof PDFStream) {
      const data = decodeStream(context, owner);
      const res = context.lookupMaybe(owner.dict.get(N.Resources), PDFDict);
      const props = res ? context.lookupMaybe(res.get(N.Properties), PDFDict) : undefined;
      ids = data ? mcidsIn(data, props, context) : undefined;
    } else {
      const contents = context.lookup(owner.get(N.Contents));
      const streams: PDFObject[] = [];
      if (contents instanceof PDFArray)
        for (let i = 0; i < contents.size(); i++) streams.push(contents.get(i));
      else if (contents) streams.push(contents);
      ids = new Set();
      const res = context.lookupMaybe(owner.get(N.Resources), PDFDict);
      const props = res ? context.lookupMaybe(res.get(N.Properties), PDFDict) : undefined;
      for (const s of streams) {
        const stream = context.lookup(s);
        const data = stream instanceof PDFStream ? decodeStream(context, stream) : undefined;
        if (!data) {
          ids = undefined;
          break;
        }
        for (const id of mcidsIn(data, props, context)) ids.add(id);
      }
    }
    cache.set(owner, ids);
    return ids;
  };
  const alive = (mcid: number, page: PDFDict | undefined, stm: PDFObject | undefined) => {
    const stream = context.lookup(stm);
    const owner = stream instanceof PDFStream ? stream : page;
    if (!owner) return false;
    const ids = mcidsOf(owner);
    return ids === undefined || ids.has(mcid);
  };

  let pruned = 0;
  let valid = true;
  const removedElements = new Set<PDFDict>();
  const visited = new Set<PDFDict>();

  /** Prunes an element's kids; returns false when the element should go. */
  const pruneElement = (elem: PDFDict, inheritedPage: PDFDict | undefined, depth: number) => {
    if (depth > MAX_DEPTH || visited.has(elem)) {
      valid = false;
      return true;
    }
    visited.add(elem);
    const page = context.lookupMaybe(elem.get(N.Pg), PDFDict) ?? inheritedPage;
    const raw = context.lookup(elem.get(N.K));
    if (raw === undefined) return true;
    const kids: PDFObject[] = [];
    if (raw instanceof PDFArray) for (let i = 0; i < raw.size(); i++) kids.push(raw.get(i));
    else kids.push(elem.get(N.K) as PDFObject);
    const kept: PDFObject[] = [];
    let lostContent = false;
    for (const kid of kids) {
      const value = context.lookup(kid);
      if (value instanceof PDFNumber) {
        if (!page) valid = false;
        if (alive(value.asNumber(), page, undefined)) kept.push(kid);
        else lostContent = true;
        continue;
      }
      if (!(value instanceof PDFDict)) {
        if (value !== PDFNull) valid = false;
        continue;
      }
      const type = context.lookup(value.get(N.Type));
      const mcid = context.lookup(value.get(N.MCID));
      if (type === PDFName.of('MCR') || (mcid instanceof PDFNumber && !value.has(N.S))) {
        const mcrPage = context.lookupMaybe(value.get(N.Pg), PDFDict) ?? page;
        const ok = mcid instanceof PDFNumber && alive(mcid.asNumber(), mcrPage, value.get(N.Stm));
        if (ok) kept.push(kid);
        else lostContent = true;
      } else if (type === PDFName.of('OBJR')) {
        const target = context.lookupMaybe(value.get(N.Obj), PDFDict);
        if (target && !removedAnnotations.has(target)) kept.push(kid);
        else lostContent = true;
      } else {
        if (!(context.lookup(value.get(N.S)) instanceof PDFName)) valid = false;
        if (pruneElement(value, page, depth + 1)) kept.push(kid);
        else {
          removedElements.add(value);
          lostContent = true;
        }
      }
    }
    if (lostContent) {
      pruned++;
      elem.delete(N.ActualText);
      elem.delete(N.Alt);
    }
    if (kept.length === 0) {
      elem.delete(N.K);
      return !lostContent;
    }
    elem.set(N.K, kept.length === 1 ? (kept[0] as PDFObject) : context.obj(kept));
    return true;
  };

  if (!pruneElement(root, undefined, 0) || !root.has(N.K)) valid = false;
  pruneParentTree(doc, root, removedElements, alive);

  if (!valid) {
    removeStructure(doc);
    return { outcome: 'untagged', pruned };
  }
  return { outcome: pruned > 0 ? 'pruned' : 'intact', pruned };
}

/** Nulls /ParentTree entries of removed MCIDs and removed elements. */
function pruneParentTree(
  doc: PDFDocument,
  root: PDFDict,
  removed: ReadonlySet<PDFDict>,
  alive: (mcid: number, page: PDFDict | undefined, stm: PDFObject | undefined) => boolean,
): void {
  const { context } = doc;
  const pagesByKey = new Map<number, PDFDict>();
  for (const page of doc.getPages()) {
    const key = context.lookup(page.node.get(N.StructParents));
    if (key instanceof PDFNumber) pagesByKey.set(key.asNumber(), page.node);
  }
  const stack: PDFDict[] = [];
  const tree = context.lookupMaybe(root.get(N.ParentTree), PDFDict);
  if (tree) stack.push(tree);
  const seen = new Set<PDFDict>();
  while (stack.length > 0 && seen.size < 10_000) {
    const node = stack.pop() as PDFDict;
    if (seen.has(node)) continue;
    seen.add(node);
    const nums = context.lookupMaybe(node.get(N.Nums), PDFArray);
    for (let i = 0; nums && i + 1 < nums.size(); i += 2) {
      const key = context.lookup(nums.get(i));
      const value = context.lookup(nums.get(i + 1));
      const page = key instanceof PDFNumber ? pagesByKey.get(key.asNumber()) : undefined;
      if (value instanceof PDFArray) {
        for (let m = 0; m < value.size(); m++) {
          const elem = context.lookupMaybe(value.get(m), PDFDict);
          if ((elem && removed.has(elem)) || (page && !alive(m, page, undefined))) {
            value.set(m, PDFNull);
          }
        }
      } else if (value instanceof PDFDict && removed.has(value)) {
        nums.set(i + 1, PDFNull);
      }
    }
    const kids = context.lookupMaybe(node.get(N.Kids), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      const kid = context.lookupMaybe(kids.get(i), PDFDict);
      if (kid) stack.push(kid);
    }
  }
}

/** Removes the structure tree and every reference into it. */
function removeStructure(doc: PDFDocument): void {
  const { context, catalog } = doc;
  catalog.delete(N.StructTreeRoot);
  const markInfo = context.lookupMaybe(catalog.get(N.MarkInfo), PDFDict);
  markInfo?.set(PDFName.of('Marked'), context.obj(false));
  for (const page of doc.getPages()) {
    page.node.delete(N.StructParents);
    const annots = context.lookupMaybe(page.node.get(PDFName.of('Annots')), PDFArray);
    for (let i = 0; annots && i < annots.size(); i++) {
      context.lookupMaybe(annots.get(i), PDFDict)?.delete(N.StructParent);
    }
  }
}
