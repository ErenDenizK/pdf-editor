/**
 * Re-parses every fixture listed in test/fixtures/manifest.json with
 * @cantoo/pdf-lib and checks it against the recorded expectations.
 *
 *   pnpm --filter @pdf-editor/fixtures-tool verify
 *
 * Page labels, outlines, named destinations and links are resolved here with
 * independent code (pdf-lib has no API for them), so this doubles as a second
 * implementation of the reader-side logic the product needs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import {
  type Box,
  FIXED_DATE,
  FIXTURES_DIR,
  MAX_CORPUS_BYTES,
  type Manifest,
  type ManifestEntry,
  type OutlineExpectation,
  sha256,
} from './lib/common.ts';
import { findToken } from './lib/scan.ts';

// pdf-lib logs parse recoveries with console.warn; keep the report readable.
const warnings: string[] = [];
console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

/** JSON with sorted object keys, so comparisons ignore property order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

class Checker {
  readonly failures: string[] = [];
  checks = 0;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  ok(condition: boolean, message: string): void {
    this.checks++;
    if (!condition) this.failures.push(message);
  }

  eq(actual: unknown, expected: unknown, message: string): void {
    const a = stableJson(actual);
    const e = stableJson(expected);
    this.ok(a === e, `${message}: expected ${e}, got ${a}`);
  }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

const N = (value: string) => PDFName.of(value);

function resolve(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function dictOf(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const r = resolve(doc, obj);
  if (r instanceof PDFDict) return r;
  if (r instanceof PDFStream) return r.dict;
  return undefined;
}

function textOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  return undefined;
}

function num(doc: PDFDocument, obj: PDFObject | undefined): number | undefined {
  const r = resolve(doc, obj);
  return r instanceof PDFNumber ? r.asNumber() : undefined;
}

function numbers(doc: PDFDocument, obj: PDFObject | undefined): number[] {
  const r = resolve(doc, obj);
  if (!(r instanceof PDFArray)) return [];
  return r.asArray().map((v) => num(doc, v) ?? Number.NaN);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function boxOf(b: { x: number; y: number; width: number; height: number }): Box {
  return [round2(b.x), round2(b.y), round2(b.width), round2(b.height)];
}

function streamText(doc: PDFDocument, obj: PDFObject | undefined): string {
  const r = resolve(doc, obj);
  if (r instanceof PDFArray)
    return r
      .asArray()
      .map((o) => streamText(doc, o))
      .join('\n');
  if (r instanceof PDFRawStream)
    return Buffer.from(decodePDFRawStream(r).decode()).toString('latin1');
  return '';
}

function pageContent(doc: PDFDocument, page: PDFPage): string {
  return streamText(doc, page.node.get(N('Contents')));
}

function hasMarker(content: string, marker: string): boolean {
  if (content.includes(`(${marker})`)) return true;
  const hex = Buffer.from(marker, 'latin1').toString('hex').toUpperCase();
  return content.toUpperCase().includes(`<${hex}>`);
}

// ---------------------------------------------------------------------------
// Reader-side logic: labels, destinations, outline
// ---------------------------------------------------------------------------

function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [value, digits] of table) {
    while (n >= value) {
      out += digits;
      n -= value;
    }
  }
  return out;
}

function toLetters(n: number): string {
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

function pageLabels(doc: PDFDocument): string[] | undefined {
  const tree = dictOf(doc, doc.catalog.get(N('PageLabels')));
  if (!tree) return undefined;
  const nums = resolve(doc, tree.get(N('Nums')));
  if (!(nums instanceof PDFArray)) return undefined;
  const ranges: { start: number; dict: PDFDict }[] = [];
  for (let i = 0; i + 1 < nums.size(); i += 2) {
    const dict = dictOf(doc, nums.get(i + 1));
    const start = num(doc, nums.get(i));
    if (dict && start !== undefined) ranges.push({ start, dict });
  }
  const count = doc.getPageCount();
  const labels: string[] = [];
  for (let p = 0; p < count; p++) {
    const range = [...ranges].reverse().find((r) => r.start <= p);
    if (!range) {
      labels.push(String(p + 1));
      continue;
    }
    const style = (resolve(doc, range.dict.get(N('S'))) as PDFName | undefined)?.decodeText();
    const prefix = textOf(resolve(doc, range.dict.get(N('P')))) ?? '';
    const n = (num(doc, range.dict.get(N('St'))) ?? 1) + (p - range.start);
    const body =
      style === 'D'
        ? String(n)
        : style === 'r'
          ? toRoman(n)
          : style === 'R'
            ? toRoman(n).toUpperCase()
            : style === 'a'
              ? toLetters(n)
              : style === 'A'
                ? toLetters(n).toUpperCase()
                : '';
    labels.push(prefix + body);
  }
  return labels;
}

function pageIndexOfRef(doc: PDFDocument, ref: PDFObject | undefined): number | undefined {
  if (!(ref instanceof PDFRef)) return undefined;
  const index = doc.getPages().findIndex((p) => p.ref === ref);
  return index < 0 ? undefined : index;
}

function lookupNameTree(doc: PDFDocument, node: PDFDict, key: string): PDFObject | undefined {
  const names = resolve(doc, node.get(N('Names')));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      if (textOf(resolve(doc, names.get(i))) === key) return resolve(doc, names.get(i + 1));
    }
  }
  const kids = resolve(doc, node.get(N('Kids')));
  if (kids instanceof PDFArray) {
    for (const kid of kids.asArray()) {
      const kidDict = dictOf(doc, kid);
      const found = kidDict && lookupNameTree(doc, kidDict, key);
      if (found) return found;
    }
  }
  return undefined;
}

interface ResolvedDest {
  page?: number | undefined;
  kind: 'explicit' | 'named-string' | 'named-name';
  name?: string;
  tree?: 'Names/Dests' | 'Catalog/Dests';
}

function explicitPage(doc: PDFDocument, dest: PDFObject | undefined): number | undefined {
  let d = resolve(doc, dest);
  if (d instanceof PDFDict) d = resolve(doc, d.get(N('D')));
  if (!(d instanceof PDFArray)) return undefined;
  const index = pageIndexOfRef(doc, d.get(0));
  return index === undefined ? undefined : index + 1;
}

function resolveDest(doc: PDFDocument, dest: PDFObject | undefined): ResolvedDest | undefined {
  const d = resolve(doc, dest);
  if (d instanceof PDFArray) return { kind: 'explicit', page: explicitPage(doc, d) };
  if (d instanceof PDFString || d instanceof PDFHexString) {
    const key = d.decodeText();
    const names = dictOf(doc, doc.catalog.get(N('Names')));
    const tree = names && dictOf(doc, names.get(N('Dests')));
    const value = tree && lookupNameTree(doc, tree, key);
    return { kind: 'named-string', name: key, tree: 'Names/Dests', page: explicitPage(doc, value) };
  }
  if (d instanceof PDFName) {
    const key = d.decodeText();
    const dests = dictOf(doc, doc.catalog.get(N('Dests')));
    const value = dests && resolve(doc, dests.get(N(key)));
    return { kind: 'named-name', name: key, tree: 'Catalog/Dests', page: explicitPage(doc, value) };
  }
  return undefined;
}

type ReadOutline = OutlineExpectation;

function readOutline(doc: PDFDocument, first: PDFObject | undefined): ReadOutline[] {
  const items: ReadOutline[] = [];
  let current = dictOf(doc, first);
  let guard = 0;
  while (current && guard++ < 1000) {
    const title = textOf(resolve(doc, current.get(N('Title')))) ?? '';
    let target: OutlineExpectation['target'] = 'explicit-dest';
    let resolved: ResolvedDest | undefined;
    const action = dictOf(doc, current.get(N('A')));
    if (current.get(N('Dest'))) {
      resolved = resolveDest(doc, current.get(N('Dest')));
      target =
        resolved?.kind === 'named-string'
          ? 'named-dest-string'
          : resolved?.kind === 'named-name'
            ? 'named-dest-name'
            : 'explicit-dest';
    } else if (action) {
      resolved = resolveDest(doc, action.get(N('D')));
      target = resolved?.kind === 'explicit' ? 'explicit-dest' : 'goto-action-named';
    }
    const item: ReadOutline = { title, page: resolved?.page ?? -1, target };
    if (resolved?.name) item.destName = resolved.name;
    const count = num(doc, current.get(N('Count')));
    if (current.get(N('First'))) {
      item.open = (count ?? 0) > 0;
      item.children = readOutline(doc, current.get(N('First')));
    }
    items.push(item);
    current = dictOf(doc, current.get(N('Next')));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Per-fixture checks
// ---------------------------------------------------------------------------

async function checkEntry(entry: ManifestEntry, c: Checker): Promise<void> {
  const path = join(FIXTURES_DIR, entry.file);
  const bytes = new Uint8Array(readFileSync(path));
  const e = entry.expect;
  c.eq(bytes.length, entry.bytes, 'byte size');
  c.eq(sha256(bytes), entry.sha256, 'sha256');
  const latin = Buffer.from(bytes).toString('latin1');
  if (e.xref === 'table') c.ok(/\nxref\s/.test(latin), 'classic xref table present');
  if (e.xref === 'stream') c.ok(latin.includes('/Type /XRef'), 'xref stream present');

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ...e.pdfLibLoadOptions });
  } catch (error) {
    c.ok(e.pdfLibLoad === 'throws', `pdf-lib load threw: ${String(error)}`);
    return;
  }
  c.ok(e.pdfLibLoad === 'ok', 'pdf-lib load was expected to throw but succeeded');
  c.eq(doc.getPageCount(), e.pageCount, 'page count');
  c.eq(entry.pageCount, e.pageCount, 'manifest pageCount');
  if (e.damage) return; // content equals simple-text; only openability matters here

  const pages = doc.getPages();
  c.eq(doc.getCreationDate()?.toISOString(), FIXED_DATE.toISOString(), 'CreationDate');
  c.eq(doc.getModificationDate()?.toISOString(), FIXED_DATE.toISOString(), 'ModDate');

  for (const pe of e.pages ?? []) {
    const page = pages[pe.page - 1];
    if (!page) {
      c.ok(false, `page ${pe.page} missing`);
      continue;
    }
    const label = `page ${pe.page}`;
    c.eq(boxOf(page.getMediaBox()), pe.mediaBox, `${label} MediaBox`);
    if (pe.cropBox) c.eq(boxOf(page.getCropBox()), pe.cropBox, `${label} CropBox`);
    if (pe.trimBox) c.eq(boxOf(page.getTrimBox()), pe.trimBox, `${label} TrimBox`);
    if (pe.bleedBox) c.eq(boxOf(page.getBleedBox()), pe.bleedBox, `${label} BleedBox`);
    c.eq(page.getRotation().angle, pe.rotate, `${label} rotation`);
    if (pe.displayedSize) {
      const crop = page.getCropBox();
      const swap = pe.rotate % 180 !== 0;
      const shown = swap ? [crop.height, crop.width] : [crop.width, crop.height];
      c.eq(shown.map(round2), pe.displayedSize, `${label} displayed size`);
    }
    const content = pageContent(doc, page);
    for (const marker of pe.markers ?? [])
      c.ok(hasMarker(content, marker), `${label} marker "${marker}"`);
  }

  for (const range of e.pageRanges ?? []) {
    for (let n = range.first; n <= range.last; n++) {
      const page = pages[n - 1];
      if (!page) {
        c.ok(false, `page ${n} missing`);
        break;
      }
      c.eq(boxOf(page.getMediaBox()), range.mediaBox, `page ${n} MediaBox`);
      c.eq(page.getRotation().angle, range.rotate, `page ${n} rotation`);
      c.ok(hasMarker(pageContent(doc, page), String(n)), `page ${n} marker`);
      c.ok(
        !page.node.get(N('MediaBox')) && !page.node.get(N('Resources')),
        `page ${n} attributes inherited`,
      );
    }
  }

  if (e.pageLabels) c.eq(pageLabels(doc), e.pageLabels, 'page labels');

  if (e.outline) {
    const outlines = dictOf(doc, doc.catalog.get(N('Outlines')));
    c.ok(!!outlines, '/Outlines present');
    if (outlines) {
      c.eq(readOutline(doc, outlines.get(N('First'))), e.outline, 'outline tree');
      c.eq(num(doc, outlines.get(N('Count'))), e.outlineVisibleCount, 'outline root /Count');
    }
  }

  for (const nd of e.namedDests ?? []) {
    const resolved = resolveDest(
      doc,
      nd.tree === 'Names/Dests' ? PDFString.of(nd.name) : PDFName.of(nd.name),
    );
    c.eq(resolved?.page, nd.page, `named dest ${nd.name} (${nd.tree})`);
  }

  if (e.links) {
    const found: unknown[] = [];
    pages.forEach((page, i) => {
      for (const annot of page.node.Annots()?.asArray() ?? []) {
        const dict = dictOf(doc, annot);
        if (dict?.get(N('Subtype'))?.toString() !== '/Link') continue;
        c.ok(dict.get(N('P')) === page.ref, `link on page ${i + 1} has /P`);
        const action = dictOf(doc, dict.get(N('A')));
        const subtype = action?.get(N('S'))?.toString();
        if (subtype === '/URI') {
          found.push({
            page: i + 1,
            kind: 'uri',
            uri: textOf(resolve(doc, action?.get(N('URI')))),
          });
        } else {
          const r = resolveDest(doc, action ? action.get(N('D')) : dict.get(N('Dest')));
          const link: Record<string, unknown> = {
            page: i + 1,
            kind: r?.kind === 'explicit' ? 'goto-explicit' : 'dest-named',
            targetPage: r?.page,
          };
          if (r?.name) link.destName = r.name;
          found.push(link);
        }
      }
    });
    c.eq(found, e.links, 'links');
  }

  if (e.fields) {
    const form = doc.getForm();
    const acro = form.acroForm.dict;
    const needApp = resolve(doc, acro.get(N('NeedAppearances')));
    c.eq(
      needApp instanceof PDFBool ? needApp.asBoolean() : false,
      e.needAppearances ?? false,
      'NeedAppearances',
    );
    const fields = form.getFields();
    c.eq(fields.map((f) => f.getName()).sort(), e.fields.map((f) => f.name).sort(), 'field names');
    for (const fe of e.fields) {
      const field = fields.find((f) => f.getName() === fe.name);
      if (!field) continue;
      let value: string | boolean | undefined;
      let type: string | undefined;
      if (field instanceof PDFTextField) [type, value] = ['text', field.getText()];
      else if (field instanceof PDFCheckBox) [type, value] = ['checkbox', field.isChecked()];
      else if (field instanceof PDFRadioGroup) [type, value] = ['radio', field.getSelected()];
      else if (field instanceof PDFDropdown) [type, value] = ['dropdown', field.getSelected()[0]];
      c.eq(type, fe.type, `field ${fe.name} type`);
      c.eq(value, fe.value, `field ${fe.name} value`);
      if (fe.options && field instanceof PDFRadioGroup)
        c.eq(field.getOptions(), fe.options, `field ${fe.name} options`);
      if (fe.options && field instanceof PDFDropdown)
        c.eq(field.getOptions(), fe.options, `field ${fe.name} options`);
      const widgets = field.acroField.getWidgets();
      c.ok(widgets.length > 0, `field ${fe.name} has widgets`);
      for (const widget of widgets) {
        c.eq(widget.dict.has(N('AP')), fe.hasAppearance, `field ${fe.name} widget /AP`);
        c.eq(
          pageIndexOfRef(doc, widget.dict.get(N('P'))),
          fe.page - 1,
          `field ${fe.name} widget /P`,
        );
      }
    }
  }

  if (e.xfa !== undefined) {
    const acro = dictOf(doc, doc.catalog.get(N('AcroForm')));
    const xfa = acro && resolve(doc, acro.get(N('XFA')));
    c.eq(!!xfa, e.xfa, '/AcroForm /XFA present');
    if (e.xfa && xfa instanceof PDFRawStream) {
      const xml = Buffer.from(decodePDFRawStream(xfa).decode()).toString('utf8');
      c.ok(xml.includes('<xdp:xdp') && xml.includes('<template'), 'XFA stream is an XDP document');
    }
  }

  if (e.encryption) {
    const enc = e.encryption;
    const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const dict = dictOf(raw, raw.context.trailerInfo.Encrypt);
    c.ok(!!dict, '/Encrypt present');
    if (dict) {
      c.eq(dict.get(N('Filter'))?.toString(), `/${enc.filter}`, '/Filter');
      c.eq(num(raw, dict.get(N('V'))), enc.v, '/V');
      c.eq(num(raw, dict.get(N('R'))), enc.r, '/R');
      c.eq(num(raw, dict.get(N('P'))), enc.p, '/P');
      const p = enc.p;
      c.eq(
        { print: !!(p & 4), modify: !!(p & 8), copy: !!(p & 16) },
        enc.permissions,
        'permission bits',
      );
      const expectedV = { 'RC4-40': 1, 'RC4-128': 2, 'AES-128': 4, 'AES-256': 5 }[enc.algorithm];
      c.eq(enc.v, expectedV, `V matches ${enc.algorithm}`);
    }
    if (enc.userPassword) {
      let refused = false;
      try {
        await PDFDocument.load(bytes, { updateMetadata: false });
      } catch {
        refused = true;
      }
      c.ok(refused, 'load without password is refused');
    }
    let wrongRefused = false;
    try {
      await PDFDocument.load(bytes, { password: 'wrong-password', updateMetadata: false });
    } catch {
      wrongRefused = true;
    }
    c.ok(wrongRefused, 'wrong password is refused');
    const owner = await PDFDocument.load(bytes, {
      password: enc.ownerPassword,
      updateMetadata: false,
    });
    c.eq(owner.getPageCount(), e.pageCount, 'page count with owner password');
    c.ok(
      hasMarker(pageContent(owner, owner.getPage(0)), 'PAGE 1 OF simple-text'),
      'owner-decrypted content',
    );
  }

  if (e.info) {
    const info: Record<string, string | undefined> = {
      Title: doc.getTitle(),
      Author: doc.getAuthor(),
      Subject: doc.getSubject(),
      Keywords: doc.getKeywords(),
      Creator: doc.getCreator(),
      Producer: doc.getProducer(),
      CreationDate: doc.getCreationDate()?.toISOString(),
      ModDate: doc.getModificationDate()?.toISOString(),
    };
    for (const [key, value] of Object.entries(e.info)) c.eq(info[key], value, `Info /${key}`);
  }

  if (e.xmp) {
    const stream = resolve(doc, doc.catalog.get(N('Metadata')));
    c.ok(stream instanceof PDFRawStream, '/Metadata stream present');
    if (stream instanceof PDFRawStream) {
      c.eq(stream.dict.get(N('Subtype'))?.toString(), '/XML', '/Metadata /Subtype');
      c.ok(!stream.dict.has(N('Filter')), 'XMP stream is uncompressed');
      const xml = Buffer.from(stream.getContents()).toString('utf8');
      for (const [tag, value] of Object.entries(e.xmp)) {
        const match = new RegExp(`<${tag}>(.*?)</${tag}>`, 's').exec(xml);
        const inner = (match?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
        c.eq(inner, value, `XMP ${tag}`);
      }
    }
  }

  if (e.attachments) {
    const attachments = doc.getAttachments().map((a) => ({
      name: a.name,
      content: Buffer.from(a.data).toString('utf8'),
      mimeType: a.mimeType,
    }));
    c.eq(attachments, e.attachments, 'attachments');
  }

  if (e.images) {
    const found: unknown[] = [];
    pages.forEach((page, i) => {
      const xobjects = dictOf(doc, page.node.Resources()?.get(N('XObject')));
      for (const value of xobjects?.values() ?? []) {
        const img = dictOf(doc, value);
        if (img?.get(N('Subtype'))?.toString() !== '/Image') continue;
        found.push({
          page: i + 1,
          filter: img.get(N('Filter'))?.toString().slice(1),
          width: num(doc, img.get(N('Width'))),
          height: num(doc, img.get(N('Height'))),
          smask: img.has(N('SMask')),
        });
      }
    });
    c.eq(found, e.images, 'images');
  }

  if (e.annotations) {
    const found: unknown[] = [];
    const nms = new Set<string>();
    const nmByRef = new Map<PDFObject, string>();
    pages.forEach((page) => {
      for (const ref of page.node.Annots()?.asArray() ?? []) {
        const nm = textOf(resolve(doc, dictOf(doc, ref)?.get(N('NM'))));
        if (nm) nmByRef.set(ref, nm);
      }
    });
    pages.forEach((page, i) => {
      for (const ref of page.node.Annots()?.asArray() ?? []) {
        const a = dictOf(doc, ref);
        if (!a) continue;
        const subtype = a.get(N('Subtype'))?.toString().slice(1) ?? '';
        const nm = textOf(resolve(doc, a.get(N('NM')))) ?? '';
        c.ok(!nms.has(nm), `annotation /NM ${nm} unique`);
        nms.add(nm);
        c.ok(a.get(N('P')) === page.ref, `${nm} /P points at its page`);
        const rect = numbers(doc, a.get(N('Rect')));
        const [rx1 = 0, ry1 = 0, rx2 = 0, ry2 = 0] = rect;
        const inside = (pts: number[]) =>
          pts.every((v, k) => (k % 2 === 0 ? v >= rx1 && v <= rx2 : v >= ry1 && v <= ry2));
        const ap = dictOf(doc, a.get(N('AP')));
        const item: Record<string, unknown> = {
          page: i + 1,
          subtype,
          nm,
          hasAppearance: !!ap,
          flags: num(doc, a.get(N('F'))),
        };
        if (ap) {
          const normal = dictOf(doc, ap.get(N('N')));
          const bbox = numbers(doc, normal?.get(N('BBox')));
          c.ok(bbox.length === 4, `${nm} appearance has /BBox`);
          if (subtype === 'Highlight') {
            const gs = dictOf(doc, dictOf(doc, normal?.get(N('Resources')))?.get(N('ExtGState')));
            const first = gs && dictOf(doc, gs.values()[0]);
            item.blendMode = first?.get(N('BM'))?.toString().slice(1);
          }
        }
        if (subtype === 'Highlight') {
          const quad = numbers(doc, a.get(N('QuadPoints')));
          item.quadPoints = quad;
          c.ok(quad.length % 8 === 0 && inside(quad), `${nm} QuadPoints inside /Rect`);
          // Upper-left, upper-right, lower-left, lower-right.
          c.ok(
            quad[1] === quad[3] && quad[5] === quad[7] && (quad[1] ?? 0) > (quad[5] ?? 0),
            `${nm} QuadPoints order`,
          );
        }
        if (subtype === 'Ink') {
          const inkList = resolve(doc, a.get(N('InkList')));
          const strokes =
            inkList instanceof PDFArray ? inkList.asArray().map((s) => numbers(doc, s)) : [];
          item.inkStrokes = strokes.length;
          c.ok(strokes.every(inside), `${nm} InkList inside /Rect`);
        }
        if (subtype === 'Popup') {
          const parent = a.get(N('Parent'));
          item.popupOf = parent ? nmByRef.get(parent) : undefined;
          const parentDict = dictOf(doc, parent);
          c.ok(parentDict?.get(N('Popup')) === ref, `${nm} parent links back via /Popup`);
        }
        found.push(item);
      }
    });
    c.eq(found, e.annotations, 'annotations');
  }

  if (e.tagged) {
    const markInfo = dictOf(doc, doc.catalog.get(N('MarkInfo')));
    const marked = resolve(doc, markInfo?.get(N('Marked')));
    c.eq(marked instanceof PDFBool && marked.asBoolean(), e.tagged.marked, '/MarkInfo /Marked');
    const root = dictOf(doc, doc.catalog.get(N('StructTreeRoot')));
    c.ok(!!root, '/StructTreeRoot present');
    const types: string[] = [];
    const mcids: number[] = [];
    const walk = (obj: PDFObject | undefined): void => {
      const r = resolve(doc, obj);
      if (r instanceof PDFArray) {
        r.asArray().forEach(walk);
        return;
      }
      if (r instanceof PDFNumber) {
        mcids.push(r.asNumber());
        return;
      }
      if (!(r instanceof PDFDict)) return;
      const s = r.get(N('S'));
      if (s) types.push(s.toString().slice(1));
      walk(r.get(N('K')));
    };
    walk(root?.get(N('K')));
    c.eq(types, e.tagged.structTypes, 'structure element types');
    c.eq(mcids, e.tagged.mcids, 'MCIDs');
    c.eq(
      pages.map((p) => num(doc, p.node.get(N('StructParents')))),
      e.tagged.structParents,
      '/StructParents',
    );
    const parentTree = dictOf(doc, root?.get(N('ParentTree')));
    const nums = resolve(doc, parentTree?.get(N('Nums')));
    const keys =
      nums instanceof PDFArray
        ? nums
            .asArray()
            .filter((_, k) => k % 2 === 0)
            .map((k) => num(doc, k))
        : [];
    c.eq(keys, e.tagged.structParents, '/ParentTree keys match /StructParents');
    pages.forEach((page, i) => {
      c.ok(pageContent(doc, page).includes('/MCID 0'), `page ${i + 1} has marked content MCID 0`);
    });
  }

  await checkM4(entry, doc, bytes, c);
}

/** M4 fixtures: token locations, revision history, fonts and images behind regions. */
async function checkM4(
  entry: ManifestEntry,
  doc: PDFDocument,
  bytes: Uint8Array,
  c: Checker,
): Promise<void> {
  const e = entry.expect;
  const latin = Buffer.from(bytes).toString('latin1');
  if (e.secret) {
    c.eq(findToken(doc, e.secret.token), e.secret.locations, 'token locations');
    c.eq(latin.includes(e.secret.token), e.secret.inRawBytes, 'token in raw bytes');
  }

  if (e.incremental) {
    const inc = e.incremental;
    const startxrefs = [...latin.matchAll(/startxref\s+(\d+)\s+%%EOF/g)].map((m) => Number(m[1]));
    c.eq(startxrefs, inc.startxrefs, 'startxref chain');
    c.eq((latin.match(/%%EOF/g) ?? []).length, inc.revisions, '%%EOF count');
    const last = startxrefs.at(-1) ?? 0;
    c.ok(latin.startsWith('xref', last), 'newest startxref points at an xref keyword');
    const prev = /\/Prev (\d+)/.exec(latin.slice(last));
    c.eq(Number(prev?.[1]), inc.prev, 'newest trailer /Prev');
    c.ok(latin.startsWith('xref', inc.prev), '/Prev points at the first xref table');
    const rev1 = bytes.slice(0, inc.revision1Bytes);
    c.ok(
      latin.slice(0, inc.revision1Bytes).trimEnd().endsWith('%%EOF'),
      'revision 1 ends at %%EOF',
    );
    const rev1Doc = await PDFDocument.load(rev1, { updateMetadata: false });
    const token = e.secret?.token;
    if (token)
      c.eq(findToken(rev1Doc, token), inc.revision1Locations, 'revision 1 token locations');
    for (const ref of inc.replaced) {
      const [n, g] = ref.split(' ');
      c.eq(
        latin.split(`\n${n} ${g} obj`).length - 1,
        inc.revisions,
        `${ref} defined once per revision`,
      );
    }
  }

  const pages = doc.getPages();
  for (const region of e.regions ?? []) {
    const page = pages[region.page - 1];
    const label = `region ${region.id}`;
    if (!page) {
      c.ok(false, `${label}: page ${region.page} missing`);
      continue;
    }
    const resources = page.node.Resources();
    if (region.font) {
      const fe = region.font;
      const fonts = dictOf(doc, resources?.get(N('Font')));
      const font = dictOf(doc, fonts?.get(N(fe.resource)));
      c.ok(!!font, `${label}: font /${fe.resource} present`);
      if (!font) continue;
      const nameOf = (o: PDFObject | undefined) => resolve(doc, o)?.toString().slice(1);
      c.eq(nameOf(font.get(N('Subtype'))), fe.subtype, `${label}: font /Subtype`);
      const baseFont = nameOf(font.get(N('BaseFont')));
      if (fe.baseFont) c.eq(baseFont, fe.baseFont, `${label}: /BaseFont`);
      const encoding = resolve(doc, font.get(N('Encoding')));
      c.eq(
        encoding instanceof PDFDict ? 'Differences' : nameOf(encoding),
        fe.encoding,
        `${label}: /Encoding`,
      );
      let descriptorHost = font;
      if (fe.subtype === 'Type0') {
        const kids = resolve(doc, font.get(N('DescendantFonts')));
        const cid = kids instanceof PDFArray ? dictOf(doc, kids.get(0)) : undefined;
        c.eq(nameOf(cid?.get(N('Subtype'))), fe.descendant, `${label}: descendant /Subtype`);
        if (cid) descriptorHost = cid;
      }
      const descriptor = dictOf(doc, descriptorHost.get(N('FontDescriptor')));
      const embedded = ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor?.has(N(k)));
      c.eq(embedded, fe.embedded, `${label}: font program embedded`);
      c.eq(/^[A-Z]{6}\+/.test(baseFont ?? ''), fe.subset, `${label}: subset tag`);
      c.eq(font.has(N('ToUnicode')), fe.toUnicode, `${label}: /ToUnicode`);
    }
    if (region.kind === 'image' && region.xobject) {
      const xobjects = dictOf(doc, resources?.get(N('XObject')));
      const image = dictOf(doc, xobjects?.get(N(region.xobject)));
      c.eq(
        image?.get(N('Subtype'))?.toString(),
        '/Image',
        `${label}: /${region.xobject} is an image`,
      );
      c.ok(
        pageContent(doc, page).includes(`/${region.xobject} Do`),
        `${label}: /${region.xobject} painted`,
      );
    }
    if (region.kind === 'inline-image') {
      c.ok(/\nBI [^]*? ID [^]*?\nEI\n/.test(pageContent(doc, page)), `${label}: BI/ID/EI present`);
    }
    if (region.xobject && region.kind === 'text') {
      let host = resources;
      for (const part of region.xobject.split('/')) {
        host = dictOf(doc, dictOf(doc, host?.get(N('XObject')))?.get(N(part)));
        c.eq(host?.get(N('Subtype'))?.toString(), '/Form', `${label}: ${part} is a Form XObject`);
        host = dictOf(doc, host?.get(N('Resources')));
      }
    }
    if (region.renderMode !== undefined) {
      c.ok(
        pageContent(doc, page).includes(` ${region.renderMode} Tr `),
        `${label}: ${region.renderMode} Tr`,
      );
    }
  }
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8'),
  ) as Manifest;
  let failed = 0;
  let checks = 0;

  const listed = new Set(manifest.fixtures.map((f) => f.file));
  const onDisk = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.pdf'));
  const unlisted = onDisk.filter((f) => !listed.has(f));
  if (unlisted.length) {
    console.log(`FAIL  PDFs missing from manifest: ${unlisted.join(', ')}`);
    failed++;
  }
  const total = onDisk.reduce((n, f) => n + statSync(join(FIXTURES_DIR, f)).size, 0);
  if (total > MAX_CORPUS_BYTES) {
    console.log(`FAIL  corpus is ${total} bytes (budget ${MAX_CORPUS_BYTES})`);
    failed++;
  }

  for (const entry of manifest.fixtures) {
    const c = new Checker(entry.file);
    warnings.length = 0;
    try {
      await checkEntry(entry, c);
    } catch (error) {
      c.ok(
        false,
        `verifier crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
    checks += c.checks;
    const note = warnings.length ? ` (pdf-lib warned ${warnings.length}x)` : '';
    if (c.failures.length) {
      failed++;
      console.log(`FAIL  ${entry.file}${note}`);
      for (const f of c.failures) console.log(`        - ${f}`);
    } else {
      console.log(`ok    ${entry.file.padEnd(36)} ${String(c.checks).padStart(4)} checks${note}`);
    }
  }
  console.log(
    `\n${manifest.fixtures.length} fixtures, ${checks} checks, ${failed} failing, ${(total / 1024).toFixed(1)} KB`,
  );
  if (failed) process.exitCode = 1;
}

await main();
