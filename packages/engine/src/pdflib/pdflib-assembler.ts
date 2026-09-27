/**
 * PdfLibAssembler: VirtualDocument -> PDF bytes with @cantoo/pdf-lib (ARCHITECTURE.md §4,
 * steps 2-4). Pure JS; runs on the main thread (tests) or in the assembly worker.
 *
 * Pipeline: load each source once -> sanitize cross-page references in the (private) source
 * copies -> one `copyPages` call per source -> place pages in virtual order (blank and image
 * pages included) -> rotation and crop -> overlays -> link, outline, page-label, AcroForm,
 * structure-tree and metadata reconciliation -> optional encryption -> save.
 */

import {
  degrees,
  drawImage,
  drawText,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFHeader,
  PDFHexString,
  type PDFImage,
  PDFName,
  PDFNull,
  PDFNumber,
  type PDFObject,
  PDFObjectCopier,
  type PDFOperator,
  PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  StandardFonts,
} from '@cantoo/pdf-lib';
import type {
  Destination,
  FontSpec,
  ImageOverlay,
  OutlineNode,
  PageId,
  PageLabelRange,
  PermissionFlags,
  Rect,
  RgbColor,
  Rotation,
  SecurityPolicy,
  SourceId,
  TextOverlay,
  VirtualDocument,
  VirtualPage,
} from '@pdf-editor/document-model';

import {
  type AssemblyInput,
  type AssemblyOptions,
  type AssemblyResult,
  EngineError,
  type PdfAssembler,
  type ReconciliationReport,
} from '../types';
import {
  anchorOrigin,
  displaySize,
  normalizeRotation,
  placeAt,
  placeOverlay,
  tileOrigins,
} from './overlay-geometry';
import { effectiveRanges, labelForIndex, PDF_LABEL_STYLE } from './page-labels';

const PRODUCER = 'pdf-editor';

/** Private marker written on link annotations between sanitizing and rewriting. */
const LINK_TAG = PDFName.of('PdfEditorLinkTarget');

const N = {
  A: PDFName.of('A'),
  AcroForm: PDFName.of('AcroForm'),
  Annots: PDFName.of('Annots'),
  B: PDFName.of('B'),
  Count: PDFName.of('Count'),
  D: PDFName.of('D'),
  DA: PDFName.of('DA'),
  Dest: PDFName.of('Dest'),
  DR: PDFName.of('DR'),
  Fields: PDFName.of('Fields'),
  First: PDFName.of('First'),
  Font: PDFName.of('Font'),
  IRT: PDFName.of('IRT'),
  Kids: PDFName.of('Kids'),
  Last: PDFName.of('Last'),
  MarkInfo: PDFName.of('MarkInfo'),
  NeedAppearances: PDFName.of('NeedAppearances'),
  Next: PDFName.of('Next'),
  Nums: PDFName.of('Nums'),
  Outlines: PDFName.of('Outlines'),
  P: PDFName.of('P'),
  PageLabels: PDFName.of('PageLabels'),
  Parent: PDFName.of('Parent'),
  Popup: PDFName.of('Popup'),
  Prev: PDFName.of('Prev'),
  S: PDFName.of('S'),
  St: PDFName.of('St'),
  StructParent: PDFName.of('StructParent'),
  StructParents: PDFName.of('StructParents'),
  StructTreeRoot: PDFName.of('StructTreeRoot'),
  Subtype: PDFName.of('Subtype'),
  T: PDFName.of('T'),
  Title: PDFName.of('Title'),
  Type: PDFName.of('Type'),
  URI: PDFName.of('URI'),
  XFA: PDFName.of('XFA'),
};

interface LoadedSource {
  readonly id: SourceId;
  readonly doc: PDFDocument;
  readonly hasStructTree: boolean;
  readonly acroForm: PDFDict | undefined;
  readonly hasXfa: boolean;
  readonly namedLinkDestinations: number;
}

interface PlacedPage {
  readonly page: PDFPage;
  readonly virtual: VirtualPage;
  readonly source?: SourceId;
  /** Visible box (CropBox) in user space, used for overlay placement. */
  readonly box: Rect;
  readonly rotation: Rotation;
}

interface Counters {
  outlineKept: number;
  outlineDropped: number;
  linksRewritten: number;
  linksDropped: number;
}

class Warnings {
  readonly list: string[] = [];
  add(message: string): void {
    if (!this.list.includes(message)) this.list.push(message);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EngineError('aborted', 'assemble aborted', { cause: signal.reason });
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Accepts 0..1 or 0..255 components. */
function toPdfColor(color: RgbColor) {
  const scale = Math.max(color.r, color.g, color.b) > 1 ? 255 : 1;
  const clamp = (v: number) => Math.min(1, Math.max(0, v / scale));
  return rgb(clamp(color.r), clamp(color.g), clamp(color.b));
}

/** Maps a FontSpec to one of the 14 standard fonts. Custom embedding is M3. */
export function standardFontFor(spec: FontSpec): StandardFonts {
  const family = spec.family.toLowerCase();
  const bold = spec.weight === 700;
  const italic = spec.italic === true;
  if (family.includes('courier') || family.includes('mono')) {
    return bold
      ? italic
        ? StandardFonts.CourierBoldOblique
        : StandardFonts.CourierBold
      : italic
        ? StandardFonts.CourierOblique
        : StandardFonts.Courier;
  }
  if ((family.includes('times') || family.includes('serif')) && !family.includes('sans')) {
    return bold
      ? italic
        ? StandardFonts.TimesRomanBoldItalic
        : StandardFonts.TimesRomanBold
      : italic
        ? StandardFonts.TimesRomanItalic
        : StandardFonts.TimesRoman;
  }
  return bold
    ? italic
      ? StandardFonts.HelveticaBoldOblique
      : StandardFonts.HelveticaBold
    : italic
      ? StandardFonts.HelveticaOblique
      : StandardFonts.Helvetica;
}

export function expandTemplate(template: string, tokens: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => tokens[name] ?? match);
}

function permissionsFor(p: PermissionFlags) {
  return {
    printing: p.print
      ? p.printHighQuality
        ? ('highResolution' as const)
        : ('lowResolution' as const)
      : false,
    modifying: p.modify,
    copying: p.copy,
    annotating: p.annotate,
    fillingForms: p.fillForms,
    contentAccessibility: p.accessibility,
    documentAssembly: p.assemble,
  };
}

export class PdfLibAssembler implements PdfAssembler {
  async assemble(input: AssemblyInput, options: AssemblyOptions = {}): Promise<AssemblyResult> {
    const { signal } = options;
    const vdoc = input.document;
    const warnings = new Warnings();
    const counters: Counters = {
      outlineKept: 0,
      outlineDropped: 0,
      linksRewritten: 0,
      linksDropped: 0,
    };
    throwIfAborted(signal);
    if (vdoc.pages.length === 0) {
      throw new EngineError('internal', 'Cannot assemble a document without pages');
    }

    // 1. Which source pages are needed, in first-use order.
    const needed = new Map<SourceId, number[]>();
    for (const vp of vdoc.pages) {
      if (vp.ref.kind !== 'source') continue;
      const list = needed.get(vp.ref.source) ?? [];
      if (!list.includes(vp.ref.index)) list.push(vp.ref.index);
      needed.set(vp.ref.source, list);
    }

    // 2. Load each source once and sanitize cross-page references in our private copy.
    const sources = new Map<SourceId, LoadedSource>();
    for (const [sourceId, indices] of needed) {
      throwIfAborted(signal);
      const bytes = input.sources.get(sourceId);
      if (!bytes) {
        throw new EngineError('internal', `Missing bytes for source ${sourceId}`);
      }
      const doc = await loadSource(sourceId, bytes);
      const pageCount = doc.getPageCount();
      const bad = indices.find((i) => i < 0 || i >= pageCount);
      if (bad !== undefined) {
        throw new EngineError(
          'internal',
          `Source ${sourceId} has no page ${bad} (${pageCount} pages)`,
        );
      }
      sources.set(sourceId, prepareSource(sourceId, doc));
    }

    // 3. Copy pages: one copyPages call per source so shared resources are copied once.
    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = new Map<SourceId, Map<number, PDFPage>>();
    for (const [sourceId, indices] of needed) {
      throwIfAborted(signal);
      const source = sources.get(sourceId) as LoadedSource;
      const pages = await out.copyPages(source.doc, indices);
      copied.set(sourceId, new Map(indices.map((index, i) => [index, pages[i] as PDFPage])));
    }

    // 4. Place pages in virtual order.
    const placed: PlacedPage[] = [];
    const firstOutputIndex = new Map<string, number>();
    const used = new Set<string>();
    const imageCache = new Map<string, PDFImage>();
    const total = vdoc.pages.length;
    for (const vp of vdoc.pages) {
      throwIfAborted(signal);
      const ref = vp.ref;
      if (ref.kind === 'source') {
        const key = `${ref.source}#${ref.index}`;
        const original = copied.get(ref.source)?.get(ref.index) as PDFPage;
        let page = original;
        if (used.has(key)) {
          page = duplicatePage(out, original, warnings);
        }
        used.add(key);
        out.addPage(page);
        if (!firstOutputIndex.has(key)) firstOutputIndex.set(key, placed.length);
        setAnnotationParents(page);
        const rotation = normalizeRotation(page.getRotation().angle + vp.rotation);
        page.setRotation(degrees(rotation));
        if (vp.cropBox) {
          page.setCropBox(vp.cropBox.x, vp.cropBox.y, vp.cropBox.width, vp.cropBox.height);
        }
        placed.push({ page, virtual: vp, source: ref.source, box: page.getCropBox(), rotation });
      } else if (ref.kind === 'blank') {
        const page = out.addPage([ref.size.width, ref.size.height]);
        const rotation = normalizeRotation(vp.rotation);
        page.setRotation(degrees(rotation));
        placed.push({ page, virtual: vp, box: page.getCropBox(), rotation });
      } else {
        const image = await embedImageCached(out, input.blobs, ref.blob, imageCache);
        const page = out.addPage([ref.size.width, ref.size.height]);
        const scale = Math.min(ref.size.width / image.width, ref.size.height / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        page.drawImage(image, {
          x: (ref.size.width - width) / 2,
          y: (ref.size.height - height) / 2,
          width,
          height,
        });
        const rotation = normalizeRotation(vp.rotation);
        page.setRotation(degrees(rotation));
        placed.push({ page, virtual: vp, box: page.getCropBox(), rotation });
      }
      options.onProgress?.(placed.length, total);
    }

    // 5. Links: rewrite destinations to the new page objects, drop links to removed pages.
    rewriteLinks(out, placed, firstOutputIndex, counters);
    for (const source of sources.values()) {
      if (source.namedLinkDestinations > 0) {
        // TODO(M1): resolve named destinations (/Dests, /Names /Dests) and rewrite them.
        warnings.add(
          `${source.namedLinkDestinations} link(s) in source ${source.id} use named destinations, which are not preserved yet`,
        );
      }
    }

    // 6. Overlays.
    const labelRanges = effectiveRanges(vdoc.labels, placed.length);
    const title = vdoc.metadata.title ?? vdoc.title;
    const today = isoDate(new Date());
    const fonts = new Map<StandardFonts, PDFFont>();
    for (const [index, entry] of placed.entries()) {
      if (entry.virtual.overlays.length === 0) continue;
      throwIfAborted(signal);
      await materializeOverlays(out, entry, {
        tokens: {
          page: String(index + 1),
          pages: String(placed.length),
          label: labelForIndex(labelRanges, index),
          title,
          date: today,
          // TODO(M2): {bates} numbering.
        },
        blobs: input.blobs,
        fonts,
        images: imageCache,
        warnings,
      });
    }

    // 7. Document-level reconciliation.
    const pageIndexById = new Map<PageId, number>(placed.map((p, i) => [p.virtual.id, i]));
    writeOutline(out, vdoc.outline, placed, pageIndexById, counters, warnings);
    writePageLabels(out, vdoc.labels, placed.length);
    const forms = reconcileAcroForm(out, placed, sources, vdoc, warnings);
    const structureTreeRemoved = [...sources.values()].some((s) => s.hasStructTree);
    out.catalog.delete(N.StructTreeRoot);
    out.catalog.delete(N.MarkInfo);
    if (structureTreeRemoved) {
      warnings.add('Tagged PDF structure was removed; the output is not tagged');
    }
    applyMetadata(out, vdoc, sources, needed, warnings);

    // 8. Compatibility and security.
    if (options.compatibility) {
      out.context.header = PDFHeader.forVersion(1, 4);
    }
    const security = options.security ?? vdoc.security;
    if (security) {
      if (options.compatibility) {
        warnings.add(
          'AES-256 encryption requires PDF 1.7 extension level 3 or later; the header version was raised',
        );
      }
      await applySecurity(out, security);
    }

    throwIfAborted(signal);
    const bytes = await out.save({
      // Strings are pre-encrypted per object (see encryptStrings); objects inside an
      // encrypted object stream must not be, so encrypted output never uses object streams.
      useObjectStreams: !options.compatibility && !security,
      updateFieldAppearances: false,
      addDefaultPage: false,
    });
    options.onProgress?.(total, total);

    const report: ReconciliationReport = {
      outlineNodesKept: counters.outlineKept,
      outlineNodesDropped: counters.outlineDropped,
      linksRewritten: counters.linksRewritten,
      linksDropped: counters.linksDropped,
      formFieldsRenamed: forms.renamed,
      structureTreeRemoved,
      xfaRemoved: forms.xfaRemoved,
      warnings: warnings.list,
    };
    return { bytes: toArrayBuffer(bytes), report };
  }
}

// ---------------------------------------------------------------------------
// Loading and sanitizing sources
// ---------------------------------------------------------------------------

async function loadSource(sourceId: SourceId, bytes: ArrayBuffer): Promise<PDFDocument> {
  try {
    // preserveXFA: pdf-lib strips /XFA in getForm() otherwise; we detect it ourselves and
    // report `xfaRemoved` truthfully (the rebuilt /AcroForm never carries XFA).
    return await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
      preserveXFA: true,
    });
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new EngineError(
        'unsupported-encryption',
        `Source ${sourceId} is encrypted; decrypt it before assembly`,
        { cause: error },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new EngineError('corrupt', `Source ${sourceId} could not be parsed: ${message}`, {
      cause: error,
    });
  }
}

/**
 * Mutates the private source copy so that `copyPages` does not drag unrelated objects along:
 * - annotation /P (page back-pointers) would copy the referenced page and, through widgets'
 *   parent fields and their other kids, other pages;
 * - link destinations point at source pages; the page ref is replaced by null and the
 *   target index is remembered in LINK_TAG, then rewritten after placement;
 * - /B (article beads) and structure-tree back-pointers are removed (the structure tree is
 *   not carried over).
 */
function prepareSource(id: SourceId, doc: PDFDocument): LoadedSource {
  const { context, catalog } = doc;
  const pages = doc.getPages();
  const pageIndexByRef = new Map<string, number>(pages.map((p, i) => [p.ref.toString(), i]));
  let namedLinkDestinations = 0;
  for (const page of pages) {
    const node = page.node;
    node.delete(N.B);
    node.delete(N.StructParents);
    const annots = context.lookupMaybe(node.get(N.Annots), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict);
      if (!annot) continue;
      annot.delete(N.P);
      annot.delete(N.StructParent);
      if (annot.get(N.Subtype) !== PDFName.of('Link')) continue;
      let destination: PDFObject | undefined = context.lookup(annot.get(N.Dest));
      if (!destination) {
        const action = context.lookupMaybe(annot.get(N.A), PDFDict);
        if (action?.get(N.S) === PDFName.of('GoTo')) {
          destination = context.lookup(action.get(N.D));
        }
      }
      if (destination instanceof PDFArray) {
        const target = destination.get(0);
        const targetIndex =
          target instanceof PDFRef ? pageIndexByRef.get(target.toString()) : undefined;
        if (targetIndex !== undefined) {
          destination.set(0, PDFNull);
          annot.set(LINK_TAG, PDFNumber.of(targetIndex));
        }
      } else if (
        destination instanceof PDFName ||
        destination instanceof PDFString ||
        destination instanceof PDFHexString
      ) {
        namedLinkDestinations++;
      }
    }
  }
  const acroForm = context.lookupMaybe(catalog.get(N.AcroForm), PDFDict);
  return {
    id,
    doc,
    hasStructTree: catalog.get(N.StructTreeRoot) !== undefined,
    acroForm,
    hasXfa: acroForm?.get(N.XFA) !== undefined,
    namedLinkDestinations,
  };
}

/** Points every annotation's /P at its (new) page. */
function setAnnotationParents(page: PDFPage): void {
  const { context } = page.doc;
  const annots = context.lookupMaybe(page.node.get(N.Annots), PDFArray);
  if (!annots) return;
  for (let i = 0; i < annots.size(); i++) {
    context.lookupMaybe(annots.get(i), PDFDict)?.set(N.P, page.ref);
  }
}

/**
 * A second occurrence of the same source page. The copied page dict is cloned so each
 * occurrence has its own dict and contents array (overlays differ per occurrence), while
 * content streams and resources stay shared. Widgets are dropped from the duplicate: a field
 * widget can only live on one page. Other annotations are cloned shallowly.
 */
function duplicatePage(out: PDFDocument, original: PDFPage, warnings: Warnings): PDFPage {
  const { context } = out;
  const leaf = original.node.clone();
  const contents = context.lookup(leaf.get(PDFName.of('Contents')));
  if (contents instanceof PDFArray) {
    leaf.set(PDFName.of('Contents'), contents.clone());
  }
  const annots = context.lookupMaybe(leaf.get(N.Annots), PDFArray);
  if (annots) {
    const cloned = context.obj([]);
    for (let i = 0; i < annots.size(); i++) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict);
      if (!annot) continue;
      if (annot.get(N.Subtype) === PDFName.of('Widget')) {
        warnings.add('Form fields on duplicated pages were kept on the first occurrence only');
        continue;
      }
      const copy = annot.clone();
      copy.delete(N.Popup);
      copy.delete(N.IRT);
      cloned.push(context.register(copy));
    }
    leaf.set(N.Annots, cloned);
  }
  return PDFPage.of(leaf, context.register(leaf), out);
}

async function embedImageCached(
  out: PDFDocument,
  blobs: ReadonlyMap<string, ArrayBuffer>,
  blobId: string,
  cache: Map<string, PDFImage>,
): Promise<PDFImage> {
  const cached = cache.get(blobId);
  if (cached) return cached;
  const buffer = blobs.get(blobId);
  if (!buffer) {
    throw new EngineError('internal', `Missing image blob ${blobId}`);
  }
  const bytes = new Uint8Array(buffer);
  const kind = sniffImage(bytes);
  if (!kind) {
    // TODO(M2): decode other formats (WebP, HEIC, TIFF) to PNG/JPEG upstream.
    throw new EngineError('unsupported', `Image ${blobId} is neither PNG nor JPEG`);
  }
  const image = kind === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  cache.set(blobId, image);
  return image;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function rewriteLinks(
  out: PDFDocument,
  placed: readonly PlacedPage[],
  firstOutputIndex: ReadonlyMap<string, number>,
  counters: Counters,
): void {
  const { context } = out;
  for (const entry of placed) {
    if (!entry.source) continue;
    const annots = context.lookupMaybe(entry.page.node.get(N.Annots), PDFArray);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict);
      const tag = annot?.get(LINK_TAG);
      if (!annot || !(tag instanceof PDFNumber)) continue;
      annot.delete(LINK_TAG);
      const targetIndex = firstOutputIndex.get(`${entry.source}#${tag.asNumber()}`);
      const target = targetIndex === undefined ? undefined : placed[targetIndex];
      let destination = context.lookup(annot.get(N.Dest));
      if (!(destination instanceof PDFArray)) {
        const action = context.lookupMaybe(annot.get(N.A), PDFDict);
        destination = action ? context.lookup(action.get(N.D)) : undefined;
      }
      if (target && destination instanceof PDFArray) {
        destination.set(0, target.page.ref);
        counters.linksRewritten++;
      } else {
        annots.remove(i);
        counters.linksDropped++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

interface OverlayContext {
  readonly tokens: Readonly<Record<string, string>>;
  readonly blobs: ReadonlyMap<string, ArrayBuffer>;
  readonly fonts: Map<StandardFonts, PDFFont>;
  readonly images: Map<string, PDFImage>;
  readonly warnings: Warnings;
}

/** Replaces characters the (WinAnsi) standard font cannot encode with '?'. */
function encodableText(font: PDFFont, text: string, warnings: Warnings): string {
  try {
    font.encodeText(text);
    return text;
  } catch {
    let result = '';
    for (const char of text) {
      try {
        font.encodeText(char);
        result += char;
      } catch {
        result += '?';
      }
    }
    // TODO(M3): embed a bundled Unicode font (subset) instead of the standard 14.
    warnings.add(
      'Some overlay characters are not supported by the standard fonts and were replaced by "?"',
    );
    return result;
  }
}

function graphicsStateFor(out: PDFDocument, page: PDFPage, opacity: number): PDFName | undefined {
  if (opacity >= 1) return undefined;
  const alpha = Math.max(0, opacity);
  return page.node.newExtGState('GS', out.context.obj({ Type: 'ExtGState', ca: alpha, CA: alpha }));
}

async function textOverlayOps(
  out: PDFDocument,
  entry: PlacedPage,
  overlay: TextOverlay,
  ctx: OverlayContext,
): Promise<PDFOperator[]> {
  const standard = standardFontFor(overlay.font);
  let font = ctx.fonts.get(standard);
  if (!font) {
    font = await out.embedFont(standard);
    ctx.fonts.set(standard, font);
  }
  const text = encodableText(font, expandTemplate(overlay.template, ctx.tokens), ctx.warnings);
  if (text.trim() === '') return [];
  const size = overlay.font.size;
  const content = {
    width: font.widthOfTextAtSize(text, size),
    height: font.heightAtSize(size, { descender: false }),
  };
  const placement = placeOverlay({
    box: entry.box,
    rotation: entry.rotation,
    anchor: overlay.anchor,
    offset: overlay.offset,
    content,
    ...(overlay.rotate === undefined ? {} : { rotate: overlay.rotate }),
  });
  const fontKey = entry.page.node.newFontDictionary(font.name, font.ref);
  const graphicsState = graphicsStateFor(out, entry.page, overlay.opacity);
  return drawText(font.encodeText(text), {
    color: toPdfColor(overlay.color),
    font: fontKey,
    size,
    rotate: degrees(placement.angle),
    xSkew: degrees(0),
    ySkew: degrees(0),
    x: placement.x,
    y: placement.y,
    ...(graphicsState ? { graphicsState } : {}),
  });
}

async function imageOverlayOps(
  out: PDFDocument,
  entry: PlacedPage,
  overlay: ImageOverlay,
  ctx: OverlayContext,
): Promise<PDFOperator[]> {
  const image = await embedImageCached(out, ctx.blobs, overlay.blob, ctx.images);
  const content = { width: image.width * overlay.scale, height: image.height * overlay.scale };
  const name = entry.page.node.newXObject('Image', image.ref);
  const graphicsState = graphicsStateFor(out, entry.page, overlay.opacity);
  const rotate = overlay.rotate ?? 0;
  const page = displaySize(entry.box, entry.rotation);
  const anchored = anchorOrigin(overlay.anchor, page, content);
  const first = { x: anchored.x + overlay.offset.x, y: anchored.y + overlay.offset.y };
  const origins = overlay.tile ? tileOrigins(page, content, first, overlay.tile) : [first];
  const ops: PDFOperator[] = [];
  for (const origin of origins) {
    const placement = placeAt(origin, content, entry.box, entry.rotation, rotate);
    ops.push(
      ...drawImage(name, {
        x: placement.x,
        y: placement.y,
        width: content.width,
        height: content.height,
        rotate: degrees(placement.angle),
        xSkew: degrees(0),
        ySkew: degrees(0),
        ...(graphicsState ? { graphicsState } : {}),
      }),
    );
  }
  return ops;
}

/**
 * Draws a page's overlays into two content streams, each wrapped in `q … Q`:
 * - `over` is appended to /Contents;
 * - `behind` is *prepended*. pdf-lib has no public API for that, so we work on the page
 *   dict directly: `normalize()` turns /Contents into an array and wraps the existing
 *   streams in q/Q (so the original content cannot leak a transformed CTM into ours), then
 *   the new stream ref is inserted at index 0 of that array.
 */
async function materializeOverlays(
  out: PDFDocument,
  entry: PlacedPage,
  ctx: OverlayContext,
): Promise<void> {
  const behind: PDFOperator[] = [];
  const over: PDFOperator[] = [];
  for (const overlay of entry.virtual.overlays) {
    const ops =
      overlay.kind === 'text'
        ? await textOverlayOps(out, entry, overlay, ctx)
        : await imageOverlayOps(out, entry, overlay, ctx);
    (overlay.layer === 'behind' ? behind : over).push(...ops);
  }
  const node = entry.page.node;
  node.normalize();
  const wrap = (ops: PDFOperator[]) =>
    out.context.register(
      out.context.contentStream([pushGraphicsState(), ...ops, popGraphicsState()]),
    );
  if (behind.length > 0) {
    const ref = wrap(behind);
    const contents = out.context.lookup(node.get(PDFName.of('Contents')));
    if (contents instanceof PDFArray) {
      contents.insert(0, ref);
    } else {
      node.addContentStream(ref);
    }
  }
  if (over.length > 0) {
    node.addContentStream(wrap(over));
  }
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

interface KeptOutlineNode {
  readonly title: string;
  readonly open: boolean;
  readonly dest?: PDFArray;
  readonly action?: PDFDict;
  readonly children: readonly KeptOutlineNode[];
}

function destinationArray(
  out: PDFDocument,
  destination: Extract<Destination, { kind: 'page' }>,
  page: PDFPage,
): PDFArray {
  const num = (v: number | undefined) => (v === undefined ? PDFNull : PDFNumber.of(v));
  const view = destination.view;
  const items: PDFObject[] = [page.ref];
  switch (view?.fit) {
    case 'fit':
      items.push(PDFName.of('Fit'));
      break;
    case 'fit-h':
      items.push(PDFName.of('FitH'), num(view.top));
      break;
    case 'fit-v':
      items.push(PDFName.of('FitV'), num(view.left));
      break;
    case 'fit-r':
      if (view.rect) {
        const r = view.rect;
        items.push(PDFName.of('FitR'), num(r.x), num(r.y), num(r.x + r.width), num(r.y + r.height));
      } else {
        items.push(PDFName.of('Fit'));
      }
      break;
    default:
      items.push(PDFName.of('XYZ'), num(view?.left), num(view?.top), num(view?.zoom));
  }
  return out.context.obj(items);
}

function filterOutline(
  out: PDFDocument,
  nodes: readonly OutlineNode[],
  placed: readonly PlacedPage[],
  pageIndexById: ReadonlyMap<PageId, number>,
  counters: Counters,
  warnings: Warnings,
): KeptOutlineNode[] {
  const kept: KeptOutlineNode[] = [];
  for (const node of nodes) {
    const children = filterOutline(out, node.children, placed, pageIndexById, counters, warnings);
    const destination = node.destination;
    let dest: PDFArray | undefined;
    let action: PDFDict | undefined;
    let resolved = true;
    if (destination?.kind === 'page') {
      const index = pageIndexById.get(destination.page);
      const target = index === undefined ? undefined : placed[index];
      if (target) dest = destinationArray(out, destination, target.page);
      else resolved = false;
    } else if (destination?.kind === 'uri') {
      action = out.context.obj({ S: 'URI', URI: PDFString.of(destination.uri) });
    } else if (destination?.kind === 'unresolved') {
      resolved = false;
    }
    if (!resolved && children.length === 0) {
      counters.outlineDropped++;
      continue;
    }
    if (!resolved) {
      warnings.add(
        'Outline entries whose target page was removed were kept as headings for their children',
      );
    }
    counters.outlineKept++;
    kept.push({
      title: node.title,
      open: node.open,
      children,
      ...(dest ? { dest } : {}),
      ...(action ? { action } : {}),
    });
  }
  return kept;
}

/** Number of items visible below a list of siblings (ISO 32000-1 §12.3.3 /Count). */
function visibleCount(nodes: readonly KeptOutlineNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + (n.open ? visibleCount(n.children) : 0), 0);
}

function writeOutlineItems(
  out: PDFDocument,
  parent: PDFRef,
  nodes: readonly KeptOutlineNode[],
): { first: PDFRef; last: PDFRef } {
  const { context } = out;
  const refs = nodes.map(() => context.nextRef());
  nodes.forEach((node, i) => {
    const dict = context.obj({});
    dict.set(N.Title, PDFHexString.fromText(node.title));
    dict.set(N.Parent, parent);
    const prev = refs[i - 1];
    const next = refs[i + 1];
    if (prev) dict.set(N.Prev, prev);
    if (next) dict.set(N.Next, next);
    const self = refs[i] as PDFRef;
    if (node.children.length > 0) {
      const sub = writeOutlineItems(out, self, node.children);
      const count = visibleCount(node.children);
      dict.set(N.First, sub.first);
      dict.set(N.Last, sub.last);
      dict.set(N.Count, PDFNumber.of(node.open ? count : -count));
    }
    if (node.dest) dict.set(N.Dest, node.dest);
    if (node.action) dict.set(N.A, node.action);
    context.assign(self, dict);
  });
  return { first: refs[0] as PDFRef, last: refs[refs.length - 1] as PDFRef };
}

function writeOutline(
  out: PDFDocument,
  outline: readonly OutlineNode[],
  placed: readonly PlacedPage[],
  pageIndexById: ReadonlyMap<PageId, number>,
  counters: Counters,
  warnings: Warnings,
): void {
  const kept = filterOutline(out, outline, placed, pageIndexById, counters, warnings);
  if (kept.length === 0) return;
  const rootRef = out.context.nextRef();
  const { first, last } = writeOutlineItems(out, rootRef, kept);
  const root = out.context.obj({ Type: 'Outlines' });
  root.set(N.First, first);
  root.set(N.Last, last);
  root.set(N.Count, PDFNumber.of(visibleCount(kept)));
  out.context.assign(rootRef, root);
  out.catalog.set(N.Outlines, rootRef);
}

// ---------------------------------------------------------------------------
// Page labels
// ---------------------------------------------------------------------------

function writePageLabels(
  out: PDFDocument,
  labels: readonly PageLabelRange[],
  pageCount: number,
): void {
  const ranges = effectiveRanges(labels, pageCount);
  if (ranges.length === 0) return;
  const { context } = out;
  const nums = context.obj([]);
  if ((ranges[0] as PageLabelRange).startIndex > 0) {
    // /PageLabels must cover page 0; uncovered leading pages get plain decimal numbers.
    // TODO(M1): fall back to the source pages' authored labels instead.
    nums.push(PDFNumber.of(0));
    nums.push(context.obj({ S: 'D' }));
  }
  for (const range of ranges) {
    const dict = context.obj({});
    const style = PDF_LABEL_STYLE[range.style];
    if (style) dict.set(N.S, PDFName.of(style));
    if (range.prefix) dict.set(N.P, PDFHexString.fromText(range.prefix));
    if (style && range.firstNumber !== undefined && range.firstNumber !== 1) {
      dict.set(N.St, PDFNumber.of(Math.max(1, Math.floor(range.firstNumber))));
    }
    nums.push(PDFNumber.of(range.startIndex));
    nums.push(dict);
  }
  out.catalog.set(N.PageLabels, context.obj({ Nums: nums }));
}

// ---------------------------------------------------------------------------
// AcroForm
// ---------------------------------------------------------------------------

function fieldName(dict: PDFDict, context: PDFDocument['context']): string | undefined {
  const t = context.lookup(dict.get(N.T));
  return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : undefined;
}

/**
 * Removes widget kids that did not make it into the output (their page was dropped) and
 * returns whether the field still has at least one placed widget.
 */
function pruneField(
  ref: PDFRef,
  context: PDFDocument['context'],
  placedWidgets: ReadonlySet<string>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(ref.toString())) return false;
  seen.add(ref.toString());
  const dict = context.lookupMaybe(ref, PDFDict);
  if (!dict) return false;
  const kids = context.lookupMaybe(dict.get(N.Kids), PDFArray);
  const selfPlaced = placedWidgets.has(ref.toString());
  if (!kids) return selfPlaced;
  let any = false;
  for (let i = kids.size() - 1; i >= 0; i--) {
    const kid = kids.get(i);
    if (kid instanceof PDFRef && pruneField(kid, context, placedWidgets, seen)) {
      any = true;
    } else {
      kids.remove(i);
    }
  }
  return any || selfPlaced;
}

function terminalNames(
  ref: PDFRef,
  context: PDFDocument['context'],
  prefix: string,
  into: string[],
): void {
  const dict = context.lookupMaybe(ref, PDFDict);
  if (!dict) return;
  const own = fieldName(dict, context);
  const name = own === undefined ? prefix : prefix === '' ? own : `${prefix}.${own}`;
  const kids = context.lookupMaybe(dict.get(N.Kids), PDFArray);
  const fieldKids = kids
    ?.asArray()
    .filter(
      (k): k is PDFRef =>
        k instanceof PDFRef && fieldName(context.lookup(k, PDFDict), context) !== undefined,
    );
  if (!fieldKids || fieldKids.length === 0) {
    if (name !== '') into.push(name);
    return;
  }
  for (const kid of fieldKids) terminalNames(kid, context, name, into);
}

/**
 * Rebuilds /AcroForm from the widgets that were placed. When several sources contribute
 * fields and the policy is `namespace-by-source`, each source's root fields are wrapped in
 * a parent field named after the source (id with '.' replaced), so equal names in different
 * sources stay distinct and widgets keep working.
 *
 * Limits (M0): /DR fonts are merged by key (first source wins on collisions); appearance
 * streams are kept as authored (no regeneration); JavaScript that references fields by full
 * name will break after namespacing; XFA is dropped. `rename-collisions` and
 * `unify-same-name` fall back to namespacing — TODO(M1).
 */
function reconcileAcroForm(
  out: PDFDocument,
  placed: readonly PlacedPage[],
  sources: ReadonlyMap<SourceId, LoadedSource>,
  vdoc: VirtualDocument,
  warnings: Warnings,
): { renamed: { from: string; to: string }[]; xfaRemoved: boolean } {
  const { context } = out;
  const xfaRemoved = [...sources.values()].some((s) => s.hasXfa);
  const placedWidgets = new Set<string>();
  const rootsBySource = new Map<SourceId, Map<string, PDFRef>>();
  for (const entry of placed) {
    if (!entry.source) continue;
    const annots = context.lookupMaybe(entry.page.node.get(N.Annots), PDFArray);
    if (!annots) continue;
    for (const item of annots.asArray()) {
      if (!(item instanceof PDFRef)) continue;
      const widget = context.lookupMaybe(item, PDFDict);
      if (widget?.get(N.Subtype) !== PDFName.of('Widget')) continue;
      placedWidgets.add(item.toString());
      let root = item;
      const seen = new Set<string>([item.toString()]);
      for (;;) {
        const parent = context.lookupMaybe(root, PDFDict)?.get(N.Parent);
        if (!(parent instanceof PDFRef) || seen.has(parent.toString())) break;
        seen.add(parent.toString());
        root = parent;
      }
      const roots = rootsBySource.get(entry.source) ?? new Map<string, PDFRef>();
      roots.set(root.toString(), root);
      rootsBySource.set(entry.source, roots);
    }
  }
  if (xfaRemoved) {
    warnings.add('XFA form data was removed; only the AcroForm fields were kept');
  }
  if (rootsBySource.size === 0) return { renamed: [], xfaRemoved };

  // Merge /DA, /DR (fonts by key) and /NeedAppearances from contributing sources.
  const acroForm = context.obj({});
  const drFonts = context.obj({});
  let needAppearances = false;
  for (const sourceId of rootsBySource.keys()) {
    const source = sources.get(sourceId);
    const form = source?.acroForm;
    if (!source || !form) continue;
    const copier = PDFObjectCopier.for(source.doc.context, context);
    const da = form.get(N.DA);
    if (da && !acroForm.get(N.DA)) acroForm.set(N.DA, copier.copy(da));
    const dr = source.doc.context.lookupMaybe(form.get(N.DR), PDFDict);
    const fonts = dr ? source.doc.context.lookupMaybe(dr.get(N.Font), PDFDict) : undefined;
    for (const [key, value] of fonts?.entries() ?? []) {
      if (drFonts.get(key)) {
        warnings.add(
          'Form resource fonts with the same name in several sources were merged (first wins)',
        );
        continue;
      }
      drFonts.set(key, copier.copy(value));
    }
    if (form.get(N.NeedAppearances)?.toString() === 'true') needAppearances = true;
  }
  if (drFonts.keys().length > 0) acroForm.set(N.DR, context.obj({ Font: drFonts }));
  if (needAppearances) acroForm.set(N.NeedAppearances, context.obj(true));

  const fields = context.obj([]);
  const renamed: { from: string; to: string }[] = [];
  const namespace = rootsBySource.size > 1;
  if (namespace && vdoc.formMergePolicy !== 'namespace-by-source') {
    warnings.add(
      `Form merge policy "${vdoc.formMergePolicy}" is not implemented yet; fields were namespaced by source`,
    );
  }
  for (const [sourceId, roots] of rootsBySource) {
    const kept = [...roots.values()].filter((ref) => pruneField(ref, context, placedWidgets));
    if (kept.length === 0) continue;
    if (!namespace) {
      for (const ref of kept) fields.push(ref);
      continue;
    }
    const prefix = String(sourceId).replace(/\./g, '_');
    const parentRef = context.nextRef();
    const parent = context.obj({});
    parent.set(N.T, PDFHexString.fromText(prefix));
    parent.set(N.Kids, context.obj(kept));
    context.assign(parentRef, parent);
    for (const ref of kept) {
      context.lookup(ref, PDFDict).set(N.Parent, parentRef);
      const names: string[] = [];
      terminalNames(ref, context, '', names);
      for (const name of names) renamed.push({ from: name, to: `${prefix}.${name}` });
    }
    fields.push(parentRef);
  }
  acroForm.set(N.Fields, fields);
  out.catalog.set(N.AcroForm, context.register(acroForm));
  return { renamed, xfaRemoved };
}

// ---------------------------------------------------------------------------
// Metadata and security
// ---------------------------------------------------------------------------

function applyMetadata(
  out: PDFDocument,
  vdoc: VirtualDocument,
  sources: ReadonlyMap<SourceId, LoadedSource>,
  needed: ReadonlyMap<SourceId, number[]>,
  warnings: Warnings,
): void {
  const meta = vdoc.metadata;
  const firstSourceId = needed.keys().next().value;
  const first = firstSourceId === undefined ? undefined : sources.get(firstSourceId)?.doc;
  if (meta.policy === 'inherit-first-source' && first) {
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
    // TODO(M1): carry over the XMP metadata stream and /Lang.
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
  out.setModificationDate(modified ?? new Date());
  // TODO(M1): regenerate the trailer /ID (pdf-lib writes one only when encrypting).
}

/**
 * AES-256 (V5/R6) via pdf-lib, plus a string-encryption pass: @cantoo/pdf-lib 2.11.1's
 * writer encrypts stream data only and leaves every string (Info, annotation /Contents,
 * field values, outline titles) in plaintext, violating ISO 32000-2 §7.6.2 — readers then
 * fail or show garbage and the "encrypted" file leaks its text. Same approach as
 * `encryptStrings` in tools/fixtures/generate.ts.
 */
async function applySecurity(out: PDFDocument, security: SecurityPolicy): Promise<void> {
  if (!security.userPassword && !security.ownerPassword) {
    throw new EngineError('unsupported', 'Encryption needs a user or an owner password');
  }
  out.encrypt({
    algorithm: 'AES-256',
    ...(security.userPassword ? { userPassword: security.userPassword } : {}),
    ...(security.ownerPassword ? { ownerPassword: security.ownerPassword } : {}),
    permissions: permissionsFor(security.permissions),
  });
  // Materialize lazily embedded fonts/images first so every string object exists now.
  await out.flush();
  encryptStrings(out);
}

/**
 * Encrypts every string of every indirect object (except /Encrypt itself) with that
 * object's key. Trailer strings (/ID) are direct objects of the trailer and stay clear, as
 * the spec requires. Must run after `encrypt()` and after the last object was created.
 */
export function encryptStrings(doc: PDFDocument): void {
  const { context } = doc;
  const security = context.security;
  if (!security) return;
  const encryptRef = context.trailerInfo.Encrypt;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (encryptRef instanceof PDFRef && ref === encryptRef) continue;
    const encryptFn = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const transform = (value: PDFObject): PDFObject | undefined => {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        return PDFHexString.fromBytes(encryptFn(value.asBytes()));
      }
      if (value instanceof PDFDict) {
        for (const [key, child] of value.entries()) {
          const next = transform(child);
          if (next) value.set(key, next);
        }
      } else if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i++) {
          const next = transform(value.get(i));
          if (next) value.set(i, next);
        }
      } else if (value instanceof PDFStream) {
        transform(value.dict);
      }
      return undefined;
    };
    transform(object);
  }
}
