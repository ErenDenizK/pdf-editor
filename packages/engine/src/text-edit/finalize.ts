/**
 * Export hygiene for sources with text edits (spec §2.5, research 05 §3 caveats), a pdf-lib
 * pass over the bytes `PdfEditor.save()` wrote:
 *
 * 1. Fonts: PDFium names a font loaded from a fontkit subset `/Untitled` (the subset has no
 *    `name` table). Each such Type0 font, its CIDFont and descriptor are renamed to a tagged
 *    subset name (`ABCDEF+Inter-Regular`); the face is recognised by comparing the subset's
 *    advance widths with the bundled faces, the tag is a hash of the program.
 * 2. Tagged PDF: a split text object repeats its marked-content id (every new object gets
 *    its own `BDC … EMC` with the same /MCID). Adjacent sequences of one id whose objects
 *    sit on the same baseline (the objects of one written paragraph line, craft spec §4.4)
 *    are first merged into one sequence; then repeats get fresh MCIDs, registered in the
 *    page's /ParentTree array and in the /K of the structure element that owned the id, so
 *    a rewritten paragraph has one MCID per written line under its original /P.
 * 3. Garbage collection (ADR-0011 §5): a second `GenerateContent` on a page leaves the
 *    previous content stream unreachable in the file; `dropUnreachable` removes it.
 */
import type { Font } from '@cantoo/fontkit';
import fontkit from '@cantoo/fontkit';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';

import { BUNDLED_FACES } from '../fonts/font-catalog';
import { dropUnreachable } from '../pdflib/metadata';
import { FaceCache, type FaceLoader } from './fonts';

export interface FinalizeTextEditsOptions {
  /** Remove unreachable objects (default true; the export's GC pass may do it instead). */
  readonly dropUnreachable?: boolean;
  /** Loads bundled face programs to recognise renamed fonts (default: bundled files). */
  readonly loadFace?: FaceLoader;
}

export interface FinalizeTextEditsResult {
  readonly bytes: ArrayBuffer;
  /** `/Untitled` fonts renamed to a tagged subset name. */
  readonly fontsRenamed: number;
  /** Repeated marked-content ids that got a fresh MCID. */
  readonly mcidsReassigned: number;
  /** Indirect objects removed as unreachable. */
  readonly unreachableRemoved: number;
}

const N = {
  Type: PDFName.of('Type'),
  Font: PDFName.of('Font'),
  Subtype: PDFName.of('Subtype'),
  Type0: PDFName.of('Type0'),
  BaseFont: PDFName.of('BaseFont'),
  DescendantFonts: PDFName.of('DescendantFonts'),
  FontDescriptor: PDFName.of('FontDescriptor'),
  FontName: PDFName.of('FontName'),
  FontFile2: PDFName.of('FontFile2'),
  ToUnicode: PDFName.of('ToUnicode'),
  CIDToGIDMap: PDFName.of('CIDToGIDMap'),
  Untitled: PDFName.of('Untitled'),
  StructTreeRoot: PDFName.of('StructTreeRoot'),
  ParentTree: PDFName.of('ParentTree'),
  StructParents: PDFName.of('StructParents'),
  Contents: PDFName.of('Contents'),
  Nums: PDFName.of('Nums'),
  Kids: PDFName.of('Kids'),
  K: PDFName.of('K'),
  Pg: PDFName.of('Pg'),
  MCID: PDFName.of('MCID'),
  MCR: PDFName.of('MCR'),
};

/** Renames subset fonts, repairs repeated MCIDs and drops unreachable objects. */
export async function finalizeTextEdits(
  bytes: ArrayBuffer,
  options: FinalizeTextEditsOptions = {},
): Promise<FinalizeTextEditsResult> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const fontsRenamed = await renameUntitledFonts(doc, new FaceCache(options.loadFace));
  const mcidsReassigned = repairMarkedContent(doc);
  let unreachableRemoved = 0;
  if (options.dropUnreachable ?? true) {
    const before = doc.context.enumerateIndirectObjects().length;
    dropUnreachable(doc);
    unreachableRemoved = before - doc.context.enumerateIndirectObjects().length;
  }
  const out = await doc.save({ useObjectStreams: false });
  return {
    bytes: out.slice().buffer,
    fontsRenamed,
    mcidsReassigned,
    unreachableRemoved,
  };
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function streamBytes(doc: PDFDocument, value: PDFObject | undefined): Uint8Array | undefined {
  const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!(stream instanceof PDFRawStream)) return undefined;
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return undefined;
  }
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/** CID → Unicode from a ToUnicode CMap (bfchar and bfrange with a start value). */
export function parseToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>();
  const utf16 = (hex: string): string => {
    let s = '';
    for (let i = 0; i + 4 <= hex.length; i += 4)
      s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      out.set(parseInt(m[1] ?? '0', 16), utf16(m[2] ?? ''));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of (block[1] ?? '').matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
    )) {
      const lo = parseInt(m[1] ?? '0', 16);
      const hi = parseInt(m[2] ?? '0', 16);
      const base = parseInt(m[3] ?? '0', 16);
      for (let cid = lo; cid <= hi && cid - lo < 0x10000; cid++) {
        out.set(cid, String.fromCharCode(base + cid - lo));
      }
    }
  }
  return out;
}

/** A deterministic six-letter subset tag. */
function subsetTag(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const b of bytes) hash = Math.imul(hash ^ b, 0x01000193) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26) ^ Math.imul(hash, 31);
    hash >>>= 0;
  }
  return tag;
}

/** The bundled face whose advances match the subset for every mapped character. */
async function recognise(
  faces: FaceCache,
  subset: Font,
  unicodeOf: ReadonlyMap<number, string>,
  gidOf: (cid: number) => number,
): Promise<string | undefined> {
  if (unicodeOf.size === 0) return undefined;
  for (const face of BUNDLED_FACES) {
    let font: Font;
    try {
      font = await faces.get(face);
    } catch {
      continue;
    }
    if (font.unitsPerEm !== subset.unitsPerEm) continue;
    let all = true;
    for (const [cid, text] of unicodeOf) {
      const glyph = font.glyphForCodePoint(text.codePointAt(0) ?? 0);
      const mine = subset.getGlyph(gidOf(cid));
      if (!mine || glyph?.advanceWidth !== mine.advanceWidth) {
        all = false;
        break;
      }
    }
    if (all) return face.key;
  }
  return undefined;
}

async function renameUntitledFonts(doc: PDFDocument, faces: FaceCache): Promise<number> {
  let renamed = 0;
  const { context } = doc;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(N.Type) !== N.Font || obj.get(N.Subtype) !== N.Type0) continue;
    if (obj.get(N.BaseFont) !== N.Untitled) continue;
    const descendants = obj.lookupMaybe(N.DescendantFonts, PDFArray);
    const cidFont = descendants?.lookupMaybe(0, PDFDict);
    const descriptor = cidFont?.lookupMaybe(N.FontDescriptor, PDFDict);
    const program = streamBytes(doc, descriptor?.get(N.FontFile2));
    if (!cidFont || !descriptor || !program) continue;
    const unicodeOf = parseToUnicode(
      latin1(streamBytes(doc, obj.get(N.ToUnicode)) ?? new Uint8Array()),
    );
    const map = streamBytes(doc, cidFont.get(N.CIDToGIDMap));
    const gidOf = (cid: number): number =>
      map && 2 * cid + 1 < map.length ? ((map[2 * cid] ?? 0) << 8) | (map[2 * cid + 1] ?? 0) : cid;
    let faceKey: string | undefined;
    try {
      faceKey = await recognise(faces, fontkit.create(program) as Font, unicodeOf, gidOf);
    } catch {
      faceKey = undefined;
    }
    const name = PDFName.of(`${subsetTag(program)}+${faceKey ?? 'Untitled'}`);
    obj.set(N.BaseFont, name);
    cidFont.set(N.BaseFont, name);
    descriptor.set(N.FontName, name);
    renamed += 1;
  }
  return renamed;
}

// ---------------------------------------------------------------------------
// Marked content
// ---------------------------------------------------------------------------

/** Value of `key` in a number tree (`/Nums`, `/Kids`). */
function numberTreeGet(
  doc: PDFDocument,
  node: PDFDict,
  key: number,
  depth = 0,
): PDFObject | undefined {
  if (depth > 32) return undefined;
  const nums = node.lookupMaybe(N.Nums, PDFArray);
  if (nums) {
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const k = nums.lookup(i);
      if (k instanceof PDFNumber && k.asNumber() === key) return nums.get(i + 1);
    }
  }
  const kids = node.lookupMaybe(N.Kids, PDFArray);
  for (let i = 0; kids && i < kids.size(); i++) {
    const kid = kids.lookupMaybe(i, PDFDict);
    const found = kid ? numberTreeGet(doc, kid, key, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** Positions of inline `/MCID n` in BDC property lists of a content stream. */
const MCID_PATTERN = /(\/MCID\s+)(\d+)(?=[^>]*>>\s*BDC)/g;

/** `/Tag <<… /MCID n …>> BDC` operations. */
const BDC_PATTERN = /\/([^\s/<>[\]()]+)\s*<<([^>]*?)\/MCID\s+(\d+)([^>]*)>>\s*BDC\b/g;
/** Marked-content operators, for nesting. */
const MARK_OPERATOR = /\b(BDC|BMC|EMC)\b/g;
const NUM = '(-?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)';
const SIX = `${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+`;
const CM_PATTERN = new RegExp(`${SIX}cm\\b`, 'g');
const TM_PATTERN = new RegExp(`${SIX}Tm\\b`, 'g');

interface MarkedSequence {
  /** Where the `/Tag <<…>> BDC` operation starts and ends, and where its `EMC` starts and ends. */
  readonly start: number;
  readonly contentStart: number;
  readonly emcStart: number;
  readonly end: number;
  readonly header: string;
}

/** The marked-content sequences with an MCID of a content stream (unbalanced ones left out). */
function markedSequences(text: string): MarkedSequence[] {
  const out: MarkedSequence[] = [];
  for (const m of text.matchAll(BDC_PATTERN)) {
    const start = m.index;
    const contentStart = start + m[0].length;
    MARK_OPERATOR.lastIndex = contentStart;
    let depth = 0;
    for (let op = MARK_OPERATOR.exec(text); op; op = MARK_OPERATOR.exec(text)) {
      if (op[1] !== 'EMC') {
        depth += 1;
      } else if (depth > 0) {
        depth -= 1;
      } else {
        out.push({
          start,
          contentStart,
          emcStart: op.index,
          end: op.index + 3,
          header: m[0].replace(/\s+/g, ''),
        });
        break;
      }
    }
  }
  return out;
}

/** The baseline of a text object drawn as `… a b c d e f cm BT … a' b' c' d' e' f' Tm …`. */
function baselineOf(
  cm: RegExpMatchArray | undefined,
  tm: RegExpMatchArray | undefined,
): { across: number; dx: number; dy: number } | undefined {
  if (!cm || !tm) return undefined;
  const [a, b, c, d, e, f] = cm.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [ta, tb, , , te, tf] = tm.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const x = te * a + tf * c + e;
  const y = te * b + tf * d + f;
  const ux = ta * a + tb * c;
  const uy = ta * b + tb * d;
  const len = Math.hypot(ux, uy);
  if (!(len > 0) || ![x, y].every(Number.isFinite)) return undefined;
  const dx = ux / len;
  const dy = uy / len;
  return { across: -x * dy + y * dx, dx, dy };
}

/**
 * Merges adjacent marked-content sequences of one MCID whose text objects share a baseline
 * (the last object of the first, the first of the second): the objects of one written line.
 */
function mergeLineSequences(text: string): { text: string; merged: number } {
  const list = markedSequences(text);
  const cuts: [number, number][] = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i] as MarkedSequence;
    const b = list[i + 1] as MarkedSequence;
    if (a.header !== b.header || text.slice(a.end, b.start).trim() !== '') continue;
    const bodyA = text.slice(a.contentStart, a.emcStart);
    const bodyB = text.slice(b.contentStart, b.emcStart);
    const last = (pattern: RegExp, body: string) => [...body.matchAll(pattern)].pop();
    const first = (pattern: RegExp, body: string) => [...body.matchAll(pattern)][0];
    const p = baselineOf(last(CM_PATTERN, bodyA), last(TM_PATTERN, bodyA));
    const q = baselineOf(first(CM_PATTERN, bodyB), first(TM_PATTERN, bodyB));
    if (!p || !q) continue;
    if (
      Math.abs(p.across - q.across) > 0.5 ||
      Math.abs(p.dx - q.dx) + Math.abs(p.dy - q.dy) > 1e-3
    ) {
      continue;
    }
    cuts.push([a.emcStart, b.contentStart]);
  }
  let out = text;
  for (const [from, to] of cuts.reverse()) out = `${out.slice(0, from)}${out.slice(to)}`;
  return { text: out, merged: cuts.length };
}

/**
 * Adds `fresh` to the structure element's /K right after `after` (the original id, or the
 * last id already split from it), so the kids keep content order.
 */
function addKid(
  doc: PDFDocument,
  element: PDFDict,
  pageRef: PDFRef,
  after: number,
  fresh: number,
): void {
  const { context } = doc;
  const onPage = element.get(N.Pg) === pageRef;
  const mcr = () => context.obj({ Type: N.MCR, Pg: pageRef, MCID: fresh });
  const k = element.get(N.K);
  const kResolved = k instanceof PDFRef ? context.lookup(k) : k;
  const entryFor = (existing: PDFObject | undefined): PDFObject =>
    existing instanceof PDFNumber && onPage ? PDFNumber.of(fresh) : mcr();
  if (kResolved instanceof PDFArray) {
    let at = kResolved.size();
    for (let i = 0; i < kResolved.size(); i++) {
      const item = kResolved.lookup(i);
      const id =
        item instanceof PDFNumber
          ? item.asNumber()
          : item instanceof PDFDict
            ? item.lookupMaybe(N.MCID, PDFNumber)?.asNumber()
            : undefined;
      if (id === after) {
        at = i + 1;
        break;
      }
    }
    kResolved.insert(at, entryFor(kResolved.lookup(Math.max(0, at - 1))));
    return;
  }
  const first = kResolved ?? PDFNumber.of(after);
  element.set(N.K, context.obj([first, entryFor(kResolved)]));
}

function repairMarkedContent(doc: PDFDocument): number {
  const { context } = doc;
  const root = doc.catalog.lookupMaybe(N.StructTreeRoot, PDFDict);
  const parentTree = root?.lookupMaybe(N.ParentTree, PDFDict);
  if (!parentTree) return 0;
  let reassigned = 0;
  for (const page of doc.getPages()) {
    const key = page.node.lookupMaybe(N.StructParents, PDFNumber)?.asNumber();
    if (key === undefined) continue;
    const entry = numberTreeGet(doc, parentTree, key);
    const ids = entry instanceof PDFRef ? context.lookup(entry) : entry;
    if (!(ids instanceof PDFArray)) continue;
    const contents = page.node.get(N.Contents);
    const resolved = contents instanceof PDFRef ? context.lookup(contents) : contents;
    const refs: (PDFRef | undefined)[] = [];
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const item = resolved.get(i);
        refs.push(item instanceof PDFRef ? item : undefined);
      }
    } else if (contents instanceof PDFRef) {
      refs.push(contents);
    }
    const seen = new Set<number>();
    /** Original MCID → the last id split from it on this page. */
    const lastOf = new Map<number, number>();
    let next = ids.size();
    const streams = refs.map((ref) => {
      const merged = mergeLineSequences(
        ref ? latin1(streamBytes(doc, ref) ?? new Uint8Array()) : '',
      );
      return { ref, text: merged.text, merged: merged.merged > 0 };
    });
    for (const s of streams)
      for (const m of s.text.matchAll(MCID_PATTERN)) next = Math.max(next, Number(m[2]) + 1);
    for (const stream of streams) {
      if (!stream.ref) continue;
      let changed = false;
      const text = stream.text.replace(MCID_PATTERN, (whole, prefix: string, digits: string) => {
        const id = Number(digits);
        if (!seen.has(id)) {
          seen.add(id);
          return whole;
        }
        const element = ids.lookup(id);
        if (!(element instanceof PDFDict)) return whole;
        const fresh = next++;
        while (ids.size() < fresh) ids.push(context.obj(null));
        const owner = ids.get(id);
        ids.push(owner);
        addKid(doc, element, page.ref, lastOf.get(id) ?? id, fresh);
        lastOf.set(id, fresh);
        reassigned += 1;
        changed = true;
        return `${prefix}${fresh}`;
      });
      if (!changed && !stream.merged) continue;
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      const old = context.lookup(stream.ref);
      const replacement = context.flateStream(out);
      if (old instanceof PDFStream) {
        for (const [name, value] of old.dict.entries()) {
          if (
            name !== PDFName.of('Length') &&
            name !== PDFName.of('Filter') &&
            name !== PDFName.of('DecodeParms')
          ) {
            replacement.dict.set(name, value);
          }
        }
      }
      context.assign(stream.ref, replacement);
    }
  }
  return reassigned;
}
