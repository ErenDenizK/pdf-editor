/**
 * Document metadata at export (spec document-tools.md §3): the Info dictionary, a mirrored
 * XMP packet, embedded files, and "Strip metadata" (`DocumentMetadata.strip`).
 *
 * - Info: the first source's standard and custom keys under `inherit-first-source`, then
 *   the model's fields on top; /Producer is always written. Custom keys are mirrored in XMP
 *   under the `pdfx:` namespace (the convention Acrobat uses for custom Info keys).
 * - XMP: a fresh packet mirroring the final Info and /Lang, never a source's packet, so Info
 *   and XMP cannot disagree (research 04, pitfall 14).
 * - Embedded files: the sources' /Names /EmbeddedFiles entries are carried over (names made
 *   unique) unless stripped. Document-level JavaScript and /OpenAction never are: the output
 *   catalog is built fresh.
 * - Strip: removes what was selected from the assembled output (page and annotation
 *   level: /AA, JavaScript actions, /PieceInfo, /Thumb, /Metadata, /AF, file attachment
 *   annotations, annotation authors and dates), then drops objects no longer reachable so
 *   the removed data is not in the file. /ID is always regenerated.
 */

import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFObjectCopier,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';
import type { MetadataStrip, VirtualDocument } from '@pdf-editor/document-model';

import type { MetadataStripReport } from '../types';
import { infoDict, readCustomInfo, readLanguage } from './inspect';
import {
  annotationSubtype,
  catalogNameTree,
  forEachDict,
  isJavaScriptAction,
  isMetadataStream,
  NAMES,
  nameTreeEntries,
  pageAnnotations,
} from './metadata-walk';

export const PRODUCER = 'pdf-editor';

const PDFX_NS = 'http://ns.adobe.com/pdfx/1.3/';
/** Custom keys mirrored in XMP must be XML names (`customKeyProblem` enforces this). */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface MetadataWarnings {
  add(message: string): void;
}

function stripsAnything(strip: MetadataStrip | undefined): strip is MetadataStrip {
  return strip !== undefined && Object.values(strip).some(Boolean);
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Writes Info, XMP and embedded files, applies "Strip metadata" and regenerates /ID.
 * `sources` are the loaded sources in order of first use (the first one is inherited
 * from). Call after every other part of the output was written and before encryption.
 * Returns the strip report when something was to be stripped.
 */
export async function applyMetadata(
  out: PDFDocument,
  vdoc: VirtualDocument,
  sources: readonly PDFDocument[],
  warnings: MetadataWarnings,
): Promise<MetadataStripReport | undefined> {
  const meta = vdoc.metadata;
  const strip = stripsAnything(meta.strip) ? meta.strip : undefined;
  const first = sources[0];
  const custom: Record<string, string> = {};
  if (meta.policy === 'inherit-first-source' && first) {
    if (!strip?.info) {
      const title = first.getTitle();
      const author = first.getAuthor();
      const subject = first.getSubject();
      const keywords = first.getKeywords();
      const creator = first.getCreator();
      const created = first.getCreationDate();
      if (title) out.setTitle(title);
      if (author) out.setAuthor(author);
      if (subject) out.setSubject(subject);
      if (keywords) out.setKeywords([keywords]);
      if (creator) out.setCreator(creator);
      if (created) out.setCreationDate(created);
    }
    if (!strip?.customKeys) Object.assign(custom, readCustomInfo(first));
    const language = readLanguage(first);
    if (language !== undefined && meta.language === undefined) out.setLanguage(language);
  }
  if (meta.title !== undefined) out.setTitle(meta.title);
  if (meta.author !== undefined) out.setAuthor(meta.author);
  if (meta.subject !== undefined) out.setSubject(meta.subject);
  if (meta.keywords !== undefined) out.setKeywords([meta.keywords]);
  if (meta.creator !== undefined) out.setCreator(meta.creator);
  if (meta.language !== undefined) out.setLanguage(meta.language);
  const created = parseDate(meta.creationDate);
  if (created) out.setCreationDate(created);
  else if (meta.creationDate !== undefined)
    warnings.add(`Ignored invalid creation date "${meta.creationDate}"`);
  out.setProducer(meta.producer ?? PRODUCER);
  const modified = parseDate(meta.modificationDate);
  if (meta.modificationDate !== undefined && !modified) {
    warnings.add(`Ignored invalid modification date "${meta.modificationDate}"`);
  }
  // Stripped Info carries no dates: an export time is metadata too.
  if (modified || !strip?.info) out.setModificationDate(modified ?? new Date());
  Object.assign(custom, meta.custom ?? {});
  const info = infoDict(out);
  for (const [key, value] of Object.entries(custom)) {
    info?.set(PDFName.of(key), PDFHexString.fromText(value));
  }
  // A new document gets a new /ID (both halves equal, ISO 32000-2 §14.4). Encryption
  // replaces it with its own random id later, which is equally fresh.
  const id = PDFHexString.fromBytes(randomBytes(16));
  out.context.trailerInfo.ID = out.context.obj([id, id]);

  if (!strip?.attachments) carryAttachments(out, sources);
  if (!strip?.xmp) writeXmp(out, custom);
  if (!strip) return undefined;
  const report = stripOutput(out, sources, strip);
  // Lazily embedded fonts and images must exist before unreachable objects are dropped.
  await out.flush();
  dropUnreachable(out);
  return report;
}

// ---------------------------------------------------------------------------
// Embedded files
// ---------------------------------------------------------------------------

/** Embedded files of every source, in order; returns how many were carried over. */
function carryAttachments(out: PDFDocument, sources: readonly PDFDocument[]): number {
  const entries: [string, PDFObject][] = [];
  const used = new Set<string>();
  for (const source of sources) {
    const tree = catalogNameTree(source, NAMES.EmbeddedFiles);
    if (!tree) continue;
    const copier = PDFObjectCopier.for(source.context, out.context);
    for (const [name, value] of nameTreeEntries(source, tree)) {
      let key = name;
      for (let n = 2; used.has(key); n++) key = `${name} (${n})`;
      used.add(key);
      entries.push([key, copier.copy(value)]);
    }
  }
  if (entries.length === 0) return 0;
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const { context } = out;
  const pairs = context.obj([]);
  for (const [key, value] of entries) {
    pairs.push(PDFHexString.fromText(key));
    pairs.push(value);
  }
  const names = context.lookupMaybe(out.catalog.get(NAMES.Names), PDFDict) ?? context.obj({});
  names.set(NAMES.EmbeddedFiles, context.register(context.obj({ Names: pairs })));
  if (!out.catalog.has(NAMES.Names)) out.catalog.set(NAMES.Names, context.register(names));
  return entries.length;
}

// ---------------------------------------------------------------------------
// XMP
// ---------------------------------------------------------------------------

/** XML 1.0 text: escaped, with the control characters XML forbids removed. */
export function escapeXml(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out +=
      char === '&'
        ? '&amp;'
        : char === '<'
          ? '&lt;'
          : char === '>'
            ? '&gt;'
            : char === '"'
              ? '&quot;'
              : char;
  }
  return out;
}

/**
 * Writes a fresh XMP packet (ISO 16684-1) mirroring the final Info dictionary, custom keys
 * (`pdfx:`) and /Lang, as an uncompressed /Metadata stream on the catalog.
 */
export function writeXmp(out: PDFDocument, custom: Readonly<Record<string, string>> = {}): void {
  const props: string[] = ['<dc:format>application/pdf</dc:format>'];
  const alt = (tag: string, value: string) =>
    `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt></${tag}>`;
  const simple = (tag: string, value: string) => `<${tag}>${escapeXml(value)}</${tag}>`;
  const title = out.getTitle();
  const author = out.getAuthor();
  const subject = out.getSubject();
  const keywords = out.getKeywords();
  const creator = out.getCreator();
  const producer = out.getProducer();
  const created = out.getCreationDate();
  const modified = out.getModificationDate();
  const language = readLanguage(out);
  if (title) props.push(alt('dc:title', title));
  if (author) {
    props.push(`<dc:creator><rdf:Seq><rdf:li>${escapeXml(author)}</rdf:li></rdf:Seq></dc:creator>`);
  }
  if (subject) props.push(alt('dc:description', subject));
  if (language) {
    props.push(
      `<dc:language><rdf:Bag><rdf:li>${escapeXml(language)}</rdf:li></rdf:Bag></dc:language>`,
    );
  }
  if (keywords) props.push(simple('pdf:Keywords', keywords));
  if (producer) props.push(simple('pdf:Producer', producer));
  if (creator) props.push(simple('xmp:CreatorTool', creator));
  if (created) props.push(simple('xmp:CreateDate', created.toISOString()));
  if (modified) {
    props.push(simple('xmp:ModifyDate', modified.toISOString()));
    props.push(simple('xmp:MetadataDate', modified.toISOString()));
  }
  const customKeys = Object.keys(custom).filter((key) => XML_NAME.test(key));
  for (const key of customKeys) props.push(simple(`pdfx:${key}`, custom[key] ?? ''));
  props.push(simple('xmpMM:DocumentID', `uuid:${crypto.randomUUID()}`));
  props.push(simple('xmpMM:InstanceID', `uuid:${crypto.randomUUID()}`));
  const packet = [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/"',
    ...(customKeys.length > 0 ? [` xmlns:pdfx="${PDFX_NS}"`] : []),
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    ' xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">',
    ...props,
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
  const stream = out.context.stream(new TextEncoder().encode(packet), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  out.catalog.set(NAMES.Metadata, out.context.register(stream));
}

// ---------------------------------------------------------------------------
// Strip
// ---------------------------------------------------------------------------

/** What the sources carried at document level that the fresh output never contains. */
function sourceLevelCounts(sources: readonly PDFDocument[], strip: MetadataStrip) {
  let infoKeys = 0;
  let xmpPackets = 0;
  let attachments = 0;
  let javascript = 0;
  sources.forEach((source, index) => {
    const info = infoDict(source);
    if (index === 0 && info) {
      for (const [key] of info.entries()) {
        const name = key.decodeText();
        if (name === 'Producer') continue;
        const standard = STANDARD_KEYS.has(name);
        if ((standard && strip.info) || (!standard && strip.customKeys)) infoKeys++;
      }
    }
    if (strip.xmp && source.catalog.has(NAMES.Metadata)) xmpPackets++;
    if (strip.attachments) {
      const tree = catalogNameTree(source, NAMES.EmbeddedFiles);
      if (tree) attachments += nameTreeEntries(source, tree).length;
    }
    if (strip.javascript) {
      const js = catalogNameTree(source, NAMES.JavaScript);
      if (js) javascript += nameTreeEntries(source, js).length;
      if (isJavaScriptAction(source, source.catalog.get(NAMES.OpenAction))) javascript++;
      if (source.catalog.has(NAMES.AA)) javascript++;
    }
  });
  return { infoKeys, xmpPackets, attachments, javascript };
}

const STANDARD_KEYS = new Set([
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
]);

/** Keys holding actions that may be JavaScript. */
const ACTION_KEYS = [NAMES.A, NAMES.OpenAction, NAMES.Next];

function stripOutput(
  out: PDFDocument,
  sources: readonly PDFDocument[],
  strip: MetadataStrip,
): MetadataStripReport {
  const counts = sourceLevelCounts(sources, strip);
  let { xmpPackets, attachments, javascript } = counts;
  let pieceInfo = 0;
  let thumbnails = 0;
  let annotationAuthors = 0;
  const { context } = out;

  if (strip.attachments) {
    const removed = new Set<PDFDict>();
    for (const { annots } of pageAnnotations(out)) {
      for (let i = annots.size() - 1; i >= 0; i--) {
        const annot = context.lookupMaybe(annots.get(i), PDFDict);
        if (annot && annotationSubtype(out, annot) === 'FileAttachment') {
          removed.add(annot);
          annots.remove(i);
          attachments++;
        }
      }
    }
    // Their popups go with them.
    for (const { annots } of pageAnnotations(out)) {
      for (let i = annots.size() - 1; i >= 0; i--) {
        const annot = context.lookupMaybe(annots.get(i), PDFDict);
        const parent = annot
          ? context.lookupMaybe(annot.get(PDFName.of('Parent')), PDFDict)
          : undefined;
        if (parent && removed.has(parent)) annots.remove(i);
      }
    }
    const names = context.lookupMaybe(out.catalog.get(NAMES.Names), PDFDict);
    names?.delete(NAMES.EmbeddedFiles);
  }

  forEachDict(out, (entry) => {
    const { dict } = entry;
    if (strip.xmp && dict.has(NAMES.Metadata)) {
      dict.delete(NAMES.Metadata);
      xmpPackets++;
    }
    if (strip.javascript) {
      if (dict.has(NAMES.AA)) {
        dict.delete(NAMES.AA);
        javascript++;
      }
      for (const key of ACTION_KEYS) {
        if (isJavaScriptAction(out, dict.get(key))) {
          dict.delete(key);
          javascript++;
        }
      }
    }
    if (strip.pieceInfo && dict.has(NAMES.PieceInfo)) {
      dict.delete(NAMES.PieceInfo);
      pieceInfo++;
    }
    if (strip.thumbnails && dict.has(NAMES.Thumb)) {
      dict.delete(NAMES.Thumb);
      thumbnails++;
    }
    if (strip.attachments && dict.has(NAMES.AF) && !isMetadataStream(out, entry)) {
      dict.delete(NAMES.AF);
      attachments++;
    }
    if (strip.annotationAuthors) {
      const subtype = annotationSubtype(out, dict);
      // Widget /T is the field name, not an author.
      if (subtype !== undefined && subtype !== 'Widget') {
        let touched = false;
        for (const key of [NAMES.T, NAMES.M, NAMES.CreationDate]) {
          if (dict.has(key)) {
            dict.delete(key);
            touched = true;
          }
        }
        if (touched) annotationAuthors++;
      }
    }
  });
  const names = context.lookupMaybe(out.catalog.get(NAMES.Names), PDFDict);
  if (strip.javascript) names?.delete(NAMES.JavaScript);
  if (names?.entries().length === 0) out.catalog.delete(NAMES.Names);

  return {
    infoKeys: counts.infoKeys,
    xmpPackets,
    attachments,
    javascript,
    pieceInfo,
    thumbnails,
    annotationAuthors,
    applied: { ...strip },
  };
}

/**
 * Deletes indirect objects not reachable from the trailer (/Root, /Info), so data detached
 * by stripping is not written. pdf-lib writes every object of its context.
 */
export function dropUnreachable(doc: PDFDocument): void {
  const { context } = doc;
  const reachable = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const { Root, Info } = context.trailerInfo;
  if (Root) stack.push(Root);
  if (Info) stack.push(Info);
  const seen = new Set<PDFObject>();
  while (stack.length > 0) {
    const value = stack.pop() as PDFObject;
    if (value instanceof PDFRef) {
      if (reachable.has(value)) continue;
      reachable.add(value);
      const target = context.lookup(value);
      if (target) stack.push(target);
      continue;
    }
    if (seen.has(value)) continue;
    if (value instanceof PDFStream) {
      seen.add(value);
      stack.push(value.dict);
    } else if (value instanceof PDFDict) {
      seen.add(value);
      for (const [, child] of value.entries()) stack.push(child);
    } else if (value instanceof PDFArray) {
      seen.add(value);
      for (let i = 0; i < value.size(); i++) stack.push(value.get(i));
    }
  }
  const dead: PDFRef[] = [];
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) dead.push(ref);
  }
  for (const ref of dead) context.delete(ref);
}
