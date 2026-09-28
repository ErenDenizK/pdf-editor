/**
 * The invisible text layer (spec §1.2, research 07 §4), written with pdf-lib. Per page:
 *
 * - one Form XObject tagged `/PdfEditorOCR << /Engine /Lang /Version >>`, BBox = MediaBox,
 *   whose content is `/PdfEditorOCR BMC … EMC` around one text object per word: `3 Tr`
 *   (invisible), size = the line's row height, `Tm` on the (rotated) baseline in user space,
 *   `Tz` so the advance equals the word's width, the word as UTF-16BE codes plus a space
 *   (except the page's last word);
 * - the page's `/Contents` becomes `[q, …original streams…, Q q /PdfEditorOCRn Do Q]`: the
 *   original streams and every image are untouched, the added streams carry `/PdfEditorOCR`
 *   in their dictionaries, and the page gets its own copy of its (possibly inherited or
 *   shared) resource dictionaries, never a mutation of a shared one.
 *
 * The font is Tesseract's glyphless `pdf.ttf` as Type0 / CIDFontType2, Identity-H, codes =
 * UTF-16 units, `/CIDToGIDMap` → GID 1, `/DW 500`, identity `ToUnicode`, embedded once.
 * `replace` (`ours`/`all-invisible`) first removes this app's earlier layer from the plan's
 * pages. Deterministic: the same bytes and plan give the same output (replay).
 */
import {
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from '@cantoo/pdf-lib';

import { EngineError, type OcrLayerPlan, type OcrLayerWord } from '../types';
import { glyphlessFontBytes } from './glyphless-font';
import { languageTag } from './geometry';
import { OCR_MARK } from './raw';

const MARK = PDFName.of(OCR_MARK);

export interface OcrLayerWriteResult {
  readonly bytes: Uint8Array;
  readonly pages: { readonly pageIndex: number; readonly words: number }[];
  readonly wordsWritten: number;
  readonly wordsSkipped: number;
  /** Earlier layers of this app removed (Form XObjects). */
  readonly ourLayersRemoved: number;
}

/** A number for a content stream: 3 decimals, no trailing zeros, no `-0`. */
function num(v: number): string {
  if (Math.abs(v) < 5e-4) return '0';
  return v.toFixed(3).replace(/\.?0+$/, '');
}

function utf16Hex(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return hex.toUpperCase();
}

/** Whether a word can be written (text and a positive size and width). */
export function writableWord(w: OcrLayerWord): boolean {
  return (
    w.text.length > 0 &&
    Number.isFinite(w.width) &&
    w.width > 0 &&
    Number.isFinite(w.fontSize) &&
    w.fontSize > 0 &&
    Number.isFinite(w.origin.x) &&
    Number.isFinite(w.origin.y) &&
    Number.isFinite(w.angle)
  );
}

/** The content of a page's layer Form XObject. */
export function layerContent(words: readonly OcrLayerWord[]): string {
  const ops: string[] = [`/${OCR_MARK} BMC`];
  words.forEach((w, i) => {
    const units = w.text.length;
    const tz = (100 * w.width) / (units * 0.5 * w.fontSize);
    const rad = (w.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const shown = i === words.length - 1 ? w.text : `${w.text} `;
    ops.push(
      'BT',
      '3 Tr',
      `/F0 ${num(w.fontSize)} Tf`,
      `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(w.origin.x)} ${num(w.origin.y)} Tm`,
      `${num(tz)} Tz`,
      `<${utf16Hex(shown)}> Tj`,
      'ET',
    );
  });
  ops.push('EMC');
  return `${ops.join('\n')}\n`;
}

/** The glyphless Type0 font of Tesseract's pdfrenderer.cpp (research 07 §4). */
function glyphlessFont(context: PDFContext): PDFRef {
  const ttf = glyphlessFontBytes();
  const fontFile = context.register(context.flateStream(ttf, { Length1: ttf.length }));
  const descriptor = context.register(
    context.obj({
      Type: 'FontDescriptor',
      FontName: 'GlyphLessFont',
      Flags: 5,
      FontBBox: [0, 0, 500, 1000],
      ItalicAngle: 0,
      Ascent: 1000,
      Descent: -1,
      CapHeight: 1000,
      StemV: 80,
      FontFile2: fontFile,
    }),
  );
  const map = new Uint8Array(65536 * 2);
  for (let i = 1; i < map.length; i += 2) map[i] = 1;
  const cidToGid = context.register(context.flateStream(map));
  const cidFont = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'GlyphLessFont',
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0,
      },
      FontDescriptor: descriptor,
      DW: 500,
      CIDToGIDMap: cidToGid,
    }),
  );
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '1 beginbfrange',
    '<0000> <FFFF> <0000>',
    'endbfrange',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const toUnicode = context.register(context.flateStream(cmap));
  return context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'GlyphLessFont',
      Encoding: 'Identity-H',
      DescendantFonts: [cidFont],
      ToUnicode: toUnicode,
    }),
  );
}

/** The value of an inheritable page attribute (Resources, MediaBox). */
function inherited(page: PDFDict, key: string): PDFObject | undefined {
  let node: PDFDict | undefined = page;
  for (let depth = 0; node && depth < 64; depth++) {
    const value = node.get(PDFName.of(key));
    if (value !== undefined) return value;
    const parent: PDFObject | undefined = node.lookup(PDFName.of('Parent'));
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/** A shallow copy of a dictionary (values shared), or an empty one. */
function copyDict(context: PDFContext, dict: PDFDict | undefined): PDFDict {
  const out = context.obj({});
  if (dict) for (const [key, value] of dict.entries()) out.set(key, value);
  return out;
}

function isOurs(context: PDFContext, value: PDFObject | undefined): boolean {
  const stream = value instanceof PDFRef ? context.lookup(value) : value;
  return stream instanceof PDFStream && stream.dict.has(MARK);
}

/** The page's content streams as a list (references or direct streams). */
function contentList(context: PDFContext, page: PDFDict): PDFObject[] {
  const contents = page.get(PDFName.of('Contents'));
  if (contents === undefined) return [];
  const resolved = contents instanceof PDFRef ? context.lookup(contents) : contents;
  if (resolved instanceof PDFArray) return resolved.asArray();
  return [contents];
}

/**
 * Removes this app's layer from a page: our tagged content streams, the tagged Form
 * XObjects they draw (from the page's own copy of its resources), and, for a tagged Form
 * XObject still drawn by other content (PDFium regenerated the page), its content (emptied,
 * so any remaining `Do` draws nothing). Returns the Form XObjects removed or emptied.
 */
function removeOurLayer(context: PDFContext, page: PDFDict): number {
  const resourcesObj = inherited(page, 'Resources');
  const resources =
    resourcesObj === undefined ? undefined : context.lookupMaybe(resourcesObj, PDFDict);
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const tagged = xobjects ? xobjects.entries().filter(([, value]) => isOurs(context, value)) : [];
  const streams = contentList(context, page);
  const kept = streams.filter((s) => !isOurs(context, s));
  if (kept.length !== streams.length) {
    page.set(PDFName.of('Contents'), context.obj(kept));
  }
  if (tagged.length === 0) return 0;
  const nextResources = copyDict(context, resources);
  const nextXObjects = copyDict(context, xobjects);
  for (const [name, value] of tagged) {
    nextXObjects.delete(name);
    // Also empty the form itself, in case anything else still draws it.
    if (value instanceof PDFRef) {
      const form = context.lookup(value, PDFStream);
      const dict = copyDict(context, form.dict);
      dict.delete(PDFName.of('Filter'));
      dict.delete(PDFName.of('DecodeParms'));
      dict.delete(PDFName.of('Resources'));
      dict.set(PDFName.of('Length'), PDFNumber.of(0));
      context.assign(value, PDFRawStream.of(dict, new Uint8Array(0)));
    }
  }
  nextResources.set(PDFName.of('XObject'), nextXObjects);
  page.set(PDFName.of('Resources'), nextResources);
  return tagged.length;
}

function mediaBox(context: PDFContext, page: PDFDict): number[] {
  const value = inherited(page, 'MediaBox');
  const array = value === undefined ? undefined : context.lookupMaybe(value, PDFArray);
  const numbers = array
    ?.asArray()
    .map((v) => context.lookupMaybe(v, PDFNumber)?.asNumber() ?? Number.NaN);
  if (numbers?.length !== 4 || numbers.some((n) => !Number.isFinite(n))) {
    return [0, 0, 612, 792];
  }
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = numbers;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function taggedStream(context: PDFContext, content: string): PDFRef {
  const stream = context.stream(content, {});
  stream.dict.set(MARK, PDFDict.withContext(context));
  return context.register(stream);
}

/** Adds the layer of `plan` to `bytes` (an unencrypted PDF) and saves a full rewrite. */
export async function writeOcrLayer(
  bytes: Uint8Array,
  plan: OcrLayerPlan,
  options: { readonly engine?: string } = {},
): Promise<OcrLayerWriteResult> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = doc.context;
  const pageCount = doc.getPageCount();
  let font: PDFRef | undefined;
  let ourLayersRemoved = 0;
  let wordsWritten = 0;
  let wordsSkipped = 0;
  const pages: { pageIndex: number; words: number }[] = [];
  const seen = new Set<number>();
  for (const planned of plan.pages) {
    const { pageIndex } = planned;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
      throw new EngineError('internal', `OCR layer: page ${pageIndex + 1} does not exist`);
    }
    if (seen.has(pageIndex)) {
      throw new EngineError('internal', `OCR layer: page ${pageIndex + 1} is planned twice`);
    }
    seen.add(pageIndex);
    const page = doc.getPage(pageIndex).node;
    if (plan.replace !== 'none') ourLayersRemoved += removeOurLayer(context, page);
    const words = planned.words.filter(writableWord);
    wordsSkipped += planned.words.length - words.length;
    pages.push({ pageIndex, words: words.length });
    if (words.length === 0) continue;
    font ??= glyphlessFont(context);
    const form = context.flateStream(layerContent(words), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: mediaBox(context, page),
      Resources: { Font: { F0: font } },
    });
    form.dict.set(
      MARK,
      context.obj({
        Engine: PDFString.of(planned.engine ?? options.engine ?? 'tesseract.js'),
        Lang: PDFString.of(planned.languages.join('+')),
        Version: 1,
      }),
    );
    const formRef = context.register(form);
    // The page's own resources: a copy of the (possibly inherited or shared) dictionary.
    const resourcesObj = inherited(page, 'Resources');
    const resources = copyDict(
      context,
      resourcesObj === undefined ? undefined : context.lookupMaybe(resourcesObj, PDFDict),
    );
    const xobjects = copyDict(context, resources.lookupMaybe(PDFName.of('XObject'), PDFDict));
    let n = 0;
    while (xobjects.has(PDFName.of(`${OCR_MARK}${n}`))) n++;
    const name = `${OCR_MARK}${n}`;
    xobjects.set(PDFName.of(name), formRef);
    resources.set(PDFName.of('XObject'), xobjects);
    page.set(PDFName.of('Resources'), resources);
    const original = contentList(context, page);
    page.set(
      PDFName.of('Contents'),
      context.obj(
        original.length === 0
          ? [taggedStream(context, `q /${name} Do Q\n`)]
          : [
              taggedStream(context, 'q\n'),
              ...original,
              taggedStream(context, `\nQ q /${name} Do Q\n`),
            ],
      ),
    );
    wordsWritten += words.length;
  }
  const catalog = doc.catalog;
  const firstLanguage = plan.pages.find((p) => p.languages.length > 0)?.languages[0];
  const lang = plan.lang ?? (firstLanguage === undefined ? undefined : languageTag(firstLanguage));
  if (lang !== undefined && wordsWritten > 0 && !catalog.has(PDFName.of('Lang'))) {
    catalog.set(PDFName.of('Lang'), PDFString.of(lang));
  }
  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes: out, pages, wordsWritten, wordsSkipped, ourLayersRemoved };
}
