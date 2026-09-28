/**
 * Scrub steps 4 (metadata) and 5 (attachments) of research 06 §3 step 4, with the
 * predicates of "Strip metadata" (pdflib/metadata-walk.ts):
 *
 * - per-object /Metadata (pages, images, forms), /PieceInfo, page /Thumb, /AA, script and
 *   external actions in /A, /OpenAction and /Next, and the /Names /JavaScript tree go;
 * - the catalog's XMP packet, when there was one, is regenerated from the (already
 *   scrubbed) Info with `writeXmp`, never kept;
 * - attachments: /Names /EmbeddedFiles and every /AF (associated files) entry go, unless
 *   `keepAttachments`, in which case their names are reported as unverified. File
 *   attachment annotations are removed by the annotation step. Files reachable any other
 *   way go too (review finding B1): every /EF entry of a file specification (GoToR links,
 *   portfolios, RichMedia assets, custom keys), GoToE actions and GoToR actions that embed
 *   their target (removed like script actions: the link stays and does nothing), the
 *   catalog's /Collection (portfolio view), and every /Type /EmbeddedFile stream that is
 *   still in the file. With `keepAttachments`, every embedded file stream is reported.
 */

import { PDFArray, PDFDict, type PDFDocument, type PDFObject, PDFRef } from '@cantoo/pdf-lib';

import { readCustomInfo } from '../pdflib/inspect';
import { writeXmp } from '../pdflib/metadata';
import {
  annotationSubtype,
  catalogNameTree,
  forEachDict,
  isEmbeddedFileAction,
  isMetadataStream,
  isScriptOrExternalAction,
  NAMES,
  nameTreeEntries,
  pageAnnotations,
  textOf,
} from '../pdflib/metadata-walk';
import { embeddedFileStreams, otherEmbeddedFiles, reachableRefs, refKey } from './pdf-util';

export interface MetadataScrubResult {
  xmpRegenerated: boolean;
  objectMetadata: number;
  pieceInfo: number;
  thumbnails: number;
  javascript: number;
  attachmentsRemoved: number;
  unverified: string[];
}

/** Runs steps 4 (without the structure tree) and 5 on `doc` in place. */
export function scrubMetadata(doc: PDFDocument, keepAttachments: boolean): MetadataScrubResult {
  const { context, catalog } = doc;
  const result: MetadataScrubResult = {
    xmpRegenerated: false,
    objectMetadata: 0,
    pieceInfo: 0,
    thumbnails: 0,
    javascript: 0,
    attachmentsRemoved: 0,
    unverified: [],
  };
  const hadXmp = catalog.has(NAMES.Metadata);

  if (keepAttachments) {
    const tree = catalogNameTree(doc, NAMES.EmbeddedFiles);
    for (const [name] of tree ? nameTreeEntries(doc, tree) : []) result.unverified.push(name);
    for (const { annots } of pageAnnotations(doc)) {
      for (let i = 0; i < annots.size(); i++) {
        const annot = context.lookupMaybe(annots.get(i), PDFDict);
        if (!annot || annotationSubtype(doc, annot) !== 'FileAttachment') continue;
        const fs = context.lookup(annot.get(NAMES.FS));
        const spec = fs instanceof PDFDict ? fs : undefined;
        const name =
          textOf(context.lookup(spec?.get(NAMES.UF))) ??
          textOf(context.lookup(spec?.get(NAMES.F))) ??
          textOf(fs);
        result.unverified.push(name ?? 'file attachment annotation');
      }
    }
    result.unverified.push(...otherEmbeddedFiles(doc, reachableRefs(context)));
  }

  // Whether an action goes (script or external, or opening an embedded file), counted.
  const drop = (value: PDFObject | undefined): boolean => {
    if (isScriptOrExternalAction(doc, value)) {
      result.javascript++;
      return true;
    }
    if (!keepAttachments && isEmbeddedFileAction(doc, value)) {
      result.attachmentsRemoved++;
      return true;
    }
    return false;
  };

  forEachDict(doc, (entry) => {
    const { dict } = entry;
    if (dict.has(NAMES.Metadata)) {
      dict.delete(NAMES.Metadata);
      if (dict !== catalog) result.objectMetadata++;
    }
    if (dict.has(NAMES.PieceInfo)) {
      dict.delete(NAMES.PieceInfo);
      result.pieceInfo++;
    }
    if (dict.has(NAMES.Thumb)) {
      dict.delete(NAMES.Thumb);
      result.thumbnails++;
    }
    if (dict.has(NAMES.AA)) {
      dict.delete(NAMES.AA);
      result.javascript++;
    }
    for (const key of [NAMES.A, NAMES.OpenAction]) {
      if (drop(dict.get(key))) dict.delete(key);
    }
    const next = context.lookup(dict.get(NAMES.Next));
    if (next instanceof PDFArray) {
      for (let i = next.size() - 1; i >= 0; i--) {
        if (drop(next.get(i))) next.remove(i);
      }
      if (next.size() === 0) dict.delete(NAMES.Next);
    } else if (drop(dict.get(NAMES.Next))) {
      dict.delete(NAMES.Next);
    }
    if (!keepAttachments && dict.has(NAMES.AF) && !isMetadataStream(doc, entry)) {
      dict.delete(NAMES.AF);
      result.attachmentsRemoved++;
    }
  });

  const names = context.lookupMaybe(catalog.get(NAMES.Names), PDFDict);
  const js = catalogNameTree(doc, NAMES.JavaScript);
  if (js) {
    result.javascript += nameTreeEntries(doc, js).length;
    names?.delete(NAMES.JavaScript);
  }
  if (!keepAttachments) {
    const files = catalogNameTree(doc, NAMES.EmbeddedFiles);
    if (files) {
      result.attachmentsRemoved += nameTreeEntries(doc, files).length;
      names?.delete(NAMES.EmbeddedFiles);
    }
  }
  if (names?.entries().length === 0) catalog.delete(NAMES.Names);
  if (!keepAttachments) {
    catalog.delete(NAMES.Collection);
    result.attachmentsRemoved += removeEmbeddedFiles(doc);
  }

  if (hadXmp) {
    writeXmp(doc, readCustomInfo(doc));
    result.xmpRegenerated = true;
  }
  return result;
}

/**
 * Removes every /EF entry and every embedded file stream left after the name tree, /AF and
 * the file attachment annotations went. Counts the files still reachable before (those the
 * other steps did not already count).
 */
function removeEmbeddedFiles(doc: PDFDocument): number {
  const { context } = doc;
  const reachable = reachableRefs(context);
  const counted = new Set<string>();
  forEachDict(doc, ({ dict, owner }) => {
    const ef = context.lookup(dict.get(NAMES.EF));
    if (ef === undefined) return;
    if (reachable.has(refKey(owner)) && ef instanceof PDFDict) {
      for (const [, value] of ef.entries()) {
        if (value instanceof PDFRef && reachable.has(refKey(value))) counted.add(refKey(value));
      }
    }
    dict.delete(NAMES.EF);
  });
  const doomed = new Set<string>();
  for (const { ref } of embeddedFileStreams(doc)) {
    if (reachable.has(refKey(ref))) counted.add(refKey(ref));
    doomed.add(refKey(ref));
    context.delete(ref);
  }
  if (doomed.size > 0) {
    // Keys still naming a removed stream (custom keys) go with it.
    forEachDict(doc, ({ dict }) => {
      for (const [key, value] of dict.entries()) {
        if (value instanceof PDFRef && doomed.has(refKey(value))) dict.delete(key);
      }
    });
  }
  return counted.size;
}
