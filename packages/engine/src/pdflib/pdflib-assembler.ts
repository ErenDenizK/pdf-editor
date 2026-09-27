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
  beginMarkedContent,
  beginText,
  concatTransformationMatrix,
  degrees,
  drawObject,
  EncryptedPDFError,
  endMarkedContent,
  endText,
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
  setFillingColor,
  setFontAndSize,
  setGraphicsState,
  setLineWidth,
  setStrokingColor,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  StandardFonts,
  TextRenderingMode,
} from '@cantoo/pdf-lib';
import type {
  Destination,
  FontSpec,
  OverlayOp,
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
  type AnnotationConformanceReport,
  type AnnotationFinalizeRequest,
  type AssemblyInput,
  type AssemblyOptions,
  type AssemblyResult,
  type EngineCallOptions,
  EngineError,
  type InspectOptions,
  type PdfAssembler,
  type ReconciliationReport,
  type SourceDiagnostics,
  type SourceInspection,
  type SourceInspector,
} from '../types';
import { loadBundledFont } from '../fonts/bundled-fonts';
import {
  type ResolvedFont,
  resolveFont,
  SYNTHETIC_BOLD_STROKE,
  SYNTHETIC_ITALIC_DEGREES,
  substituteFont,
} from '../fonts/font-catalog';
import { displaySize, normalizeRotation, type Placement, placeAt } from './overlay-geometry';
import {
  layoutOverlay,
  type OverlayBox,
  type OverlayTextContext,
  overlayText,
  pageInRange,
} from './overlay-layout';
import { checkAnnotationConformance } from '../annotations/conformance';
import { finalizeAnnotations } from '../annotations/finalize';
import { inspectSource } from './inspect';
import { applyMetadata } from './metadata';
import { diagnoseSource } from './metadata-diagnostics';
import { nameText, namedDestinationResolver } from './named-destinations';
import { effectiveRanges, labelForIndex, PDF_LABEL_STYLE } from './page-labels';

/** Private marker written on link annotations between sanitizing and rewriting. */
const LINK_TAG = PDFName.of('PdfEditorLinkTarget');

const N = {
  A: PDFName.of('A'),
  AcroForm: PDFName.of('AcroForm'),
  Annots: PDFName.of('Annots'),
  B: PDFName.of('B'),
  Count: PDFName.of('Count'),
  CropBox: PDFName.of('CropBox'),
  D: PDFName.of('D'),
  DA: PDFName.of('DA'),
  Dest: PDFName.of('Dest'),
  DR: PDFName.of('DR'),
  Fields: PDFName.of('Fields'),
  First: PDFName.of('First'),
  Font: PDFName.of('Font'),
  IRT: PDFName.of('IRT'),
  NM: PDFName.of('NM'),
  Kids: PDFName.of('Kids'),
  Last: PDFName.of('Last'),
  MarkInfo: PDFName.of('MarkInfo'),
  NeedAppearances: PDFName.of('NeedAppearances'),
  Next: PDFName.of('Next'),
  Nums: PDFName.of('Nums'),
  Outlines: PDFName.of('Outlines'),
  P: PDFName.of('P'),
  PageLabels: PDFName.of('PageLabels'),
  Rotate: PDFName.of('Rotate'),
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
}

/** LINK_TAG value for a link whose destination cannot be resolved: dropped on rewrite. */
const UNRESOLVED_LINK = -1;

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

export class PdfLibAssembler implements PdfAssembler, SourceInspector {
  /** Page labels and /Lang (see inspect.ts). Never rejects for damaged or locked files. */
  inspect(bytes: ArrayBuffer, options: InspectOptions = {}): Promise<SourceInspection> {
    throwIfAborted(options.signal);
    return inspectSource(
      bytes,
      options.password === undefined ? {} : { password: options.password },
    );
  }

  /** Diagnostics and metadata findings (metadata-diagnostics.ts). Never rejects. */
  diagnose(bytes: ArrayBuffer, options: InspectOptions = {}): Promise<SourceDiagnostics> {
    throwIfAborted(options.signal);
    return diagnoseSource(
      bytes,
      options.password === undefined ? {} : { password: options.password },
    );
  } /** One label per page, or undefined when the file has no /PageLabels. */
  async getPageLabels(
    bytes: ArrayBuffer,
    options: InspectOptions = {},
  ): Promise<readonly string[] | undefined> {
    return (await this.inspect(bytes, options)).pageLabels;
  }

  /** The annotation post-pass of `PdfEditor.save()` (annotations/finalize.ts). */
  finalizeAnnotations(
    bytes: ArrayBuffer,
    request: AnnotationFinalizeRequest,
    options: EngineCallOptions = {},
  ): Promise<ArrayBuffer> {
    throwIfAborted(options.signal);
    return finalizeAnnotations(bytes, request);
  }

  /** `checkAnnotationConformance` (annotations/conformance.ts). */
  checkAnnotations(
    bytes: ArrayBuffer,
    options: { readonly ids?: readonly string[]; readonly password?: string } = {},
    callOptions: EngineCallOptions = {},
  ): Promise<AnnotationConformanceReport> {
    throwIfAborted(callOptions.signal);
    return checkAnnotationConformance(bytes, options);
  }

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
    // Each copied page's own /Rotate and /CropBox before placement mutates them: repeated
    // occurrences of a source page start from these, not from the first occurrence's edits.
    const pristine = new Map<PDFPage, PristineBoxes>();
    for (const [sourceId, indices] of needed) {
      throwIfAborted(signal);
      const source = sources.get(sourceId) as LoadedSource;
      const pages = await out.copyPages(source.doc, indices);
      for (const page of pages) pristine.set(page, snapshotBoxes(page));
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
          page = duplicatePage(out, original, pristine.get(original), warnings);
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

    // 5. Links: rewrite destinations (explicit and named, resolved in prepareSource) to the
    // new page objects; drop links to removed pages and to names that do not resolve.
    rewriteLinks(out, placed, firstOutputIndex, counters);

    // 6. Overlays (page furniture), laid out by overlay-layout.ts.
    const labelRanges = effectiveRanges(vdoc.labels, placed.length);
    const overlayContext: OverlayContext = {
      count: placed.length,
      text: {
        label: '',
        title: vdoc.metadata.title ?? vdoc.title,
        date: new Date(),
        ...(vdoc.metadata.language ? { locale: vdoc.metadata.language } : {}),
        ...(vdoc.bates ? { bates: vdoc.bates } : {}),
      },
      blobs: input.blobs,
      fonts: new OverlayFonts(out),
      images: imageCache,
      forms: new Map(),
      warnings,
    };
    for (const [index, entry] of placed.entries()) {
      if (entry.virtual.overlays.length === 0) continue;
      throwIfAborted(signal);
      await materializeOverlays(out, entry, index, {
        ...overlayContext,
        text: { ...overlayContext.text, label: labelForIndex(labelRanges, index) },
      });
    }

    // 7. Document-level reconciliation.
    const pageIndexById = new Map<PageId, number>(placed.map((p, i) => [p.virtual.id, i]));
    writeOutline(out, vdoc.outline, placed, pageIndexById, counters, warnings);
    writePageLabels(out, vdoc.labels, placed.length);
    const forms = reconcileAcroForm(out, placed, sources, vdoc, input.sourceNames, warnings);
    const structureTreeRemoved = [...sources.values()].some((s) => s.hasStructTree);
    out.catalog.delete(N.StructTreeRoot);
    out.catalog.delete(N.MarkInfo);
    if (structureTreeRemoved) {
      warnings.add('Tagged PDF structure was removed; the output is not tagged');
    }
    const metadataStripped = await applyMetadata(
      out,
      vdoc,
      [...needed.keys()].flatMap((id) => {
        const doc = sources.get(id)?.doc;
        return doc ? [doc] : [];
      }),
      warnings,
    );

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
      formFieldsUnified: forms.unified,
      structureTreeRemoved,
      xfaRemoved: forms.xfaRemoved,
      ...(metadataStripped ? { metadataStripped } : {}),
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
 *   target index is remembered in LINK_TAG, then rewritten after placement. Named
 *   destinations are resolved here and replaced by an explicit copy of their array, because
 *   the output carries no name tree; names that do not resolve are tagged for removal;
 * - /B (article beads) and structure-tree back-pointers are removed (the structure tree is
 *   not carried over).
 */
function prepareSource(id: SourceId, doc: PDFDocument): LoadedSource {
  const { context, catalog } = doc;
  const pages = doc.getPages();
  const pageIndexByRef = new Map<string, number>(pages.map((p, i) => [p.ref.toString(), i]));
  const resolveName = namedDestinationResolver(doc);
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
      // Where the destination lives: the annotation's /Dest or its GoTo action's /D.
      let holder: PDFDict | undefined;
      let key = N.Dest;
      let destination: PDFObject | undefined = context.lookup(annot.get(N.Dest));
      if (destination) {
        holder = annot;
      } else {
        const action = context.lookupMaybe(annot.get(N.A), PDFDict);
        if (action?.get(N.S) === PDFName.of('GoTo')) {
          holder = action;
          key = N.D;
          destination = context.lookup(action.get(N.D));
        }
      }
      if (!holder || !destination) continue;
      const name = nameText(destination);
      if (name !== undefined) {
        const resolved = resolveName(name);
        if (!resolved) {
          annot.set(LINK_TAG, PDFNumber.of(UNRESOLVED_LINK));
          continue;
        }
        // An explicit copy the rewrite can point at the new page (views may be shared).
        destination = resolved.clone(context);
        holder.set(key, destination);
      }
      if (destination instanceof PDFArray) {
        const target = destination.get(0);
        const targetIndex =
          target instanceof PDFRef ? pageIndexByRef.get(target.toString()) : undefined;
        if (targetIndex !== undefined) {
          if (name === undefined) {
            // Explicit arrays may be shared between links: give each link its own.
            destination = destination.clone(context);
            holder.set(key, destination);
          }
          (destination as PDFArray).set(0, PDFNull);
          annot.set(LINK_TAG, PDFNumber.of(targetIndex));
        } else if (name !== undefined) {
          annot.set(LINK_TAG, PDFNumber.of(UNRESOLVED_LINK));
        }
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

/** A copied page's own /Rotate and /CropBox (copyPages flattens inherited ones). */
interface PristineBoxes {
  readonly rotate: PDFObject | undefined;
  readonly cropBox: PDFObject | undefined;
}

function snapshotBoxes(page: PDFPage): PristineBoxes {
  const { node } = page;
  return {
    rotate: deepCloneDirect(node.get(N.Rotate)),
    cropBox: deepCloneDirect(node.get(N.CropBox)),
  };
}

/**
 * Copies direct containers (dictionaries and arrays) recursively; indirect references and
 * immutable scalars are shared. Strings are encrypted with their holding object's key (see
 * `encryptStrings`), so a direct object shared by two holders cannot decrypt for both.
 */
function deepCloneDirect<T extends PDFObject | undefined>(value: T): T {
  // `clone()` is shallow and keeps the subclass (a page leaf stays a PDFPageLeaf).
  if (value instanceof PDFDict) {
    const copy = value.clone();
    for (const [key, child] of value.entries()) copy.set(key, deepCloneDirect(child));
    return copy as unknown as T;
  }
  if (value instanceof PDFArray) {
    const copy = value.clone();
    for (let i = 0; i < value.size(); i++) copy.set(i, deepCloneDirect(value.get(i)));
    return copy as unknown as T;
  }
  return value;
}

/**
 * A second occurrence of the same source page. The copied page dict is deep-cloned (direct
 * objects only) so each occurrence has its own dict, contents array and direct resources
 * (overlays differ per occurrence), while content streams and indirect resources stay
 * shared. /Rotate and /CropBox come from the pristine snapshot, not from the first
 * occurrence, which may already be rotated or cropped. Widgets are dropped from the
 * duplicate: a field widget can only live on one page. Other annotations are cloned with
 * their direct objects (actions, borders, colors); popup/parent and reply links are
 * re-pointed at the clones, and /NM gets a `~<object number>` suffix to stay unique.
 */
function duplicatePage(
  out: PDFDocument,
  original: PDFPage,
  pristine: PristineBoxes | undefined,
  warnings: Warnings,
): PDFPage {
  const { context } = out;
  const leaf = deepCloneDirect(original.node);
  const contents = context.lookup(leaf.get(PDFName.of('Contents')));
  if (contents instanceof PDFArray) {
    // Possibly an indirect array: overlays wrap it, so each occurrence needs its own.
    leaf.set(PDFName.of('Contents'), contents.clone());
  }
  if (pristine) {
    for (const [key, value] of [
      [N.Rotate, pristine.rotate],
      [N.CropBox, pristine.cropBox],
    ] as const) {
      if (value === undefined) leaf.delete(key);
      else leaf.set(key, deepCloneDirect(value));
    }
  }
  const annots = context.lookupMaybe(leaf.get(N.Annots), PDFArray);
  if (annots) {
    const cloned = context.obj([]);
    // Popup <-> parent and reply links point at the first occurrence's annotations:
    // re-point them at the copies, and drop links that leave the page.
    const copies = new Map<string, PDFRef>();
    const linked: PDFDict[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const annot = context.lookupMaybe(raw, PDFDict);
      if (!annot) continue;
      if (annot.get(N.Subtype) === PDFName.of('Widget')) {
        warnings.add('Form fields on duplicated pages were kept on the first occurrence only');
        continue;
      }
      const copy = deepCloneDirect(annot);
      const ref = context.register(copy);
      // /NM must stay unique in the document: the copy gets a derived name.
      const nm = context.lookup(copy.get(N.NM));
      if (nm instanceof PDFString || nm instanceof PDFHexString) {
        copy.set(N.NM, PDFString.of(`${nm.decodeText()}~${ref.objectNumber}`));
      }
      if (raw instanceof PDFRef) copies.set(raw.toString(), ref);
      linked.push(copy);
      cloned.push(ref);
    }
    for (const copy of linked) {
      for (const key of [N.Popup, N.Parent, N.IRT]) {
        const target = copy.get(key);
        if (target === undefined) continue;
        const mapped = target instanceof PDFRef ? copies.get(target.toString()) : undefined;
        if (mapped) copy.set(key, mapped);
        else copy.delete(key);
      }
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
      const targetIndex =
        tag.asNumber() === UNRESOLVED_LINK
          ? undefined
          : firstOutputIndex.get(`${entry.source}#${tag.asNumber()}`);
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
//
// Placement comes from overlay-layout.ts, shared with the app's live preview. Each text
// overlay copy is a Form XObject (text at the origin, baseline on y = 0) drawn with a
// `cm` per copy, so a watermark tiled over every page is one stream reused everywhere.
// Page furniture is wrapped in /Artifact marked content (not part of the reading order).

interface OverlayContext {
  readonly count: number;
  readonly text: Omit<OverlayTextContext, 'index' | 'count'>;
  readonly blobs: ReadonlyMap<string, ArrayBuffer>;
  readonly fonts: OverlayFonts;
  readonly images: Map<string, PDFImage>;
  /** Text Form XObjects by content key, reused across pages. */
  readonly forms: Map<string, PDFRef>;
  readonly warnings: Warnings;
}

interface LoadedFont {
  readonly font: PDFFont;
  readonly resolved: ResolvedFont;
  /** Code points the font has glyphs for (bundled fonts only). */
  readonly charset?: ReadonlySet<number>;
}

/** Embeds each font once per output document: standard-14 or bundled (subset) TTF. */
class OverlayFonts {
  private readonly cache = new Map<string, Promise<LoadedFont>>();
  private fontkitRegistered = false;

  constructor(private readonly out: PDFDocument) {}

  get(resolved: ResolvedFont): Promise<LoadedFont> {
    const key =
      resolved.kind === 'bundled'
        ? resolved.face.key
        : standardFontFor({
            family: resolved.family,
            size: 1,
            weight: resolved.bold ? 700 : 400,
            italic: resolved.italic,
          });
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.embed(resolved);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async embed(resolved: ResolvedFont): Promise<LoadedFont> {
    if (resolved.kind === 'standard') {
      const name = standardFontFor({
        family: resolved.family,
        size: 1,
        weight: resolved.bold ? 700 : 400,
        italic: resolved.italic,
      });
      return { font: await this.out.embedFont(name), resolved };
    }
    if (!this.fontkitRegistered) {
      // Loaded on first use: exports without bundled-font furniture never fetch fontkit.
      const { default: fontkit } = await import('@cantoo/fontkit');
      this.out.registerFontkit(fontkit);
      this.fontkitRegistered = true;
    }
    const bytes = await loadBundledFont(resolved.face);
    const font = await this.out.embedFont(bytes, { subset: true });
    return { font, resolved, charset: new Set(font.getCharacterSet()) };
  }
}

/** Whether a standard-14 font (WinAnsi) has every character of `text`. */
function canEncode(font: PDFFont, text: string): boolean {
  const charset = new Set(font.getCharacterSet());
  for (const char of text) {
    if (!charset.has(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * The font a text overlay is set in on this page: its own, or, when a standard-14 font
 * cannot encode the text (non-WinAnsi characters), the closest bundled family.
 */
async function fontForText(
  overlay: TextOverlay,
  text: string,
  ctx: OverlayContext,
): Promise<LoadedFont> {
  const resolved = resolveFont(overlay.font);
  const loaded = await ctx.fonts.get(resolved);
  if (resolved.kind === 'standard' && !canEncode(loaded.font, text)) {
    ctx.warnings.add(
      `Overlay text uses characters the standard ${resolved.family} font cannot encode; a bundled font was embedded instead`,
    );
    return ctx.fonts.get(substituteFont(overlay.font));
  }
  if (loaded.charset) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code > 0x20 && !loaded.charset.has(code)) {
        ctx.warnings.add(
          'Some overlay characters are not covered by the bundled fonts and were left blank',
        );
        break;
      }
    }
  }
  return loaded;
}

function graphicsStateFor(out: PDFDocument, page: PDFPage, opacity: number): PDFName | undefined {
  if (opacity >= 1) return undefined;
  const alpha = Math.max(0, opacity);
  return page.node.newExtGState('GS', out.context.obj({ Type: 'ExtGState', ca: alpha, CA: alpha }));
}

/** A Form XObject drawing `text` with its baseline origin at (0, 0). */
function textForm(
  out: PDFDocument,
  loaded: LoadedFont,
  overlay: TextOverlay,
  text: string,
  width: number,
  ctx: OverlayContext,
): PDFRef {
  const { resolved, font } = loaded;
  const size = overlay.font.size;
  const color = toPdfColor(overlay.color);
  const bold = resolved.kind === 'bundled' && resolved.syntheticBold;
  const italic = resolved.kind === 'bundled' && resolved.syntheticItalic;
  const key = JSON.stringify([font.name, size, overlay.color, bold, italic, text]);
  const cached = ctx.forms.get(key);
  if (cached) return cached;
  const skew = italic ? Math.tan((SYNTHETIC_ITALIC_DEGREES * Math.PI) / 180) : 0;
  const ops: PDFOperator[] = [pushGraphicsState(), setFillingColor(color)];
  if (bold) {
    ops.push(
      setStrokingColor(color),
      setLineWidth(size * SYNTHETIC_BOLD_STROKE),
      setTextRenderingMode(TextRenderingMode.FillAndOutline),
    );
  }
  ops.push(
    beginText(),
    setFontAndSize('F0', size),
    setTextMatrix(1, 0, skew, 1, 0, 0),
    showText(font.encodeText(text)),
    endText(),
    popGraphicsState(),
  );
  const pad = size;
  const form = out.context.formXObject(ops, {
    BBox: [-pad, -pad, width + 2 * pad, 2 * pad],
    Resources: { Font: { F0: font.ref } },
  });
  const ref = out.context.register(form);
  ctx.forms.set(key, ref);
  return ref;
}

/** `q [gs] cm <object> Q` for every box of a laid-out overlay. */
function placeCopies(
  entry: PlacedPage,
  boxes: readonly OverlayBox[],
  draw: (placement: Placement) => PDFOperator[],
  graphicsState: PDFName | undefined,
): PDFOperator[] {
  const ops: PDFOperator[] = [];
  for (const box of boxes) {
    const placement = placeAt(box, box, entry.box, entry.rotation, box.rotate);
    ops.push(pushGraphicsState());
    if (graphicsState) ops.push(setGraphicsState(graphicsState));
    ops.push(...draw(placement), popGraphicsState());
  }
  return ops;
}

function placementMatrix(placement: Placement): PDFOperator {
  const rad = (placement.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return concatTransformationMatrix(cos, sin, -sin, cos, placement.x, placement.y);
}

async function overlayOps(
  out: PDFDocument,
  entry: PlacedPage,
  index: number,
  overlay: OverlayOp,
  ctx: OverlayContext,
): Promise<PDFOperator[]> {
  const input = {
    index,
    count: ctx.count,
    page: displaySize(entry.box, entry.rotation),
    text: ctx.text,
  };
  if (!pageInRange(overlay.pages, index, ctx.count)) return [];
  if (overlay.kind === 'text') {
    const text = overlayText(overlay, { ...ctx.text, index, count: ctx.count });
    if (text.trim() === '') return [];
    const loaded = await fontForText(overlay, text, ctx);
    const size = overlay.font.size;
    const layout = layoutOverlay(overlay, input, {
      textWidth: (t) => loaded.font.widthOfTextAtSize(t, size),
      imageSize: () => undefined,
    });
    if (layout?.kind !== 'text') return [];
    const width = layout.boxes[0]?.width ?? 0;
    const form = textForm(out, loaded, overlay, layout.text, width, ctx);
    const name = entry.page.node.newXObject('Fm', form);
    const graphicsState = graphicsStateFor(out, entry.page, overlay.opacity);
    return placeCopies(
      entry,
      layout.boxes,
      (placement) => [placementMatrix(placement), drawObject(name)],
      graphicsState,
    );
  }
  const image = await embedImageCached(out, ctx.blobs, overlay.blob, ctx.images);
  const layout = layoutOverlay(overlay, input, {
    textWidth: () => 0,
    imageSize: () => ({ width: image.width, height: image.height }),
  });
  if (!layout) return [];
  const name = entry.page.node.newXObject('Image', image.ref);
  const graphicsState = graphicsStateFor(out, entry.page, overlay.opacity);
  return placeCopies(
    entry,
    layout.boxes,
    (placement) => {
      const box = layout.boxes[0] as OverlayBox;
      return [
        placementMatrix(placement),
        concatTransformationMatrix(box.width, 0, 0, box.height, 0, 0),
        drawObject(name),
      ];
    },
    graphicsState,
  );
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
  index: number,
  ctx: OverlayContext,
): Promise<void> {
  const behind: PDFOperator[] = [];
  const over: PDFOperator[] = [];
  for (const overlay of entry.virtual.overlays) {
    const ops = await overlayOps(out, entry, index, overlay, ctx);
    (overlay.layer === 'behind' ? behind : over).push(...ops);
  }
  if (behind.length === 0 && over.length === 0) return;
  const node = entry.page.node;
  node.normalize();
  const wrap = (ops: PDFOperator[]) =>
    out.context.register(
      out.context.contentStream([
        pushGraphicsState(),
        beginMarkedContent('Artifact'),
        ...ops,
        endMarkedContent(),
        popGraphicsState(),
      ]),
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

/**
 * Writes exactly the ranges it is given; no ranges means no /PageLabels. The caller derives
 * ranges that cover every page (`deriveLabelRanges`, which folds in the sources' authored
 * labels) and passes `[]` when `needsPageLabels` is false. A /PageLabels tree must have an
 * entry for page 0 (ISO 32000-2 §12.4.2), so if the first range starts later, the leading
 * pages get plain decimal numbers — which is also what readers show without labels.
 */
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

type PdfContext = PDFDocument['context'];

/** Field-level keys moved to a new parent when a merged field/widget dict is split. */
const FIELD_KEYS = ['FT', 'T', 'TU', 'TM', 'Ff', 'V', 'DV', 'Opt', 'TI', 'I', 'MaxLen', 'RV', 'DS'];
const FF_RADIO = 1 << 15;
const FF_PUSHBUTTON = 1 << 16;

/** Where a field sits: the /Fields list (root) or a parent field's /Kids. */
interface FieldContainer {
  readonly parent: PDFRef | undefined;
  refs(): PDFRef[];
  add(ref: PDFRef): void;
  replace(old: PDFRef, next: PDFRef): void;
}

function rootContainer(list: PDFRef[]): FieldContainer {
  return {
    parent: undefined,
    refs: () => [...list],
    add: (ref) => list.push(ref),
    replace: (old, next) => {
      const i = list.indexOf(old);
      if (i >= 0) list[i] = next;
    },
  };
}

function kidsContainer(context: PdfContext, parent: PDFRef): FieldContainer {
  const kids = (): PDFArray => {
    const dict = context.lookup(parent, PDFDict);
    let array = context.lookupMaybe(dict.get(N.Kids), PDFArray);
    if (!array) {
      array = context.obj([]);
      dict.set(N.Kids, array);
    }
    return array;
  };
  return {
    parent,
    refs: () =>
      kids()
        .asArray()
        .filter((k): k is PDFRef => k instanceof PDFRef),
    add: (ref) => kids().push(ref),
    replace: (old, next) => {
      const array = kids();
      for (let i = 0; i < array.size(); i++) {
        if (array.get(i) === old) array.set(i, next);
      }
    },
  };
}

/** Kids that are fields (carry /T); the others are widgets. */
function fieldKids(context: PdfContext, dict: PDFDict): PDFRef[] {
  const kids = context.lookupMaybe(dict.get(N.Kids), PDFArray);
  return (kids?.asArray() ?? []).filter(
    (k): k is PDFRef =>
      k instanceof PDFRef && fieldName(context.lookup(k, PDFDict), context) !== undefined,
  );
}

function fieldFlags(context: PdfContext, dict: PDFDict): number {
  const ff = context.lookup(dict.get(PDFName.of('Ff')));
  return ff instanceof PDFNumber ? ff.asNumber() : 0;
}

/** Same kind of terminal field: /FT and, for buttons, radio/push-button flags agree. */
function compatibleTerminals(context: PdfContext, a: PDFDict, b: PDFDict): boolean {
  const ftA = context.lookup(a.get(PDFName.of('FT')));
  const ftB = context.lookup(b.get(PDFName.of('FT')));
  if (!(ftA instanceof PDFName) || ftA !== ftB) return false;
  const mask = FF_RADIO | FF_PUSHBUTTON;
  return (fieldFlags(context, a) & mask) === (fieldFlags(context, b) & mask);
}

/** Smallest `${base}_${n}` (n >= 2) not in `taken`. */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** A partial field name may not contain a period (ISO 32000-2 §12.7.4.2). */
function partialName(label: string, fallback: string): string {
  const cleaned = label.replace(/\./g, '_').trim();
  return cleaned === '' ? fallback.replace(/\./g, '_') : cleaned;
}

interface FormMerge {
  readonly context: PdfContext;
  readonly renamed: { from: string; to: string }[];
  readonly unified: Set<string>;
  readonly warnings: Warnings;
  /** Output widgets whose appearance no longer matches the field value. */
  needAppearances: boolean;
}

/** Renames field `ref` (child of `parentPath`) to `name`; records every terminal rename. */
function renameField(merge: FormMerge, ref: PDFRef, parentPath: string, name: string): void {
  const { context } = merge;
  const dict = context.lookup(ref, PDFDict);
  const before: string[] = [];
  terminalNames(ref, context, parentPath, before);
  dict.set(N.T, PDFHexString.fromText(name));
  const after: string[] = [];
  terminalNames(ref, context, parentPath, after);
  before.forEach((from, i) => merge.renamed.push({ from, to: after[i] ?? from }));
}

/** Adds `ref` to `container`, renaming it first when its name is taken there. */
function addFieldTo(
  merge: FormMerge,
  container: FieldContainer,
  ref: PDFRef,
  parentPath: string,
): void {
  const { context } = merge;
  const dict = context.lookup(ref, PDFDict);
  const taken = new Set(
    container.refs().flatMap((r) => fieldName(context.lookup(r, PDFDict), context) ?? []),
  );
  const own = fieldName(dict, context);
  if (own !== undefined && taken.has(own)) {
    renameField(merge, ref, parentPath, uniqueName(own, taken));
  }
  if (container.parent) dict.set(N.Parent, container.parent);
  else dict.delete(N.Parent);
  container.add(ref);
}

/**
 * Turns a merged field/widget dictionary into a field parent with the widget as its only
 * kid, so more widgets can join it. The widget keeps its ref (pages point at it); the new
 * field takes the old place in `container`. Returns the field's ref.
 */
function splitMergedField(context: PdfContext, ref: PDFRef, container: FieldContainer): PDFRef {
  const widget = context.lookup(ref, PDFDict);
  if (widget.get(N.Kids) || widget.get(N.Subtype) !== PDFName.of('Widget')) return ref;
  const field = context.obj({});
  for (const key of FIELD_KEYS) {
    const value = widget.get(PDFName.of(key));
    if (value === undefined) continue;
    field.set(PDFName.of(key), value);
    widget.delete(PDFName.of(key));
  }
  for (const key of [N.DA, PDFName.of('Q')]) {
    const value = widget.get(key);
    if (value !== undefined) field.set(key, value);
  }
  const parent = widget.get(N.Parent);
  if (parent) field.set(N.Parent, parent);
  const fieldRef = context.register(field);
  field.set(N.Kids, context.obj([ref]));
  widget.set(N.Parent, fieldRef);
  container.replace(ref, fieldRef);
  return fieldRef;
}

/** Widgets of a terminal field (itself when merged). */
function widgetsOf(context: PdfContext, ref: PDFRef): PDFRef[] {
  const dict = context.lookup(ref, PDFDict);
  const kids = context.lookupMaybe(dict.get(N.Kids), PDFArray);
  if (!kids) return [ref];
  return kids.asArray().filter((k): k is PDFRef => k instanceof PDFRef);
}

/**
 * Acrobat semantics for equal full names: one field, several widgets, one value (the first
 * source's). `other`'s widgets join `target`; their appearance is made consistent with the
 * shared value (buttons: /AS; text and choice: /AP removed, /NeedAppearances set).
 */
function unifyTerminal(
  merge: FormMerge,
  container: FieldContainer,
  target: PDFRef,
  other: PDFRef,
  path: string,
): void {
  const { context } = merge;
  const fieldRef = splitMergedField(context, target, container);
  const field = context.lookup(fieldRef, PDFDict);
  const otherDict = context.lookup(other, PDFDict);
  const isButton = context.lookup(field.get(PDFName.of('FT'))) === PDFName.of('Btn');
  const value = context.lookup(field.get(PDFName.of('V')));
  const targetOpt = context.lookupMaybe(field.get(PDFName.of('Opt')), PDFArray);
  const otherOpt = context.lookupMaybe(otherDict.get(PDFName.of('Opt')), PDFArray);
  const kids = context.lookup(field.get(N.Kids), PDFArray);
  for (const widgetRef of widgetsOf(context, other)) {
    const widget = context.lookup(widgetRef, PDFDict);
    if (widgetRef === other) {
      for (const key of FIELD_KEYS) widget.delete(PDFName.of(key));
    }
    widget.set(N.Parent, fieldRef);
    kids.push(widgetRef);
    if (isButton) {
      const normal = context.lookupMaybe(
        context.lookupMaybe(widget.get(PDFName.of('AP')), PDFDict)?.get(PDFName.of('N')),
        PDFDict,
      );
      const on = value instanceof PDFName && normal?.get(value) !== undefined;
      widget.set(PDFName.of('AS'), on ? value : PDFName.of('Off'));
    } else {
      widget.delete(PDFName.of('AP'));
      merge.needAppearances = true;
    }
  }
  // Button /Opt has one entry per widget kid, in order.
  if (targetOpt && otherOpt) {
    for (let i = 0; i < otherOpt.size(); i++) targetOpt.push(otherOpt.get(i));
  }
  merge.unified.add(path);
}

/** Merges field tree `other` into `target` (same full name `path`) under `unify-same-name`. */
function mergeSameName(
  merge: FormMerge,
  container: FieldContainer,
  target: PDFRef,
  other: PDFRef,
  path: string,
  parentPath: string,
): void {
  const { context } = merge;
  const targetDict = context.lookup(target, PDFDict);
  const otherDict = context.lookup(other, PDFDict);
  const targetKids = fieldKids(context, targetDict);
  const otherKids = fieldKids(context, otherDict);
  if (targetKids.length === 0 && otherKids.length === 0) {
    if (compatibleTerminals(context, targetDict, otherDict)) {
      unifyTerminal(merge, container, target, other, path);
      return;
    }
  } else if (targetKids.length > 0 && otherKids.length > 0) {
    const inner = kidsContainer(context, target);
    for (const kid of otherKids) {
      const name = fieldName(context.lookup(kid, PDFDict), context) as string;
      const match = inner
        .refs()
        .find((r) => fieldName(context.lookup(r, PDFDict), context) === name);
      if (match) mergeSameName(merge, inner, match, kid, `${path}.${name}`, path);
      else addFieldTo(merge, inner, kid, path);
    }
    return;
  }
  merge.warnings.add(
    'Some fields with equal names differ in type and were renamed instead of joined',
  );
  addFieldTo(merge, container, other, parentPath);
}

/**
 * Rebuilds /AcroForm from the widgets that were placed. Policy when several sources
 * contribute fields (`VirtualDocument.formMergePolicy`, research 04 §1 item 4):
 * - `namespace-by-source`: each source's root fields are wrapped in a parent field named
 *   after the source (its name from `sourceNames`, else its id; periods replaced), so every
 *   name stays distinct and widgets keep working;
 * - `rename-collisions`: fields keep their names; a root field whose name an earlier source
 *   already uses is renamed `name_2` (`name_3`, …);
 * - `unify-same-name`: Acrobat semantics — fields with equal full names and compatible types
 *   become one field with the first source's value; others fall back to renaming.
 * Every rename is reported in `formFieldsRenamed`, every join in `formFieldsUnified`.
 *
 * Limits: /DR fonts are merged by key (first source wins on collisions); appearance
 * streams are kept as authored, except that joined text/choice widgets lose theirs and
 * /NeedAppearances is set (TODO(M2): regenerate appearances instead); JavaScript that
 * references fields by full name breaks after renaming; XFA is dropped.
 */
function reconcileAcroForm(
  out: PDFDocument,
  placed: readonly PlacedPage[],
  sources: ReadonlyMap<SourceId, LoadedSource>,
  vdoc: VirtualDocument,
  sourceNames: ReadonlyMap<SourceId, string> | undefined,
  warnings: Warnings,
): { renamed: { from: string; to: string }[]; unified: string[]; xfaRemoved: boolean } {
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
  if (rootsBySource.size === 0) return { renamed: [], unified: [], xfaRemoved };

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

  const merge: FormMerge = {
    context,
    renamed: [],
    unified: new Set(),
    warnings,
    needAppearances,
  };
  const kept = new Map<SourceId, PDFRef[]>();
  for (const [sourceId, roots] of rootsBySource) {
    const refs = [...roots.values()].filter((ref) => pruneField(ref, context, placedWidgets));
    if (refs.length > 0) kept.set(sourceId, refs);
  }
  const fields: PDFRef[] = [];
  const policy = kept.size > 1 ? vdoc.formMergePolicy : undefined;
  if (policy === undefined) {
    for (const refs of kept.values()) fields.push(...refs);
  } else if (policy === 'namespace-by-source') {
    const prefixes = new Set<string>();
    for (const [sourceId, refs] of kept) {
      let prefix = partialName(sourceNames?.get(sourceId) ?? '', String(sourceId));
      if (prefixes.has(prefix)) prefix = uniqueName(prefix, prefixes);
      prefixes.add(prefix);
      const parentRef = context.nextRef();
      const parent = context.obj({});
      parent.set(N.T, PDFHexString.fromText(prefix));
      parent.set(N.Kids, context.obj(refs));
      context.assign(parentRef, parent);
      for (const ref of refs) {
        context.lookup(ref, PDFDict).set(N.Parent, parentRef);
        const names: string[] = [];
        terminalNames(ref, context, '', names);
        for (const name of names) merge.renamed.push({ from: name, to: `${prefix}.${name}` });
      }
      fields.push(parentRef);
    }
  } else {
    const root = rootContainer(fields);
    for (const refs of kept.values()) {
      for (const ref of refs) {
        const name = fieldName(context.lookup(ref, PDFDict), context);
        const existing =
          name === undefined
            ? undefined
            : root.refs().find((r) => fieldName(context.lookup(r, PDFDict), context) === name);
        if (existing && policy === 'unify-same-name') {
          mergeSameName(merge, root, existing, ref, name as string, '');
        } else {
          addFieldTo(merge, root, ref, '');
        }
      }
    }
    if (merge.unified.size > 0) {
      warnings.add('Fields with equal names were joined and now share the first file’s value');
    }
  }
  if (merge.needAppearances) acroForm.set(N.NeedAppearances, context.obj(true));
  acroForm.set(N.Fields, context.obj(fields));
  out.catalog.set(N.AcroForm, context.register(acroForm));
  return { renamed: merge.renamed, unified: [...merge.unified], xfaRemoved };
}

// ---------------------------------------------------------------------------
// Metadata and security
// ---------------------------------------------------------------------------

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
  // Without an owner password pdf-lib reuses the user password as the owner password, so
  // whoever can open the file could lift the restrictions: a random one keeps them.
  // An empty owner password counts as none.
  const ownerPassword =
    security.ownerPassword === undefined || security.ownerPassword === ''
      ? randomOwnerPassword()
      : security.ownerPassword;
  out.encrypt({
    algorithm: 'AES-256',
    ...(security.userPassword ? { userPassword: security.userPassword } : {}),
    ownerPassword,
    permissions: permissionsFor(security.permissions),
  });
  // Materialize lazily embedded fonts/images first so every string object exists now.
  await out.flush();
  encryptStrings(out);
}

/** 32 random bytes as hex: an owner password nobody knows. */
function randomOwnerPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
} /**
 * Encrypts every string of every indirect object (except /Encrypt itself) with that
 * object's key, visiting each container once. Trailer strings (/ID) are direct objects of
 * the trailer and stay clear, as the spec requires. Must run after `encrypt()` and after
 * the last object was created.
 */
export function encryptStrings(doc: PDFDocument): void {
  const { context } = doc;
  const security = context.security;
  if (!security) return;
  const encryptRef = context.trailerInfo.Encrypt;
  // A direct container reachable from two indirect objects (a bug elsewhere, but cheap to
  // guard) must not be encrypted twice: the second pass would turn it into garbage.
  const visited = new Set<PDFDict | PDFArray>();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (encryptRef instanceof PDFRef && ref === encryptRef) continue;
    const encryptFn = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const transform = (value: PDFObject): PDFObject | undefined => {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        return PDFHexString.fromBytes(encryptFn(value.asBytes()));
      }
      if (value instanceof PDFDict || value instanceof PDFArray) {
        if (visited.has(value)) return undefined;
        visited.add(value);
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
