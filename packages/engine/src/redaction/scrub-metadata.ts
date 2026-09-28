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
 *   attachment annotations are removed by the annotation step.
 */

import { PDFArray, PDFDict, type PDFDocument } from '@cantoo/pdf-lib';

import { readCustomInfo } from '../pdflib/inspect';
import { writeXmp } from '../pdflib/metadata';
import {
  annotationSubtype,
  catalogNameTree,
  forEachDict,
  isMetadataStream,
  isScriptOrExternalAction,
  NAMES,
  nameTreeEntries,
  pageAnnotations,
  textOf,
} from '../pdflib/metadata-walk';

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
  }

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
      if (isScriptOrExternalAction(doc, dict.get(key))) {
        dict.delete(key);
        result.javascript++;
      }
    }
    const next = context.lookup(dict.get(NAMES.Next));
    if (next instanceof PDFArray) {
      for (let i = next.size() - 1; i >= 0; i--) {
        if (isScriptOrExternalAction(doc, next.get(i))) {
          next.remove(i);
          result.javascript++;
        }
      }
      if (next.size() === 0) dict.delete(NAMES.Next);
    } else if (isScriptOrExternalAction(doc, dict.get(NAMES.Next))) {
      dict.delete(NAMES.Next);
      result.javascript++;
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

  if (hadXmp) {
    writeXmp(doc, readCustomInfo(doc));
    result.xmpRegenerated = true;
  }
  return result;
}
